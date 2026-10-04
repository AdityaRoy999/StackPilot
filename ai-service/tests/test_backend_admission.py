import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app.agent_runtime.runtime import backend


class BackendAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, tool, result):
        response = MagicMock()
        response.json.return_value = result
        client = AsyncMock()
        client.post.return_value = response
        with patch('httpx.AsyncClient') as factory:
            factory.return_value.__aenter__.return_value = client
            return await backend(tool, {}, 'fixture-user')

    async def test_worker_capability_block_preserves_provisioning_request(self):
        result = {'status': 'blocked', 'scope': 'sandbox_admission', 'verified': False,
                  'error': 'Required sandbox capability is unavailable',
                  'missing': ['toolchain.image'], 'provisioning': {'implemented': False}}
        self.assertEqual(await self.request('_internal_agent_process', result), result)
        self.assertEqual(await self.request('_internal_agent_image', result), result)

    async def test_lease_revocation_still_raises(self):
        with self.assertRaisesRegex(RuntimeError, 'revoked'):
            await self.request('_internal_agent_process', {'error': 'Task lease revoked'})

    async def test_unrelated_errors_are_not_treated_as_admission(self):
        with self.assertRaisesRegex(RuntimeError, 'denied'):
            await self.request('_internal_agent_authorize',
                               {'status': 'blocked', 'scope': 'sandbox_admission',
                                'verified': False, 'error': 'Membership denied'})


if __name__ == '__main__':
    unittest.main()
