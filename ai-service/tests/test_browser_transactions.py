import unittest
from app.browser_testing.transactions import validate_batch, completion_evidence, SUPPORTED_BATCH_ACTIONS


class TransactionTests(unittest.TestCase):
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
