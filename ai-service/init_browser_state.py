"""Initialize the private browser journal volume before the non-root service.

Use SQLite backup to preserve legacy development checkpoints, including WAL
transactions. Existing volume data always takes precedence over legacy data.
"""
import os
from pathlib import Path
import sqlite3
import tempfile


DATABASE = "browser-runs.sqlite3"


def initialize(state_directory, legacy_directory=None, uid=10001, gid=10001):
    state = Path(state_directory)
    if state.is_symlink():
        raise ValueError("Browser state directory must not be a symlink")
    state.mkdir(parents=True, exist_ok=True)
    target = state / DATABASE
    if target.is_symlink():
        raise ValueError("Browser journal must not be a symlink")
    migrated = False
    legacy = Path(legacy_directory) / DATABASE if legacy_directory else None
    if not target.exists() and legacy is not None and legacy.exists():
        if legacy.is_symlink() or not legacy.is_file():
            raise ValueError("Legacy browser journal must be a regular file")
        descriptor, temporary = tempfile.mkstemp(prefix="browser-journal-", suffix=".sqlite3", dir=state)
        os.close(descriptor)
        try:
            with sqlite3.connect(str(legacy), timeout=10) as source:
                with sqlite3.connect(temporary) as destination:
                    source.backup(destination)
                    if destination.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                        raise ValueError("Legacy browser journal failed integrity checking")
            os.replace(temporary, target)
            migrated = True
        finally:
            Path(temporary).unlink(missing_ok=True)
    for entry in [state, target, *(state / (DATABASE + suffix) for suffix in ("-wal", "-shm", "-journal"))]:
        if entry.is_symlink():
            raise ValueError("Browser state entries must not be symlinks")
        if entry.exists():
            if entry != state and not entry.is_file():
                raise ValueError("Browser journal entries must be regular files")
            os.chown(entry, uid, gid)
            os.chmod(entry, 0o700 if entry == state else 0o600)
    return {"migrated": migrated, "journal_present": target.exists()}


if __name__ == "__main__":
    print(initialize("/state", "/legacy-state" if Path("/legacy-state").exists() else None))
