from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from app.service_readiness import observe


class Connection:
    def __init__(self, writable=True):
        self.writable = writable
        self.rolled_back = False
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def cursor(self): return self
    def execute(self, statement):
        if statement == 'BEGIN IMMEDIATE' and not self.writable:
            raise PermissionError('readonly journal')
    def fetchone(self): return [1]
    def close(self): pass
    def rollback(self): self.rolled_back = True


class ServiceReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def result(self, writable=True, constructor_error=None):
        connection = Connection(writable)
        journal = SimpleNamespace(connection=lambda: connection)
        original = httpx.AsyncClient
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json={'webSocketDebuggerUrl': 'ws://fixture/devtools'}))
        with patch.dict('os.environ', {'STACKPILOT_AI_SERVICE_TOKEN': 'fixture'}), \
             patch('app.tools.get_db_connection', return_value=Connection()), \
             patch('app.browser_testing.run_state.RunJournal', return_value=journal, side_effect=constructor_error), \
             patch('app.service_readiness.httpx.AsyncClient', side_effect=lambda **kwargs: original(transport=transport, **kwargs)):
            return await observe(), connection

    async def test_readiness_requires_writable_checkpoint_storage(self):
        result, connection = await self.result()
        self.assertTrue(result['ready'])
        self.assertTrue(result['dependencies']['browser_checkpoint_storage'])
        self.assertTrue(connection.rolled_back)

    async def test_healthy_browser_and_postgres_cannot_hide_readonly_journal(self):
        result, _ = await self.result(writable=False)
        self.assertFalse(result['ready'])
        self.assertTrue(result['dependencies']['browser'])
        self.assertTrue(result['dependencies']['database'])
        self.assertFalse(result['dependencies']['browser_checkpoint_storage'])

    async def test_unavailable_journal_marks_service_unready(self):
        result, _ = await self.result(constructor_error=OSError('missing storage'))
        self.assertFalse(result['ready'])
        self.assertFalse(result['dependencies']['browser_checkpoint_storage'])
