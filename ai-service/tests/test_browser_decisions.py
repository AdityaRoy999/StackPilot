import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

from app.browser_testing.decisions import SystemOneDecider, choice_probability, decision_stream
from app.browser_testing.planning import BrowserReasoningGate


def answer(choice, probabilities):
    return {'choice': choice, 'probabilities': probabilities}


class DecisionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.environment = patch.dict('os.environ', {
            'STACKPILOT_BROWSER_DECISION_URL': 'http://decision.test/v1/systemone',
            'STACKPILOT_BROWSER_DECISION_MODEL': 'multilingual',
            'STACKPILOT_BROWSER_DECISION_KEY': '',
            'STACKPILOT_BROWSER_DECISION_THRESHOLD': '.95',
            'STACKPILOT_BROWSER_DECISION_TIMEOUT_SECONDS': '.1',
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.session = SimpleNamespace(current_url='https://fixture.test/path?token=private',
            page_title='Fixture', interactive_elements=[
                {'id': 29, 'tag': 'button', 'text': 'Continue', 'is_in_viewport': True},
                {'id': 30, 'tag': 'a', 'text': 'Home', 'is_in_viewport': True},
                {'id': 31, 'tag': 'input', 'type': 'password', 'value': 'private', 'is_in_viewport': True}])
        self.data = {'answers': {
            'operation': answer('CLICK', {'CLICK': .99, 'REASON': .01}),
            'click_target': answer('1', {'1': .99, '2': .01})}}

    async def choose(self, handler=None, decider=None, **kwargs):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler or (
                lambda request: httpx.Response(200, json=self.data)))) as client:
            return await (decider or SystemOneDecider()).choose(client, self.session,
                kwargs.pop('goal', 'Open Continue'), targeted=True, mode='fast', **kwargs)

    async def test_choice_uses_only_observed_reference_without_values_or_url_tokens(self):
        bodies = []
        def handler(request):
            bodies.append(json.loads(request.content))
            return httpx.Response(200, json=self.data)
        result = await self.choose(handler)
        self.assertEqual(result, {'action': 'click', 'element_id': 29, 'include_frame': False})
        self.assertNotIn('private', json.dumps(bodies))
        self.assertNotIn('password', json.dumps(bodies))

    async def test_ambiguous_response_or_decline_returns_to_planner(self):
        for choice, scores in [('REASON', {'REASON': .99, 'CLICK': .01}),
                               ('CLICK', {'CLICK': .8, 'REASON': .2})]:
            self.data['answers']['operation'] = answer(choice, scores)
            self.assertIsNone(await self.choose())

    async def test_malformed_answers_fall_back_without_breaking_the_request(self):
        for data in ({'answers': None}, {'answers': []}, {'answers': 'invalid'}, []):
            decider = SystemOneDecider()
            self.assertIsNone(await self.choose(lambda request: httpx.Response(200, json=data), decider))
            self.assertTrue(decider.disabled)

    async def test_invalid_probability_distribution_and_unknown_target_never_execute(self):
        for target in (answer('999', {'1': .99, '2': .01}),
                       answer('1', {'1': float('nan'), '2': .01}),
                       answer('1', {'1': 1, '2': 1}),
                       answer('1', {'1': .2, '2': .8})):
            self.data['answers']['click_target'] = target
            decider = SystemOneDecider()
            # Invoke a duck client so JSON NaN transport validation does not
            # hide the invalid response from the adapter under test.
            client = SimpleNamespace(post=AsyncMock(return_value=SimpleNamespace(
                raise_for_status=lambda: None, json=lambda: self.data)))
            self.assertIsNone(await decider.choose(client, self.session, 'Continue', targeted=True, mode='fast'))
            self.assertTrue(decider.disabled)

    async def test_page_or_control_change_during_request_invalidates_choice(self):
        def handler(request):
            self.session.interactive_elements[0]['text'] = 'Delete account'
            return httpx.Response(200, json=self.data)
        self.assertIsNone(await self.choose(handler))

    async def test_repeated_unchanged_choice_returns_to_planner(self):
        decider = SystemOneDecider()
        self.assertIsNotNone(await self.choose(decider=decider))
        self.assertIsNone(await self.choose(decider=decider))
        self.assertEqual(decider.last_reason, 'repeated_choice')

    async def test_credentials_audits_and_thinking_mode_do_not_call_classifier(self):
        client = SimpleNamespace(post=AsyncMock())
        for goal, kwargs in [('Use password private', {}), ('Open Continue', {'targeted': False}),
                              ('Open Continue', {'mode': 'thinking'}), ('Open Continue', {'recovering': True})]:
            self.assertIsNone(await SystemOneDecider().choose(client, self.session, goal,
                **{'targeted': True, 'mode': 'fast', **kwargs}))
        client.post.assert_not_awaited()

    async def test_http_failure_opens_circuit_and_timeout_is_bounded(self):
        decider = SystemOneDecider()
        calls = []
        def handler(request):
            calls.append(request)
            return httpx.Response(404)
        self.assertIsNone(await self.choose(handler, decider))
        self.assertIsNone(await self.choose(handler, decider))
        self.assertEqual(len(calls), 1)
        async def slow(*args, **kwargs):
            await asyncio.sleep(1)
        decider = SystemOneDecider()
        self.assertIsNone(await decider.choose(SimpleNamespace(post=slow), self.session,
            'Continue', targeted=True, mode='fast'))
        self.assertTrue(decider.disabled)

    async def test_choice_enters_normal_tool_call_stream(self):
        async with decision_stream({'action': 'click', 'element_id': 29}, 4) as response:
            lines = [line async for line in response.aiter_lines() if line.startswith('data: {')]
            call = json.loads(lines[0][6:])['choices'][0]['delta']['tool_calls'][0]
            self.assertEqual(call['function']['name'], 'browser_interact')
            self.assertEqual(json.loads(call['function']['arguments'])['element_id'], 29)


class ReasoningGateTests(unittest.TestCase):
    def test_uncertain_input_recovers_but_harmless_hover_does_not(self):
        gate = BrowserReasoningGate()
        gate.record('browser_interact', {'status': 'unverified', 'action': 'hover'})
        self.assertFalse(gate.take())
        gate.record('browser_interact', {'status': 'unverified', 'action': 'click', 'target': 'Continue'})
        self.assertTrue(gate.take())
        self.assertFalse(gate.take())

    def test_distinct_failed_batch_steps_get_their_own_recovery_turn(self):
        gate = BrowserReasoningGate()
        for error in ('Missing suggestion', 'Popup replaced'):
            gate.record('browser_interact_batch', {'status': 'failed', 'action': 'batch',
                'results': [{'status': 'failed', 'action': 'click', 'error': error}]})
            self.assertTrue(gate.take())
            self.assertFalse(gate.take())

    def test_one_recovery_turn_then_fast_even_after_reads(self):
        gate = BrowserReasoningGate()
        self.assertFalse(gate.take())
        failure = {'status': 'failed', 'error': 'Target was replaced'}
        gate.record('browser_interact', failure)
        self.assertTrue(gate.take())
        gate.record('browser_observe', {'status': 'observed'})
        self.assertFalse(gate.take())
        gate.record('browser_interact', failure)
        self.assertFalse(gate.take())
        gate.record('browser_interact', {'status': 'passed'})
        gate.record('browser_interact', failure)
        self.assertTrue(gate.take())
