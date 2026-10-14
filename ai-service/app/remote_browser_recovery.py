"""Wake a configured remote browser tunnel before allocating a new CDP tab."""

import asyncio
import os

import httpx


class RemoteBrowserUnavailable(ValueError):
    """An actionable remote-worker setup or recovery failure."""


async def ensure_remote_browser_ready(endpoint: str) -> None:
    async def ready(client: httpx.AsyncClient) -> bool:
        try:
            response = await client.get(endpoint + "/json/version", headers={"Host": "localhost"}, timeout=0.8)
            payload = response.json() if response.status_code == 200 else None
            return isinstance(payload, dict) and bool(payload.get("webSocketDebuggerUrl"))
        except (httpx.HTTPError, ValueError):
            return False

    async with httpx.AsyncClient(trust_env=False) as client:
        if await ready(client):
            return

        token = os.getenv("STACKPILOT_AI_SERVICE_TOKEN", "").strip()
        if not token:
            raise RemoteBrowserUnavailable("Remote browser tunnel recovery requires the AI service token.")
        backend = os.getenv("BACKEND_INTERNAL_URL", "http://backend:8090").rstrip("/")
        try:
            response = await client.post(
                backend + "/api/v1/internal/browser-tunnel/ensure",
                headers={"X-StackPilot-Service-Token": token, "Authorization": f"Bearer {token}"}, timeout=6,
            )
            if response.status_code != 200:
                try:
                    message = response.json().get("error", "Remote browser tunnel could not start.")
                except ValueError:
                    message = "Remote browser tunnel could not start."
                raise RemoteBrowserUnavailable(message)
        except httpx.HTTPError as exc:
            raise RemoteBrowserUnavailable("Remote browser tunnel recovery could not reach the StackPilot backend.") from exc

        # Docker start returns before the SSH forwards and remote Chrome are ready.
        # Allow the pinned SSH connection its full startup window.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 12
        while loop.time() < deadline:
            if await ready(client):
                return
            await asyncio.sleep(0.4)
        raise RemoteBrowserUnavailable("The tunnel started, but the remote browser is still unreachable. Check the remote worker and tunnel logs.")
