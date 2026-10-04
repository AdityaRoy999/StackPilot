"""Validate the resolved Compose model before host-daemon execution."""
import argparse
import json
import math
import re
from pathlib import Path


def contained(root, value):
    path = (root/value).resolve()
    if not path.is_relative_to(root):
        raise ValueError('Build/mount path escapes the submitted repository')
    return path


def sanitize(model, root):
    root = Path(root).resolve()
    if not isinstance(model.get('services'), dict) or not model['services']:
        raise ValueError('Compose has no services')
    for name, service in model['services'].items():
        if service.get('privileged') or service.get('devices') or service.get('device_cgroup_rules'):
            raise ValueError(f'{name}: privileged/device access requires a dedicated capability worker')
        if service.get('network_mode') in {'host'} or service.get('pid') == 'host' or service.get('ipc') == 'host':
            raise ValueError(f'{name}: host namespaces are forbidden')
        if service.get('network_mode','').startswith(('container:', 'service:')):
            raise ValueError(f'{name}: shared network namespaces require an explicit worker policy')
        if service.get('cap_add') or service.get('security_opt') or service.get('sysctls') or service.get('cgroup_parent'):
            raise ValueError(f'{name}: custom host security settings are forbidden')
        service.pop('container_name', None)
        service['cap_drop'] = ['ALL']
        # NET_BIND_SERVICE is needed by common unprivileged HTTP images.
        service['cap_add'] = ['NET_BIND_SERVICE', 'CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE']
        service['security_opt'] = ['no-new-privileges:true']
        memory = str(service.get('mem_limit', '2g')).lower()
        match = re.fullmatch(r'(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?', memory)
        if not match:
            raise ValueError(f'{name}: invalid memory limit')
        memory_bytes = float(match[1]) * 1024 ** ('kmgt'.index(match[2])+1 if match[2] else 0)
        service['mem_limit'] = int(min(max(memory_bytes, 16*1024**2), 2*1024**3))
        cpus = float(service.get('cpus', 2))
        if not math.isfinite(cpus) or cpus <= 0:
            raise ValueError(f'{name}: CPU quota must be finite and positive')
        service['cpus'] = min(cpus, 4)
        pids = int(service.get('pids_limit', 256))
        if pids <= 0:
            raise ValueError(f'{name}: unlimited PID allocation is forbidden')
        service['pids_limit'] = min(pids, 512)
        # Do not silently discard replicas, placement or Swarm semantics.
        if service.get('deploy'):
            raise ValueError(f'{name}: deploy policies require a supported orchestrator; shared Compose admission refused')
        for key in ('env_file',):
            for entry in service.get(key, []):
                contained(root, entry.get('path','') if isinstance(entry,dict) else entry)
        for mount in service.get('volumes', []):
            if not isinstance(mount, dict):
                raise ValueError('Compose must be resolved to JSON before policy validation')
            if mount.get('type') == 'bind':
                source = contained(root, mount.get('source',''))
                if 'docker.sock' in str(source) or not mount.get('read_only'):
                    raise ValueError(f'{name}: bind mounts must stay inside the source root and be read-only')
            elif mount.get('type') not in {'volume','tmpfs'}:
                raise ValueError(f'{name}: unsupported volume type')
        build = service.get('build')
        if build:
            # Compose generates a project-scoped image name. Never overwrite a
            # serving candidate's image tag supplied by repository configuration.
            service.pop('image',None)
            context = contained(root, build['context'] if isinstance(build,dict) else build)
            if isinstance(build,dict):
                if build.get('privileged') or build.get('network') == 'host' or build.get('entitlements'):
                    raise ValueError(f'{name}: unsafe build entitlements')
                for extra in build.get('additional_contexts', {}).values():
                    contained(root, extra)
        for port in service.get('ports', []):
            if not isinstance(port,dict):
                raise ValueError('Unresolved port mapping')
            port['host_ip'] = '127.0.0.1'
            port['published'] = '0'
    for kind in ('volumes','networks'):
        for entry in model.get(kind, {}).values():
            if entry and (entry.get('external') or entry.get('driver_opts') or entry.get('driver') not in {None, 'local' if kind=='volumes' else 'bridge'}):
                raise ValueError('External resources and custom host drivers require a dedicated worker')
            if entry:
                entry.pop('name', None)
    for kind in ('configs', 'secrets'):
        for entry in model.get(kind, {}).values():
            if entry.get('external') or entry.get('environment'):
                raise ValueError('External config/secret resources require a dedicated worker')
            if entry.get('file'):
                contained(root, entry['file'])
    return model


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('model', type=Path)
    parser.add_argument('root', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    value = sanitize(json.loads(args.model.read_text()), args.root)
    args.output.write_text(json.dumps(value, indent=2))
    args.output.chmod(0o600)
