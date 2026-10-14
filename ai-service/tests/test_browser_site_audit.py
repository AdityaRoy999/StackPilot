import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.browser_driver import BrowserSession,browser_manager
from app.browser_testing.site_audit import SiteAuditor,canonical_url,risky_label,download_control
from app.testing_runtime import build_test_report,action_status
from app.tools import execute_tool_call,_compact_interactive_elements


class AuditContracts(unittest.TestCase):
    def test_origin_scope_preserves_distinct_routes_and_hash_router(self):
        root = 'https://fixture.invalid/'
        self.assertEqual(canonical_url('/Path?x=2',root),'https://fixture.invalid/Path?x=2')
        self.assertEqual(canonical_url('/#section',root),root)
        self.assertEqual(canonical_url('/#/settings',root),root+'#/settings')
        for url in ('javascript:alert(1)','https://other.invalid/','http://fixture.invalid/','https://user:secret@fixture.invalid/'):
            self.assertIsNone(canonical_url(url,root))
        self.assertTrue(risky_label('Sign out'))

    def test_long_link_destination_is_not_truncated(self):
        href = '/records/'+('identifier-'*20)+'?view=detail'
        self.assertEqual(_compact_interactive_elements([{'id':1,'tag':'a','text':'詳細','href':href}])[0]['href'],href)

    def test_resume_and_export_controls_are_downloads_not_general_ui(self):
        self.assertTrue(download_control({'tag':'button','label':'Resume'}))
        self.assertTrue(download_control({'tag':'a','text':'Get file','href':'/resume.pdf'}))
        self.assertTrue(download_control({'tag':'button','label':'Export CSV'}))
        self.assertFalse(download_control({'tag':'button','label':'Resume playback'}))
        self.assertFalse(download_control({'tag':'button','label':'Save settings'}))
        self.assertEqual(action_status({'action':'click','verification':{
            'verified':False,'effect_type':'download_canceled'}}),'failed')

    def test_coverage_report_cannot_hide_untested_pages(self):
        report = build_test_report([], 'https://fixture.invalid/','Fixture',coverage={
            'visited_pages':1,'discovered_pages':2,'routes':[{'url':'/','status':'visited'},{'url':'/detail','status':'pending'}],
            'controls_requiring_review':[{'url':'/','label':'Send','reason':'Submission untested'}]})
        self.assertIn('INCOMPLETE',report)
        self.assertIn('1/2',report)
        self.assertIn('/detail',report)
        self.assertIn('Submission untested',report)


class AutonomousValidationTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, *, max_actions=10):
        session=SimpleNamespace(session_id='native-check',target_url='https://fixture.invalid/',
            current_url='https://fixture.invalid/')
        execute=AsyncMock(return_value={'status':'passed'})
        auditor=SiteAuditor(session,execute,include_frame=False,autonomous=True,max_actions=max_actions)
        auditor.add_case=AsyncMock()
        control={'id':1,'tag':'input','type':'email','name':'email','label':'Email',
                 'required':True,'current_value':'original@example.test'}
        auditor.controls=AsyncMock(side_effect=[[{**control,'id':index}] for index in range(2,7)])
        return auditor,execute,control

    async def test_native_cases_reacquire_targets_and_restore_original_value(self):
        auditor,execute,control=self.fixture()
        review={}
        await auditor.validate_input(control,review)
        actions=[call.args[1] for call in execute.await_args_list if call.args[0]=='browser_interact']
        assertions=[call.args[1] for call in execute.await_args_list if call.args[0]=='browser_assert']
        self.assertEqual([action['element_id'] for action in actions],[2,4,6])
        self.assertEqual([action['text'] for action in actions],['','qa+stackpilot@example.test','original@example.test'])
        self.assertEqual([check['expectations'][0]['element_id'] for check in assertions],[3,5])
        self.assertEqual(review['native_validation_states'],[False,True])
        self.assertTrue(review['input_restored'])

    async def test_failed_input_cannot_count_as_passed_validation(self):
        auditor,execute,control=self.fixture()
        execute.return_value={'status':'failed'}
        review={}
        await auditor.validate_input(control,review)
        self.assertFalse(any(call.args[0]=='browser_assert' for call in execute.await_args_list))
        self.assertEqual(review['native_validation_states'],[])
        self.assertEqual(execute.await_args_list[-1].args[1]['text'],control['current_value'])

    async def test_already_empty_field_is_asserted_without_retyping_it(self):
        auditor,execute,control=self.fixture()
        control['current_value']=''
        auditor.controls=AsyncMock(side_effect=[[{**control,'id':index}] for index in range(2,6)])
        review={}
        await auditor.validate_input(control,review)
        actions=[call.args[1] for call in execute.await_args_list if call.args[0]=='browser_interact']
        self.assertEqual([action['text'] for action in actions],['qa+stackpilot@example.test',''])
        self.assertEqual(execute.await_args_list[0].args[0],'browser_assert')
        self.assertEqual(review['native_validation_states'],[False,True])

    async def test_budget_reserves_an_action_for_restoration(self):
        auditor,execute,control=self.fixture(max_actions=2)
        review={}
        await auditor.validate_input(control,review)
        self.assertEqual(auditor.actions,2)
        self.assertEqual(execute.await_args_list[-1].args[1]['text'],control['current_value'])
        self.assertTrue(review['input_restored'])

    async def test_sensitive_readonly_and_unpreservable_inputs_receive_no_value(self):
        for changes in ({'type':'password'},{'type':'file'},{'tag':'select','type':'select-one'},
                        {'readonly':True},{'current_value':None}):
            auditor,execute,control=self.fixture()
            await auditor.validate_input({**control,**changes},{})
            execute.assert_not_awaited()


@unittest.skipUnless(os.getenv('AI_BROWSER_LIVE_TESTS')=='1','Opt-in same-origin local audit fixture')
class LiveAuditTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests=[]
        async def serve(reader,writer):
            try:
                request = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'),3)
                method,path,_ = request.split(b'\r\n',1)[0].decode().split(' ')
                self.requests.append((method,path))
                if path=='/resume.pdf':
                    body=b'%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n'
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="resume.pdf"\r\nConnection: close\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
                    await writer.drain()
                    return
                if path=='/':
                    html='''<!doctype html><title>Audit root</title><style>body{margin:0}</style>
                    <a href="/two">第二</a><a href="/three">3</a><a href="/two">Duplicate destination</a>
                    <a id="section-link" href="#bottom" onclick="event.preventDefault();document.getElementById('bottom').scrollIntoView()">Section</a>
                    <button id="theme" type="button" onclick="document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light'">Theme</button>
                    <form method="POST" action="/sent"><input required name="email" type="email">
                    <button id="budget" type="button" onclick="this.setAttribute('aria-pressed','true')">Small budget</button><button>Send</button></form>
                    <a href="/account/delete">Delete account</a><a href="https://external.invalid/">External</a>
                    <div style="height:1200px"></div><section id="bottom"><h2>Bottom</h2></section>'''
                else:
                    html=f'<!doctype html><title>Audit {path}</title><h1>{path}</h1><a href="/">Home</a><a href="/two">第二</a><a href="/three">3</a>'
                body=html.encode()
                writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
                await writer.drain()
            except (ConnectionError,asyncio.IncompleteReadError,TimeoutError):
                pass
            finally:
                writer.close()
                await writer.wait_closed()
        self.server=await asyncio.start_server(serve,'0.0.0.0',0)
        port=self.server.sockets[0].getsockname()[1]
        fixture_host=os.getenv('AI_BROWSER_FIXTURE_HOST','ai-service')
        self.session=BrowserSession('audit-fixture',target_url=f'http://{fixture_host}:{port}/',
            sandbox_mode=os.getenv('AI_BROWSER_TEST_MODE','local'))
        await self.session.connect()
        browser_manager.sessions[self.session.session_id]=self.session
        await self.session.navigate(self.session.target_url)
        self.addAsyncCleanup(self.cleanup)

    async def cleanup(self):
        await browser_manager.close_session(self.session.session_id)
        self.server.close()
        await self.server.wait_closed()

    async def audit(self,**kwargs):
        theme=next(c['id'] for c in self.session.interactive_elements if c.get('input_id')=='theme')
        return await execute_tool_call('browser_audit_site',{'session_id':self.session.session_id,
            'ui_control_ids':[theme],'max_pages':10,'max_seconds':30,**kwargs},'fixture')

    async def test_route_queue_hover_and_section_oracle_never_submit_or_delete(self):
        self.session.audit_read_only=True
        result=await self.audit()
        self.assertEqual(result['coverage']['visited_pages'],3)
        self.assertEqual(result['coverage']['discovered_pages'],3)
        self.assertFalse(result['coverage']['exhaustive'])
        sections=[c for c in result['cases'] if c['label']=='Section target section']
        self.assertEqual(sections[0]['result']['status'],'passed')
        self.assertTrue(any(c['action']=='hover' and c['result']['status']=='passed' for c in result['cases']))
        self.assertTrue(any(c['label']=='Theme' and c['result']['status']=='passed' for c in result['cases']))
        self.assertTrue(any(c['label']=='Send' for c in result['coverage']['controls_requiring_review']))
        self.assertFalse(any(method=='POST' or '/delete' in path for method,path in self.requests))
        cached=await execute_tool_call('browser_audit_site',{'session_id':self.session.session_id},'fixture')
        self.assertTrue(cached['cached'])
        self.assertEqual(cached['actions'],result['actions'])
        await self.session.navigate(self.session.target_url)
        # The audit was generic; this separate scenario explicitly requests
        # sending so its exact step can exercise the approval boundary.
        self.session.task_context = {'goal':'Send the form'}
        send=next(c['id'] for c in self.session.interactive_elements if c.get('tag')=='button' and c.get('text')=='Send')
        blocked=await execute_tool_call('browser_interact',{'session_id':self.session.session_id,'action':'click','element_id':send},'fixture')
        self.assertEqual(blocked['status'],'failed')
        self.assertIn('invalid required fields',blocked['error'])
        email=next(c['id'] for c in self.session.interactive_elements if c.get('name')=='email')
        typed=await execute_tool_call('browser_interact',{'session_id':self.session.session_id,'action':'type',
            'element_id':email,'text':'qa@example.test','include_frame':False},'fixture')
        self.assertEqual(typed['status'],'passed')
        send=next(c['id'] for c in self.session.interactive_elements if c.get('tag')=='button' and c.get('text')=='Send')
        blocked=await execute_tool_call('browser_interact',{'session_id':self.session.session_id,'action':'click','element_id':send},'fixture')
        self.assertTrue(blocked.get('approval_required'),blocked)

        await self.session.evaluate("document.querySelector('input').focus()")
        blocked=await execute_tool_call('browser_interact',{'session_id':self.session.session_id,'action':'press_key'},'fixture')
        self.assertTrue(blocked.get('approval_required'),blocked)
        self.assertFalse(any(method=='POST' for method,path in self.requests))

    async def test_returned_document_uses_fresh_ids_for_remaining_controls(self):
        # A custom navigation control changes the document during the root
        # control loop. Subsequent controls must be reacquired on return.
        await self.session.evaluate("""(() => {
            const nav=document.createElement('nav');
            nav.innerHTML='<a href="/two" onclick="location.href=this.href;return false">Next page</a>';
            document.body.prepend(nav);
        })()""")
        self.session.audit_read_only=True
        result=await self.audit(include_hover=False,include_frame=False,max_seconds=60)
        self.assertTrue(any(c['label']=='Next page' and c['result']['status']=='passed' for c in result['cases']))
        self.assertTrue(any(c['label']=='Theme' and c['result']['status']=='passed' for c in result['cases']))
        self.assertFalse(any(c['result'].get('status')=='stale_element' for c in result['cases']))
        self.assertFalse(any(method=='POST' or '/delete' in path for method,path in self.requests))

    async def test_header_and_footer_duplicate_labels_are_not_ambiguous(self):
        await self.session.evaluate("""document.body.insertAdjacentHTML('afterbegin','<header><a href="/two">Same link</a></header>');
            document.body.insertAdjacentHTML('beforeend','<footer><a href="/two">Same link</a></footer>');""")
        self.session.audit_read_only=True
        result=await self.audit(include_frame=False,max_seconds=60)
        self.assertTrue(any(c['label']=='Same link' and c['action']=='hover' and c['result']['status']=='passed' for c in result['cases']))
        self.assertFalse(any(c['label']=='Same link' and 'ambiguous' in c['reason'] for c in result['coverage']['controls_requiring_review']))

    async def test_page_budget_keeps_pending_routes_visible(self):
        result=await self.audit(max_pages=1,include_hover=False)
        self.assertEqual(result['coverage']['visited_pages'],1)
        self.assertEqual(result['coverage']['pending_pages'],2)
        self.assertIn('Page budget',result['coverage']['stop_reason'])

    async def test_positive_and_negative_native_input_validation_never_submit(self):
        self.session.audit_read_only=True
        email=next(c['id'] for c in self.session.interactive_elements if c.get('name')=='email')
        async def valid(expected):
            return await execute_tool_call('browser_assert',{'session_id':self.session.session_id,'purpose':'outcome',
                'expectations':[{'kind':'validity','element_id':email,'expected':expected}],'timeout_seconds':0},'fixture')
        self.assertEqual((await valid(False))['status'],'passed')
        for text,expected in (('invalid-email',False),('qa@example.test',True)):
            typed=await execute_tool_call('browser_interact',{'session_id':self.session.session_id,'action':'type',
                'element_id':email,'text':text,'include_frame':False},'fixture')
            self.assertEqual(typed['status'],'passed')
            self.assertEqual((await valid(expected))['status'],'passed')
        self.assertFalse(any(method=='POST' or '/sent' in path for method,path in self.requests))

    async def test_missing_click_target_cannot_approve_body_or_send_data(self):
        from app.browser_testing.permissions import approval_requirement, resolve_browser_arguments
        self.session.audit_read_only=True
        for args in ({'action':'click'},{'action':'click','selector':'#theme'},
                     {'action':'click','text':'Missing fixture control'}):
            self.assertIsNone(await approval_requirement(self.session,'browser_interact',args,True))
            result=await execute_tool_call('browser_interact',{'session_id':self.session.session_id,**args},'fixture')
            self.assertEqual(result['status'],'stale_element')
            self.assertFalse(result.get('approval_required'))
        args=resolve_browser_arguments(self.session,'browser_interact',{'action':'click','text':'Send'})
        requirement=await approval_requirement(self.session,'browser_interact',args,True)
        self.assertEqual(requirement['label'],'Send')
        self.assertFalse(any(method=='POST' for method,path in self.requests))

    async def test_original_goal_obligation_prepares_live_send_after_native_cases_without_dispatch(self):
        from app.browser_testing.coverage import reconcile_native_validation
        from app.browser_testing.obligations import prepare_explicit_workflow_review
        from app.browser_testing.permissions import approval_requirement
        self.session.audit_read_only=True
        coverage=(await self.audit(include_hover=False))['coverage']
        await self.session.navigate(self.session.target_url)
        goal='Test this website deeply and request permission to send the form. Do not actually submit.'
        self.assertIsNone(await prepare_explicit_workflow_review(goal,coverage,self.session))
        email=next(c['id'] for c in self.session.interactive_elements if c.get('name')=='email')
        for text,expected in (('invalid-email',False),('qa@example.test',True)):
            await execute_tool_call('browser_interact',{'session_id':self.session.session_id,'action':'type',
                'element_id':email,'text':text,'include_frame':False},'fixture')
            result=await execute_tool_call('browser_assert',{'session_id':self.session.session_id,
                'expectations':[{'kind':'validity','element_id':email,'expected':expected}],'timeout_seconds':0},'fixture')
            self.assertEqual(result['status'],'passed')
            reconcile_native_validation(coverage,result,self.session.current_url,self.session.interactive_elements)
        prepared=await prepare_explicit_workflow_review(goal,coverage,self.session)
        self.assertIsNotNone(prepared)
        requirement=await approval_requirement(self.session,'browser_interact',prepared['arguments'],True)
        self.assertEqual(requirement['label'],'Send')
        self.assertEqual(requirement['fingerprint'],prepared['fingerprint'])
        self.assertFalse(any(method=='POST' or path=='/account/delete' for method,path in self.requests))

    async def test_stale_ui_contract_executes_no_input(self):
        result=await execute_tool_call('browser_audit_site',{'session_id':self.session.session_id,'ui_control_ids':[999999]},'fixture')
        self.assertEqual(result['status'],'failed')
        self.assertIsNone(await self.session.evaluate('document.documentElement.dataset.theme || null'))

    async def test_autonomous_audit_exercises_form_choices_and_native_cases_without_submitting(self):
        self.session.audit_read_only=True
        self.session.agent_access_mode='full_access'
        self.session.allow_agent_questions=False
        result=await self.audit(autonomous=True,include_hover=False,include_frame=False,max_seconds=60)
        self.assertTrue(any(case['label']=='Small budget' and case['result']['status']=='passed'
                            for case in result['cases']), str([
                                (c['label'], c['action'], c['result'].get('status'), c['result'].get('error'))
                                for c in result['cases']]))
        reviews=result['coverage']['controls_requiring_review']
        email=next(review for review in reviews if review.get('name')=='email')
        self.assertEqual(email['native_validation_states'],[False,True], str([
            (c['label'], c['action'], c['result'].get('status'), c['result'].get('error'))
            for c in result['cases'] if c['label'].startswith('Email')]))
        self.assertTrue(email['input_restored'])
        self.assertTrue(any(review['label']=='Send' for review in reviews))
        self.assertFalse(any(method=='POST' or '/delete' in path for method,path in self.requests))

    async def test_autonomous_audit_discovers_fields_revealed_by_its_last_control(self):
        await self.session.evaluate("""(() => {
            const button=document.createElement('button');
            button.type='button';button.textContent='Request a demo';
            button.onclick=()=>{
                if(document.getElementById('demo-email'))return;
                const field=document.createElement('input');
                field.id='demo-email';field.name='demo-email';field.type='email';field.required=true;
                document.body.append(field);
            };
            document.body.append(button);
        })()""")
        self.session.audit_read_only=True
        self.session.agent_access_mode='full_access'
        self.session.allow_agent_questions=False
        result=await self.audit(autonomous=True,include_hover=False,include_frame=False,max_seconds=60)
        email=next(review for review in result['coverage']['controls_requiring_review'] if review.get('name')=='demo-email')
        self.assertEqual(email['native_validation_states'],[False,True], str([
            (c['label'], c['action'], c['result'].get('status'), c['result'].get('error'))
            for c in result['cases'] if c['label'].startswith('demo-email')]))
        self.assertTrue(email['input_restored'])
        self.assertFalse(any(method=='POST' for method,path in self.requests))

    async def test_autonomous_audit_reviews_download_without_opening_save_dialog(self):
        await self.session.evaluate("""(() => {const b=document.createElement('button');b.id='resume';b.type='button';
            b.textContent='Resume';b.onclick=()=>location.href='/resume.pdf';document.body.append(b);})()""")
        self.session.audit_read_only=True
        self.session.agent_access_mode='full_access'
        result=await self.audit(autonomous=True,include_hover=False,include_frame=False,max_seconds=60)
        self.assertTrue(any(review['label']=='Resume' and 'Download' in review['reason']
                            for review in result['coverage']['controls_requiring_review']))
        self.assertFalse(any(path=='/resume.pdf' for _,path in self.requests))

    async def test_explicit_download_is_saved_without_native_dialog(self):
        await self.session.evaluate("""(() => {const b=document.createElement('button');b.id='resume';b.type='button';
            b.textContent='Resume';b.onclick=()=>location.href='/resume.pdf';document.body.append(b);})()""")
        await self.session.extract_interactive_tree()
        resume=next(c['id'] for c in self.session.interactive_elements if c.get('input_id')=='resume')
        self.assertTrue(await self.session.click_element(resume,label='Resume'))
        self.assertIsNone(self.session.native_dialog)
        self.assertEqual(self.session.last_action_verification['effect_type'],'download_completed')
        self.assertEqual(self.session.last_download['filename'],'resume.pdf')
        observed=await execute_tool_call('browser_observe',{'session_id':self.session.session_id,'include_frame':False},'fixture')
        self.assertTrue(any(item['filename']=='resume.pdf' and item['state']=='completed'
                            for item in observed['downloads']))
        self.assertTrue(any(path=='/resume.pdf' for _,path in self.requests))
