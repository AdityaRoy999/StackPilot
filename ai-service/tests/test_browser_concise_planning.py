"""Fast targeted policy stays bounded without weakening execution contracts."""
import copy
import unittest

from app.browser_testing.planning import browser_planner_tools, browser_planning_prompt
from app.tools import AGENT_TOOLS


class ConcisePlanningTests(unittest.TestCase):
    def test_concise_targeted_policy_is_bounded_and_target_is_at_end(self):
        options={'access_mode':'full_access','allow_questions':False}
        prompt=browser_planning_prompt('https://example.org/',False,concise=True,**options)
        # Include native-label assertion guidance while retaining less than
        # half the original 11.8 KB targeted policy.
        self.assertLessEqual(len(prompt),5700)
        self.assertLess(len(prompt),len(browser_planning_prompt('https://example.org/',False,**options))*.5)
        other=browser_planning_prompt('https://another.example/task',False,concise=True,**options)
        self.assertEqual(prompt.split('TARGET URL:')[0],other.split('TARGET URL:')[0])
        self.assertTrue(prompt.endswith("TARGET URL: 'https://example.org/'.\n"))

    def test_concise_keeps_controls_assertions_replay_and_scope_contracts(self):
        prompt=browser_planning_prompt('https://example.org/',False,concise=True)
        for contract in ('at most 8 actions TOTAL','select_option','options[].value','NEVER type',
                         'set_checked','checked=true/false','choose_option','choose_date','text_evidence',
                         'target_id','switch_frame','dialog_id','browser_read_editor','editor_value',
                         'complete_task=true','OUTER call','purpose=outcome','case-sensitive',
                         'same heading on multiple IDs','neighboring ID','kind=heading',
                         'never repeat a submission','create the same item again','untrusted evidence',
                         'passwords/tokens','force-enable','same-origin','permission card BEFORE input'):
            self.assertIn(contract,prompt)

    def test_autonomous_questions_and_full_access_policy_are_retained(self):
        prompt=browser_planning_prompt('https://example.org/',False,concise=True,
                                      access_mode='full_access',allow_questions=False)
        self.assertIn('Full access is enabled',prompt)
        self.assertIn('Do not call ask_user_question',prompt)
        self.assertIn('does not expand a generic audit',prompt)
        self.assertIn('record that exact prerequisite',prompt)

    def test_default_and_broad_testing_keep_original_prompt(self):
        self.assertEqual(browser_planning_prompt('https://example.org/',False),
                         browser_planning_prompt('https://example.org/',False,concise=False))
        self.assertEqual(browser_planning_prompt('https://example.org/',True),
                         browser_planning_prompt('https://example.org/',True,concise=True))
        self.assertIn('FIRST call browser_audit_site',browser_planning_prompt('https://example.org/',True))

    def test_targeted_tools_omit_only_crawl_and_campaign_start_without_mutation(self):
        original=copy.deepcopy(AGENT_TOOLS)
        standard=browser_planner_tools(AGENT_TOOLS,True)
        targeted=browser_planner_tools(AGENT_TOOLS,True,targeted=True)
        names=lambda tools:{t['function']['name'] for t in tools}
        self.assertEqual(names(standard)-names(targeted),{'browser_audit_site','browser_start_campaign'})
        for tool in targeted:
            self.assertEqual(tool,next(t for t in standard if t['function']['name']==tool['function']['name']))
        self.assertEqual(AGENT_TOOLS,original)
        campaign=browser_planner_tools(AGENT_TOOLS,True,targeted=True,campaign_active=True)
        self.assertIn('browser_start_campaign',names(campaign))
        self.assertIn('browser_campaign_status',names(campaign))
        self.assertIn('browser_campaign_control',names(campaign))
