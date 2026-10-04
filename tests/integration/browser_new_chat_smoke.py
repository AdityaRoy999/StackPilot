"""New-chat -> saved session -> owner ticket -> real Docker browser frames.

Creates/deletes only a disposable fixture account and chat. No model calls,
deployment changes, host-browser access, or existing user chat modifications.
"""
from stackpilot_test_artifacts import artifact_path
import asyncio
import base64
import json
from pathlib import Path
import secrets
import time
import uuid

import release_pipeline_smoke as release
from browser_authorization_smoke import sql


async def watch(session_id, ticket):
    import websockets
    from io import BytesIO
    from PIL import Image

    started = time.monotonic()
    events, frames, first_frame = set(), 0, None
    async with websockets.connect(
        f"ws://127.0.0.1:8010/ws/browser/{session_id}?ticket={ticket}",
        proxy=None, open_timeout=10, max_size=8 * 1024 * 1024,
    ) as socket:
        await socket.send(json.dumps({"type": "attach", "url": "about:blank", "video_codec": "jpeg", "sandbox_mode": "local"}))
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            message = await asyncio.wait_for(socket.recv(), timeout=15)
            payload = None
            if isinstance(message, bytes):
                if message[:2] == b"SP":
                    offset = 16 + int.from_bytes(message[14:16], "big")
                    payload = message[offset:]
            else:
                event = json.loads(message)
                events.add(event.get("type"))
                if event.get("type") == "browser_error":
                    raise AssertionError(event.get("message", "Browser failed"))
                if event.get("type") == "frame" and event.get("data"):
                    payload = base64.b64decode(event["data"])
            if payload:
                image = Image.open(BytesIO(payload))
                image.load()
                assert image.width > 0 and image.height > 0
                frames += 1
                if first_frame is None:
                    first_frame = time.monotonic() - started
                if frames >= 3 and "page_state" in events:
                    return {"decoded_frames": frames, "first_frame_seconds": round(first_frame, 2), "page_state_received": True}
    raise AssertionError("The saved new chat did not produce browser frames")


def main():
    run = uuid.uuid4().hex[:12]
    user = session = None
    try:
        user = release.api("POST", "/auth/register", {
            "username": "new-chat-" + run, "email": "new-chat-" + run + "@example.test",
            "password": "Fixture-" + secrets.token_hex(16) + "!aA1",
        })["user"]["id"]
        created = release.api("POST", "/ai/sessions", {})["session"]
        session = str(uuid.UUID(created["id"]))
        assert created["session_type"] == "agent_chat" and created["message_count"] == 0
        assert release.api("GET", "/ai/sessions/" + session)["messages"] == []
        ticket = release.api("GET", "/ai/browser-ticket/" + session)
        assert ticket["control"] is True
        result = asyncio.run(watch(session, ticket["ticket"]))
        assert sql("SELECT COUNT(*) FROM ai_runs WHERE user_id='" + user + "';") == "0"
        result.update({"verified": True, "new_chat_persisted": True, "owner_ticket_authorized": True, "model_calls": 0,
                       "visible_presentation_verified": False})
        (artifact_path('browser-new-chat-qualification-2026-09-30.json')).write_text(json.dumps(result, indent=2) + "\n")
        print("BROWSER_NEW_CHAT_PASS " + json.dumps(result), flush=True)
    finally:
        if session:
            release.api("POST", "/ai/chat/stop", {"session_id": session})
            release.api("DELETE", "/ai/sessions/" + session)
        if user:
            sql("DELETE FROM users WHERE id='" + user + "';")


if __name__ == "__main__":
    main()
