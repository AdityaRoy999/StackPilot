"""Read-only text references retain exact assertion semantics and action isolation."""
import json
import os
from pathlib import Path
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.browser_testing.text_evidence import observe_text_evidence
from app.browser_testing.text_evidence import assertion_recovery_evidence


class TextEvidenceContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_recovery_observes_candidates_without_retargeting_or_passing_failure(self):
        from unittest.mock import patch
        original = {'status':'failed','purpose':'outcome','assertions':[{'status':'failed',
            'expectation':{'kind':'text','element_id':10,'expected':'mathematician'},'actual':'Other text'}]}
        candidate = {'id':21,'tag':'p','role':'text','read_only':True,'supported_actions':['assert'],
                     'text':'Ada was an English mathematician.'}
        session = SimpleNamespace(current_url='https://fixture.test/article')
        with patch('app.browser_testing.text_evidence.observe_text_evidence', AsyncMock(
                return_value={'text_evidence':[candidate]})) as observe:
            result = await assertion_recovery_evidence(session, original)
        observe.assert_awaited_once()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['assertions'], original['assertions'])
        self.assertEqual(result['recovery']['text_evidence'], [candidate])
        self.assertNotIn('recovery', original)

    async def test_passed_or_private_assertions_never_trigger_recovery_scan(self):
        from unittest.mock import patch
        for result in ({'status':'passed'}, {'status':'unverified','assertions':[{'status':'unverified',
                'actual':'[redacted]','expectation':{'kind':'text','expected':'[redacted]'}}]}):
            with patch('app.browser_testing.text_evidence.observe_text_evidence', AsyncMock()) as observe:
                self.assertEqual(await assertion_recovery_evidence(SimpleNamespace(), result), result)
                observe.assert_not_awaited()

    def setUp(self):
        self.controls = [{'id': 1, 'text': 'Remove', 'tag': 'button'}]
        self.session = SimpleNamespace(target_id='tab-a', current_url='https://fixture.test/cart',
            _navigation_generation=2, _selected_frame=None, _next_element_id=10,
            interactive_elements=self.controls, observed_targets={1: 'existing'},
            evaluate=AsyncMock(return_value={
                'text_evidence':[{'id': 10, 'text': '1', 'role':'text', 'read_only':True,
                                  'supported_actions':['assert']}],
                'text_evidence_total':1, 'text_evidence_has_more':False,
                'text_evidence_next_offset':None, 'text_evidence_scan_limited':False,
                'next_element_id':11}))

    async def test_query_returns_separate_assertion_only_references(self):
        result = await observe_text_evidence(self.session, 'quantity')
        self.assertEqual(result['text_evidence'][0]['text'], '1')
        self.assertEqual(self.session._next_element_id, 11)
        self.assertIs(self.session.interactive_elements, self.controls)
        self.assertEqual(self.session.observed_targets, {1:'existing'})
        self.assertNotIn('next_element_id', result)
        expression = self.session.evaluate.call_args.args[0]
        self.assertIn('"query": "quantity"', expression)
        self.assertNotIn('setAttribute(', expression)
        self.assertNotIn('dispatchEvent(', expression)
        self.assertNotIn('.click(', expression)

    async def test_unfiltered_and_invalid_queries_do_not_scan(self):
        for query, kwargs in [(None,{}), ('',{}), ('x'*121,{}), ('quantity',{'offset':True}),
                              ('quantity',{'limit':81}), ('quantity',{'scope':'unknown'})]:
            result = await observe_text_evidence(self.session, query, **kwargs)
            self.assertEqual(result['text_evidence'], [])
        self.session.evaluate.assert_not_awaited()

    async def test_query_is_encoded_as_data_and_boundaries_are_preserved(self):
        query = '"; window.bad=true; //'
        await observe_text_evidence(self.session, query, scope='viewport', offset=4, limit=7)
        expression = self.session.evaluate.call_args.args[0]
        self.assertIn(json.dumps({'query':query, 'scope':'viewport', 'offset':4, 'limit':7,
                                  'generation':2}), expression)
        self.assertEqual(self.session.evaluate.call_args.kwargs['timeout'], 2)

    async def test_identity_change_discards_stale_text_ids(self):
        original = self.session.evaluate.return_value
        async def replaced(*args, **kwargs):
            self.session._selected_frame = 'new-frame'
            return original
        self.session.evaluate.side_effect = replaced
        result = await observe_text_evidence(self.session, '1')
        self.assertEqual(result['text_evidence'], [])
        self.assertIn('changed', result['text_evidence_reason'])
        self.assertEqual(self.session._next_element_id, 10)

    async def test_failed_observation_or_native_dialog_cannot_supply_text(self):
        self.session.evaluate.side_effect = TimeoutError
        self.assertEqual((await observe_text_evidence(self.session, 'quantity'))['text_evidence'], [])
        self.session.evaluate.reset_mock()
        self.session.native_dialog = {'type':'confirm'}
        self.assertEqual((await observe_text_evidence(self.session, 'quantity'))['text_evidence'], [])
        self.session.evaluate.assert_not_awaited()

    async def test_allocator_never_moves_backwards(self):
        self.session._next_element_id = 100
        await observe_text_evidence(self.session, 'quantity')
        self.assertEqual(self.session._next_element_id, 100)


@unittest.skipUnless(os.getenv('AI_BROWSER_DOM_TESTS') == '1', 'Opt-in local Chromium DOM fixture')
class SemanticTextDOMTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from app.browser_testing.assertions import PROBE
        from app.browser_testing.text_evidence import TEXT_EVIDENCE_PROBE
        fixture = Path(__file__).resolve().parents[2] / 'tests/integration/browser_text_evidence_fixture.mjs'
        result = subprocess.run(['node', str(fixture)], input=json.dumps({
            'observation':TEXT_EVIDENCE_PROBE, 'assertion':PROBE}),
            text=True, encoding='utf-8', capture_output=True, timeout=45)
        if result.returncode:
            raise RuntimeError('Local DOM fixture failed: '+result.stderr[-2000:])
        cls.result = json.loads(result.stdout)

    def test_inline_code_and_permalink_preserve_real_heading_identity(self):
        headings = [item for item in self.result['heading']['text_evidence'] if item['tag']=='h1']
        self.assertEqual(headings[0]['text'], 'dataclasses — Data Classes')
        self.assertEqual(headings[0]['semantic_role'], 'heading')
        self.assertEqual(headings[0]['supported_actions'], ['assert'])
        self.assertTrue(headings[0]['read_only'])
        self.assertTrue(self.result['identity'])
        self.assertTrue(self.result['exact'][0]['matched'])
        self.assertFalse(self.result['wrongCase'][0]['matched'])

    def test_inline_role_heading_output_and_adjacent_fragments_are_aggregated(self):
        for key, text, tag in [('reference','API Reference','h2'), ('role','Typed Decisions','div'),
                               ('output','Build complete','output'), ('adjacent','PrefixCodeSuffix','h4')]:
            with self.subTest(key=key):
                self.assertTrue(any(item['tag']==tag and item['text']==text
                    for item in self.result[key]['text_evidence']))

    def test_hidden_inputs_and_editors_are_absent_from_evidence_context_and_assertion(self):
        for key in ('heading','privacy','privacyAssert','reference','role','output','adjacent'):
            self.assertNotIn('PRIVATE_', json.dumps(self.result[key]))
        self.assertTrue(self.result['privacyAssert'][0]['matched'])
        self.assertEqual(self.result['privacyAssert'][0]['actual'], 'Safe Title')

    def test_linked_and_inline_code_paragraphs_are_observable_and_assertable(self):
        self.assertTrue(any(item['tag']=='p' and item['text']=='Ada was an English mathematician and writer.'
                            for item in self.result['paragraph']['text_evidence']))
        self.assertTrue(self.result['paragraphAssert'][0]['matched'])
        self.assertTrue(any(item['tag']=='p' and item['text']=='This module provides a decorator and functions.'
                            for item in self.result['description']['text_evidence']))

    def test_native_input_names_match_labels_and_wrong_text_kind_is_actionable(self):
        self.assertTrue(self.result['nativeName'][0]['matched'])
        self.assertEqual(self.result['nativeName'][0]['actual'], 'StackPilot task')
        self.assertTrue(self.result['wrongInputText'][0]['unavailable'])
        self.assertIn('accessible_name', self.result['wrongInputText'][0]['reason'])

    def test_observation_dispatches_nothing_and_keeps_scope_and_staleness(self):
        self.assertEqual(self.result['effects'], {'mutations':[], 'clicks':0})
        self.assertFalse(any(item.get('semantic_role')=='heading'
            and item['text']=='Clickable heading excluded' for item in self.result['interactive']['text_evidence']))
        self.assertEqual(self.result['viewport']['text_evidence'], [])
        self.assertEqual(self.result['staleGeneration']['text_evidence'], [])
        self.assertFalse(self.result['detached'][0]['matched'])
        self.assertIn('found 0', self.result['detached'][0]['reason'])
