"""Standard-library installation checks and conservative local updates."""
import json
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

REPOSITORY = "https://github.com/AdityaRoy999/StackPilot.git"
PROFILES = {"base": [], "core": ["ai", "browser"], "full": ["full"], "monitoring": ["full", "monitoring"]}


def run(args, root=None, timeout=30, env=None, log_path=None):
    options = {"cwd": root, "timeout": timeout, "text": True, "encoding": "utf-8", "errors": "replace", "env": env}
    if log_path:
        log_path = Path(log_path)
        log_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.chmod(log_path, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, **options)
    else:
        result = subprocess.run(args, capture_output=True, **options)
    if result.returncode:
        # Never copy subprocess output into HTTP responses: it can contain credentials.
        detail = f" Open the private log: {log_path}." if log_path else " Check Docker or the terminal and retry."
        raise RuntimeError(f"{Path(args[0]).name} {args[1] if len(args) > 1 else ''} failed (exit {result.returncode}).{detail}")
    return (result.stdout or "").strip()


def prerequisites():
    checks = [{"name": "Python 3.10+", "ok": sys.version_info >= (3, 10),
               "help": "https://www.python.org/downloads/"}]
    checks.append({"name": "Python venv / pip (Linux: python3-venv)",
                   "ok": importlib.util.find_spec("venv") is not None and importlib.util.find_spec("ensurepip") is not None,
                   "help": "https://docs.python.org/3/library/venv.html"})
    free = shutil.disk_usage(Path.home()).free / (1024 ** 3)
    checks.append({"name": f"Free disk: {free:.1f} GiB (10+ recommended for first builds)",
                   "ok": free >= 10, "required": False,
                   "help": "https://github.com/AdityaRoy999/StackPilot/blob/main/docs/guided-setup.md"})
    for name, url in [("Git", "https://git-scm.com/downloads"), ("Docker", "https://docs.docker.com/get-started/get-docker/")]:
        checks.append({"name": name, "ok": bool(shutil.which(name.lower())), "help": url})
    for name, command in [("Docker running", ["docker", "info", "--format", "{{.ServerVersion}}"]),
                          ("Linux containers", ["docker", "info", "--format", "{{.OSType}}"]),
                          ("Docker Compose v2", ["docker", "compose", "version", "--short"])]:
        try:
            value = run(command, timeout=8)
            ok = bool(value) and (name != "Docker Compose v2" or value.lstrip("v").split(".")[0].isdigit() and int(value.lstrip("v").split(".")[0]) >= 2)
            if name == "Linux containers":
                ok = value == "linux"
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            ok = False
        checks.append({"name": name, "ok": ok, "help": "https://docs.docker.com/get-started/get-docker/"})
    return checks


def compose(root, profile="core"):
    if profile not in PROFILES:
        raise ValueError("Choose a supported service profile.")
    command = ["docker", "compose", "-f", str(root / "docker-compose.yml")]
    for item in PROFILES[profile]:
        command += ["--profile", item]
    return command


def installation(root):
    """Read only routing/profile metadata; do not deserialize .env secrets."""
    root = Path(root).resolve()
    for path in [root / ".stackpilot-install.json", Path.home() / ".stackpilot" / "config.json"]:
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            if path.parent == root or Path(data.get("workspace", "")).resolve() == root:
                if data.get("production"):
                    raise RuntimeError("This is an HTTPS server installation. Use the documented server update procedure; the local setup wizard will not change it.")
                profile = data.get("profile", data.get("default_profile"))
                if profile in PROFILES:
                    return profile
    environment = root / ".env"
    if environment.is_file():
        for line in environment.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "STACKPILOT_ENV" and value.strip().strip("\"'") == "production":
                raise RuntimeError("Use the server update procedure for this production installation.")
    return None


def healthy(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return response.status == 200
    except (OSError, ValueError):
        return False


def wait_ready(report, timeout=600):
    report("Waiting for the backend and dashboard health checks…")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if healthy("http://127.0.0.1:8090/api/v1/health") and healthy("http://127.0.0.1:3000/api/health"):
            return
        time.sleep(3)
    raise RuntimeError("Services did not become healthy. Open the terminal, run stackpilot logs, fix the reported error, and retry. Your configuration and volumes have been kept.")


def update_status(root, fetch=True):
    root = Path(root).resolve()
    if not (root / "docker-compose.yml").is_file():
        raise RuntimeError("Choose an existing StackPilot checkout.")
    origin = run(["git", "remote", "get-url", "origin"], root)
    if origin.rstrip("/").removesuffix(".git").lower() not in {
        "https://github.com/adityaroy999/stackpilot", "git@github.com:adityaroy999/stackpilot"}:
        raise RuntimeError("Automatic updates require the official StackPilot origin.")
    if run(["git", "rev-parse", "--show-toplevel"], root).replace("\\", "/").lower() != str(root).replace("\\", "/").lower():
        raise RuntimeError("Workspace must be the repository root.")
    if run(["git", "branch", "--show-current"], root) != "main":
        raise RuntimeError("Switch to main before using automatic updates.")
    if run(["git", "status", "--porcelain"], root):
        raise RuntimeError("Local changes detected. Commit or move them before updating; nothing has been overwritten.")
    if fetch:
        run(["git", "fetch", "origin", "main"], root, 120)
    ahead, behind = map(int, run(["git", "rev-list", "--left-right", "--count", "HEAD...origin/main"], root).split())
    if ahead:
        raise RuntimeError("This checkout has local commits. Review them before updating.")
    return {"available": behind > 0, "commits": behind,
            "current": run(["git", "rev-parse", "HEAD"], root),
            "target": run(["git", "rev-parse", "origin/main"], root)}


def update(root, profile="core", report=print):
    root = Path(root).resolve()
    lock = root / ".stackpilot-update.lock"
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise RuntimeError("An update is already running. If its process exited, remove .stackpilot-update.lock after confirming no update is active.")
    try:
        with os.fdopen(descriptor, "w") as target:
            target.write(str(os.getpid()))
        return _update(root, profile, report)
    finally:
        lock.unlink()


def _update(root, profile="core", report=print):
    root = Path(root).resolve()
    profile = installation(root) or profile
    status = update_status(root)
    if not status["available"]:
        report("Already up to date.")
        return status
    command = compose(root, profile)
    report("Backing up configuration and PostgreSQL before updating…")
    backup = root / ".stackpilot-backups" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup.mkdir(parents=True, mode=0o700)
    if (root / ".env").is_file():
        with open(root / ".env", "rb") as source, open(backup / "environment", "xb") as target:
            os.chmod(target.name, 0o600)
            shutil.copyfileobj(source, target)
    # Credentials stay inside the container; no secrets in command arguments or logs.
    with open(backup / "database.dump", "xb") as target:
        os.chmod(target.name, 0o600)
        result = subprocess.run(command + ["exec", "-T", "postgres", "sh", "-c",
            'exec pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"'],
            cwd=root, stdout=target, stderr=subprocess.DEVNULL, timeout=120)
    if result.returncode:
        raise RuntimeError("Database backup failed. Start the existing PostgreSQL service and retry; the checkout was not updated.")
    (backup / "revision.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
    # A file edited while the backup ran also blocks the update.
    update_status(root, fetch=False)
    report("Applying the checked revision without overwriting local files…")
    run(["git", "merge", "--ff-only", status["target"]], root, 120)
    python = root / ".stackpilot-venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if python.is_file():
        run([str(python), "-m", "pip", "install", "--disable-pip-version-check", str(root / "stackpilot-cli")], root, 300, log_path=backup / "cli-install.log")
    report("Building updated services. Existing database and application volumes are preserved…")
    run(command + ["up", "-d", "--build"], root, 3600, log_path=backup / "build.log")
    wait_ready(report)
    report(f"Update healthy. Recovery backup: {backup}")
    return {**status, "backup": str(backup)}
