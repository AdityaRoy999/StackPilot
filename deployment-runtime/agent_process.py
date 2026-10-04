"""Run a command in a disposable, resource-limited local Docker worker.

Only the source snapshot is copied into the guest. No host bind mount, control
plane environment, socket, Git credentials or application secrets are supplied.
This development adapter is not a hostile-tenant VM isolation claim.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid
import threading
import time
import urllib.request

SKIP = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.gradle', '.next', '.stackpilot-runtime'}
from sandbox_capabilities import DEFAULT_IMAGES, select


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
    image = spec.get('image') or 'python:3.12-slim'
    placement = select(spec.get('capabilities', []), image, purpose='command',owned_run=spec.get('run_id'))
    if placement['status'] != 'ready':
        return {**placement, 'status': 'blocked', 'error': 'Required sandbox capability is unavailable', 'changes': []}
    network = bool(spec.get('network'))
    if network and os.getenv('STACKPILOT_AGENT_WORKER_NETWORK', 'false').lower() != 'true':
        raise ValueError('Worker network capability is unavailable; request it explicitly')
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
        created = False
        try:
            if not lease_valid(spec):
                raise PermissionError('Task execution lease revoked before worker creation')
            creation = ['docker','create','--name',container,'--network','bridge' if network else 'none',
                '--memory',os.getenv('STACKPILOT_AGENT_WORKER_MEMORY','512m'),'--cpus','1','--pids-limit','128',
                '--cap-drop','ALL','--security-opt','no-new-privileges','--workdir','/workspace',
                '--label','stackpilot.agent-task='+str(spec['task_id']), '--entrypoint', argv[0], image, *argv[1:]]
            created = True
            subprocess.run(creation, check=True, capture_output=True, timeout=120)
            subprocess.run(['docker','cp',str(input_root)+'/.',container+':/workspace'], check=True, capture_output=True, timeout=60)
            timed_out = False
            process = subprocess.Popen(['docker','start','-a',container], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            captured = bytearray()
            def drain():
                with process.stdout:
                    while block := process.stdout.read(4096):
                        remaining = 65536-len(captured)
                        if remaining > 0:
                            captured.extend(block[:remaining])
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
                'image_id':image_id,'argv':argv,'changes':changes,'verified':False,'scope':'command_execution'}
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
