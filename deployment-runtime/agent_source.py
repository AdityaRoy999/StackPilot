"""Verify a broker-sealed repaired tree before preparing a deployment context."""
import hashlib
import json
import os
from pathlib import Path
import sys

SKIP = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.gradle', '.next', '.stackpilot-runtime'}
MANIFEST = '.stackpilot-source.json'


def tree_digest(root):
    root = Path(root)
    entries = []
    total = 0
    for current, directories, files in os.walk(root, followlinks=False):
        if any((Path(current)/name).is_symlink() for name in directories if name not in SKIP):
            raise ValueError('Source directory symlink refused')
        directories[:] = sorted(name for name in directories if name not in SKIP)
        for name in sorted(files):
            if name == MANIFEST or name == '.git' or name == '.env' or (name.startswith('.env.') and not name.endswith(('example','sample','template'))):
                continue
            path = Path(current)/name
            if path.is_symlink() or not path.is_file():
                raise ValueError('Source must contain regular files')
            total += path.stat().st_size
            if total > 256*1024*1024 or len(entries) >= 20000:
                raise ValueError('Source exceeds broker snapshot budget')
            entries.append([path.relative_to(root).as_posix(), hashlib.sha256(path.read_bytes()).hexdigest(), bool(path.stat().st_mode & 0o111)])
    return hashlib.sha256(json.dumps(sorted(entries), separators=(',', ':')).encode()).hexdigest()


def export(root, destination, revision):
    from source_snapshot import snapshot
    root, destination = Path(root).resolve(), Path(destination).absolute()
    manifest = json.loads((root/MANIFEST).read_text())
    if manifest.get('revision') != revision or manifest.get('tree_digest') != tree_digest(root):
        raise ValueError('Accepted repaired source identity does not match its sealed bytes')
    # The seal was created by the broker, outside any repository process. Repeat
    # the hash check at the build boundary rather than trusting a model report.
    for relative, expected in manifest.get('acceptance', {}).get('files', {}).items():
        path = root/relative
        if not path.resolve().is_relative_to(root) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('Original regression evidence changed: '+relative)
    # The broker already filtered secrets/caches and sealed these exact bytes.
    # A second generic filter would drop accepted target/ assets or env templates.
    return snapshot(root, destination.parent/'source-store', destination,exact=True)


if __name__ == '__main__':
    try:
        result = export(*sys.argv[1:4])
        print(json.dumps(result))
    except Exception as error:
        print('Repaired source export failed: '+str(error), file=sys.stderr)
        raise SystemExit(1)
