import unittest
from unittest.mock import patch
import httpx
from app.connection_test import test_provider


class ConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def probe(self, response=None, exception=None, key="fixture-secret", model="fixture-model"):
        self.calls = []
        def handle(request):
            self.calls.append(request)
            if exception:
                raise exception
            return response
        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        with patch("app.connection_test.httpx.AsyncClient", return_value=client):
            return await test_provider("openai_compatible", "https://fixture.example/v1", key, model,
                                       {"model": model, "messages": [{"role": "user", "content": "Reply OK"}], "stream": False})

    async def test_real_completion_has_no_tools_and_one_request(self):
        result = await self.probe(httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]}))
        self.assertTrue(result["ok"])
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn(b"tools", self.calls[0].content)
        self.assertNotIn("fixture-secret", str(result))

    async def test_catalog_or_empty_completion_is_not_success(self):
        for body in ({"data": [{"id": "fixture-model"}]}, {"choices": []}, {"choices": [{"message": {"content": ""}}]}):
            result = await self.probe(httpx.Response(200, json=body))
            self.assertFalse(result["ok"])

    async def test_provider_failures_are_sanitized_and_never_retried(self):
        for status in (401, 403, 404, 429, 500, 302):
            result = await self.probe(httpx.Response(status, text="fixture-secret", headers={"Location": "https://elsewhere.example"}))
            self.assertFalse(result["ok"])
            self.assertEqual(len(self.calls), 1)
            self.assertNotIn("fixture-secret", str(result))

    async def test_timeout_and_malformed_response_fail_closed(self):
        result = await self.probe(exception=httpx.ConnectTimeout("fixture-secret"))
        self.assertFalse(result["ok"])
        self.assertNotIn("fixture-secret", str(result))
        self.assertFalse((await self.probe(httpx.Response(200, text="invalid")))["ok"])
        self.assertFalse((await self.probe(httpx.Response(200, content=b"x" * 65537)))["ok"])

    async def test_keyless_compatible_provider_does_not_send_empty_bearer(self):
        self.assertTrue((await self.probe(httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]}), key=""))["ok"])
        self.assertNotIn("Authorization", self.calls[0].headers)

    async def test_cloud_provider_missing_credentials_does_not_make_request(self):
        with patch("app.connection_test.httpx.AsyncClient") as client:
            result = await test_provider("nvidia_nim", "https://fixture.example/v1", "", "fixture-model", {})
        self.assertFalse(result["ok"])
        client.assert_not_called()
