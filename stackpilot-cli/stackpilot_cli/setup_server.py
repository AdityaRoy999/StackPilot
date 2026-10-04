"""Loopback-only setup UI. Also runs directly from a downloaded launcher bundle."""
import argparse
import hmac
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from .lifecycle import installation, prerequisites, run, update, update_status, wait_ready, PROFILES
except ImportError:
    from lifecycle import installation, prerequisites, run, update, update_status, wait_ready, PROFILES


class SetupState:
    def __init__(self, workspace, installer_directory):
        self.workspace = Path(workspace).resolve()
        self.installers = Path(installer_directory).resolve()
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.Lock()
        self.job = {"running": False, "message": "Check prerequisites to get started.", "ok": None}

    def report(self, message):
        with self.lock:
            self.job["message"] = message

    def start(self, action, profile):
        if profile not in PROFILES or action not in {"install", "update", "check-update"}:
            raise ValueError("Unsupported setup action.")
        with self.lock:
            if self.job["running"]:
                raise ValueError("A setup operation is already running.")
            self.job = {"running": True, "message": "Checking your installation…", "ok": None}
        def work():
            try:
                saved_profile = installation(self.workspace)
                selected_profile = saved_profile or profile
                if action == "check-update":
                    info = update_status(self.workspace)
                    self.report(f"{info['commits']} update commits available." if info["available"] else "Already up to date.")
                else:
                    if not all(item["ok"] or item.get("required") is False for item in prerequisites()):
                        raise RuntimeError("Install the missing prerequisites, start Docker, then check again.")
                    if action == "update":
                        update(self.workspace, selected_profile, self.report)
                    else:
                        if not (self.workspace / ".env").is_file():
                            existing = run(["docker", "ps", "-a", "--filter", "name=^/stackpilot-postgres$", "--format", "{{.ID}}"], timeout=8)
                            volumes = run(["docker", "volume", "ls", "--filter", "label=com.docker.compose.project=stackpilot",
                                           "--filter", "label=com.docker.compose.volume=postgres_data", "--format", "{{.Name}}"], timeout=8)
                            if existing or volumes:
                                raise RuntimeError("Existing StackPilot database detected. Reopen stackpilot setup from its original checkout with the original .env; new secrets will not be generated over your saved data.")
                        self.report("Downloading StackPilot and building services. The first build can take several minutes…")
                        if os.name == "nt":
                            args = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                                    str(self.installers / "install.ps1"), "-Directory", str(self.workspace), "-Profile", selected_profile]
                        else:
                            args = ["bash", str(self.installers / "install.sh"), "--directory", str(self.workspace), "--profile", selected_profile]
                        run(args, self.workspace if self.workspace.is_dir() else Path.home(), 3600,
                            env={**os.environ, "STACKPILOT_SETUP_PYTHON": sys.executable},
                            log_path=Path.home() / ".stackpilot" / "setup.log")
                        wait_ready(self.report)
                        self.report("StackPilot is healthy. Open the dashboard to create your account and connect AI.")
                with self.lock:
                    self.job["ok"] = True
            except Exception as error:
                # Our lifecycle errors are deliberately secret-free; OS exceptions only contain local paths.
                self.report(str(error) if isinstance(error, (RuntimeError, ValueError, OSError)) else "Setup timed out. Check Docker and retry.")
                with self.lock:
                    self.job["ok"] = False
            finally:
                with self.lock:
                    self.job["running"] = False
        threading.Thread(target=work, daemon=True).start()


def create_server(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # No access logs containing the session token.

        def respond(self, status, payload, content_type="application/json"):
            data = payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type + "; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def allowed(self):
            expected = f"127.0.0.1:{self.server.server_port}"
            origin = self.headers.get("Origin")
            return (self.headers.get("Host") == expected and
                    (origin is None or origin == f"http://{expected}") and
                    hmac.compare_digest(self.headers.get("X-Setup-Token", ""), state.token))

        def do_GET(self):
            if self.path == "/" and self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}":
                self.respond(200, Path(__file__).with_name("setup.html").read_text(encoding="utf-8"), "text/html")
            elif not self.allowed():
                self.respond(403, {"error": "Reopen the setup link from your terminal."})
            elif self.path == "/status":
                with state.lock:
                    job = dict(state.job)
                try:
                    profile = installation(state.workspace)
                    self.respond(200, {"workspace": str(state.workspace), "installed": (state.workspace / ".env").is_file(), "profile": profile, "job": job})
                except (ValueError, OSError, RuntimeError):
                    self.respond(409, {"error": "This installation cannot use local setup. Check its configuration or follow the server update guide."})
            elif self.path == "/checks":
                self.respond(200, {"checks": prerequisites()})
            else:
                self.respond(404, {"error": "Unknown setup route."})

        def do_POST(self):
            if not self.allowed():
                # Drain a bounded small body before closing. Otherwise Windows may
                # reset the TCP connection before the client receives the rejection.
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if 0 < length <= 1024:
                        self.connection.settimeout(1)
                        self.rfile.read(length)
                except (ValueError, OSError):
                    pass
                self.respond(403, {"error": "Setup session not authorized."})
                return
            try:
                if self.path != "/action" or self.headers.get("Content-Type") != "application/json":
                    raise ValueError("Unsupported setup request.")
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024:
                    raise ValueError("Invalid request size.")
                data = json.loads(self.rfile.read(length))
                state.start(data["action"], data.get("profile", "core"))
                self.respond(202, {"started": True})
            except (ValueError, KeyError, TypeError):
                self.respond(400, {"error": "Invalid action or an operation is already running."})
    return ThreadingHTTPServer(("127.0.0.1", 0), Handler)


def default_workspace():
    config = Path.home() / ".stackpilot" / "config.json"
    try:
        candidate = Path(json.loads(config.read_text(encoding="utf-8"))["workspace"])
        if candidate.is_absolute() and (candidate / "docker-compose.yml").is_file() and (candidate / "stackpilot-cli").is_dir():
            return candidate.resolve()
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return Path.home() / "stackpilot"


def launch(workspace=None, installer_directory=None, open_browser=True):
    workspace = Path(workspace or default_workspace()).resolve()
    candidates = [Path(installer_directory)] if installer_directory else [Path(__file__).parent, workspace / "scripts"]
    installers = next((path for path in candidates if (path / "install.sh").is_file()), candidates[0])
    state = SetupState(workspace, installers)
    with create_server(state) as server:
        server.daemon_threads = True
        url = f"http://127.0.0.1:{server.server_port}/#{state.token}"
        print(f"StackPilot Setup: {url}\nKeep this terminal open. Press Ctrl+C when finished.", flush=True)
        if open_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace")
    parser.add_argument("--no-browser", action="store_true")
    options = parser.parse_args()
    if sys.version_info < (3, 10):
        sys.exit("Install Python 3.10 or newer to run StackPilot Setup.")
    launch(options.workspace, open_browser=not options.no_browser)
