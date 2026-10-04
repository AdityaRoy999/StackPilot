import unittest
from unittest.mock import patch

from app import main


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_closing_repository_stream_closes_the_inner_provider_generator(self):
        closed=[]
        async def produce(*args):
            try:
                yield 'data: {"type":"content","delta":"Observed activity"}\n\n'
                yield 'data: {"type":"done"}\n\n'
            finally:closed.append(True)
        request=main.AgentRequest(message='Inspect repository',session_id='transport-fixture')
        with patch.object(main,'_stream_agent_reply_impl',produce):
            stream=main._stream_browser_agent_reply(request)
            await anext(stream)
            await stream.aclose()
        self.assertEqual(closed,[True])
