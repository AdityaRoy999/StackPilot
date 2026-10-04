"""A repaired source cannot grade itself by deleting original regression inputs."""
import hashlib
import json
from pathlib import Path

LISTS = ('tests', 'checks', 'browser_checks', 'scenarios', 'monitor_scenarios', 'native_scenarios', 'console_scenarios')
FLAGS = ('tests_required', 'fail_on_console_error', 'native_preview_required')


def capture(root):
    from .workspace import source_files
    root = Path(root)
    files = {}
    manifest_tests = {}
    for relative in source_files(root):
        path = Path(relative)
        if any(part.lower() in {'tests', 'test', '__tests__'} for part in path.parts[:-1]) or path.name.startswith('test_') or '.test.' in path.name or '.spec.' in path.name or path.name == 'stackpilot.completion.json':
            files[relative] = hashlib.sha256((root/relative).read_bytes()).hexdigest()
        if path.name=='package.json':
            package=json.loads((root/relative).read_text())
            if package.get('scripts',{}).get('test'):manifest_tests[relative]=package['scripts']['test']
    config = json.loads((root/'stackpilot.json').read_text()) if (root/'stackpilot.json').is_file() else {}
    return {'version': 1, 'files': files, 'contract': config,'manifest_tests':manifest_tests}


def validate(root, baseline):
    root = Path(root)
    for relative, expected in baseline['files'].items():
        path = root/relative
        if not path.is_file() or path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('Original regression input changed: '+relative+'. Repair the implementation or explicitly revise project acceptance outside this agent run.')
    current = json.loads((root/'stackpilot.json').read_text()) if (root/'stackpilot.json').is_file() else {}
    for relative,command in baseline.get('manifest_tests',{}).items():
        target=root/relative
        if not target.is_file() or target.is_symlink() or json.loads(target.read_text()).get('scripts',{}).get('test')!=command:
            raise ValueError('Original package test script was changed: '+relative)
    def check(before, after, label):
        for key in LISTS:
            if any(value not in after.get(key, []) for value in before.get(key, [])):
                raise ValueError('Original acceptance was weakened: '+label+key)
        for key in FLAGS:
            if before.get(key) is True and after.get(key) is not True:
                raise ValueError('Original acceptance flag was disabled: '+label+key)
        for component in before.get('components', []):
            matches = [item for item in after.get('components', []) if isinstance(item, dict) and item.get('id') == component.get('id')]
            if not matches:
                raise ValueError('Original component acceptance was removed: '+str(component.get('id')))
            check(component, matches[0], label+str(component.get('id'))+'.')
    check(baseline['contract'], current, '')
