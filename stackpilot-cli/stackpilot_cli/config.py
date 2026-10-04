import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

CONFIG_DIR = Path.home() / ".stackpilot"
CONFIG_FILE = CONFIG_DIR / "config.json"
AUTH_FILE = CONFIG_DIR / "auth.json"

DEFAULT_CONFIG: Dict[str, Any] = {
    "backend_url": "http://localhost:8090",
    "ai_service_url": "http://localhost:8010",
    "browser_stream_url": "http://localhost:8099",
    "frontend_url": "http://localhost:3000",
    "default_profile": "core",
    "timeout_seconds": 60,
    "potato_mode": False
}

def ensure_config_dir() -> Path:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        CONFIG_DIR.chmod(0o700)
    return CONFIG_DIR


def _save_private(path: Path, data: Dict[str, Any]) -> None:
    ensure_config_dir()
    descriptor, temporary = tempfile.mkstemp(dir=CONFIG_DIR, prefix=".config-", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            json.dump(data, target, indent=2)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def load_config() -> Dict[str, Any]:
    ensure_config_dir()
    if not CONFIG_FILE.exists():
        save_config(DEFAULT_CONFIG)
        return DEFAULT_CONFIG.copy()
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            merged = DEFAULT_CONFIG.copy()
            merged.update(data)
            return merged
    except Exception:
        return DEFAULT_CONFIG.copy()

def save_config(config: Dict[str, Any]) -> None:
    _save_private(CONFIG_FILE, config)

def load_auth() -> Optional[Dict[str, Any]]:
    ensure_config_dir()
    if not AUTH_FILE.exists():
        return None
    try:
        with open(AUTH_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def save_auth(auth_data: Dict[str, Any]) -> None:
    _save_private(AUTH_FILE, auth_data)

def clear_auth() -> None:
    if AUTH_FILE.exists():
        AUTH_FILE.unlink()

def get_auth_token() -> Optional[str]:
    auth = load_auth()
    if auth:
        return auth.get("token")
    return None
