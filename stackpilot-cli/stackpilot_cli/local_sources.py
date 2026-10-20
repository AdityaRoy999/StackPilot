"""Read-only desktop filesystem mounts for browsing existing local projects."""
import ctypes
import json
import os
import platform
from pathlib import Path

OVERRIDE_NAME = ".stackpilot-local-folders.compose.json"


def host_filesystems():
    if platform.system() == "Windows":
        # Enumerate real fixed/removable drives, not PowerShell aliases or network
        # shares which Docker Desktop cannot necessarily mount.
        kernel = ctypes.windll.kernel32
        mask = kernel.GetLogicalDrives()
        return [(f"{chr(65 + index)}:/", f"/app/host-drives/{chr(97 + index)}",
                 f"{chr(65 + index)}:") for index in range(26)
                if mask & (1 << index) and kernel.GetDriveTypeW(f"{chr(65 + index)}:\\") in (2, 3)
                and Path(f"{chr(65 + index)}:/").is_dir()]
    return [("/", "/app/host-filesystem", "This computer")]


def local_sources_override(root, *, production=False):
    """Refresh mounts on startup (including newly attached drives), never secrets.

    Production deployments keep their explicitly configured source roots. Only
    the backend gets drive access; AI workers receive the selected build copy.
    """
    root = Path(root)
    metadata = {}
    environment = root / ".env"
    if environment.is_file():
        for line in environment.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() in {"STACKPILOT_ENV", "STACKPILOT_LOCAL_FILESYSTEM"}:
                metadata[key.strip()] = value.strip().strip("\"'")
    enabled = os.environ.get("STACKPILOT_LOCAL_FILESYSTEM", metadata.get("STACKPILOT_LOCAL_FILESYSTEM", "true"))
    if production or metadata.get("STACKPILOT_ENV") == "production" or enabled.lower() in {"false", "0", "off"}:
        return None
    drives = host_filesystems()
    if not drives:
        return None
    mappings = [{"path": target, "host_path": source, "name": name} for source, target, name in drives]
    contents = json.dumps({"services": {"backend": {
        "environment": {"LOCAL_SOURCE_ROOT_MAPPINGS": json.dumps(mappings, ensure_ascii=False)},
        "volumes": [{"type": "bind", "source": source, "target": target, "read_only": True,
                     "bind": {"create_host_path": False}} for source, target, _ in drives]
    }}}, indent=2, ensure_ascii=False) + "\n"
    path = root / OVERRIDE_NAME
    if not path.is_file() or path.read_text(encoding="utf-8") != contents:
        temporary = path.with_suffix(".tmp")
        temporary.write_text(contents, encoding="utf-8")
        os.replace(temporary, path)
    return path
