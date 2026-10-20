"""A final observed response can complete without another paid planning turn."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.browser_testing.outcomes import BrowserOutcomeGuard, terminal_assertion
from app.browser_testing.assertions import assert_browser_state


class TerminalCompletionTests(unittest.TestCase):
    def setUp(self):
        self.args = {'purpose':'outcome', 'complete_task':True}
        self.result = {'action':'assert', 'status':'passed', 'purpose':'outcome',
            'verification':{'verified':True},
            'assertions':[{'status':'passed', 'expectation':{'kind':'text','expected':'Received!'},
                           'evidence_role':'outcome'}]}

    def test_new_confirmation_may_finish_targeted_workflow(self):
        guard = BrowserOutcomeGuard('Submit the demo form and verify its confirmation')
        guard.observe([{'id':1,'text':'Submit'}], 'https://fixture.test/form', 'Form')
        guarded = guard.assertion_result(self.result)
        self.assertTrue(terminal_assertion(self.args, guarded))

    def test_unchanged_launcher_cannot_complete_submission(self):
        guard = BrowserOutcomeGuard('Submit the demo form and verify its confirmation')
        guard.observe([{'id':1,'text':'Submit'}], 'https://fixture.test/form', 'Form')
        result = {**self.result, 'assertions':[{'status':'passed',
            'expectation':{'kind':'text','element_id':1,'expected':'Submit'}}]}
        self.assertFalse(terminal_assertion(self.args, guard.assertion_result(result)))

    def test_partial_or_failed_assertions_never_complete(self):
        for checks in ([], [{'status':'failed'}], [{'status':'passed'}, {'status':'failed'}]):
            self.assertFalse(terminal_assertion(self.args, {**self.result,'assertions':checks}))
        for status in ('unverified','blocked','failed'):
            self.assertFalse(terminal_assertion(self.args, {**self.result,'status':status}))

    def test_declaration_required_and_broad_audit_never_completed(self):
        self.assertFalse(terminal_assertion({'purpose':'outcome'}, self.result))
        self.assertFalse(terminal_assertion({'purpose':'outcome','complete_task':'true'}, self.result))
        self.assertFalse(terminal_assertion(self.args, self.result, broad=True))
        self.assertFalse(terminal_assertion(self.args, {**self.result,'purpose':'checkpoint'}))

    def test_inconsistent_or_missing_evidence_is_not_completion(self):
        self.assertFalse(terminal_assertion(self.args, {**self.result,'verification':{'verified':False}}))
        for role in (None,'unknown','checkpoint'):
            self.assertFalse(terminal_assertion(self.args, {**self.result,'assertions':[
                {'status':'passed','evidence_role':role}]}))


class AssertionRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_guessing_new_text_target_does_not_repeat_polling_wait(self):
        session = SimpleNamespace(current_url='https://fixture.test/cart', dispatched_inputs=1,
            evaluate=AsyncMock(return_value=[{'matched':False,'actual':'Card: Widget, quantity 1'}]))
        first = await assert_browser_state(session, [{'kind':'text','element_id':10,'expected':'1'}], 0)
        second = await assert_browser_state(session, [{'kind':'text','element_id':11,'expected':'1'}], 5)
        self.assertEqual(first['status'], 'failed')
        self.assertEqual(second['status'], 'failed')
        self.assertEqual(second['attempts'], 1)
        self.assertIn('text_evidence', second['hint'])
        session.evaluate.return_value = [{'matched':True,'actual':'1'}]
        third = await assert_browser_state(session, [{'kind':'text','element_id':12,'expected':'1'}], 5)
        self.assertEqual(third['status'], 'passed')
