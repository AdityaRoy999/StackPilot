"""Configured Linux sandbox admission for local Docker provisioning.

Admission is not proof that an image exists or that application tests pass.
No cloud resources are provisioned here. Arbitrary repository images do not
gain access to the control-plane socket, environment or credentials.
"""
import json
import os
import platform
import re
import subprocess
import sys

DEFAULT_IMAGES = 'python:3.12-slim,node:22-bookworm-slim,eclipse-temurin:21-jdk,golang:1.24-bookworm,gcc:14-bookworm,ubuntu:24.04,debian:bookworm-slim,alpine:3.21'
DEFAULT_FAMILIES = 'python,node,golang,rust,eclipse-temurin,mcr.microsoft.com/dotnet/sdk,ruby,php,gcc,ubuntu,debian,alpine'
FAMILIES = {
    'python': 'python', 'node': 'node', 'golang': 'go', 'rust': 'rust',
    'eclipse-temurin': 'java', 'mcr.microsoft.com/dotnet/sdk': 'dotnet',
    'ruby': 'ruby', 'php': 'php', 'gcc': 'cmake',
}
DISTRIBUTIONS = {
    'ubuntu': {'default_image': 'ubuntu:24.04', 'package_manager': 'apt'},
    'debian': {'default_image': 'debian:bookworm-slim', 'package_manager': 'apt'},
    'alpine': {'default_image': 'alpine:3.21', 'package_manager': 'apk'},
}
_VERSIONED_TAG = r'\d+(?:\.\d+){0,3}(?:-[a-zA-Z0-9][a-zA-Z0-9.-]{0,64})?'


def _list(name, default=''):
    return [item.strip() for item in os.getenv(name, default).split(',') if item.strip()]


def _bounded_environment(name, default, minimum, maximum):
    try:
        value = float(os.getenv(name, str(default)))
        return max(minimum, min(maximum, value)) if value == value else default
    except (ValueError, TypeError):
        return default


def _architecture(value):
    value = str(value or '').lower()
    return {'x86_64': 'amd64', 'x64': 'amd64', 'aarch64': 'arm64'}.get(value, value)


def image_distribution(image):
    """Describe a known base, without executing it or inventing SDK provenance."""
    if not isinstance(image, str):
        return None
    family, separator, tag = image.split('@', 1)[0].rpartition(':')
    if not separator:
        return None
    if family in DISTRIBUTIONS:
        return family
    if family not in FAMILIES:
        return None
    # Plain SDK tags can change their underlying distribution. Only explicit
    # distro variants are useful evidence for userspace-specific admission.
    if re.search(r'-(bookworm|bullseye|trixie)(?:-|$)', tag):
        return 'debian'
    if re.search(r'-alpine(?:\d+(?:\.\d+)*)?(?:-|$)', tag):
        return 'alpine'
    if re.search(r'-(focal|jammy|noble)(?:-|$)', tag):
        return 'ubuntu'
    return None


def _required(value):
    if not isinstance(value, list) or len(value) > 32 or any(
            not isinstance(item, str) or not re.fullmatch(r'[a-z][a-z0-9_.-]{0,80}', item) for item in value):
        raise ValueError('Sandbox capabilities must be bounded identifiers')
    return sorted(set(value))


def image_admitted(image):
    if not isinstance(image, str) or not 1 <= len(image) <= 256 or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._/@:+-]*', image):
        raise ValueError('Invalid toolchain image reference')
    # Explicit operator registration permits private/custom/digest-pinned SDKs.
    if image in _list('STACKPILOT_AGENT_WORKER_IMAGES', DEFAULT_IMAGES):
        return True
    family, separator, tag = image.rpartition(':')
    # Families are operator-controlled; only versioned official SDK references
    # are enabled by default. No latest or arbitrary repository registry.
    registered_family = family in (FAMILIES.keys() | DISTRIBUTIONS.keys()) and family in _list('STACKPILOT_AGENT_WORKER_FAMILIES', DEFAULT_FAMILIES)
    stable_debian_tag = family == 'debian' and re.fullmatch(r'(?:bookworm|bullseye|trixie)(?:-slim)?', tag)
    return bool(separator and registered_family and (re.fullmatch(_VERSIONED_TAG, tag) or stable_debian_tag))


def owned_sdk(image, run_id):
    if not isinstance(image,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',image): return False
    if not isinstance(run_id,str) or not re.fullmatch(r'[a-f0-9-]{36}',run_id): return False
    try:
        observed=json.loads(subprocess.run(['docker','image','inspect',image],capture_output=True,
                           text=True,timeout=10,check=True).stdout)[0]
        labels=observed.get('Config',{}).get('Labels') or {}
        return (observed.get('Id')==image and labels.get('stackpilot.agent-run')==run_id and
                labels.get('stackpilot.agent-sdk')=='true' and bool(labels.get('stackpilot.agent-task')))
    except (OSError,ValueError,IndexError,TypeError,AttributeError,subprocess.SubprocessError): return False


def registry(*, probe=False, purpose='deployment'):
    if purpose not in {'deployment', 'command'}:
        raise ValueError('Unknown sandbox purpose')
    architecture = _architecture(os.getenv('STACKPILOT_DOCKER_ARCHITECTURE', platform.machine()))
    enabled = purpose != 'command' or os.getenv('STACKPILOT_AGENT_LOCAL_WORKERS', 'false').lower() == 'true'
    observation = {'state': 'not_probed'}
    if probe and enabled:
        try:
            answer = subprocess.run(['docker', 'info', '--format', '{{json .}}'], capture_output=True, text=True, timeout=8, check=True)
            info = json.loads(answer.stdout)
            architecture = _architecture(info.get('Architecture'))
            if not re.fullmatch(r'[a-z][a-z0-9_]{0,31}', architecture):
                raise ValueError('Docker daemon did not report a usable architecture')
            enabled = info.get('OSType') == 'linux'
            observation = {'state': 'observed', 'os': info.get('OSType'), 'architecture': architecture,
                           'cpu_count': info.get('NCPU'), 'memory_bytes': info.get('MemTotal')}
        except (OSError, ValueError, TypeError, AttributeError, subprocess.SubprocessError):
            enabled = False
            observation = {'state': 'unreachable'}
    families = [item for item in _list('STACKPILOT_AGENT_WORKER_FAMILIES', DEFAULT_FAMILIES) if item in FAMILIES or item in DISTRIBUTIONS]
    capabilities = {'linux', 'docker', 'oci', 'process', 'arch.'+architecture, 'linux.'+architecture}
    capabilities.update('toolchain.'+FAMILIES[item] for item in families if item in FAMILIES)
    # Configuration cannot manufacture hardware, a different kernel/CPU, or
    # distribution provenance. Those need a matching executor/image observation.
    extra = _required(_list('STACKPILOT_DOCKER_CAPABILITIES'))
    capabilities.update(item for item in extra if item not in {'windows', 'macos', 'darwin', 'ios', 'gpu', 'network'}
                        and not item.startswith(('arch.', 'linux.', 'distro.', 'gpu.', 'windows.', 'macos.', 'darwin.', 'ios.')))
    network = os.getenv('STACKPILOT_AGENT_WORKER_NETWORK', 'false').lower() == 'true'
    if network or purpose == 'deployment': capabilities.add('network')
    provisioning_enabled = enabled and os.getenv('STACKPILOT_AGENT_DOCKER_PROVISIONING', 'true').lower() == 'true'
    profiles = [{'id': name, 'os': 'linux', 'scope': 'userspace', **profile,
                 'capabilities': ['distro.'+name], 'enabled': image_admitted(profile['default_image'])}
                for name, profile in DISTRIBUTIONS.items()]
    maximum_memory = int(_bounded_environment('STACKPILOT_AGENT_INSTANCE_MAX_MEMORY_MB', 4096, 1, 65536))
    maximum_cpus = int(_bounded_environment('STACKPILOT_AGENT_INSTANCE_MAX_CPUS', 8, 1, 128))
    maximum_pids = int(_bounded_environment('STACKPILOT_AGENT_INSTANCE_PIDS_LIMIT', 128, 1, 2048))
    return {'version': 2, 'executors': [{
        'id': 'local-docker', 'type': 'docker', 'os': 'linux', 'architecture': architecture,
        'enabled': enabled, 'capabilities': sorted(capabilities), 'observation': observation,
        'images': _list('STACKPILOT_AGENT_WORKER_IMAGES', DEFAULT_IMAGES), 'versioned_image_families': families,
        'distribution_profiles': profiles,
        'limits': {'memory': os.getenv('STACKPILOT_AGENT_WORKER_MEMORY', '512m'), 'command_timeout_seconds': 300,
                   'instance_memory_mb': int(_bounded_environment('STACKPILOT_AGENT_INSTANCE_MEMORY_MB', min(512, maximum_memory), 1, maximum_memory)),
                   'instance_max_memory_mb': maximum_memory,
                   'instance_cpus': int(_bounded_environment('STACKPILOT_AGENT_INSTANCE_CPUS', 1, 1, maximum_cpus)),
                   'instance_max_cpus': maximum_cpus,
                   'instance_pids_limit': min(128, maximum_pids),
                   'instance_max_pids_limit': maximum_pids,
                   'instance_max_ttl_seconds': int(_bounded_environment('STACKPILOT_AGENT_INSTANCE_MAX_TTL_SECONDS', 3600, 1, 86400)),
                   'instance_total_memory_mb': int(_bounded_environment('STACKPILOT_AGENT_INSTANCE_TOTAL_MEMORY_MB', 4096, 1, 65536)),
                   'instance_total_cpus': int(_bounded_environment('STACKPILOT_AGENT_INSTANCE_TOTAL_CPUS', 4, 1, 128)),
                   'instance_max_total': int(_bounded_environment('STACKPILOT_AGENT_INSTANCE_MAX_TOTAL', 8, 1, 128)),
                   'instance_max_per_run': int(_bounded_environment('STACKPILOT_AGENT_INSTANCE_MAX_PER_RUN', 3, 1, 32))},
    }], 'provisioning': {'implemented': provisioning_enabled, 'backend': 'docker', 'type': 'container',
                       'enabled': provisioning_enabled,
                       'description': 'Provision bounded, run-owned Linux userspace instances with Docker.',
                       'cloud': {'implemented': False, 'backend': 'deferred'}}}


def select(required=None, image=None, *, purpose='deployment', probe=False, owned_run=None):
    required = _required(required or [])
    data = registry(probe=probe, purpose=purpose)
    executor = data['executors'][0]
    requested_distributions = [item[7:] for item in required if item.startswith('distro.')]
    if image is None and len(requested_distributions) == 1 and requested_distributions[0] in DISTRIBUTIONS:
        image = DISTRIBUTIONS[requested_distributions[0]]['default_image']
    capabilities = set(executor['capabilities'])
    distribution = image_distribution(image)
    if distribution is not None:
        capabilities.add('distro.'+distribution)
    missing = sorted(set(required)-capabilities)
    if not executor['enabled']: missing.append('executor.local-docker')
    admitted = image is None or image_admitted(image) or (owned_run is not None and owned_sdk(image,owned_run))
    requirements = [{'kind': 'capability', 'description': 'A registered Linux sandbox must supply '+item} for item in missing]
    if not admitted:
        missing.append('toolchain.image')
        requirements.append({'kind': 'toolchain', 'description': 'Register the required image or versioned SDK family: '+image})
    return {'status': 'unavailable' if missing else 'ready', 'verified': False,
            'executor_id': executor['id'], 'executor_type': executor['type'], 'image': image,
            'capabilities': sorted(capabilities), 'distribution': distribution,
            'missing': missing, 'requirements': requirements,
            'registry': data, 'scope': 'sandbox_admission',
            'provisioning': {**data['provisioning'],
                             'implemented': bool(data['provisioning']['implemented'] and not missing),
                             'fulfillable': not bool(missing),
                             'requested_capabilities': missing, 'requested_image': image}}


if __name__ == '__main__':
    request = json.loads(open(sys.argv[1], encoding='utf-8').read()) if len(sys.argv) > 1 else {}
    result = select(request.get('capabilities', []), request.get('image'), purpose='command', probe=True,owned_run=request.get('run_id'))
    if len(sys.argv) > 2:
        with open(sys.argv[2], 'w', encoding='utf-8') as output: json.dump(result, output)
    else: print(json.dumps(result))
