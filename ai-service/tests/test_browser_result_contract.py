import unittest

from app.browser_testing.result_contract import classify_browser_result


class ResultContractTests(unittest.TestCase):
    def test_dispatched_submission_without_outcome_is_not_complete(self):
        result = {'status': 'unverified', 'action': 'click', 'requires_outcome': True}
        self.assertEqual(classify_browser_result('browser_interact', result, 2, 'call-1'), {
            'dispatch_state': 'dispatched', 'verification_state': 'unverified', 'command_id': 'call-1'})

    def test_blocked_control_did_not_dispatch(self):
        result = {'status': 'stale_element', 'error': 'No input was dispatched.'}
        self.assertEqual(classify_browser_result('browser_interact', result, 0)['dispatch_state'], 'not_dispatched')

    def test_timeout_without_ack_is_uncertain(self):
        result = {'status': 'failed', 'error': 'Browser input acknowledgment timed out'}
        self.assertEqual(classify_browser_result('browser_interact', result, 0)['dispatch_state'], 'unknown')

    def test_outcome_requires_explicit_assertion(self):
        self.assertEqual(classify_browser_result('browser_interact', {'status': 'passed'}, 1)['verification_state'], 'checkpoint_passed')
        self.assertEqual(classify_browser_result('browser_assert', {'status': 'passed', 'purpose': 'outcome'}, 0)['verification_state'], 'outcome_passed')
        self.assertEqual(classify_browser_result('browser_interact_batch', {'status': 'passed', 'completion_verified': True}, 1)['verification_state'], 'outcome_passed')
