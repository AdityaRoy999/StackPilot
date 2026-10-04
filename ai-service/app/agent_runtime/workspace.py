"""Broker-owned Git metadata and independent task working trees.

Repository processes receive only the working tree, never this metadata or the
source/import directory. Git is invoked with argv and without repository hooks.
"""
import contextlib
import base64
import hashlib
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path, PurePosixPath


IGNORED = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.gradle', '.next', '.stackpilot-runtime'}
MAX_FILES = 20000
MAX_BYTES = 256 * 1024 * 1024
_locks = {}
_locks_guard = threading.Lock()


def validate_scope(scopes):
    if not isinstance(scopes, list) or len(scopes) > 100:
        raise ValueError('write_scope must be a bounded list of paths or directory/** prefixes')
    for scope in scopes:
        if not isinstance(scope, str) or not scope or len(scope) > 500:
            raise ValueError('Invalid write scope')
        prefix = scope[:-3] if scope.endswith('/**') else scope
        if scope != '**' and (any(char in prefix for char in '*?[]:') or prefix.startswith('/') or '\\' in prefix or any(part in {'..', '.', '.git'} for part in prefix.split('/'))):
            raise ValueError('Use a relative file, directory/**, or ** scope')
    return scopes


def allowed(path, scopes):
    return any(scope == '**' or path == scope or (scope.endswith('/**') and path.startswith(scope[:-2])) for scope in scopes)


def scope_contains(parent, child):
    """An exact file capability never grants a directory capability."""
    return any(item == '**' or item == child or
               (item.endswith('/**') and child.removesuffix('/**').startswith(item[:-2]))
               for item in parent)


def scopes_overlap(left, right):
    for a in left:
        for b in right:
            if a == '**' or b == '**' or a == b:
                return True
            ap, bp = a[:-2] if a.endswith('/**') else a, b[:-2] if b.endswith('/**') else b
            if (a.endswith('/**') and bp.startswith(ap)) or (b.endswith('/**') and ap.startswith(bp)):
                return True
    return False


def digest(path):
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file():
        raise ValueError('Only regular source files are accepted')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_path(root, value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value or '\0' in value:
        raise ValueError('Use a relative repository path')
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {'.git', '..'} for part in path.parts):
        raise PermissionError('Path traversal or Git metadata access denied')
    target = root.joinpath(*path.parts)
    current = target
    while current != root:
        if current.is_symlink():
            raise PermissionError('Symlink source access denied')
        current = current.parent
    if not target.resolve().is_relative_to(root.resolve()) or target == root:
        raise PermissionError('Path traversal denied')
    return target


def source_files(root):
    paths, size = [], 0
    for current, directories, files in os.walk(root, followlinks=False):
        if any((Path(current)/name).is_symlink() for name in directories if name not in IGNORED):
            raise ValueError('Source directory symlink requires explicit portable packaging')
        directories[:] = sorted(name for name in directories if name not in IGNORED)
        for name in sorted(files):
            path = Path(current)/name
            if name in {'.git', '.stackpilot-source.json'} or name == '.env' or (name.startswith('.env.') and not name.endswith(('example', 'sample', 'template'))):
                continue
            if path.is_symlink():
                raise ValueError('Source symlink requires explicit portable packaging')
            if not path.is_file():
                raise ValueError('Special files are not source inputs')
            size += path.stat().st_size
            paths.append(path.relative_to(root).as_posix())
            if len(paths) > MAX_FILES or size > MAX_BYTES:
                raise ValueError('Source snapshot limit exceeded; select component roots explicitly')
    return paths


def copy_source(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    for relative in source_files(source):
        target = safe_path(destination, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source/relative, target)


class Workspaces:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def directory(self, run_id, agent_id='lead'):
        # IDs originate in the trusted runtime, but validate persisted/API IDs too.
        import uuid
        uuid.UUID(run_id)
        if agent_id != 'lead':
            uuid.UUID(agent_id)
        return self.root/run_id/('integration' if agent_id == 'lead' else 'tasks/'+agent_id)

    @contextlib.contextmanager
    def locked(self, run_id):
        key = str(self.directory(run_id))
        with _locks_guard:
            lock = _locks.setdefault(key, threading.RLock())
        with lock:
            # Cross-process integration is serialized by the caller's Postgres run lock.
            yield

    def git(self, run_id, agent_id, *args):
        work = self.directory(run_id, agent_id)
        metadata = self.root/run_id/'metadata'/agent_id
        environment = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull,
                       'GIT_TERMINAL_PROMPT': '0', 'GIT_AUTHOR_NAME': 'StackPilot',
                       'GIT_AUTHOR_EMAIL': 'agent@stackpilot.local', 'GIT_COMMITTER_NAME': 'StackPilot',
                       'GIT_COMMITTER_EMAIL': 'agent@stackpilot.local'}
        command = ['git', '-c', 'core.hooksPath='+str(self.root/'disabled-hooks'), '-c', 'core.autocrlf=false',
                   '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false',
                   '--git-dir='+str(metadata), '--work-tree='+str(work), *args]
        result = subprocess.run(command, env=environment, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('Source version operation failed: '+result.stderr.decode(errors='replace')[:1000])
        return result.stdout

    def initialize(self, run_id, source):
        with self.locked(run_id):
            work = self.directory(run_id)
            metadata = self.root/run_id/'metadata'/'lead'
            if metadata.exists():
                return self.head(run_id)
            copy_source(Path(source), work)
            # Original regression inputs and acceptance are broker-owned. Agents
            # can add tests; they cannot remove the evidence that revealed a bug.
            from .acceptance import capture
            acceptance = self.root/run_id/'acceptance.json'
            acceptance.write_text(json.dumps(capture(work)), encoding='utf-8')
            metadata.parent.mkdir(parents=True, exist_ok=True)
            result = subprocess.run(['git', 'init', '--bare', str(metadata)], capture_output=True, timeout=30)
            if result.returncode:
                raise RuntimeError('Git is required for agent workspace isolation')
            return self.commit(run_id, 'lead', 'Imported source baseline')

    def commit(self, run_id, agent_id, message):
        files = source_files(self.directory(run_id, agent_id))
        self.git(run_id, agent_id, 'add', '-u')
        for start in range(0, len(files), 100):
            self.git(run_id, agent_id, 'add', '-f', '--', *files[start:start+100])
        self.git(run_id, agent_id, 'commit', '--allow-empty', '-m', message)
        return self.head(run_id, agent_id)

    def head(self, run_id, agent_id='lead'):
        return self.git(run_id, agent_id, 'rev-parse', 'HEAD').decode().strip()

    def reconcile(self, run_id, expected_revision):
        with self.locked(run_id):
            if not expected_revision:
                raise ValueError('Run has no committed source baseline')
            # The database integration revision is authoritative after a crash.
            # Uncommitted/DB-unaccepted staging writes cannot enter a new task.
            self.git(run_id, 'lead', 'reset', '--hard', expected_revision)
            self.git(run_id, 'lead', 'clean', '-fd')

    def allocate(self, run_id, agent_id):
        with self.locked(run_id):
            work = self.directory(run_id, agent_id)
            record = self.root/run_id/'metadata'/agent_id/'allocation.json'
            if record.exists():
                return json.loads(record.read_text())
            base = self.head(run_id)
            copy_source(self.directory(run_id), work)
            metadata = record.parent
            subprocess.run(['git', 'init', '--bare', str(metadata)], check=True, capture_output=True, timeout=30)
            own_base = self.commit(run_id, agent_id, 'Task source baseline')
            allocation = {'base_revision': base, 'task_baseline': own_base}
            record.write_text(json.dumps(allocation))
            return allocation

    def changes(self, run_id, agent_id, scope):
        allocation = self.allocate(run_id, agent_id)
        baseline = allocation['task_baseline']
        work = self.directory(run_id, agent_id)
        records = self.git(run_id, agent_id, 'ls-tree', '-r', '-z', baseline).decode().split('\0')
        modes = {record.split('\t',1)[1]: record.split(' ',1)[0] == '100755' for record in records if record}
        baseline_files = list(modes)
        changes = []
        for relative in sorted(set(source_files(work)) | set(filter(None, baseline_files))):
            target = safe_path(work, relative)
            try:
                before = self.git(run_id, agent_id, 'show', baseline+':'+relative)
                before_hash = hashlib.sha256(before).hexdigest()
            except RuntimeError:
                before_hash = None
            after_hash = digest(target)
            executable = bool(target.stat().st_mode & 0o111) if target.exists() else False
            if before_hash != after_hash or (target.exists() and modes.get(relative, False) != executable):
                if not allowed(relative, scope):
                    raise PermissionError('Patch changed a path outside its write scope: '+relative)
                if target.exists() and target.stat().st_size > 1024*1024:
                    raise ValueError('Agent patch file exceeds 1 MiB')
                changes.append({'path': relative, 'before': before_hash, 'after': after_hash,
                                'before_executable': modes.get(relative, False), 'executable': executable})
        if len(changes) > 200:
            raise ValueError('Patch exceeds 200 files; split it into tasks')
        return allocation, changes

    def integrate(self, run_id, agent_id, changes):
        with self.locked(run_id):
            integration = self.directory(run_id)
            conflicts = [change['path'] for change in changes if digest(safe_path(integration, change['path'])) != change['before'] or
                         (safe_path(integration, change['path']).exists() and
                          bool(safe_path(integration, change['path']).stat().st_mode & 0o111) != change.get('before_executable', False))]
            if conflicts:
                return {'status': 'conflict', 'conflicting_paths': conflicts,
                        'error': 'Integration source changed since task allocation; rebase/reassign and retest'}
            # Source is private to the trusted broker. Roll back the full staging
            # commit on failure; a submitted patch never edits the imported source.
            old_head = self.head(run_id)
            try:
                for change in changes:
                    source = safe_path(self.directory(run_id, agent_id), change['path'])
                    if digest(source) != change['after']:
                        raise ValueError('Submitted patch changed after submission')
                    if source.exists() and bool(source.stat().st_mode & 0o111) != change.get('executable', False):
                        raise ValueError('Submitted executable mode changed after submission')
                    target = safe_path(integration, change['path'])
                    if change['after'] is None:
                        target.unlink()
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source, target)
                revision = self.commit(run_id, 'lead', 'Integrate task '+agent_id)
                return {'status': 'integrated', 'revision': revision, 'changed_paths': [c['path'] for c in changes],
                        'verified': False, 'next_step': 'Run combined tests and the existing verified release pipeline'}
            except BaseException:
                self.git(run_id, 'lead', 'reset', '--hard', old_head)
                self.git(run_id, 'lead', 'clean', '-fd')
                raise

    def seal(self, run_id):
        with self.locked(run_id):
            from .acceptance import validate
            acceptance = json.loads((self.root/run_id/'acceptance.json').read_text())
            validate(self.directory(run_id), acceptance)
            revision = self.head(run_id)
            destination = self.root/run_id/'releases'/revision
            if not destination.exists():
                temporary = destination.with_name(revision+'.staging')
                copy_source(self.directory(run_id), temporary)
                entries = [[relative, digest(temporary/relative), bool((temporary/relative).stat().st_mode & 0o111)] for relative in source_files(temporary)]
                tree_hash = hashlib.sha256(json.dumps(sorted(entries), separators=(',', ':')).encode()).hexdigest()
                (temporary/'.stackpilot-source.json').write_text(json.dumps({'revision': revision, 'tree_digest': tree_hash, 'acceptance': acceptance}))
                destination.parent.mkdir(parents=True, exist_ok=True)
                temporary.rename(destination)
            return revision, str(destination)

    def files(self, run_id, agent_id):
        return source_files(self.directory(run_id, agent_id))

    def read(self, run_id, agent_id, relative):
        path = safe_path(self.directory(run_id, agent_id), relative)
        if not path.is_file() or path.stat().st_size > 1024*1024:
            raise ValueError('File missing or exceeds 1 MiB')
        return {'content': path.read_text(encoding='utf-8'), 'file_path': relative, 'revision': digest(path)}

    def write(self, run_id, agent_id, relative, content, scopes, expected=None, delete=False):
        if not allowed(relative, scopes):
            raise PermissionError('File is outside the assigned write scope')
        path = safe_path(self.directory(run_id, agent_id), relative)
        current = digest(path)
        if current != expected:
            raise ValueError('Stale file revision; read the current file before editing')
        if delete:
            path.unlink()
        else:
            if not isinstance(content, str) or len(content.encode()) > 1024*1024:
                raise ValueError('File content must not exceed 1 MiB')
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name+'.stackpilot-write')
            temporary.write_text(content, encoding='utf-8', newline='')
            if path.exists():
                temporary.chmod(path.stat().st_mode & 0o777)
            os.replace(temporary, path)
        return {'status': 'deleted' if delete else 'written', 'file_path': relative, 'revision': digest(path)}

    def import_changes(self, run_id, agent_id, changes, scopes):
        if not isinstance(changes, list) or len(changes) > 200:
            raise ValueError('Invalid worker source patch')
        staged, total = [], 0
        work = self.directory(run_id, agent_id)
        for change in changes:
            target = safe_path(work, change['path'])
            if not allowed(change['path'], scopes) or digest(target) != change['before']:
                raise PermissionError('Worker patch is stale or outside assigned ownership')
            if target.exists() and 'before_executable' in change and bool(target.stat().st_mode & 0o111)!=change['before_executable']:
                raise PermissionError('Worker patch executable mode is stale')
            data = base64.b64decode(change['content_base64'], validate=True) if change.get('content_base64') is not None else None
            total += len(data or b'')
            if len(data or b'') > 1024*1024 or total > 8*1024*1024:
                raise ValueError('Worker patch return budget exceeded')
            if data is not None and hashlib.sha256(data).hexdigest() != change['after']:
                raise ValueError('Worker patch digest mismatch')
            staged.append((target, data, change.get('executable', False)))
        for target, data, executable in staged:
            if data is None:
                target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_name(target.name+'.stackpilot-write')
                temporary.write_bytes(data)
                temporary.chmod(0o755 if executable else 0o644)
                os.replace(temporary, target)
        return [change['path'] for change in changes]
