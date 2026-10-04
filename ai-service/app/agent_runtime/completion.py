"""Frozen feature contracts and execution-derived completion, not model grades."""
import hashlib
import json
import re
from pathlib import PurePosixPath

WORKLOADS = {'web', 'api', 'cli', 'worker', 'job', 'tcp', 'grpc', 'artifact',
             'package', 'desktop', 'android', 'windows', 'macos', 'ios'}
CONTRACT_FILE = 'stackpilot.completion.json'


def text(value, label, limit=4000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or '\0' in value:
        raise ValueError(label+' must be bounded nonempty text')
    return value


def argv(value, label):
    if not isinstance(value, list) or not 1 <= len(value) <= 100:
        raise ValueError(label+' must be a nonempty argv array')
    text(value[0], label+' executable', 12000)
    if any(not isinstance(item, str) or '\0' in item or len(item) > 12000 for item in value):
        raise ValueError(label+' arguments must be bounded strings')
    return list(value)


def normalize(value):
    # Some provider tool adapters serialize nested objects a second time.
    # Parse bounded JSON data, then apply exactly the same contract validation.
    if isinstance(value, str):
        if len(value.encode()) > 128*1024:
            raise ValueError('Completion contract exceeds the byte budget')
        try:
            value = json.loads(value)
        except ValueError as error:
            raise ValueError('Completion contract must be an object or valid JSON encoding of that object') from error
    if not isinstance(value, dict) or type(value.get('version', 1)) is not int or value.get('version', 1) != 1:
        raise ValueError('Completion contract must be a version 1 object')
    if set(value)-{'version', 'summary', 'workload', 'assumptions', 'features'}:
        raise ValueError('Unknown completion contract field')
    if value.get('workload') not in WORKLOADS:
        raise ValueError('Choose a supported workload, preserving the application type')
    features = value.get('features')
    if not isinstance(features, list) or not 1 <= len(features) <= 32:
        raise ValueError('Declare 1–32 features with executable acceptance checks')
    assumptions = value.get('assumptions', [])
    if not isinstance(assumptions, list) or len(assumptions) > 32:
        raise ValueError('Assumptions must be a bounded text array')
    result = {'version': 1, 'summary': text(value.get('summary'), 'Summary', 8000),
              'workload': value['workload'], 'assumptions': [text(item, 'Assumption') for item in assumptions], 'features': []}
    ids, count = set(), 0
    for feature in features:
        if not isinstance(feature, dict) or set(feature)-{'id', 'description', 'checks'}:
            raise ValueError('Features contain only id, description and checks')
        ident = feature.get('id')
        if not isinstance(ident, str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', ident) or ident in ids:
            raise ValueError('Feature IDs must be unique lowercase identifiers')
        ids.add(ident)
        checks = feature.get('checks')
        if not isinstance(checks, list) or not 1 <= len(checks) <= 16:
            raise ValueError('Every feature needs 1–16 executable checks')
        normalized = []
        for check in checks:
            if not isinstance(check, dict) or set(check)-{'argv', 'root', 'image', 'setup', 'network', 'timeout_seconds', 'output_contains'}:
                raise ValueError('Unknown acceptance check field')
            root = check.get('root', '.')
            if not isinstance(root, str) or len(root) > 512 or '\\' in root or ':' in root or '\0' in root:
                raise ValueError('Check root must be a relative repository directory')
            path = PurePosixPath(root)
            if not root or path.is_absolute() or '..' in path.parts or '.git' in path.parts:
                raise ValueError('Check root escapes the repository')
            setup = check.get('setup', [])
            if not isinstance(setup, list) or len(setup) > 8:
                raise ValueError('Check setup must contain at most eight argv commands')
            network = check.get('network', False)
            timeout = check.get('timeout_seconds', 120)
            if type(network) is not bool or type(timeout) is not int or not 1 <= timeout <= 300:
                raise ValueError('Invalid network capability or check timeout')
            outputs = check.get('output_contains', [])
            if not isinstance(outputs, list) or len(outputs) > 16:
                raise ValueError('Output assertions must be a bounded text array')
            normalized.append({'root': path.as_posix(), 'argv': argv(check.get('argv'), 'Check'),
                'image': text(check.get('image', 'python:3.12-slim'), 'Toolchain image', 256),
                'setup': [argv(command, 'Setup') for command in setup], 'network': network,
                'timeout_seconds': timeout, 'output_contains': [text(item, 'Expected output') for item in outputs]})
        count += len(normalized)
        result['features'].append({'id': ident, 'description': text(feature.get('description'), 'Feature description'), 'checks': normalized})
    if count > 48 or len(json.dumps(result).encode()) > 128*1024:
        raise ValueError('Completion contract exceeds the check or byte budget')
    return result


def digest(contract):
    return hashlib.sha256(json.dumps(contract, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def commands(contract):
    return [{**check, 'feature_id': feature['id'], 'check_id': feature['id']+':'+str(index)}
            for feature in contract['features'] for index, check in enumerate(feature['checks'])]


def check_passed(command, result):
    return (result.get('status') == 'completed' and result.get('exit_code') == 0
            and not result.get('error') and not result.get('timed_out')
            and all(value in result.get('output', '') for value in command.get('output_contains', [])))


def feature_results(contract, evidence, current=True):
    observed = {item['command'].get('check_id'): item for item in evidence if item['command'].get('check_id')}
    result = []
    for feature in contract['features']:
        expected = [feature['id']+':'+str(index) for index in range(len(feature['checks']))]
        checks = [observed.get(ident) for ident in expected]
        passed = current and all(item and item.get('check_passed') is True for item in checks)
        failed = current and any(item and item.get('check_passed') is False for item in checks)
        result.append({'id': feature['id'], 'description': feature['description'],
                       'status': 'passed' if passed else 'failed' if failed else 'unverified',
                       'checks_passed': sum(bool(item and item.get('check_passed')) for item in checks) if current else 0,
                       'checks_total': len(expected)})
    return result
