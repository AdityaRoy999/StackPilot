"""Regressions from the stopped portfolio audit: no repeated work or lost evidence."""
import asyncio
import json
import html
import os
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.browser_driver import BrowserManager, BrowserSession, browser_manager
from app.browser_testing.editors import input_already_matches
from app.browser_testing.frames import frame_transform, frame_point_is_clear
from app.browser_testing.loop import browser_call_signature
from app.browser_testing.permissions import PROBE, permission_reason
from app.browser_testing.planning import BrowserReasoningGate, compact_browser_messages
from app.browser_testing.progress import browser_progress_summary
from app.browser_testing.coverage import reconcile_ui_review, coverage_obligations
from app.browser_testing.result_contract import classify_browser_result
from app.tools import execute_tool_call


class RunEfficiencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_value_is_read_without_typing_or_replacing_an_editor(self):
        session=SimpleNamespace(evaluate=AsyncMock(return_value=True))
        self.assertTrue(await input_already_matches(session,{'action':'type','element_id':4,'text':'test value'}))
        script=session.evaluate.call_args.args[0]
        self.assertIn('e.value === "test value"',script)
        self.assertNotIn("'password'",script)
        self.assertNotIn('dispatchEvent',script)
        session.evaluate.reset_mock()
        self.assertFalse(await input_already_matches(session,{'action':'type','element_id':4,'text':'x','auto_select_suggestion':'x'}))
        session.evaluate.assert_not_awaited()

    async def test_readback_failure_falls_back_to_normal_input_path(self):
        session=SimpleNamespace(evaluate=AsyncMock(side_effect=TimeoutError()))
        self.assertFalse(await input_already_matches(session,{'action':'type','element_id':4,'text':'x'}))

    async def test_new_value_does_not_add_an_extra_browser_round_trip(self):
        session=SimpleNamespace(interactive_elements=[{'id':4,'value':''}],evaluate=AsyncMock())
        self.assertFalse(await input_already_matches(session,{'action':'type','element_id':4,'text':'new value'}))
        session.evaluate.assert_not_awaited()

    def test_old_batch_keeps_failed_step_and_passed_checks_after_compaction(self):
        result={'status':'failed','action':'batch','results':[
            {'status':'passed','action':'assert','assertions':[{'status':'passed','expectation':{'kind':'validity','element_id':3,'expected':True}}]},
            {'status':'blocked','action':'click','error':'Scope prerequisite','recovery':{'reason':'outside_test_scope'}}]}
        messages=[{'role':'tool','tool_call_id':'a','content':json.dumps(result)}]+[{'role':'assistant','content':'next'}]*10
        compact=json.loads(compact_browser_messages(messages)[0]['content'])
        self.assertEqual(compact['results'][1]['recovery']['reason'],'outside_test_scope')
        self.assertTrue(compact['results'][0]['assertions'][0]['expectation']['expected'])

    def test_progress_retains_distinct_validation_states_without_duplicate_checks(self):
        def case(value):
            return {'url':'https://fixture.invalid/','action':'assert','result':{'assertions':[
                {'status':'passed','expectation':{'kind':'validity','element_id':3,'expected':value}}]}}
        summary=browser_progress_summary([case(False),case(True),case(True)])
        self.assertEqual(len(summary['completed_checks']),2)
        self.assertEqual(summary['remaining_review'],[])

    def test_recorded_theme_check_leaves_review_but_a_form_action_does_not(self):
        coverage={'controls_requiring_review':[{'url':'https://fixture.invalid/','label':'Toggle theme'},
                                              {'url':'https://fixture.invalid/','label':'Send'}]}
        result={'status':'passed','verification':{'effect_type':'visual_state_change'}}
        controls=[{'id':3,'text':'Toggle theme'},{'id':4,'text':'Send','form':True}]
        for ref in [3,4]:reconcile_ui_review(coverage,result,{'action':'click','element_id':ref},'https://fixture.invalid/',controls)
        self.assertEqual([r['label'] for r in coverage_obligations(coverage)],['Send'])

    def test_existing_value_checkpoint_is_never_counted_as_input_or_outcome(self):
        result={'status':'passed','already_satisfied':True,'verification':{'effect_type':'value_already_set'}}
        self.assertEqual(classify_browser_result('browser_interact',result,0),
                         {'dispatch_state':'not_dispatched','verification_state':'checkpoint_passed'})

    def test_scope_block_and_benign_batch_do_not_enable_expensive_recovery(self):
        gate=BrowserReasoningGate()
        gate.record('browser_interact_batch',{'status':'failed','results':[
            {'status':'failed','action':'click','error':'Outside scope','recovery':{'reason':'outside_test_scope'}}]})
        self.assertFalse(gate.take())
        gate.record('browser_interact_batch',{'status':'unverified','results':[
            {'status':'unverified','action':'hover'}]})
        self.assertFalse(gate.take())

    def test_animation_jitter_does_not_reset_loop_detection_but_input_changes_do(self):
        session=SimpleNamespace(interactive_elements=[{'id':2,'value':'','box':[1,2,3,4]}])
        before=browser_call_signature('browser_interact',{'action':'click','element_id':2},session)
        session.interactive_elements[0]['box']=[1.3,2.5,3,4]
        self.assertEqual(browser_call_signature('browser_interact',{'action':'click','element_id':2},session),before)
        session.interactive_elements[0]['value']='changed'
        self.assertNotEqual(browser_call_signature('browser_interact',{'action':'click','element_id':2},session),before)

    def test_header_navigation_and_discovery_share_harmless_semantics(self):
        self.assertIn("nav,header,footer,[role=\"navigation\"]",PROBE)
        self.assertFalse(permission_reason({'action':'click'},{'tag':'button','label':'About','global':True},True))
        self.assertTrue(permission_reason({'action':'click'},{'tag':'button','label':'Delete','global':True},True))

    def test_theme_change_allows_restoration_without_ignoring_repeat_cycles(self):
        session=SimpleNamespace(interactive_elements=[{'id':2,'text':'Toggle theme'}],_observed_visual_state='dark')
        args={'action':'click','element_id':2}
        dark=browser_call_signature('browser_interact',args,session)
        session._observed_visual_state='light'
        self.assertNotEqual(browser_call_signature('browser_interact',args,session),dark)
        session._observed_visual_state='dark'
        self.assertEqual(browser_call_signature('browser_interact',args,session),dark)

    async def test_concurrent_cleanup_closes_once_without_keyerror(self):
        manager=BrowserManager()
        async def close():await asyncio.sleep(.01)
        session=SimpleNamespace(close=AsyncMock(side_effect=close))
        manager.sessions['idle']=session
        await asyncio.gather(manager.close_session('idle'),manager.close_session('idle'))
        session.close.assert_awaited_once()
        self.assertNotIn('idle',manager.sessions)

    async def test_scaled_frame_coordinates_and_parent_hit_testing(self):
        calls=[]
        async def command(method,params,cdp_session_id=None):
            calls.append((method,params,cdp_session_id))
            if method=='DOM.getFrameOwner':return {'backendNodeId':7}
            if method=='DOM.getBoxModel':return {'model':{'content':[100,80,500,80,500,280,100,280]}}
            if method=='Runtime.evaluate':return {'result':{'value':{'width':800,'height':400}}}
            if method=='DOM.getNodeForLocation':return {'backendNodeId':7,'frameId':'child'}
            raise AssertionError(method)
        session=SimpleNamespace(_main_frame_id='main',frame_parents={'child':'main'},
            frame_contexts={'main':{'session_id':None},'child':{'session_id':'C','context_id':4}},
            frame_session_roots={'C':'child'},send_command=command)
        self.assertEqual(await frame_transform(session,'child'),(100,80,.5,.5))
        self.assertTrue(await frame_point_is_clear(session,'child',150,105))
        self.assertIn(('DOM.getNodeForLocation',{'x':100,'y':50},'C'),calls)


@unittest.skipUnless(os.getenv('AI_BROWSER_LIVE_TESTS')=='1','Opt-in isolated Chromium efficiency regressions')
class LiveEfficiencyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session=BrowserSession('run-efficiency-'+self._testMethodName)
        await self.session.connect()
        browser_manager.sessions[self.session.session_id]=self.session
        self.addAsyncCleanup(self.cleanup)

    async def cleanup(self):await browser_manager.close_session(self.session.session_id)

    async def test_scaled_frame_fills_and_already_matching_batch_continues_once(self):
        content='<label>Email<input id="email" type="email" value="qa@example.test" oninput="window.events=(window.events||0)+1"></label><label>Name<input id="name"></label>'
        fixture='<iframe style="position:absolute;left:100px;top:80px;width:800px;height:400px;border:0;transform:scale(.5);transform-origin:top left" srcdoc="'+html.escape(content,quote=True)+'"></iframe>'
        tree=(await self.session.send_command('Page.getFrameTree'))['frameTree']
        await self.session.send_command('Page.setDocumentContent',{'frameId':tree['frame']['id'],'html':fixture})
        deadline=time.monotonic()+5
        while True:
            tree=(await self.session.send_command('Page.getFrameTree'))['frameTree']
            children=tree.get('childFrames') or []
            if children and children[0]['frame']['id'] in self.session.frame_contexts:break
            if time.monotonic()>deadline:self.fail('Child frame context did not load')
            await asyncio.sleep(.05)
        switched=await self.session.switch_frame(children[0]['frame']['id'])
        self.assertEqual(switched['status'],'passed',switched)
        self.assertAlmostEqual(self.session.frame_scale[0],.5,places=2)
        refs={c.get('input_id'):c['id'] for c in self.session.interactive_elements}
        actions=[{'action':'type','element_id':refs['email'],'text':'qa@example.test'},
                 {'action':'type','element_id':refs['name'],'text':'Fixture'},
                 {'action':'assert','expectations':[{'kind':'value','element_id':refs['name'],'expected':'Fixture'}]}]
        result=await execute_tool_call('browser_interact_batch',{'session_id':self.session.session_id,'include_frame':False,'actions':actions},'efficiency-fixture')
        self.assertEqual(result['status'],'passed',result)
        self.assertEqual(len(result['results']),3)
        self.assertTrue(result['results'][0]['already_satisfied'])
        self.assertEqual(await self.session.evaluate('window.events||0'),0)


if __name__=='__main__':unittest.main()
