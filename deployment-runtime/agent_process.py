"""Run a command in a disposable, resource-limited local Docker worker.

Only the source snapshot is copied into the guest. No host bind mount, control
plane environment, socket, Git credentials or application secrets are supplied.
This development adapter is not a hostile-tenant VM isolation claim.
"""
import base64
import hashlib
import json
import os
import shlex
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid
import threading
import time
import urllib.request

SKIP = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.gradle', '.next', '.stackpilot-runtime', '.pytest_cache', '.mypy_cache', '.ruff_cache'}
from sandbox_capabilities import DEFAULT_IMAGES, select


def capture_output(captured, block):
    """Keep the beginning and failure tail of verbose package/build output."""
    captured.extend(block)
    if len(captured) > 65000:
        del captured[8192:len(captured)-56808]
        return True
    return False


def inventory(root):
    result, size = {}, 0
    for current, directories, files in os.walk(root, followlinks=False):
        if any((Path(current)/directory).is_symlink() for directory in directories if directory not in SKIP):
            raise ValueError('Worker returned a source directory symlink')
        directories[:] = [directory for directory in directories if directory not in SKIP]
        for name in files:
            path = Path(current)/name
            if path.is_symlink() or not path.is_file():
                raise ValueError('Worker source contains a special file')
            size += path.stat().st_size
            if len(result) >= 20000 or size > 256*1024*1024:
                raise ValueError('Worker source exceeds return budget')
            result[path.relative_to(root).as_posix()] = {'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                'executable':bool(path.stat().st_mode & 0o111)}
    return result


def allowed(path, scopes):
    return any(scope == '**' or path == scope or (scope.endswith('/**') and path.startswith(scope[:-2])) for scope in scopes)


def lease_valid(spec):
    payload = {key:spec[key] for key in ('run_id','task_id','user_id','lease_owner','attempt')}
    request = urllib.request.Request(os.getenv('STACKPILOT_AI_SERVICE_URL','http://ai-service:8010').rstrip('/')+'/agent/tasks/lease',
        data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-StackPilot-Service-Token':os.getenv('STACKPILOT_AI_SERVICE_TOKEN','')})
    try:
        with urllib.request.urlopen(request,timeout=3) as response:
            return json.load(response).get('authorized') is True
    except Exception:
        return False


def execute(source, spec):
    argv = spec.get('argv')
    if not isinstance(argv, list) or not 1 <= len(argv) <= 100 or not argv[0] or any(not isinstance(arg, str) or '\0' in arg or len(arg) > 12000 for arg in argv):
        raise ValueError('argv must be a bounded nonempty string array')
    root = spec.get('root', '.')
    if not isinstance(root, str) or '\\' in root or Path(root).is_absolute() or '..' in Path(root).parts:
        raise ValueError('Command root must be a repository-relative directory')
    directory = (Path(source)/root).resolve()
    if not directory.is_relative_to(Path(source).resolve()) or not directory.is_dir():
        raise ValueError('Command root must remain inside the source snapshot')
    setup = spec.get('setup', [])
    if not isinstance(setup, list) or len(setup) > 32 or any(not isinstance(command, list) or not 1 <= len(command) <= 100 or not command[0] or any(not isinstance(arg, str) or '\0' in arg or len(arg) > 12000 for arg in command) for command in setup):
        raise ValueError('Setup must be bounded argv arrays')
    if argv[0] in {'cd', 'export', 'source'} or any(arg in {'&&', '||', ';', '|', '>'} for arg in argv[1:]):
        raise ValueError('argv does not interpret shell operators. Use root for cwd and setup for dependency commands, or explicitly invoke ["sh", "-lc", "..."]')
    image = spec.get('image') or 'python:3.12-slim'
    placement = select(spec.get('capabilities', []), image, purpose='command',owned_run=spec.get('run_id'))
    if placement['status'] != 'ready':
        return {**placement, 'status': 'blocked', 'error': 'Required sandbox capability is unavailable', 'changes': []}
    network = bool(spec.get('network'))
    if network and os.getenv('STACKPILOT_AGENT_WORKER_NETWORK', 'false').lower() != 'true':
        raise ValueError('Worker network capability is unavailable; request it explicitly')
    if setup and not network:
        # A profile can deliberately use an offline SDK; do not override that
        # choice. Give a useful error for commands that require package servers.
        installs = any(not any(a in {'--no-index','--offline'} for a in c) and ((c[0] in {'pip', 'pip3', 'npm', 'pnpm', 'yarn', 'apt', 'apt-get'} and any(a in {'install', 'ci', 'update'} for a in c[1:])) or (c[:3] in (['python', '-m', 'pip'], ['python3', '-m', 'pip']) and 'install' in c[3:])) for c in setup)
        if installs:
            raise ValueError('Dependency setup needs network=true and admitted worker network; offline installs need an explicit prebuilt SDK')
    guest_argv = argv
    if setup:
        # Quote every argument; model strings are data, never interpolated shell
        # syntax. Setup failure stops before the requested check can claim success.
        script = 'set -e\n'+'\n'.join(shlex.join(command) for command in setup)+'\nexec '+shlex.join(argv)
        guest_argv = ['sh', '-c', script]
    timeout = max(1, min(300, int(spec.get('timeout_seconds', 120))))
    container = 'stackpilot-agent-'+uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix='stackpilot-agent-') as temporary:
        input_root, output_root = Path(temporary)/'input', Path(temporary)/'output'
        shutil.copytree(source, input_root, symlinks=True)
        before = inventory(input_root)
        for current, directories, _ in os.walk(input_root, topdown=True):
            for name in list(directories):
                if name in SKIP:
                    shutil.rmtree(Path(current)/name)
                    directories.remove(name)
        # docker cp can retain source UID/mode from the unprivileged broker.
        # A cap-drop worker cannot override those permissions, even as UID 0.
        # Normalize only this disposable copy so admitted image users can build
        # and edit it; returned edits still pass scope and revision checks.
        for current, _, files in os.walk(input_root):
            Path(current).chmod(0o777)
            for name in files:
                path = Path(current)/name
                path.chmod(0o666 | (path.stat().st_mode & 0o111))
        created = False
        try:
            if not lease_valid(spec):
                raise PermissionError('Task execution lease revoked before worker creation')
            creation = ['docker','create','--name',container,'--network','bridge' if network else 'none',
                '--memory',os.getenv('STACKPILOT_AGENT_WORKER_MEMORY','1g'),'--cpus','1','--pids-limit','128',
                '--cap-drop','ALL','--security-opt','no-new-privileges','--workdir','/workspace'+('/'+root if root != '.' else ''),
                '--label','stackpilot.agent-task='+str(spec['task_id']), '--entrypoint', guest_argv[0], image, *guest_argv[1:]]
            created = True
            subprocess.run(creation, check=True, capture_output=True, timeout=120)
            subprocess.run(['docker','cp',str(input_root)+'/.',container+':/workspace'], check=True, capture_output=True, timeout=60)
            timed_out = False
            process = subprocess.Popen(['docker','start','-a',container], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            captured = bytearray()
            truncated = False
            def drain():
                nonlocal truncated
                with process.stdout:
                    while block := process.stdout.read(4096):
                        truncated = capture_output(captured, block) or truncated
            reader = threading.Thread(target=drain,daemon=True)
            reader.start()
            started, checked, revoked = time.monotonic(), 0, False
            while process.poll() is None:
                now = time.monotonic()
                if now-checked >= 2:
                    checked = now
                    revoked = not lease_valid(spec)
                if revoked or now-started > timeout:
                    timed_out = not revoked
                    subprocess.run(['docker','kill',container], capture_output=True, timeout=15)
                    try: process.wait(timeout=15)
                    except subprocess.TimeoutExpired: process.kill();process.wait(timeout=5)
                    break
                time.sleep(.2)
            reader.join(timeout=5)
            output = captured.decode(errors='replace')
            if truncated:
                output = captured[:8192].decode(errors='replace')+'\n[intermediate output truncated]\n'+captured[8192:].decode(errors='replace')
            if revoked or not lease_valid(spec):
                raise PermissionError('Task execution lease revoked; worker output cannot mutate source')
            status = json.loads(subprocess.run(['docker','inspect','--format','{{json .State}}',container], check=True, capture_output=True, timeout=15).stdout)
            image_id = subprocess.run(['docker','inspect','--format','{{.Image}}',container], check=True, capture_output=True, timeout=15).stdout.decode().strip()
            output_root.mkdir()
            subprocess.run(['docker','cp',container+':/workspace/.',str(output_root)], check=True, capture_output=True, timeout=60)
            after = inventory(output_root)
            changes = []
            returned_bytes = 0
            scopes = spec.get('write_scope') or []
            for path in sorted(set(before) | set(after)):
                if before.get(path) == after.get(path):
                    continue
                if not allowed(path, scopes):
                    if path in before:
                        raise PermissionError('Command changed source outside its task scope: '+path)
                    continue  # Test/build output is not silently imported as source.
                target = output_root/path
                if target.exists() and target.stat().st_size > 1024*1024:
                    raise ValueError('Returned source patch file exceeds 1 MiB')
                returned_bytes += target.stat().st_size if target.exists() else 0
                if returned_bytes > 8*1024*1024:
                    raise ValueError('Returned source patch exceeds 8 MiB')
                changes.append({'path':path,'before':before.get(path,{}).get('sha256'),'after':after.get(path,{}).get('sha256'),
                    'before_executable':before.get(path,{}).get('executable',False),
                    'content_base64':base64.b64encode(target.read_bytes()).decode() if target.exists() else None,
                    'executable': bool(target.stat().st_mode & 0o111) if target.exists() else False})
            if len(changes) > 200:
                raise ValueError('Worker patch exceeds 200 files')
            return {'status':'failed' if timed_out or status['ExitCode'] else 'completed',
                'exit_code':124 if timed_out else status['ExitCode'], 'output':output, 'timed_out':timed_out,
                'image_id':image_id,'argv':argv,'root':root,'setup':setup,'network':network,
                'changes':changes,'verified':False,'scope':'command_execution'}
        finally:
            if created:
                subprocess.run(['docker','rm','-f',container], capture_output=True, timeout=20)


if __name__ == '__main__':
    source, request_path, result_path = sys.argv[1:4]
    try:
        result = execute(Path(source), json.loads(Path(request_path).read_text()))
    except Exception as error:
        result = {'status':'failed','error':str(error),'verified':False,'changes':[]}
    Path(result_path).write_text(json.dumps(result))
