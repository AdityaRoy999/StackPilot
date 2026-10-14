import json
import unittest

import httpx

from app.browser_testing.visual_fallback import describe_visual_fallback, needs_visual_fallback


class VisualFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_image_bytes_are_sent_to_configured_model(self):
        seen = []
        def respond(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={'choices': [{'message': {'content': 'Visible dialog with a Close button.'}}]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            result = await describe_visual_fallback('data:image/jpeg;base64,/9j/', 'fixture-vision',
                                                    'https://vision.invalid/v1', {}, client=client)
        self.assertEqual(result['status'], 'observed')
        self.assertEqual(seen[0]['model'], 'fixture-vision')
        self.assertEqual(seen[0]['messages'][0]['content'][1]['image_url']['url'], 'data:image/jpeg;base64,/9j/')
        self.assertNotIn('tools', seen[0])

    async def test_invalid_frame_never_calls_provider(self):
        result = await describe_visual_fallback('not an image', 'fixture-vision', 'https://vision.invalid/v1', {})
        self.assertEqual(result['status'], 'unavailable')

    def test_escalates_sparse_or_occluded_state_only(self):
        self.assertTrue(needs_visual_fallback({'interactive_elements': []}))
        self.assertTrue(needs_visual_fallback({'status': 'failed', 'recovery': {'reason': 'occluded'}}))
        self.assertFalse(needs_visual_fallback({'status': 'passed', 'interactive_elements': [{'id': 1}, {'id': 2}]}))
