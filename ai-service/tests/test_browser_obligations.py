import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from app.browser_testing.obligations import explicit_workflow, refresh_obligations, prepare_explicit_workflow_review


class ObligationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.goal='Test this website deeply. Complete safe checks before requesting a step-scoped permission to send the form. Do not actually submit.'
        self.url='https://fixture.invalid/'
        self.control={'id':31,'tag':'button','type':'submit','label':'Send','text':'Send',
            'form':True,'native_validity':True,'url':self.url}
        self.session=SimpleNamespace(is_connected=True,current_url=self.url,session_id='fixture',
            interactive_elements=[self.control],extract_interactive_tree=AsyncMock(),
            evaluate=AsyncMock(return_value=self.control))
        self.coverage={'controls_requiring_review':[
            {'url':self.url,'label':'email','tag':'input','native_validation_states':[False,True],'reason':'Native checks passed'},
            {'url':self.url,'label':'Send','tag':'button','type':'submit','reason':'Review submission'},
            {'url':self.url,'label':'Delete account','tag':'a','reason':'Review deletion'}]}

    async def test_explicit_workflow_prepares_current_exact_target_without_input(self):
        step=await prepare_explicit_workflow_review(self.goal,self.coverage,self.session)
        self.assertEqual(step['arguments']['element_id'],31)
        self.assertEqual(step['arguments']['action'],'click')
        self.session.extract_interactive_tree.assert_awaited_once()
        self.assertEqual(self.coverage['workflow_obligations'][1]['state'],'permission_prepared')
        self.assertEqual(self.coverage['workflow_obligations'][2]['state'],'pending_review')

    async def test_generic_deep_test_never_prepares_an_arbitrary_critical_button(self):
        self.assertIsNone(await prepare_explicit_workflow_review('Test everything on this website',self.coverage,self.session))
        self.session.evaluate.assert_not_awaited()
        self.assertEqual(len(self.coverage['workflow_obligations']),3)

    async def test_stale_ambiguous_and_changed_context_cannot_prepare(self):
        self.session.current_url=self.url+'other'
        self.assertIsNone(await prepare_explicit_workflow_review(self.goal,self.coverage,self.session))
        self.session.current_url=self.url
        self.session.interactive_elements.append({**self.control,'id':32})
        self.assertIsNone(await prepare_explicit_workflow_review(self.goal,self.coverage,self.session))
        self.session.interactive_elements=[self.control]
        self.session.evaluate.return_value={**self.control,'label':'Purchase'}
        self.assertIsNone(await prepare_explicit_workflow_review(self.goal,self.coverage,self.session))

    async def test_multiple_discovered_workflows_require_clarification(self):
        self.coverage['controls_requiring_review'].append({**self.coverage['controls_requiring_review'][1],'url':self.url+'other'})
        self.assertIsNone(await prepare_explicit_workflow_review(self.goal,self.coverage,self.session))
        self.session.evaluate.assert_not_awaited()
        self.assertEqual(self.coverage['workflow_obligations'][1]['state'],'blocked_ambiguous')

    async def test_unverified_input_or_invalid_form_keeps_prerequisite_obligation(self):
        self.coverage['controls_requiring_review'][0]['native_validation_states']=[True]
        self.assertIsNone(await prepare_explicit_workflow_review(self.goal,self.coverage,self.session))
        self.coverage['controls_requiring_review'][0]['native_validation_states']=[False,True]
        self.session.evaluate.return_value={**self.control,'native_validity':False}
        self.assertIsNone(await prepare_explicit_workflow_review(self.goal,self.coverage,self.session))
        self.assertEqual(self.coverage['workflow_obligations'][1]['state'],'blocked_prerequisite')

    async def test_executed_step_is_not_automatically_proposed_again(self):
        step=await prepare_explicit_workflow_review(self.goal,self.coverage,self.session)
        obligation=next(o for o in self.coverage['workflow_obligations'] if o['id']==step['obligation_id'])
        obligation['state']='executed_pending_verification'
        self.assertIsNone(await prepare_explicit_workflow_review(self.goal,self.coverage,self.session))

    async def test_reordered_discovery_cannot_recreate_an_executed_obligation(self):
        prepared=await prepare_explicit_workflow_review(self.goal,self.coverage,self.session)
        original=next(o for o in self.coverage['workflow_obligations'] if o['id']==prepared['obligation_id'])
        original['state']='executed_pending_verification'
        self.coverage['controls_requiring_review'].reverse()
        self.assertIsNone(await prepare_explicit_workflow_review(self.goal,self.coverage,self.session))
        current=next(o for o in self.coverage['workflow_obligations'] if o['id']==prepared['obligation_id'])
        self.assertEqual(current['state'],'executed_pending_verification')

    def test_duplicate_semantic_identities_are_ambiguous_not_new_steps(self):
        self.coverage['controls_requiring_review'].append(dict(self.coverage['controls_requiring_review'][1]))
        obligations=refresh_obligations(self.goal,self.coverage)
        duplicates=[o for o in obligations if o['label']=='Send']
        self.assertEqual(duplicates[0]['id'],duplicates[1]['id'])
        self.assertTrue(all(o['state']=='blocked_ambiguous' for o in duplicates))

    async def test_temporary_duplicate_does_not_erase_execution_evidence(self):
        prepared=await prepare_explicit_workflow_review(self.goal,self.coverage,self.session)
        original=next(o for o in self.coverage['workflow_obligations'] if o['id']==prepared['obligation_id'])
        original['state']='executed_pending_verification'
        self.coverage['controls_requiring_review'].append(dict(self.coverage['controls_requiring_review'][1]))
        refresh_obligations(self.goal,self.coverage)
        self.coverage['controls_requiring_review'].pop()
        self.assertIsNone(await prepare_explicit_workflow_review(self.goal,self.coverage,self.session))

    def test_original_goal_binding_cannot_adopt_page_or_other_task_intent(self):
        original=refresh_obligations(self.goal,self.coverage)
        ids={o['id'] for o in original}
        replacement=refresh_obligations('Test this website without submitting anything',self.coverage)
        self.assertTrue(ids.isdisjoint({o['id'] for o in replacement}))
        self.assertIsNone(explicit_workflow('Do not request permission to send the form.'))
        self.assertIsNone(explicit_workflow('Test the website without requesting permission to send the form.'))
        self.assertIsNone(explicit_workflow('Test all buttons, including Delete account.'))
