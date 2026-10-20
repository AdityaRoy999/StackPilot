import unittest

from app.browser_testing.intent import is_broad_browser_goal
from app.browser_testing.outcomes import BrowserOutcomeGuard
from app.browser_testing.transactions import verified_batch_report


ABOUT = {'id': 2739558384781445, 'input_id': 'about-nav', 'tag': 'button',
         'text': 'About', 'is_in_viewport': True}


def assertion(spec, actual=None):
    return {'status': 'passed', 'action': 'assert', 'purpose': 'outcome',
            'verification': {'verified': True, 'effect_type': 'assertion'},
            'assertions': [{'status': 'passed', 'expectation': spec,
                            'actual': spec.get('expected') if actual is None else actual}]}


class BrowserOutcomeTests(unittest.TestCase):
    def guard(self, goal='Open the About section', broad=False):
        guard = BrowserOutcomeGuard(goal, broad)
        guard.observe([ABOUT], 'https://fixture.invalid/', 'Portfolio')
        return guard

    def test_short_test_commands_mean_broad_coverage(self):
        for goal in ('test', 'TEST!', '/test', 'test it', 'test https://fixture.invalid/',
                     '/test https://fixture.invalid/', 'test www.fixture.com', 'test the website',
                     'audit this', 'test everything on this website'):
            with self.subTest(goal=goal):
                self.assertTrue(is_broad_browser_goal(goal))
        for goal in ('Test the contact form validation', 'Verify the page title is Fixture',
                     'Test logging in with Google', 'Open the About section', 'Test the date picker'):
            with self.subTest(goal=goal):
                self.assertFalse(is_broad_browser_goal(goal))

    def test_unchanged_label_passes_only_as_a_checkpoint(self):
        for spec in ({'kind': 'text', 'element_id': ABOUT['id'], 'expected': 'About'},
                     {'kind': 'text', 'selector': '#about-nav', 'expected': 'About'},
                     {'kind': 'text', 'selector': 'nav button', 'expected': 'About'},
                     {'kind': 'text', 'expected': 'About', 'match': 'contains'},
                     {'kind': 'visible', 'element_id': ABOUT['id']},
                     {'kind': 'in_viewport', 'element_id': ABOUT['id']},
                     {'kind': 'title', 'expected': 'Portfolio'},
                     {'kind': 'url', 'expected': 'https://fixture.invalid/'},
                     {'kind': 'focused', 'element_id': ABOUT['id'], 'expected': True}):
            with self.subTest(spec=spec):
                result = self.guard().assertion_result(assertion(spec))
                self.assertEqual(result['status'], 'passed')
                self.assertEqual(result['purpose'], 'checkpoint')
                self.assertEqual(result['requested_purpose'], 'outcome')
                self.assertTrue(result['completion_reason'])

    def test_assert_only_batch_cannot_launder_an_unchanged_control_label(self):
        spec = {'kind': 'text', 'element_id': ABOUT['id'], 'expected': 'About'}
        args = {'complete_task': True, 'actions': [{'action': 'assert', 'purpose': 'outcome', 'expectations': [spec]}]}
        result = self.guard().tool_result('browser_interact_batch', args,
            {'status': 'passed', 'completion_verified': True, 'results': [assertion(spec)]})
        self.assertFalse(result['completion_verified'])
        self.assertEqual(result['results'][0]['purpose'], 'checkpoint')

    def test_actual_destination_and_changed_route_are_outcomes(self):
        for spec in ({'kind': 'in_viewport', 'selector': '#about-section'},
                     {'kind': 'url', 'expected': 'https://fixture.invalid/about'},
                     {'kind': 'text', 'selector': '#result', 'expected': 'Saved'}):
            with self.subTest(spec=spec):
                self.assertEqual(self.guard().assertion_result(assertion(spec))['purpose'], 'outcome')

    def test_changed_control_state_keeps_its_original_baseline(self):
        guard = BrowserOutcomeGuard('Expand the details')
        guard.observe([{'id': 8, 'input_id': 'toggle', 'text': 'Expand'}])
        guard.observe([{'id': 9, 'input_id': 'toggle', 'text': 'Collapse'}])
        result = guard.assertion_result(assertion({'kind': 'text', 'selector': '#toggle', 'expected': 'Collapse'}))
        self.assertEqual(result['purpose'], 'outcome')
        result = guard.assertion_result(assertion({'kind': 'text', 'element_id': 9, 'expected': 'Collapse'}))
        self.assertEqual(result['purpose'], 'outcome')

    def test_explicit_observation_can_verify_unchanged_title_and_label(self):
        for goal, spec in (('Verify the page title is Portfolio', {'kind': 'title', 'expected': 'Portfolio'}),
                           ('Check the About button label', {'kind': 'text', 'element_id': ABOUT['id'], 'expected': 'About'})):
            with self.subTest(goal=goal):
                self.assertEqual(self.guard(goal).assertion_result(assertion(spec))['purpose'], 'outcome')

    def test_read_prefix_does_not_make_sign_in_an_observation_task(self):
        result = self.guard('Check that I can sign in with Google').assertion_result(
            assertion({'kind': 'title', 'expected': 'Portfolio'}))
        self.assertEqual(result['purpose'], 'checkpoint')
        result = self.guard('Check the About button label').assertion_result(
            assertion({'kind': 'title', 'expected': 'Portfolio'}))
        self.assertEqual(result['purpose'], 'checkpoint')

    def test_legitimate_workflow_outcome_does_not_complete_a_broad_audit(self):
        spec = {'kind': 'text', 'selector': '#result', 'expected': 'Saved'}
        args = {'complete_task': True, 'actions': [{'action': 'assert', 'purpose': 'outcome', 'expectations': [spec]}]}
        result = self.guard('test', broad=True).tool_result('browser_interact_batch', args,
            {'completion_verified': True, 'results': [assertion(spec)]})
        self.assertFalse(result['completion_verified'])
        self.assertEqual(result['results'][0]['purpose'], 'outcome')
        self.assertIn('audit', result['completion_reason'])

    def test_report_counts_outcomes_separately_from_static_checkpoints(self):
        specs = [{'kind': 'text', 'element_id': ABOUT['id'], 'expected': 'About'},
                 {'kind': 'in_viewport', 'selector': '#about-section'}]
        result = self.guard().assertion_result({'action': 'assert', 'purpose': 'outcome', 'status': 'passed',
            'assertions': [assertion(spec)['assertions'][0] for spec in specs]})
        report = verified_batch_report({'results': [result]})
        self.assertIn('Verified 1', report)
        self.assertIn('#about-section', report)
        self.assertNotIn('element #2739558384781445', report)

    def test_baseline_never_copies_entered_field_values(self):
        guard = BrowserOutcomeGuard('Enter the text')
        guard.observe([{'id': 1, 'text': 'Name', 'value': 'private fixture value'}])
        self.assertNotIn('value', guard.controls[('id', '1')])

    def test_destination_text_does_not_alias_old_navigation_caption(self):
        guard = self.guard('Open the About page and verify its heading')
        evidence = {'id':21,'tag':'h1','role':'text','read_only':True,'supported_actions':['assert']}
        guard.observe_readonly([evidence], 'https://fixture.invalid/about')
        result = guard.assertion_result(assertion({'kind':'text','element_id':21,'expected':'About'}))
        self.assertEqual(result['purpose'], 'outcome')
        # A current launcher or guessed CSS alias is not this read-only result.
        for spec in ({'kind':'text','element_id':ABOUT['id'],'expected':'About'},
                     {'kind':'text','selector':'nav button','expected':'About'}):
            self.assertEqual(guard.assertion_result(assertion(spec))['purpose'], 'checkpoint')

    def test_same_page_or_actionable_caption_cannot_use_destination_exception(self):
        guard = self.guard()
        guard.observe_readonly([{'id':21,'tag':'p','role':'text','read_only':True,'supported_actions':['assert']}],
                               'https://fixture.invalid/')
        guard.observe_readonly([{'id':22,'tag':'button','role':'text','read_only':True,'supported_actions':['assert']}],
                               'https://fixture.invalid/about')
        for ref in (21,22):
            self.assertEqual(guard.assertion_result(assertion({'kind':'text','element_id':ref,'expected':'About'}))['purpose'], 'checkpoint')

    def test_search_and_destination_links_do_not_contaminate_original_baseline(self):
        guard = self.guard('Search for an article and verify its heading and lead')
        guard.observe([{'id':11,'tag':'a','text':'Ada Lovelace'}], 'https://fixture.invalid/search')
        guard.observe([{'id':12,'tag':'a','text':'mathematician'}], 'https://fixture.invalid/article')
        for spec in ({'kind':'text','selector':'h1','expected':'Ada Lovelace'},
                     {'kind':'text','expected':'mathematician','match':'contains'}):
            self.assertEqual(guard.assertion_result(assertion(spec))['purpose'], 'outcome')
        # A direct assertion on that current link remains just its caption.
        self.assertEqual(guard.assertion_result(assertion(
            {'kind':'text','element_id':12,'expected':'mathematician'}))['purpose'], 'checkpoint')
        self.assertEqual(guard.assertion_result(assertion(
            {'kind':'text','expected':'About','match':'contains'}))['purpose'], 'checkpoint')


if __name__ == '__main__':
    unittest.main()
