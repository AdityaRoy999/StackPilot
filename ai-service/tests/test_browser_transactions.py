import unittest
from app.browser_testing.transactions import validate_batch, completion_evidence, continue_batch_after, SUPPORTED_BATCH_ACTIONS, compile_batch


class TransactionTests(unittest.TestCase):
    def test_compiler_preserves_expectations_and_removes_redundant_field_clicks(self):
        controls = [{'id': i, 'tag': 'input', 'type': 'text'} for i in range(4)]
        actions = [step for i in range(4) for step in (
            {'action': 'click', 'element_id': i, 'description': 'Focus field'},
            {'action': 'type', 'element_id': i, 'text': str(i)},
            {'action': 'assert', 'element_id': i, 'expectations': [{'kind': 'value', 'expected': str(i)}]})]
        compiled = compile_batch(actions, controls)
        self.assertEqual(len(compiled), 8)
        self.assertIsNone(validate_batch(compiled))
        self.assertEqual(compiled[1]['expectations'][0]['element_id'], 0)
        self.assertEqual(len(actions), 12)
        self.assertIn('description', actions[0])

    def test_long_compatible_plan_still_validates_every_step_before_dispatch(self):
        self.assertIsNone(validate_batch(compile_batch([{'action': 'get_theme'}] * 12), max_actions=32))
        self.assertIsNotNone(validate_batch(compile_batch([{'action': 'get_theme'}] * 9 +
            [{'action': 'click', 'selector': '#invented'}]), max_actions=32))
        self.assertIsNotNone(validate_batch(compile_batch([{'action': 'get_theme'}] * 33), max_actions=32))

    def test_missing_required_arguments_in_late_steps_reject_the_whole_plan(self):
        for tail in ({'action': 'click'}, {'action': 'type', 'element_id': 4},
                     {'action': 'type', 'element_id': 4, 'text': None},
                     {'action': 'select_option', 'element_id': 4}, {'action': 'press_key'}):
            self.assertIn('No actions executed', validate_batch(
                [{'action': 'get_theme'}] * 9 + [tail], max_actions=32))

    def test_compiler_does_not_remove_unknown_or_noneditable_clicks(self):
        actions = [{'action': 'click', 'element_id': 5}, {'action': 'type', 'element_id': 5, 'text': 'value'}]
        self.assertEqual(compile_batch(actions, [{'id': 5, 'tag': 'button'}]), actions)
        self.assertEqual(compile_batch(actions, []), actions)

    def test_redundant_page_target_and_positive_visibility_are_normalized(self):
        actions = [
            {'action': 'navigate', 'url': 'https://fixture.invalid/contact'},
            {'action': 'assert', 'purpose': 'outcome', 'expectations': [
                {'kind': 'title', 'element_id': 1, 'expected': 'Contact'},
            ]},
        ]
        self.assertIsNone(validate_batch(actions, True))
        self.assertEqual(actions[-1]['expectations'], [{'kind': 'title', 'expected': 'Contact'}])
        visible = [{'action': 'assert', 'expectations': [
            {'kind': 'in_viewport', 'element_id': 2, 'expected': True},
        ]}]
        self.assertIsNone(validate_batch(visible))
        self.assertNotIn('expected', visible[0]['expectations'][0])
        self.assertIsNotNone(validate_batch([{'action': 'assert', 'expectations': [
            {'kind': 'in_viewport', 'element_id': 2, 'expected': False},
        ]}]))

    def test_oversized_batch_cannot_partially_execute(self):
        self.assertIn('No actions executed', validate_batch([{'action': 'get_theme'}] * 9))

    def test_navigation_can_end_with_route_specific_page_assertions(self):
        self.assertIsNone(validate_batch([
            {'action':'navigate','url':'https://fixture.invalid/contact'},
            {'action':'assert','purpose':'outcome','expectations':[{'kind':'title','expected':'Contact'}]}
        ],True))

    def test_navigation_rejects_old_control_ids_before_dispatch(self):
        for later in ({'action':'click','element_id':1},
                      {'action':'assert','expectations':[{'kind':'value','element_id':1,'expected':'old'}]}):
            self.assertIn('No actions executed',validate_batch([
                {'action':'navigate','url':'https://fixture.invalid/contact'},later]))

    def test_malformed_action_after_navigation_is_rejected_without_exception(self):
        for later in (None,'click',{'action':'assert','expectations':None}):
            self.assertIsNotNone(validate_batch([{'action':'navigate','url':'https://fixture.invalid/contact'},later]))
        self.assertIsNotNone(validate_batch([{'action':'navigate'}]))

    def test_invalid_terminal_assertion_rejected_before_mutation(self):
        actions=[{'action':'type','element_id':1,'text':'changed'},
                 {'action':'assert','purpose':'outcome','expectations':[{'kind':'value','element_id':1,'expected':True}]}]
        self.assertIsNotNone(validate_batch(actions,True))

    def test_completion_requires_explicit_terminal_assertion(self):
        self.assertIsNotNone(validate_batch([{'action':'click','element_id':1}],True))

    def test_unknown_action_is_rejected_before_any_valid_prefix(self):
        problem=validate_batch([{'action':'click','element_id':1},{'action':'invented_action'}])
        self.assertIn('No actions executed',problem)
        self.assertIsNotNone(validate_batch([]))
        self.assertIsNone(validate_batch([{'action':'get_theme'}]))

    def test_selector_and_dom_id_arguments_cannot_mutate_batch_prefix(self):
        for args in ({'action':'click','selector':'#theme'},{'action':'click','element_id':'theme'}):
            problem=validate_batch([{'action':'type','element_id':1,'text':'safe'},args])
            self.assertIn('No actions executed',problem)

    def test_advertised_batch_actions_match_executor_preflight(self):
        from app.tools import AGENT_TOOLS
        tool=next(t['function'] for t in AGENT_TOOLS if t['function']['name']=='browser_interact_batch')
        supported=tool['parameters']['properties']['actions']['items']['properties']['action']['enum']
        self.assertEqual(set(supported),SUPPORTED_BATCH_ACTIONS)

    def test_completion_cannot_use_failed_or_incomplete_evidence(self):
        assertions=[{'status':'passed'}]
        passed={'action':'assert','purpose':'outcome','assertions':assertions,'verification':{'verified':True,'effect_type':'assertion'}}
        self.assertTrue(completion_evidence([{}],[passed],True))
        self.assertFalse(completion_evidence([{},{}],[passed],True))
        self.assertFalse(completion_evidence([{}],[{**passed,'assertions':[{'status':'failed'}]}],True))
        self.assertFalse(completion_evidence([{}],[passed],False))

    def test_no_effect_scroll_can_reach_outcome_but_no_effect_click_cannot(self):
        scroll={'action':'scroll','status':'unverified','verification':{'verified':False,'effect_type':'no_effect'}}
        click={**scroll,'action':'click'}
        outcome={'action':'assert','purpose':'outcome','assertions':[{'status':'passed'}],
                 'verification':{'verified':True,'effect_type':'assertion'}}
        self.assertTrue(continue_batch_after(scroll))
        self.assertFalse(continue_batch_after(click))
        self.assertTrue(completion_evidence([{},{}],[scroll,outcome],True))
        self.assertFalse(completion_evidence([{},{}],[click,outcome],True))
