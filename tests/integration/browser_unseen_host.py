"""Run the actual qualification planner on an isolated Windows Edge CDP worker.

Fallback for a stopped Docker engine. Uses the same planner, executor, fixed
manifest and provider; only the Chromium worker/runtime location changes. Never
connects to the user's normal browser profile. Provider settings are loaded into
this process from .env and never printed.
"""
import argparse
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen


def run() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--browser-executable", default=r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    args, rest = parser.parse_known_args()
    if "--run-live" not in rest:
        raise SystemExit("This worker wrapper requires --run-live; use browser_unseen_benchmark.py --list for the manifest.")
    root = Path(__file__).resolve().parents[2]
    executable = Path(args.browser_executable)
    if not executable.is_file():
        raise SystemExit("Set --browser-executable to an installed Chromium-based browser.")
    env_file = root / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8-sig").splitlines():
            key, separator, value = line.strip().partition("=")
            if separator and key.startswith(("NVIDIA_", "NVIDIA_NIM_", "OPENAI_COMPATIBLE_")):
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                    value = value[1:-1]
                if value:
                    os.environ.setdefault(key, value)
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="stackpilot-unseen-worker-", ignore_cleanup_errors=True) as temporary:
        endpoint = f"http://127.0.0.1:{port}"
        command = [str(executable), "--headless=new", "--no-first-run", "--no-default-browser-check",
                   "--disable-component-update", "--disable-background-networking",
                   "--remote-debugging-address=127.0.0.1", f"--remote-debugging-port={port}",
                   "--user-data-dir=" + str(Path(temporary) / "profile"), "about:blank"]
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            for _ in range(80):
                if process.poll() is not None:
                    raise RuntimeError("The isolated browser exited before its CDP worker became ready.")
                try:
                    with urlopen(endpoint + "/json/version", timeout=1) as response:
                        version = json.load(response)
                    break
                except OSError:
                    time.sleep(.25)
            else:
                raise RuntimeError("The isolated browser worker did not become ready.")
            os.environ["BROWSER_SANDBOX_URL"] = endpoint
            os.environ["BROWSER_STREAM_HOST"] = "127.0.0.1"
            os.environ["STACKPILOT_AGENT_RUN_DB"] = str(Path(temporary) / "browser-runs.sqlite3")
            # These anonymous tasks bypass only project recovery in the harness;
            # there is no backend or database in this standalone qualification.
            os.environ["DB_HOST"] = "127.0.0.1"
            os.environ["DB_CONNECT_TIMEOUT"] = "2"
            sys.path.insert(0, str(root / "ai-service"))
            sys.argv = [str(root / "tests/integration/browser_unseen_benchmark.py"), *rest,
                        "--runtime-label", "Windows isolated Edge CDP: " + str(version.get("Browser", "Chromium"))]
            runpy.run_path(sys.argv[0], run_name="__main__")
        finally:
            if process.poll() is None:
                # Only this wrapper's owned process tree; never user tabs/profiles.
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False)
                else:
                    process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()


if __name__ == "__main__":
    run()
