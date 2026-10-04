"""Durable task-owned Linux Docker workspaces, not virtual machines.

The trusted broker supplies and checks task identities. Only bounded source is
copied into guests; host mounts, Docker sockets and control-plane credentials
are never supplied. SQLite reservations and operation tokens fence concurrent
helpers. An interrupted execution is stopped and quarantined, never replayed.
"""
import base64
from contextlib import closing
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid

from agent_process import SKIP, allowed, inventory, lease_valid
from agent_image import stage
from sandbox_capabilities import select


IDENTITY = ('run_id', 'user_id', 'task_id', 'lease_owner', 'attempt')
ACTIVE = ('provisioning', 'ready', 'executing', 'uncertain', 'releasing', 'failed')
IMAGE_ID = re.compile(r'sha256:[0-9a-f]{64}')
CONTAINER_ID = re.compile(r'[0-9a-f]{64}')
SOURCE_ARCHIVE_BUDGET = 272*1024*1024


def canonical(value, field):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('Instance requires a canonical '+field)
    return value


def identity(spec):
    if not isinstance(spec, dict): raise ValueError('Instance request must be an object')
    for key in ('run_id', 'user_id'): canonical(spec.get(key), key)
    for key in ('task_id', 'lease_owner'):
        if not isinstance(spec.get(key), str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', spec[key]):
            raise ValueError('Instance requires a bounded '+key)
    if type(spec.get('attempt')) is not int or not 1 <= spec['attempt'] <= 10000:
        raise ValueError('Instance requires a live task attempt')
    return {key: spec[key] for key in IDENTITY}


def ceiling(name, default, maximum):
    value = int(os.getenv('STACKPILOT_AGENT_INSTANCE_'+name, str(default)))
    if not 1 <= value <= maximum: raise ValueError('Invalid operator instance limit: '+name)
    return value


def bounded(spec, key, default, maximum):
    value = spec.get(key, min(default, maximum))
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError(key+' exceeds operator instance limit')
    return value


def options(spec):
    identity(spec)
    network = spec.get('network', False)
    if type(network) is not bool: raise ValueError('Instance network must be a boolean')
    if network and os.getenv('STACKPILOT_AGENT_WORKER_NETWORK', 'false').lower() != 'true':
        raise ValueError('Worker network capability is unavailable; request it explicitly')
    maximum_memory = ceiling('MAX_MEMORY_MB', 4096, 65536)
    maximum_cpus = ceiling('MAX_CPUS', 8, 128)
    return {'ttl_seconds': bounded(spec, 'ttl_seconds', 3600, ceiling('MAX_TTL_SECONDS', 3600, 86400)),
            'memory_mb': bounded(spec, 'memory_mb', ceiling('MEMORY_MB', min(512, maximum_memory), maximum_memory), maximum_memory),
            'cpus': bounded(spec, 'cpus', ceiling('CPUS', 1, maximum_cpus), maximum_cpus),
            'pids_limit': bounded(spec, 'pids_limit', 128, ceiling('PIDS_LIMIT', 128, 2048)),
            'network': network}


def root_directory():
    root = Path(os.getenv('STACKPILOT_AGENT_INSTANCE_ROOT', 'uploads/agent-instances'))
    if root.is_symlink(): raise ValueError('Instance registry cannot be a symlink')
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def database():
    root = root_directory()
    deadline = time.monotonic()+15
    while True:
        connection = sqlite3.connect(str(root/'instances.sqlite3'), timeout=15, isolation_level=None)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute('PRAGMA busy_timeout=15000')
            if connection.execute('PRAGMA journal_mode').fetchone()[0] != 'wal':
                connection.execute('PRAGMA journal_mode=WAL')
            connection.execute('''CREATE TABLE IF NOT EXISTS instances (
                sandbox_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, user_id TEXT NOT NULL,
                state TEXT NOT NULL, expires_at REAL NOT NULL, operation_pid INTEGER,
                operation_stamp TEXT, operation_token TEXT, record TEXT NOT NULL)''')
            connection.execute('CREATE INDEX IF NOT EXISTS instance_run ON instances(run_id,state)')
            return connection
        except sqlite3.OperationalError as error:
            connection.close()
            if 'locked' not in str(error) or time.monotonic() >= deadline: raise
            time.sleep(.05)
        except Exception: connection.close(); raise


def process_stamp(pid):
    try:
        # Linux /proc starttime also prevents a reused PID from holding a lock.
        text = Path('/proc/'+str(pid)+'/stat').read_text()
        return text[text.rfind(')')+2:].split()[19]
    except OSError:
        return None


def helper_alive(row):
    pid = row.get('operation_pid')
    if not pid: return False
    observed = process_stamp(pid)
    if row.get('operation_stamp') and observed != row['operation_stamp']: return False
    if os.name == 'nt':
        import ctypes
        kernel = ctypes.windll.kernel32
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle: return False
        code = ctypes.c_ulong()
        try: return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally: kernel.CloseHandle(handle)
    try: os.kill(pid, 0); return True
    except (ProcessLookupError, PermissionError): return False


def decode(row):
    if row is None: raise ValueError('Unknown sandbox_id')
    record = json.loads(row['record'])
    return {**record, **{key: row[key] for key in ('state', 'expires_at', 'operation_pid', 'operation_stamp', 'operation_token')}}


def read(sandbox_id):
    canonical(sandbox_id, 'sandbox_id')
    with closing(database()) as connection:
        return decode(connection.execute('SELECT * FROM instances WHERE sandbox_id=?', (sandbox_id,)).fetchone())


def save(record, *, token=None):
    with closing(database()) as connection:
        values = (record['state'], record['expires_at'], record.get('operation_pid'), record.get('operation_stamp'),
                  record.get('operation_token'), json.dumps(record), record['sandbox_id'])
        sql = 'UPDATE instances SET state=?,expires_at=?,operation_pid=?,operation_stamp=?,operation_token=?,record=? WHERE sandbox_id=?'
        if token is not None: sql += ' AND operation_token=?'; values += (token,)
        if connection.execute(sql, values).rowcount != 1:
            raise RuntimeError('Instance operation lost its durable ownership token')


def reserve(source, spec, limits):
    sandbox_id = str(uuid.uuid4()); now = time.time()
    record = {**identity(spec), 'sandbox_id': sandbox_id, 'state': 'provisioning',
              'created_at': now, 'expires_at': now+limits['ttl_seconds'], 'limits': limits,
              'source_path': str(source), 'source_baseline': inventory(source),
              'container_name': 'stackpilot-agent-instance-'+sandbox_id.replace('-', ''),
              'operation_pid': os.getpid(), 'operation_stamp': process_stamp(os.getpid()),
              'operation_token': str(uuid.uuid4())}
    connection = database()
    try:
        connection.execute('BEGIN IMMEDIATE')
        total = connection.execute("SELECT COUNT(*) FROM instances WHERE state!='released'").fetchone()[0]
        per_run = connection.execute("SELECT COUNT(*) FROM instances WHERE state!='released' AND run_id=?", (spec['run_id'],)).fetchone()[0]
        if total >= ceiling('MAX_TOTAL', 8, 128) or per_run >= ceiling('MAX_PER_RUN', 3, 32):
            raise ValueError('Docker instance quota reached; release or reconcile owned instances')
        # Reservations include pending and uncertain guests until reconciled;
        # they cannot collectively overcommit the operator's resource budget.
        allocated = [json.loads(row[0])['limits'] for row in connection.execute("SELECT record FROM instances WHERE state!='released'")]
        if sum(item['memory_mb'] for item in allocated)+limits['memory_mb'] > ceiling('TOTAL_MEMORY_MB', 4096, 65536) or sum(item['cpus'] for item in allocated)+limits['cpus'] > ceiling('TOTAL_CPUS', 4, 128):
            raise ValueError('Docker instance aggregate CPU or memory budget reached')
        connection.execute('INSERT INTO instances VALUES (?,?,?,?,?,?,?,?,?)', (sandbox_id, spec['run_id'], spec['user_id'],
            record['state'], record['expires_at'], record['operation_pid'], record['operation_stamp'], record['operation_token'], json.dumps(record)))
        connection.commit()
    except Exception: connection.rollback(); raise
    finally: connection.close()
    return record


def ownership(record, spec):
    identity(spec)
    if any(record.get(key) != spec[key] for key in IDENTITY):
        raise PermissionError('Sandbox belongs to another task lease, user or attempt')


def assert_lease(record, spec):
    ownership(record, spec)
    if record['expires_at'] <= time.time(): raise PermissionError('Sandbox TTL expired; provision a fresh instance')
    if not lease_valid(spec): raise PermissionError('Task execution lease revoked')


def labels(record):
    return {'stackpilot.agent-instance': 'true', 'stackpilot.agent-run': record['run_id'],
            'stackpilot.agent-user': record['user_id'], 'stackpilot.agent-task': record['task_id'],
            'stackpilot.agent-attempt': str(record['attempt']), 'stackpilot.agent-sandbox': record['sandbox_id']}


def docker_environment(configuration):
    configuration.mkdir(exist_ok=True); (configuration/'config.json').write_text('{}')
    return {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'DOCKER_CONFIG': str(configuration)}


def call(argv, env, *, timeout=30, check=True):
    return subprocess.run(['docker', *argv], capture_output=True, text=True, timeout=timeout, check=check, env=env)


def daemon(env):
    data = json.loads(call(['info', '--format', '{{json .}}'], env, timeout=10).stdout)
    if data.get('OSType') != 'linux': raise ValueError('A Linux Docker daemon is required')
    value = data.get('ID')
    if not isinstance(value, str) or not 1 <= len(value) <= 256: raise ValueError('Docker daemon returned no identity')
    return value


def observation(record, env, *, allow_missing=False, allow_unpinned=False):
    if record.get('daemon_id') and daemon(env) != record['daemon_id']:
        raise PermissionError('Docker daemon identity changed; instance cannot be reused or removed')
    reference = record.get('container_id') or record['container_name']
    result = call(['inspect', reference], env, timeout=15, check=False)
    if result.returncode:
        if allow_missing and ('No such' in result.stderr or 'not found' in result.stderr): return None
        raise ValueError('Owned Docker instance could not be observed')
    rows = json.loads(result.stdout)
    if not isinstance(rows, list) or len(rows) != 1: raise ValueError('Docker returned ambiguous instance observation')
    observed = rows[0]; container_id = observed.get('Id', '')
    if not CONTAINER_ID.fullmatch(container_id): raise ValueError('Docker returned an invalid container identity')
    if record.get('container_id') and container_id != record['container_id']:
        raise PermissionError('Docker container identity changed')
    if not record.get('container_id') and not allow_unpinned: raise ValueError('Instance has no accepted container identity')
    actual = (observed.get('Config') or {}).get('Labels') or {}
    if any(actual.get(key) != value for key, value in labels(record).items()):
        raise PermissionError('Docker instance ownership observation mismatch')
    if record.get('image_id') and observed.get('Image') != record['image_id']:
        raise PermissionError('Docker instance image identity changed')
    host = observed.get('HostConfig') or {}
    if host.get('Privileged') or host.get('Binds') or host.get('Devices') or observed.get('Mounts'):
        raise PermissionError('Docker instance gained forbidden host resources')
    return observed


def clear_operation(record, state):
    record.update(state=state, operation_pid=None, operation_stamp=None, operation_token=None)


def summary(record):
    fields = ('sandbox_id', 'run_id', 'task_id', 'state', 'created_at', 'expires_at', 'image', 'image_id', 'distribution',
              'container_id', 'limits', 'last_execution_id', 'last_error')
    return {**{key: record[key] for key in fields if key in record}, 'executor_type': 'docker', 'os': 'linux',
            'verified': False, 'scope': 'docker_instance', 'changes': []}


def claim(sandbox_id, spec, operation):
    connection = database()
    try:
        connection.execute('BEGIN IMMEDIATE')
        record = decode(connection.execute('SELECT * FROM instances WHERE sandbox_id=?', (sandbox_id,)).fetchone())
        ownership(record, spec)
        if record.get('operation_token'):
            if helper_alive(record): raise RuntimeError('Sandbox has an active operation; concurrent access is refused')
            raise RuntimeError('Sandbox operation was interrupted; inspect or release it before continuing')
        if operation == 'execute' and record['state'] != 'ready':
            raise RuntimeError('Sandbox is not ready; provision a fresh instance')
        record.update(state='executing' if operation == 'execute' else 'releasing', operation_pid=os.getpid(),
                      operation_stamp=process_stamp(os.getpid()), operation_token=str(uuid.uuid4()))
        connection.execute('UPDATE instances SET state=?,operation_pid=?,operation_stamp=?,operation_token=?,record=? WHERE sandbox_id=?',
                           (record['state'], record['operation_pid'], record['operation_stamp'], record['operation_token'], json.dumps(record), sandbox_id))
        connection.commit(); return record
    except Exception: connection.rollback(); raise
    finally: connection.close()


def stop_owned(record, env):
    observed = observation(record, env, allow_missing=True, allow_unpinned=True)
    if observed is not None and (observed.get('State') or {}).get('Running'):
        stopped = call(['kill', observed['Id']], env, timeout=15, check=False)
        actual = observation(record, env, allow_missing=True, allow_unpinned=True)
        if stopped.returncode != 0 or actual is not None and (actual.get('State') or {}).get('Running'):
            raise RuntimeError('Owned instance stop could not be confirmed; reconciliation is required')


def recover(record, env):
    """Atomically quarantine a dead helper before stopping its owned guest."""
    connection = database()
    try:
        connection.execute('BEGIN IMMEDIATE')
        record = decode(connection.execute('SELECT * FROM instances WHERE sandbox_id=?', (record['sandbox_id'],)).fetchone())
        if not record.get('operation_token') or helper_alive(record): connection.commit(); return record
        token = record['operation_token']
        record['last_error'] = 'Helper interrupted; command outcome is uncertain and will not be replayed'
        clear_operation(record, 'uncertain')
        connection.execute('UPDATE instances SET state=?,operation_pid=NULL,operation_stamp=NULL,operation_token=NULL,record=? WHERE sandbox_id=? AND operation_token=?',
                           ('uncertain', json.dumps(record), record['sandbox_id'], token))
        connection.commit()
    except Exception: connection.rollback(); raise
    finally: connection.close()
    stop_owned(record, env)
    return record


def provision(source, spec):
    limits = options(spec)
    if os.getenv('STACKPILOT_AGENT_DOCKER_PROVISIONING', 'true').lower() != 'true':
        return {'status': 'blocked', 'error': 'Docker instance provisioning is disabled', 'changes': [], 'verified': False}
    root = Path(source)
    if root.is_symlink() or not root.is_dir(): raise ValueError('Instance source must be a real directory')
    root = root.resolve()
    image = spec.get('image')
    required = spec.get('capabilities', [])
    if image is None and not any(str(item).startswith('distro.') for item in required): image = 'ubuntu:24.04'
    placement = select(required, image, purpose='command', probe=True, owned_run=spec['run_id'])
    if placement['status'] != 'ready': return {**placement, 'status': 'blocked', 'changes': []}
    image = placement.get('image') or image or 'ubuntu:24.04'
    if not lease_valid(spec): raise PermissionError('Task execution lease revoked before instance reservation')
    record = reserve(root, spec, limits); token = record['operation_token']; record['image'] = image
    with tempfile.TemporaryDirectory(prefix='stackpilot-instance-') as temporary:
        temporary = Path(temporary); env = docker_environment(temporary/'docker-config')
        try:
            record['daemon_id'] = daemon(env); save(record, token=token)
            metadata = call(['image', 'inspect', image], env, timeout=15, check=False)
            if metadata.returncode:
                if os.getenv('STACKPILOT_AGENT_INSTANCE_PULL', 'true').lower() != 'true':
                    raise ValueError('Instance base image is not cached and operator image pulls are disabled')
                assert_lease(record, spec)
                call(['pull', image], env, timeout=180)
                metadata = call(['image', 'inspect', image], env, timeout=15)
            observed = json.loads(metadata.stdout)[0]; record['image_id'] = observed.get('Id', '')
            if not IMAGE_ID.fullmatch(record['image_id']): raise ValueError('Instance image has no observed immutable image identity')
            host = json.loads(call(['info', '--format', '{{json .}}'], env, timeout=10).stdout)
            normalize_architecture = lambda value: {'x86_64': 'amd64', 'x64': 'amd64', 'aarch64': 'arm64'}.get(value, value)
            if observed.get('Os') != 'linux' or not observed.get('Architecture') or normalize_architecture(observed.get('Architecture')) != normalize_architecture(host.get('Architecture')):
                raise ValueError('Instance image must match the observed Linux Docker architecture')
            if (observed.get('Config') or {}).get('Volumes'): raise ValueError('Instance images cannot declare implicit volumes')
            save(record, token=token)
            snapshot = temporary/'source'; stage(root, snapshot, record['source_baseline'])
            assert_lease(record, spec)
            args = ['create', '--name', record['container_name'], '--network', 'bridge' if limits['network'] else 'none',
                    '--memory', str(limits['memory_mb'])+'m', '--memory-swap', str(limits['memory_mb'])+'m',
                    '--cpus', str(limits['cpus']), '--pids-limit', str(limits['pids_limit']), '--cap-drop', 'ALL',
                    '--security-opt', 'no-new-privileges', '--user', '0:0', '--workdir', '/workspace']
            # Package managers need file ownership and dropping to an unprivileged
            # download user. These guest-only capabilities do not include mounts,
            # devices, host networking, SYS_ADMIN, ptrace or privileged mode.
            for capability in ('CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'):
                args.extend(['--cap-add', capability])
            for key, value in labels(record).items(): args.extend(['--label', key+'='+value])
            args.extend(['--entrypoint', '/bin/sh', record['image_id'], '-c', 'while :; do sleep 3600; done'])
            record['container_id'] = call(args, env, timeout=120).stdout.strip()
            if not CONTAINER_ID.fullmatch(record['container_id']): raise ValueError('Docker create returned no container identity')
            save(record, token=token); observation(record, env)
            call(['cp', str(snapshot)+'/.', record['container_id']+':/workspace'], env, timeout=60)
            assert_lease(record, spec); call(['start', record['container_id']], env, timeout=30)
            accepted = observation(record, env)
            if not (accepted.get('State') or {}).get('Running'): raise ValueError('Instance initialization failed; /bin/sh is required')
            operating_system = call(['exec', record['container_id'], '/bin/sh', '-c',
                'command -v tar >/dev/null && cat /etc/os-release'], env, timeout=15).stdout
            observed_distribution = next((line.partition('=')[2].strip().strip('\"') for line in operating_system.splitlines() if line.startswith('ID=')), None)
            if not isinstance(observed_distribution, str) or not re.fullmatch(r'[a-z0-9_.-]{1,80}', observed_distribution):
                raise ValueError('Instance must expose its Linux distribution and tar')
            expected_distribution = next((item[len('distro.'):] for item in required if item.startswith('distro.')), None)
            if expected_distribution and expected_distribution != observed_distribution:
                raise ValueError('Observed instance distribution does not satisfy its requested capability')
            record['distribution'] = observed_distribution
            record['started_at'] = (accepted.get('State') or {}).get('StartedAt')
            record['restart_count'] = accepted.get('RestartCount', 0)
            assert_lease(record, spec)
            clear_operation(record, 'ready'); save(record, token=token)
            return {**summary(record), 'status': 'ready'}
        except Exception as error:
            record['last_error'] = str(error)
            try:
                actual = observation(record, env, allow_missing=True, allow_unpinned=True)
                if actual is not None:
                    record['container_id'] = actual['Id']; call(['rm', '-f', actual['Id']], env, timeout=20)
                clear_operation(record, 'released')
            except Exception: clear_operation(record, 'failed')
            save(record, token=token)
            raise


def inspect(spec):
    record = read(spec.get('sandbox_id')); ownership(record, spec)
    with tempfile.TemporaryDirectory(prefix='stackpilot-instance-inspect-') as temporary:
        env = docker_environment(Path(temporary)/'docker-config'); record = recover(record, env)
        assert_lease(record, spec)
        if record['state'] == 'released': return {**summary(record), 'status': 'released'}
        observed = observation(record, env)
        if record['state'] == 'ready' and (not (observed.get('State') or {}).get('Running') or
                (observed.get('State') or {}).get('StartedAt') != record.get('started_at') or
                observed.get('RestartCount', 0) != record.get('restart_count')):
            record['last_error'] = 'Instance stopped or restarted; provision a fresh instance'
            clear_operation(record, 'uncertain'); save(record)
        return {**summary(record), 'status': record['state'], 'running': bool((observed.get('State') or {}).get('Running'))}


def command(spec):
    argv = spec.get('argv')
    if not isinstance(argv, list) or not 1 <= len(argv) <= 100 or not argv[0] or any(
            not isinstance(arg, str) or '\0' in arg or len(arg) > 12000 for arg in argv):
        raise ValueError('argv must be a bounded nonempty string array')
    scopes = spec.get('write_scope', [])
    if not isinstance(scopes, list) or len(scopes) > 200: raise ValueError('write_scope must be a bounded path array')
    for scope in scopes:
        if not isinstance(scope, str) or not scope or len(scope) > 512 or any(c in scope for c in '\\:\0\r\n'):
            raise ValueError('Invalid write scope')
        path = PurePosixPath(scope)
        if path.is_absolute() or '..' in path.parts: raise ValueError('Write scope escapes source')
    return argv, scopes, bounded(spec, 'timeout_seconds', 120, 300)


def export_source(record, env, destination):
    """Bound archive bytes before extracting; never trust guest tar paths."""
    args = ['docker', 'exec', record['container_id'], 'tar', '-C', '/workspace']
    args.extend('--exclude='+name for name in sorted(SKIP)); args.extend(['-cf', '-', '.'])
    archive = destination.with_suffix('.tar'); captured = 0
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    overflow = []; done = threading.Event()
    def drain():
        nonlocal captured
        try:
            with archive.open('wb') as target, process.stdout:
                while block := process.stdout.read(65536):
                    captured += len(block)
                    if captured > SOURCE_ARCHIVE_BUDGET: overflow.append(True); process.kill(); break
                    target.write(block)
        finally: done.set()
    reader = threading.Thread(target=drain, daemon=True); reader.start()
    try:
        process.wait(timeout=60); done.wait(5)
        if overflow: raise ValueError('Worker source archive exceeds return budget')
        if process.returncode: raise ValueError('Instance source export failed; tar is required in its image')
        if not done.is_set(): raise ValueError('Instance source archive did not finish')
        destination.mkdir(); count = 0; size = 0; seen = set()
        with tarfile.open(archive, 'r:') as incoming:
            for member in incoming:
                if any(character in member.name for character in '\\:\0\r\n'):
                    raise ValueError('Worker archive has an unsafe source path')
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts: raise ValueError('Worker archive escapes source')
                if not path.parts or path.as_posix() == '.': continue
                if any(part in SKIP for part in path.parts): continue
                if member.isdir(): continue
                if not member.isfile(): raise ValueError('Worker source contains a link or special file')
                name = path.as_posix()
                if name in seen: raise ValueError('Worker source archive contains duplicate files')
                seen.add(name); count += 1; size += member.size
                if count > 20000 or size > 256*1024*1024: raise ValueError('Worker source exceeds return budget')
                target = destination.joinpath(*path.parts); target.parent.mkdir(parents=True, exist_ok=True)
                stream = incoming.extractfile(member)
                with target.open('wb') as output: shutil.copyfileobj(stream, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    finally:
        if process.poll() is None: process.kill(); process.wait(timeout=5)
        reader.join(timeout=5)
        if process.stderr is not None: process.stderr.close()


def source_changes(before, after, destination, scopes):
    changes = []; returned_bytes = 0; baseline = dict(before)
    for path in sorted(set(before) | set(after)):
        if before.get(path) == after.get(path): continue
        if not allowed(path, scopes):
            if path in before: raise PermissionError('Command changed source outside its task scope: '+path)
            continue
        target = destination/path
        if target.exists() and target.stat().st_size > 1024*1024: raise ValueError('Returned source patch file exceeds 1 MiB')
        returned_bytes += target.stat().st_size if target.exists() else 0
        if returned_bytes > 8*1024*1024: raise ValueError('Returned source patch exceeds 8 MiB')
        changes.append({'path': path, 'before': before.get(path, {}).get('sha256'), 'after': after.get(path, {}).get('sha256'),
            'before_executable': before.get(path, {}).get('executable', False),
            'content_base64': base64.b64encode(target.read_bytes()).decode() if target.exists() else None,
            'executable': bool(target.stat().st_mode & 0o111) if target.exists() else False})
        if path in after: baseline[path] = after[path]
        else: baseline.pop(path, None)
    if len(changes) > 200: raise ValueError('Worker patch exceeds 200 files')
    return changes, baseline


def execution_policy(record, spec):
    """A persistent instance cannot silently change its admitted environment."""
    if 'image' in spec and spec['image'] not in {record['image'], record['image_id']}:
        raise PermissionError('Requested image differs from the provisioned instance; provision a fresh instance')
    if 'network' in spec:
        if type(spec['network']) is not bool: raise ValueError('Instance network must be a boolean')
        if spec['network'] != record['limits']['network']:
            raise PermissionError('Requested network differs from the provisioned instance policy')
    if record['limits']['network'] and os.getenv('STACKPILOT_AGENT_WORKER_NETWORK', 'false').lower() != 'true':
        raise PermissionError('Operator revoked this instance network capability')
    required = spec.get('capabilities', [])
    placement = select(required, record['image'], purpose='command', probe=True, owned_run=record['run_id'])
    if placement['status'] != 'ready': raise PermissionError('Instance does not supply currently admitted sandbox capabilities')
    if any(item.startswith('distro.') and item[len('distro.'):] != record.get('distribution') for item in required):
        raise PermissionError('Observed instance distribution does not supply the requested capability')


def execute(source, spec):
    argv, scopes, timeout = command(spec)
    record = read(spec.get('sandbox_id')); assert_lease(record, spec)
    execution_policy(record, spec)
    root = Path(source)
    if root.is_symlink() or not root.is_dir() or str(root.resolve()) != record['source_path']:
        raise PermissionError('Instance source directory does not match its provisioned source')
    if inventory(root) != record['source_baseline']:
        return {**summary(record), 'status': 'blocked', 'error': 'Host source revision changed or prior patches were not imported; provision a fresh instance',
                'requires_fresh_instance': True}
    record = claim(record['sandbox_id'], spec, 'execute'); token = record['operation_token']
    record['last_execution_id'] = str(uuid.uuid4()); save(record, token=token)
    with tempfile.TemporaryDirectory(prefix='stackpilot-instance-command-') as temporary:
        temporary = Path(temporary); env = docker_environment(temporary/'docker-config'); process = None
        try:
            observed = observation(record, env)
            if not (observed.get('State') or {}).get('Running') or (observed.get('State') or {}).get('StartedAt') != record['started_at'] or observed.get('RestartCount', 0) != record['restart_count']:
                raise ValueError('Instance stopped or restarted; provision a fresh instance')
            assert_lease(record, spec)
            process = subprocess.Popen(['docker', 'exec', '--workdir', '/workspace', record['container_id'], *argv],
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
            captured = bytearray()
            def drain():
                with process.stdout:
                    while block := process.stdout.read(4096):
                        remaining = 65536-len(captured)
                        if remaining > 0: captured.extend(block[:remaining])
            reader = threading.Thread(target=drain, daemon=True); reader.start()
            started = time.monotonic(); checked = 0; timed_out = False
            while process.poll() is None:
                now = time.monotonic()
                if now-checked >= 2: checked = now; assert_lease(record, spec)
                if now-started >= timeout:
                    timed_out = True; stop_owned(record, env); process.wait(timeout=15); break
                time.sleep(.2)
            reader.join(timeout=5); assert_lease(record, spec)
            if timed_out:
                record['last_error'] = 'Command timed out; instance stopped and requires fresh provision'
                clear_operation(record, 'uncertain'); save(record, token=token)
                return {**summary(record), 'status': 'failed', 'exit_code': 124, 'timed_out': True,
                        'output': captured.decode(errors='replace'), 'argv': argv, 'changes': []}
            final_observed = observation(record, env)
            if not (final_observed.get('State') or {}).get('Running') or (final_observed.get('State') or {}).get('StartedAt') != record['started_at'] or final_observed.get('RestartCount', 0) != record['restart_count']:
                raise ValueError('Instance execution crossed a stop or restart; output cannot mutate source')
            output_root = temporary/'returned'; export_source(record, env, output_root)
            after = inventory(output_root)
            changes, baseline = source_changes(record['source_baseline'], after, output_root, scopes)
            if inventory(root) != record['source_baseline']:
                raise PermissionError('Host source changed during execution; worker output cannot mutate source')
            assert_lease(record, spec)
            record['source_baseline'] = baseline
            clear_operation(record, 'ready'); save(record, token=token)
            return {**summary(record), 'status': 'completed' if process.returncode == 0 else 'failed',
                    'exit_code': process.returncode, 'output': captured.decode(errors='replace'), 'timed_out': False,
                    'argv': argv, 'changes': changes, 'scope': 'instance_command_execution'}
        except Exception as error:
            record['last_error'] = str(error)
            try: stop_owned(record, env)
            except Exception: pass
            if process is not None and process.poll() is None:
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
            clear_operation(record, 'uncertain'); save(record, token=token)
            raise


def remove(record, env):
    observed = observation(record, env, allow_missing=True, allow_unpinned=True)
    if observed is not None: call(['rm', '-f', observed['Id']], env, timeout=20)


def release(spec):
    record = read(spec.get('sandbox_id')); assert_lease(record, spec)
    if record['state'] == 'released': return {**summary(record), 'status': 'released'}
    with tempfile.TemporaryDirectory(prefix='stackpilot-instance-release-') as temporary:
        env = docker_environment(Path(temporary)/'docker-config'); record = recover(record, env)
        record = claim(record['sandbox_id'], spec, 'release'); token = record['operation_token']
        try:
            remove(record, env); clear_operation(record, 'released'); save(record, token=token)
            return {**summary(record), 'status': 'completed'}
        except Exception as error:
            record['last_error'] = str(error); clear_operation(record, 'failed'); save(record, token=token); raise


def cleanup(spec):
    """Broker authorizes terminal runs; expired_only authorizes working owners.

    Registry ownership and actual Docker labels/identities are independently
    checked. Working-run cleanup removes expired instances or exact retired
    task/attempts supplied only by the trusted broker, never every active task.
    """
    run_id = canonical(spec.get('run_id'), 'run_id')
    expired_only = spec.get('expired_only', False)
    if type(expired_only) is not bool: raise ValueError('expired_only must be a boolean')
    retired = spec.get('retired_leases', [])
    if not isinstance(retired, list) or len(retired) > 128:
        raise ValueError('retired_leases must be a bounded broker-owned task list')
    retired_keys = set()
    for item in retired:
        if not isinstance(item, dict) or not isinstance(item.get('task_id'), str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', item['task_id']) or type(item.get('attempt')) is not int or not 1 <= item['attempt'] <= 10000:
            raise ValueError('Invalid retired task lease')
        retired_keys.add((item['task_id'], item['attempt']))
    if expired_only: canonical(spec.get('user_id'), 'user_id')
    with closing(database()) as connection:
        rows = connection.execute("SELECT * FROM instances WHERE run_id=? AND state!='released' ORDER BY expires_at LIMIT 129", (run_id,)).fetchall()
    if len(rows) > 128: raise ValueError('Instance cleanup exceeds bounded reconciliation budget')
    removed = []; retained = []; started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='stackpilot-instance-cleanup-') as temporary:
        env = docker_environment(Path(temporary)/'docker-config')
        for row in rows:
            record = decode(row)
            if expired_only and record['user_id'] != spec['user_id']:
                retained.append({'sandbox_id': record['sandbox_id'], 'reason': 'owner mismatch'}); continue
            if expired_only and record['expires_at'] > time.time() and (record['task_id'], record['attempt']) not in retired_keys: continue
            if time.monotonic()-started > 60:
                retained.append({'sandbox_id': record['sandbox_id'], 'reason': 'cleanup observation budget exceeded'}); continue
            try:
                # A terminal/expired run may interrupt its active operation. A
                # token change ensures that helper cannot accept output later.
                connection = database()
                try:
                    connection.execute('BEGIN IMMEDIATE')
                    record = decode(connection.execute('SELECT * FROM instances WHERE sandbox_id=?', (record['sandbox_id'],)).fetchone())
                    if expired_only and record['expires_at'] > time.time() and (record['task_id'], record['attempt']) not in retired_keys:
                        connection.commit(); continue
                    record.update(state='releasing', operation_pid=os.getpid(), operation_stamp=process_stamp(os.getpid()), operation_token=str(uuid.uuid4()))
                    connection.execute('UPDATE instances SET state=?,operation_pid=?,operation_stamp=?,operation_token=?,record=? WHERE sandbox_id=?',
                        (record['state'], record['operation_pid'], record['operation_stamp'], record['operation_token'], json.dumps(record), record['sandbox_id']))
                    connection.commit()
                except Exception: connection.rollback(); raise
                finally: connection.close()
                token = record['operation_token']; remove(record, env)
                clear_operation(record, 'released'); save(record, token=token); removed.append(record['sandbox_id'])
            except Exception as error:
                retained.append({'sandbox_id': record['sandbox_id'], 'reason': str(error)})
                if record.get('operation_pid') == os.getpid():
                    token = record.get('operation_token'); record['last_error'] = str(error)
                    clear_operation(record, 'failed')
                    try: save(record, token=token)
                    except Exception: pass
    return {'status': 'partial' if retained else 'completed', 'run_id': run_id, 'expired_only': expired_only,
            'removed': removed, 'retained': retained, 'verified': False, 'scope': 'docker_instance_cleanup'}


def dispatch(source, spec):
    if source == 'cleanup': return cleanup(spec)
    operation = spec.get('operation')
    if operation == 'provision': return provision(source, spec)
    if operation == 'inspect': return inspect(spec)
    if operation == 'execute': return execute(source, spec)
    if operation == 'release': return release(spec)
    raise ValueError('Unknown instance operation')


if __name__ == '__main__':
    source, request_path, result_path = sys.argv[1:4]
    try: result = dispatch(source, json.loads(Path(request_path).read_text()))
    except Exception as error:
        result = {'status': 'failed', 'error': str(error), 'verified': False, 'changes': [], 'scope': 'docker_instance'}
    Path(result_path).write_text(json.dumps(result))
