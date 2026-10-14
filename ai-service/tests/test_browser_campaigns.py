"""Durability, leases, authorization, budgets and interruption regressions."""
import asyncio
import hashlib
import hmac
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from app.browser_testing.campaign_store import CampaignStore
from app.browser_testing.campaigns import CampaignRuntime, requested_campaign, budgets_from_message
from app.browser_testing.campaign_api import router
from app.browser_testing.recovery import OperationRecovery
from app.browser_testing.transactions import validate_batch
from app.browser_testing.widgets import outcome_contract_error


class CampaignStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.now=100000.
        self.store=CampaignStore(Path(self.directory.name)/'campaigns.sqlite3','fixture-secret',lambda:self.now)
        self.job,_=self.store.create('owner','chat',{'goal':'Test 120 pages','provider_overrides':{'api_key':'PRIVATE_TEST_KEY'},'custom_url':'https://fixture.invalid'})

    def test_provider_login_and_input_evidence_are_encrypted_and_scoped(self):
        self.store.save_browser(self.job,{'cookies':[{'value':'PRIVATE_COOKIE'}]})
        self.store.event(self.job,{'type':'tool_call','text':'PRIVATE_INPUT'})
        self.assertEqual(self.store.job(self.job,'owner')['payload']['provider_overrides']['api_key'],'PRIVATE_TEST_KEY')
        raw=self.store.path.read_bytes()
        for value in (b'PRIVATE_TEST_KEY',b'PRIVATE_COOKIE',b'PRIVATE_INPUT'): self.assertNotIn(value,raw)
        for fn in (lambda:self.store.job(self.job,'other'),lambda:self.store.status(self.job,'owner','other-chat'),lambda:self.store.frames(self.job,'other')):
            with self.assertRaises(PermissionError): fn()
        self.assertNotIn('payload',self.store.status(self.job,'owner'))

    def test_one_worker_owns_a_job_and_stale_worker_cannot_commit(self):
        self.assertTrue(self.store.claim_job(self.job,'worker-a'))
        self.assertFalse(self.store.claim_job(self.job,'worker-b'))
        self.store.add_task(self.job,'page','one',{'url':'https://fixture.invalid/one'})
        task=self.store.claim(self.job,'worker-a')
        self.assertFalse(self.store.finish_task(self.job,task['id'],'worker-b',{}))
        self.now+=46;self.store.recover_expired()
        self.assertTrue(self.store.claim_job(self.job,'worker-b'))
        replacement=self.store.claim(self.job,'worker-b')
        self.assertFalse(self.store.finish_task(self.job,task['id'],'worker-a',{}))
        self.assertTrue(self.store.finish_task(self.job,replacement['id'],'worker-b',{'visited':True}))

    def test_completed_pages_survive_reopen_and_pending_pages_resume(self):
        for i in range(120): self.store.add_task(self.job,'page',str(i),{'url':f'https://fixture.invalid/{i}'})
        self.store.claim_job(self.job,'first')
        for _ in range(53):
            task=self.store.claim(self.job,'first');self.store.finish_task(self.job,task['id'],'first',{'visited':True})
        lost=self.store.claim(self.job,'first')
        self.now+=46
        reopened=CampaignStore(self.store.path,'fixture-secret',lambda:self.now);reopened.recover_expired()
        self.assertTrue(reopened.claim_job(self.job,'second'))
        pending=reopened.claim(self.job,'second')
        self.assertEqual(pending['id'],lost['id'])
        status=reopened.status(self.job,'owner')
        self.assertEqual(next(t['count'] for t in status['tasks'] if t['state']=='completed'),53)

    def test_interrupted_workflow_requires_reconciliation_and_never_blind_replay(self):
        self.store.add_task(self.job,'workflow','checkout',{'label':'Submit booking'})
        self.store.claim_job(self.job,'first');task=self.store.claim(self.job,'first')
        self.now+=46;self.store.recover_expired()
        self.assertEqual(self.store.status(self.job,'owner')['state'],'needs_reconciliation')
        self.assertIsNone(self.store.claim(self.job,'second'))
        with self.assertRaises(ValueError): self.store.control(self.job,'owner','resume')
        self.store.control(self.job,'owner','reconcile')
        self.assertTrue(self.store.claim_job(self.job,'second'))
        self.assertTrue(self.store.claim(self.job,'second')['payload']['reconcile'])

    def test_four_hour_deadline_survives_a_service_restart(self):
        self.now+=3*3600
        reopened=CampaignStore(self.store.path,'fixture-secret',lambda:self.now)
        runtime=CampaignRuntime(reopened,SimpleNamespace(),AsyncMock())
        self.assertEqual(runtime.limit_reason(reopened.job(self.job,'owner')),'')
        self.now+=3600
        self.assertIn('time budget',runtime.limit_reason(reopened.job(self.job,'owner')))
        reopened.control(self.job,'owner','pause')
        reopened.recover_expired()
        self.assertEqual(reopened.status(self.job,'owner')['state'],'budget_exhausted')

    def test_recording_persists_and_stops_on_every_terminal_or_pause_state(self):
        self.store.claim_job(self.job,'worker')
        self.assertTrue(self.store.frame(self.job,b'jpeg',self.now,{},1000))
        self.assertFalse(self.store.frame(self.job,b'x'*2000,self.now,{},1000))
        reopened=CampaignStore(self.store.path,'fixture-secret',lambda:self.now)
        self.assertEqual(reopened.read_frame(self.job,'owner',1),b'jpeg')
        for state in ('paused','waiting_for_permission','needs_reconciliation','completed','cancelled','budget_exhausted'):
            self.store.update(self.job,state=state)
            self.assertFalse(self.store.frame(self.job,b'after finish',self.now,{}))
        self.assertEqual(len(self.store.frames(self.job,'owner')),1)

    def test_answer_resumes_only_paused_task_and_cannot_grant_full_access(self):
        self.store.add_task(self.job,'workflow','search',{'label':'Search'})
        self.store.claim_job(self.job,'worker');task=self.store.claim(self.job,'worker')
        self.store.finish_task(self.job,task['id'],'worker',{},'waiting_for_input')
        self.store.update(self.job,state='waiting_for_input')
        self.store.answer(self.job,{'message':'Mumbai Central','agent_access_mode':'full_access'})
        self.store.control(self.job,'owner','resume')
        self.store.claim_job(self.job,'worker')
        resumed=self.store.claim(self.job,'worker')
        self.assertEqual(resumed['payload']['answer'],{'message':'Mumbai Central'})

    def test_deduplicates_jobs_pages_and_limits_discovery(self):
        same,created=self.store.create('owner','chat',{})
        self.assertEqual(same,self.job);self.assertFalse(created)
        for i in range(250): self.assertTrue(self.store.add_task(self.job,'page',str(i),{'url':str(i)}))
        self.assertFalse(self.store.add_task(self.job,'page','extra',{}))
        self.assertFalse(self.store.add_task(self.job,'page','1',{}))
        for budget in (False,0,10001):
            with self.assertRaises(ValueError): self.store.create('o','s',{},max_pages=budget)

    def test_heartbeat_tolerates_finished_task_but_stale_worker_is_fenced(self):
        self.store.claim_job(self.job,'worker')
        self.store.add_task(self.job,'page','one',{})
        task=self.store.claim(self.job,'worker')
        self.store.finish_task(self.job,task['id'],'worker',{})
        self.assertTrue(self.store.heartbeat(self.job,'worker',task['id']))
        self.now+=46
        self.store.claim_job(self.job,'replacement')
        self.assertFalse(self.store.update(self.job,worker='worker',state='completed'))
        self.assertFalse(self.store.save_browser(self.job,{'url':'old'},worker='worker'))
        self.assertIsNone(self.store.claim(self.job,'worker'))

    def test_resume_cannot_bypass_a_paused_question_or_interrupted_workflow(self):
        self.store.claim_job(self.job,'worker')
        self.store.add_task(self.job,'workflow','one',{})
        task=self.store.claim(self.job,'worker')
        self.store.finish_task(self.job,task['id'],'worker',{},'waiting_for_input')
        self.store.control(self.job,'owner','pause')
        with self.assertRaises(ValueError): self.store.control(self.job,'owner','resume')
        with self.assertRaises(ValueError): self.store.answer(self.job,{'message':'','approval_token':''})

    def test_terminal_results_cannot_be_replaced_and_retention_preserves_active_runs(self):
        self.store.claim_job(self.job,'worker')
        self.store.update(self.job,state='cancelled')
        self.assertFalse(self.store.update(self.job,worker='worker',state='paused'))
        self.store.release_job(self.job,'worker')
        active,_=self.store.create('owner','chat',{})
        self.now+=8*86400
        self.assertEqual(self.store.prune(),1)
        self.assertEqual(self.store.job(active,'owner')['state'],'queued')
        with self.assertRaises(PermissionError): self.store.job(self.job,'owner')


class CampaignRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.store=CampaignStore(Path(self.directory.name)/'worker.sqlite3','fixture-key')
        self.job,_=self.store.create('owner','chat',{'goal':'Test this website','message':'Test this website','user_id':'owner','session_id':'chat','custom_url':'https://fixture.invalid/'})
        self.session=SimpleNamespace(is_connected=True,current_url='https://fixture.invalid/',_selected_frame=None)
        self.manager=SimpleNamespace(sessions={'chat':self.session},configure_session=lambda *args:None,get_or_create_session=AsyncMock(return_value=self.session))
        self.runtime=CampaignRuntime(self.store,self.manager,AsyncMock())
        self.runtime.initialize=AsyncMock();self.runtime.record=AsyncMock()
        self.runtime.sample_frame=AsyncMock(return_value=True)
        self.enterContext(patch('app.browser_testing.campaigns.capture_session',new=AsyncMock(return_value={'url':'https://fixture.invalid/'})))
        self.store.claim_job(self.job,self.runtime.worker)
        self.reference={'id':self.job,'session_id':'chat','user_id':'owner'}

    async def test_page_retries_are_bounded_and_discovery_can_resume(self):
        self.store.add_task(self.job,'page','root',{'url':'https://fixture.invalid/'})
        self.runtime.discover=AsyncMock(side_effect=[ConnectionError(),ConnectionError(),{'task_state':'completed','summary':'Visited'}])
        await self.runtime.run(self.reference)
        self.assertEqual(self.runtime.discover.await_count,3)
        self.assertEqual(self.store.status(self.job,'owner')['state'],'completed')
        self.assertEqual(self.store.results(self.job,'owner')[0]['state'],'completed')

    async def test_pausing_active_workflow_requires_reconciliation(self):
        self.store.add_task(self.job,'workflow','form',{'label':'Submit form','url':'https://fixture.invalid/'})
        entered=asyncio.Event()
        async def interrupted(*args): entered.set();await asyncio.Event().wait()
        self.runtime.workflow=interrupted
        self.runtime.sessions['chat']=self.job
        worker=asyncio.create_task(self.runtime.run(self.reference));self.runtime.tasks[self.job]=worker
        await asyncio.wait_for(entered.wait(),2)
        await self.runtime.control(self.job,'owner','pause','chat')
        await asyncio.wait_for(worker,2)
        self.assertEqual(self.store.status(self.job,'owner')['state'],'needs_reconciliation')
        self.assertEqual(self.store.results(self.job,'owner')[0]['state'],'needs_reconciliation')
        self.assertFalse(self.runtime.protected())
        with self.assertRaises(ValueError): await self.runtime.control(self.job,'owner','resume','chat')
        await self.runtime.control(self.job,'owner','reconcile','chat')
        self.store.claim_job(self.job,self.runtime.worker)
        self.assertTrue(self.store.claim(self.job,self.runtime.worker)['payload']['reconcile'])

    async def test_cancelled_campaign_is_never_changed_back_to_paused(self):
        self.manager.get_or_create_session=AsyncMock(side_effect=ConnectionError())
        self.store.control(self.job,'owner','cancel')
        await self.runtime.run(self.reference)
        self.assertEqual(self.store.status(self.job,'owner')['state'],'cancelled')

    async def test_workflow_needs_real_outcome_checks_not_a_claimed_success(self):
        task={'id':1,'payload':{'label':'Run program','url':'https://fixture.invalid/'}}
        job=self.store.job(self.job,'owner')
        async def stream(*args,**kwargs):
            yield 'data: '+json.dumps({'type':'tool_result','result':{'purpose':'checkpoint','assertions':[{'status':'passed'}]}})+'\n\n'
            yield 'data: '+json.dumps({'type':'done','status':'verified','content':'Claimed success'})+'\n\n'
        with patch('app.main._stream_browser_agent_reply',new=stream):
            result=await self.runtime.run_workflow(job,task,asyncio.Event())
        self.assertFalse(result['verified']);self.assertEqual(result['task_state'],'unverified')

    async def test_campaign_blocks_other_sessions_and_external_origins_before_dispatch(self):
        from app.browser_testing.campaigns import campaign_scope
        self.runtime.cancellations[self.job]=asyncio.Event()
        token=campaign_scope.set((self.runtime,self.job,'owner'))
        dispatch=AsyncMock()
        try:
            for args in ({'session_id':'other','action':'navigate','url':'https://fixture.invalid/'},
                         {'session_id':'chat','action':'navigate','url':'https://external.invalid/'}):
                result=await self.runtime.record_tool('browser_interact',args,dispatch)
                self.assertEqual(result['status'],'blocked')
            self.assertEqual(dispatch.await_count,0)
        finally: campaign_scope.reset(token)

    async def test_provider_budget_reserves_unknown_usage_and_settles_reported_usage(self):
        from app.browser_testing.campaigns import campaign_scope
        self.runtime.cancellations[self.job]=asyncio.Event()
        token=campaign_scope.set((self.runtime,self.job,'owner'))
        try:
            payload={'messages':[{'role':'user','content':'Test fixture'}],'max_tokens':100}
            await self.runtime.reserve_model(payload)
            self.assertGreater(self.store.job(self.job,'owner')['tokens'],100)
            await self.runtime.settle_usage(self.job,35)
            self.assertEqual(self.store.job(self.job,'owner')['tokens'],35)
            self.store.update(self.job,tokens=999999)
            with self.assertRaises(asyncio.CancelledError): await self.runtime.reserve_model(payload)
            self.assertEqual(self.store.job(self.job,'owner')['state'],'budget_exhausted')
        finally: campaign_scope.reset(token)

    async def test_start_seeds_the_normalized_root_atomically_and_freezes_timezone(self):
        from app.main import AgentRequest
        request=AgentRequest(user_id='owner',session_id='new-chat',message='/test-long https://fixture.invalid',custom_url='https://fixture.invalid#section',runtime={'timezone':'Asia/Kolkata'})
        result=await self.runtime.start(request,{'max_pages':3})
        job=self.store.job(result['campaign_id'],'owner','new-chat')
        self.assertEqual(job['payload']['custom_url'],'https://fixture.invalid/')
        self.assertEqual(job['payload']['task_context']['timezone'],'Asia/Kolkata')
        self.assertEqual(self.store.status(job['id'],'owner')['tasks'],[{'kind':'page','state':'pending','count':1}])

    async def test_recovered_full_access_step_still_requires_fresh_exact_review(self):
        from app.browser_testing.permissions import approval_requirement
        session=SimpleNamespace(campaign_recovery=True,current_url='https://fixture.invalid/',interactive_elements=[{'id':2,'tag':'button','text':'Run'}])
        review=await approval_requirement(session,'browser_interact',{'action':'click','element_id':2})
        self.assertIn('interrupted',review['reason'])
        session.campaign_recovery=False
        self.assertIsNone(await approval_requirement(session,'browser_interact',{'action':'click','element_id':2}))


class CampaignApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.store=CampaignStore(Path(self.directory.name)/'api.sqlite3','fixture-key')
        self.job,_=self.store.create('owner','chat',{})
        app=FastAPI();app.include_router(router('fixture-key'))
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app),base_url='http://fixture.invalid')
        self.addAsyncCleanup(self.client.aclose)
        self.runtime=CampaignRuntime(self.store,SimpleNamespace(),AsyncMock())
        self.enterContext(patch('app.browser_testing.campaign_api.get_campaign_runtime',return_value=self.runtime))
        self.enterContext(patch('app.browser_testing.campaign_api.remote_device_active',return_value=True))
        self.runtime.initialize=AsyncMock()

    def ticket(self,user='owner',session='chat',control=True):
        import time
        data=json.dumps({'user_id':user,'session_id':session,'control':control,'expires':int(time.time())+240}).encode()
        return data.hex()+'.'+hmac.new(b'fixture-key',data,hashlib.sha256).hexdigest()

    async def test_status_recording_and_report_reject_missing_wrong_owner_or_chat(self):
        url=f'/ws/browser/chat/campaigns/{self.job}'
        for headers in ({},{'x-stackpilot-browser-ticket':self.ticket(session='wrong')},{'x-stackpilot-browser-ticket':self.ticket(user='other')}):
            response=await self.client.get(url,headers=headers)
            self.assertIn(response.status_code,(401,404))
        self.assertEqual((await self.client.get(url,headers={'x-stackpilot-browser-ticket':self.ticket()})).status_code,200)

    async def test_readonly_ticket_cannot_pause_or_cancel(self):
        url=f'/ws/browser/chat/campaigns/{self.job}/control'
        response=await self.client.post(url,json={'action':'cancel'},headers={'x-stackpilot-browser-ticket':self.ticket(control=False)})
        self.assertEqual(response.status_code,403)
        response=await self.client.post(url,json={'action':'pause'},headers={'x-stackpilot-browser-ticket':self.ticket()})
        self.assertEqual(response.status_code,200);self.assertEqual(response.json()['state'],'paused')


class BrowserRecoveryTests(unittest.TestCase):
    def test_tab_frame_batches_use_surface_ids_and_cannot_reuse_old_controls(self):
        self.assertIsNone(validate_batch([{'action':'switch_tab','target_id':'owned-tab'}]))
        self.assertIn('target_id',validate_batch([{'action':'switch_tab','element_id':2}]))
        self.assertIn('invalidates',validate_batch([{'action':'switch_frame','frame_id':'child'}, {'action':'type','element_id':3,'text':'code'}]))
        self.assertIsNone(validate_batch([{'action':'handle_dialog','dialog_id':'observed','accept':False}]))

    def test_changed_text_does_not_evade_operation_failure_limit(self):
        session=SimpleNamespace(current_url='https://fixture.invalid',interactive_elements=[{'id':3,'tag':'div','role':'textbox','input_id':'source','editor_kind':'ace'}])
        guard=OperationRecovery()
        for text in ('linked list','Hello World'):
            guard.record(session,{'action':'type','element_id':3,'text':text},{'status':'failed'})
        self.assertTrue(guard.blocked(session,{'action':'type','element_id':3,'text':'Hello'}))
        guard.editor_readback(session,3)
        self.assertFalse(guard.blocked(session,{'action':'type','element_id':3,'text':'linked list'}))
        guard.record(session,{'action':'type','element_id':3},{'status':'failed'})
        guard.editor_readback(session,3)
        self.assertTrue(guard.blocked(session,{'action':'type','element_id':3}))

    def test_source_editing_cannot_verify_compiler_execution(self):
        session=SimpleNamespace(task_context={'goal':'Execute a C++ linked-list program and give me its output'})
        self.assertTrue(outcome_contract_error(session,[{'kind':'editor_value','expected':'code'}],'outcome'))
        self.assertFalse(outcome_contract_error(session,[{'kind':'text','expected':'1 -> 2 -> 3'}],'outcome'))

    def test_large_test_requests_route_to_campaign_without_promoting_short_tests(self):
        for message in ('Test 100+ pages','Test for 4 hours','/test-long https://fixture.invalid'):
            self.assertTrue(requested_campaign(message))
        self.assertFalse(requested_campaign('Run the linked-list program'))
        self.assertFalse(requested_campaign('Can we test 100 pages for 4 hours?'))
        self.assertTrue(requested_campaign('Can you please test 100 pages for 4 hours?'))
        self.assertEqual(budgets_from_message('Test for 4 hours')['max_seconds'],14400)


if __name__=='__main__': unittest.main()
