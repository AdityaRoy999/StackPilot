"""Real worker switching through the settings protocol in an isolated API process.

Run inside ai-service with PYTHONPATH=/app. No model calls, user chats or cookies
are used. Each tab/context belongs to this fixture and is disposed on shutdown.
"""
import argparse
from contextlib import asynccontextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import time
import uuid

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.main import browser_manager, websocket_browser_stream


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    args = parser.parse_args()

    @asynccontextmanager
    async def lifespan(app):
        yield
        for session_id in list(browser_manager.sessions):
            await browser_manager.close_session(session_id)

    api = FastAPI(lifespan=lifespan)
    api.websocket("/ws/browser/{session_id}")(websocket_browser_stream)
    session_id = str(uuid.uuid4())
    payload = json.dumps(dict(session_id=session_id, kind="browser", user_id="owned-sandbox-switch-qa",
        control=True, expires=int(time.time()) + 180), separators=(",", ":")).encode()
    ticket = payload.hex() + "." + hmac.new(os.environ["STACKPILOT_AI_SERVICE_TOKEN"].encode(), payload, hashlib.sha256).hexdigest()
    fixture_url = "data:text/html,<title>Owned sandbox switch QA</title><button>Fixture</button>"
    rows = []
    with TestClient(api) as client:
        for mode in ["local", "remote", "host", "local"]:
            started = time.monotonic()
            with client.websocket_connect(f"/ws/browser/{session_id}?ticket={ticket}&control_only=1") as socket:
                socket.send_json(dict(type="switch_mode", sandbox_mode=mode, url=fixture_url))
                result = socket.receive_json()
            row = dict(requested=mode, confirmed=result.get("browser_mode"),
                seconds=round(time.monotonic() - started, 3), url_preserved=result.get("url") == fixture_url,
                error=result.get("message"))
            rows.append(row)
            assert row["confirmed"] == mode and row["url_preserved"], row
            assert len(browser_manager.sessions) == 1
    output = dict(switches=rows, owned_contexts_cleaned=not browser_manager.sessions)
    if args.output:
        Path(args.output).write_text(json.dumps(output, indent=2))
    print(json.dumps(output), flush=True)


if __name__ == "__main__":
    main()
