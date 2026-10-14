import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.remote_browser_recovery import RemoteBrowserUnavailable, ensure_remote_browser_ready


class FakeClient:
    def __init__(self, probes, backend_status=200, backend_error=""):
        self.probes = iter(probes)
        self.backend_status = backend_status
        self.backend_error = backend_error
        self.posts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return None

    async def get(self, url, **kwargs):
        self.last_probe = (url, kwargs)
        available = next(self.probes, False)
        return httpx.Response(200 if available else 503, json={"webSocketDebuggerUrl": "ws://worker/devtools/browser/id"} if available else {})

    async def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        return httpx.Response(self.backend_status, json={"error": self.backend_error} if self.backend_error else {})


class RemoteBrowserRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_healthy_worker_does_not_touch_backend(self):
        client = FakeClient([True])
        with patch("app.remote_browser_recovery.httpx.AsyncClient", return_value=client):
            await ensure_remote_browser_ready("http://remote:9222")
        self.assertEqual(client.posts, [])
        self.assertEqual(client.last_probe[1]["headers"], {"Host": "localhost"})

    async def test_stopped_tunnel_is_started_and_worker_waited_for(self):
        client = FakeClient([False, False, True])
        with patch.dict(os.environ, {"STACKPILOT_AI_SERVICE_TOKEN": "fixture", "BACKEND_INTERNAL_URL": "http://backend:8090"}), \
             patch("app.remote_browser_recovery.httpx.AsyncClient", return_value=client), \
             patch("app.remote_browser_recovery.asyncio.sleep", new=AsyncMock()):
            await ensure_remote_browser_ready("http://remote:9222")
        self.assertEqual(len(client.posts), 1)
        self.assertEqual(client.posts[0][0], "http://backend:8090/api/v1/internal/browser-tunnel/ensure")
        self.assertEqual(client.posts[0][1]["headers"], {
            "X-StackPilot-Service-Token": "fixture",
            "Authorization": "Bearer fixture",
        })

    async def test_missing_tunnel_reports_one_time_setup(self):
        client = FakeClient([False], 503, "Remote browser tunnel is not installed.")
        with patch.dict(os.environ, {"STACKPILOT_AI_SERVICE_TOKEN": "fixture"}), \
             patch("app.remote_browser_recovery.httpx.AsyncClient", return_value=client):
            with self.assertRaisesRegex(RemoteBrowserUnavailable, "not installed"):
                await ensure_remote_browser_ready("http://remote:9222")

    async def test_remote_session_connect_checks_worker_before_allocating_context(self):
        from app.browser_driver import BrowserSession

        with patch.dict(os.environ, {"REMOTE_BROWSER_SANDBOX_URL": "http://remote:9222"}), \
             patch("app.remote_browser_recovery.ensure_remote_browser_ready", new=AsyncMock(side_effect=RemoteBrowserUnavailable("offline"))) as ensure, \
             patch("app.browser_testing.isolation.open_context_owner", new=AsyncMock()) as owner:
            session = BrowserSession("fixture", sandbox_mode="remote")
            with self.assertRaisesRegex(RemoteBrowserUnavailable, "offline"):
                await session.connect()
        ensure.assert_awaited_once_with("http://remote:9222")
        owner.assert_not_awaited()
