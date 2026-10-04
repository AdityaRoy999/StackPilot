"""Host-worker authentication and profile ownership, without launching host Chrome."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

path = Path(__file__).resolve().parents[2] / 'native-browser' / 'host.py'


@unittest.skipUnless(path.exists(), 'Host browser worker source must be available')
class HostWorkerTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('qa_host_worker', path)
        self.worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.worker)

    def test_worker_refuses_missing_authentication_before_starting_chrome(self):
        with self.assertRaisesRegex(ValueError, '32 characters'):
            self.worker.create_app('', 9226)

    def test_only_a_dedicated_profile_and_loopback_debugging_are_used(self):
        with tempfile.TemporaryDirectory() as root:
            args = self.worker.launch_args('chrome', root, 9226)
            self.assertIn('--headless=new', args)
            self.assertIn('--remote-debugging-address=127.0.0.1', args)
            self.assertIn('--user-data-dir=' + str(Path(root).resolve() / 'stackpilot-chrome-profile'), args)
            self.assertFalse(any('swiftshader' in value or '--no-sandbox' in value for value in args))

    def test_unauthorized_http_and_websocket_cannot_reach_chrome(self):
        from fastapi.testclient import TestClient
        app = self.worker.create_app('x' * 32, 9226)
        with TestClient(app) as client, patch.object(self.worker.httpx, 'AsyncClient') as upstream:
            self.assertEqual(client.get('/json/version').status_code, 401)
            with self.assertRaises(Exception):
                with client.websocket_connect('/devtools/browser/fixture'):
                    pass
            upstream.assert_not_called()

    def test_valid_authentication_is_forwarded_only_to_the_local_cdp_port(self):
        import httpx
        from fastapi.testclient import TestClient
        app = self.worker.create_app('x' * 32, 9226)
        upstream = AsyncMock()
        upstream.request.return_value = httpx.Response(200, json={'webSocketDebuggerUrl': 'ws://127.0.0.1:9226/devtools/browser/owned'})
        with TestClient(app) as client, patch.object(self.worker.httpx, 'AsyncClient') as factory:
            factory.return_value.__aenter__.return_value = upstream
            response = client.get('/json/version', headers={'Authorization': 'Bearer ' + 'x' * 32})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(upstream.request.call_args.args[:2], ('GET', 'http://127.0.0.1:9226/json/version'))
            self.assertEqual(client.get('/json/new', headers={'Authorization': 'Bearer ' + 'x' * 32}).status_code, 404)
