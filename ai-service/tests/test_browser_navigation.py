import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.browser_testing.navigation import move_history, restore_parent
from app.browser_testing.site_audit import match_control
from app.browser_testing.submissions import preflight_submission, dispatch_key
from app.browser_testing.transactions import validate_batch


class HistoryContracts(unittest.IsolatedAsyncioTestCase):
    async def test_audit_reacquires_after_animation_between_observation_reads(self):
        from app.browser_testing.site_audit import SiteAuditor
        session=SimpleNamespace(target_url='https://fixture.invalid/',current_url='https://fixture.invalid/',
            interactive_elements=[{'id':1,'card_context':'Old view'}],
            evaluate=AsyncMock(side_effect=[[],[{'id':2,'tag':'button','label':'Back'}]]))
        async def extract():
            if session.extract_interactive_tree.await_count > 1:
                session.interactive_elements=[{'id':2,'card_context':'New detail'}]
        session.extract_interactive_tree=AsyncMock(side_effect=extract)
        controls=await SiteAuditor(session,None).controls()
        self.assertEqual([c['id'] for c in controls],[2])
        self.assertEqual(controls[0]['card_context'],'New detail')
        self.assertEqual(session.extract_interactive_tree.await_count,2)

    async def test_permission_probe_preserves_distinct_card_context(self):
        from app.browser_testing.permissions import observe_step
        session=SimpleNamespace(task_context={'goal':'Send invoices'},interactive_elements=[
            {'id':7,'card_context':'Invoice Alpha'}, {'id':8,'card_context':'Invoice Beta'}],
            evaluate=AsyncMock(return_value={'id':7,'tag':'button','label':'Send invoice','url':'https://fixture.invalid/'}))
        first=await observe_step(session,{'action':'click','element_id':7})
        session.evaluate.return_value={'id':8,'tag':'button','label':'Send invoice','url':'https://fixture.invalid/'}
        second=await observe_step(session,{'action':'click','element_id':8})
        self.assertEqual(first['card_context'],'Invoice Alpha')
        self.assertEqual(second['card_context'],'Invoice Beta')
        self.assertNotEqual(dispatch_key(session,{'action':'click'},first),dispatch_key(session,{'action':'click'},second))

    def session(self, urls, index):
        entries = [{'id':i+10,'url':url} for i,url in enumerate(urls)]
        state = {'currentIndex':index,'entries':entries}
        session = SimpleNamespace(current_url=urls[index],native_dialog=None,interactive_elements=[],
            is_url_in_target_domain=lambda url: url.startswith('https://fixture.invalid/'),
            _notify_listeners=lambda event: None, wait_for_quiescence=AsyncMock(), extract_interactive_tree=AsyncMock())
        async def command(method, params):
            if method == 'Page.navigateToHistoryEntry':
                state['currentIndex'] = next(i for i,e in enumerate(entries) if e['id'] == params['entryId'])
                session.current_url = entries[state['currentIndex']]['url']
            return state.copy()
        session.send_command = AsyncMock(side_effect=command)
        session.evaluate = AsyncMock(side_effect=lambda expression: session.current_url)
        return session

    async def test_back_forward_uses_exact_entry_preserving_case_and_query(self):
        urls = ['https://fixture.invalid/','https://fixture.invalid/Detail?x=1','https://fixture.invalid/Detail?x=2']
        session = self.session(urls, 2)
        back = await move_history(session, -1)
        self.assertEqual(back['status'], 'passed')
        self.assertEqual(session.current_url, urls[1])
        forward = await move_history(session, 1)
        self.assertEqual(forward['status'], 'passed')
        self.assertEqual(session.current_url, urls[2])

    async def test_same_url_spa_history_is_verified_by_entry_id(self):
        session = self.session(['https://fixture.invalid/']*2, 1)
        result = await move_history(session, -1)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['history_entry_id'], 10)

    async def test_history_boundary_dispatches_nothing(self):
        session = self.session(['https://fixture.invalid/'], 0)
        result = await move_history(session, 1)
        self.assertEqual(result['dispatch_state'], 'not_dispatched')
        self.assertEqual(result['recovery']['reason'], 'history_boundary')
        self.assertEqual(session.send_command.await_count, 1)

    async def test_external_and_consequential_history_entries_are_blocked(self):
        for url in ('https://elsewhere.invalid/','https://fixture.invalid/account/logout'):
            session = self.session([url,'https://fixture.invalid/'], 1)
            result = await move_history(session, -1)
            self.assertEqual(result['status'], 'blocked')
            self.assertEqual(session.send_command.await_count, 1)

    async def test_no_effect_history_is_not_reported_passed(self):
        session = self.session(['https://fixture.invalid/','https://fixture.invalid/child'], 1)
        state = await session.send_command('Page.getNavigationHistory', {})
        session.send_command = AsyncMock(return_value=state)
        result = await move_history(session, -1, timeout=.01)
        self.assertEqual(result['status'], 'unverified')
        self.assertFalse(result['verification']['verified'])

    async def test_native_dialog_blocks_parent_recovery(self):
        session = self.session(['https://fixture.invalid/'], 0)
        session.native_dialog = {'type':'confirm'}
        result = await restore_parent(session, session.current_url)
        self.assertFalse(result['success'])
        session.send_command.assert_not_awaited()

    async def test_cancelled_dispatch_is_recorded_as_uncertain_not_replayable(self):
        from app.browser_driver import browser_manager
        from app.tools import _execute_legacy_tool
        session = SimpleNamespace(dispatched_inputs=0)
        browser_manager.sessions['cancelled-submit-fixture'] = session
        async def cancelled(*args):
            session._pending_consequential_dispatch = 'operation'
            session.dispatched_inputs += 1
            raise asyncio.CancelledError()
        try:
            with patch('app.tools._execute_tool_call', side_effect=cancelled):
                with self.assertRaises(asyncio.CancelledError):
                    await _execute_legacy_tool('browser_interact',{'session_id':'cancelled-submit-fixture'},'fixture')
            self.assertEqual(session.completed_consequential_inputs,{'operation':True})
        finally:
            browser_manager.sessions.pop('cancelled-submit-fixture',None)


class ExplorationContracts(unittest.TestCase):
    def test_identical_labels_keep_current_node_and_card_context(self):
        alpha = {'id':1,'tag':'button','label':'View details','card_context':'Alpha'}
        beta = {**alpha,'id':2,'card_context':'Beta'}
        self.assertEqual(match_control(beta,[alpha,beta]), beta)
        self.assertEqual(match_control({**beta,'id':9},[alpha,beta]), beta)
        self.assertIsNone(match_control({**beta,'id':9},[beta,{**beta,'id':3}]))
        self.assertEqual(match_control(beta,[beta,{**beta,'id':3}]), beta)

    def test_history_actions_end_a_batch_scene(self):
        for action in ('navigate_back','navigate_forward','return_to_parent'):
            self.assertIsNone(validate_batch([{'action':action}]))
            self.assertIsNotNone(validate_batch([{'action':action},{'action':'click','element_id':1}]))


class SubmissionContracts(unittest.TestCase):
    def fixture(self, goal='test everything'):
        session = SimpleNamespace(target_id='tab',current_url='https://fixture.invalid/',
            task_context={'goal':goal},audit_read_only=True,agent_access_mode='full_access')
        control = {'url':session.current_url,'tag':'button','role':'button','type':'submit',
                   'label':'Send Message','form':True,'form_id':'contact','native_validity':True}
        return session, control, {'action':'click','element_id':1}

    def test_full_access_broad_test_does_not_send_data(self):
        session, control, args = self.fixture()
        blocked, key = preflight_submission(session,args,control)
        self.assertEqual(blocked['recovery']['reason'], 'outside_test_scope')
        self.assertIsNone(key)

    def test_explicit_send_goal_can_dispatch_once(self):
        session, control, args = self.fixture('Send the message')
        blocked, key = preflight_submission(session,args,control)
        self.assertIsNone(blocked)
        session.completed_consequential_inputs = {key:True}
        changed = {**control,'label':'Sent ✓','state_digest':'new-filled-form','native_validity':False}
        blocked, _ = preflight_submission(session,args,changed)
        self.assertEqual(blocked['recovery']['reason'], 'submission_already_dispatched')
        self.assertEqual(dispatch_key(session,args,control),dispatch_key(session,args,changed))

    def test_readonly_query_is_not_a_submission(self):
        session, control, args = self.fixture()
        control.update(label='Search flights',form_method='get')
        self.assertEqual(preflight_submission(session,args,control), (None,None))

    def test_enter_and_click_share_the_same_form_submission_identity(self):
        from app.browser_testing.submissions import dispatch_key
        session,control,args=self.fixture()
        control.update(tag='button',role='',name='',input_id='send',href=None,card_context=None)
        field={**control,'tag':'input','type':'email','name':'email','input_id':'email','card_context':'Email field',
            'submit_control':{key:control.get(key) for key in ('tag','role','name','input_id','href','label','type','form')}}
        self.assertEqual(dispatch_key(session,args,control),dispatch_key(session,{'action':'press_key','key':'Enter'},field))
        session.completed_consequential_inputs={dispatch_key(session,args,control):True}
        blocked,_=preflight_submission(session,{'action':'press_key','key':'Enter'},field)
        self.assertEqual(blocked['recovery']['reason'],'submission_already_dispatched')


@unittest.skipUnless(os.getenv('AI_BROWSER_LIVE_TESTS') == '1', 'Opt-in isolated Chromium fixture')
class NavigationLiveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from app.browser_driver import BrowserSession, browser_manager
        self.requests = []
        async def serve(reader,writer):
            try:
                header = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 4)
                method, path, _ = header.split(b'\r\n')[0].decode().split(' ',2)
                self.requests.append((method,path))
                html = '''<!doctype html><title>Navigation fixture</title><main id="main"></main>
                <script>
                function root(){document.getElementById('main').innerHTML=`<h1>Projects</h1>
                  <article><h2>Alpha</h2><button onclick="detail('Alpha')">View details</button></article>
                  <article><h2>Beta</h2><button onclick="detail('Beta')">View details</button></article>
                  <a href="/child">Child route</a>`;}
                function detail(name){document.getElementById('main').innerHTML=`<h1>${name} detail</h1>
                  <button onclick="root()">Back to projects</button>
                  <button onclick="modal()">View more</button>
                  <a href="/child">Read child</a>`;}
                function modal(){let dialog=document.createElement('dialog');dialog.innerHTML=`<h2>Details popup</h2>
                  <button onclick="this.setAttribute('aria-pressed','true')">View summary</button>
                  <button onclick="this.closest('dialog').remove()">Close</button>`;document.body.append(dialog);dialog.showModal();}
                root();
                </script>'''
                if path.startswith('/child'):
                    html = '<!doctype html><title>Child fixture</title><h1>Child</h1><a href="/">Home</a>'
                body=html.encode()
                writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
                await writer.drain()
            except (ConnectionError,asyncio.IncompleteReadError,TimeoutError):
                pass
            finally:
                writer.close()
                await writer.wait_closed()
        self.server = await asyncio.start_server(serve,'0.0.0.0',0)
        port = self.server.sockets[0].getsockname()[1]
        url = 'http://'+os.getenv('AI_BROWSER_FIXTURE_HOST','ai-service')+':'+str(port)+'/'
        self.session = BrowserSession('navigation-live-fixture', target_url=url)
        self.addAsyncCleanup(self.cleanup)
        await self.session.connect()
        browser_manager.sessions[self.session.session_id] = self.session
        await self.session.navigate(url)
        self.session.agent_access_mode = 'full_access'
        self.session.task_context = {'goal':'test everything'}
        self.session.audit_read_only = True

    async def cleanup(self):
        from app.browser_driver import browser_manager
        await browser_manager.close_session(self.session.session_id)
        self.server.close()
        await self.server.wait_closed()

    async def action(self, **args):
        from app.tools import execute_tool_call
        return await execute_tool_call('browser_interact', {'session_id':self.session.session_id,'include_frame':False,**args},'fixture')

    async def test_actual_history_back_forward_and_boundary(self):
        result = await self.action(action='navigate',url=self.session.target_url+'child?x=1')
        self.assertEqual(result['status'],'passed',result)
        stale_id = self.session.interactive_elements[0]['id']
        back = await self.action(action='navigate_back')
        self.assertEqual(back['status'],'passed',back)
        self.assertEqual(self.session.current_url,self.session.target_url)
        forward = await self.action(action='navigate_forward')
        self.assertEqual(forward['status'],'passed',forward)
        self.assertTrue(self.session.current_url.endswith('/child?x=1'))
        self.assertNotIn(stale_id,[c['id'] for c in self.session.interactive_elements])
        boundary = await self.action(action='navigate_forward')
        self.assertEqual(boundary['recovery']['reason'],'history_boundary')

    async def test_duplicate_cards_nested_modal_restore_and_subpage_queue(self):
        from app.tools import execute_tool_call
        result = await execute_tool_call('browser_audit_site', {'session_id':self.session.session_id,
            'ui_control_ids':[],'include_hover':False,'include_frame':False,'max_pages':5,'max_actions':60,'max_seconds':60},'fixture')
        scenes = result['coverage']['detail_views']
        self.assertTrue(any(scene.get('card_context')=='Alpha' for scene in scenes),scenes)
        self.assertTrue(any(scene.get('card_context')=='Beta' for scene in scenes),scenes)
        self.assertTrue(any(scene['depth']==2 for scene in scenes),scenes)
        self.assertTrue(all(scene['parent_restored'] for scene in scenes),scenes)
        self.assertEqual(result['coverage']['visited_pages'],2,result['coverage'])
        self.assertEqual(result['coverage']['starting_page_restoration']['status'],'passed')
        self.assertEqual(self.session.current_url,self.session.target_url)
        self.assertFalse(any(method=='POST' for method,_ in self.requests))
        self.assertFalse(await self.session.evaluate("Boolean(document.querySelector('dialog[open]'))"))

    async def test_animated_same_url_details_return_before_next_sibling(self):
        from app.tools import execute_tool_call
        await self.session.evaluate("""(() => {
            const originalDetail=detail;
            detail=name=>setTimeout(()=>{originalDetail(name);
                document.querySelector('button').onclick=()=>setTimeout(root,400);},400);
        })()""")
        result=await execute_tool_call('browser_audit_site',{'session_id':self.session.session_id,
            'include_hover':False,'include_frame':False,'max_pages':2,'max_actions':60,'max_seconds':60},'fixture')
        scenes=result['coverage']['detail_views']
        self.assertTrue(any(scene.get('card_context')=='Alpha' for scene in scenes),scenes)
        self.assertTrue(any(scene.get('card_context')=='Beta' for scene in scenes),scenes)
        self.assertTrue(all(scene.get('parent_restored') for scene in scenes),scenes)
        self.assertEqual(result['coverage']['starting_page_restoration']['status'],'passed')
        self.assertEqual(await self.session.evaluate("document.querySelector('h1').textContent"),'Projects')

    async def test_same_url_spa_pushstate_back_forward(self):
        await self.session.evaluate("history.pushState({view:1},'',location.href)")
        back = await self.action(action='navigate_back')
        self.assertEqual(back['status'],'passed',back)
        self.assertIsNone(await self.session.evaluate('history.state'))
        forward = await self.action(action='navigate_forward')
        self.assertEqual(forward['status'],'passed',forward)
        self.assertEqual(await self.session.evaluate('history.state.view'),1)

    async def test_generic_audit_cannot_send_and_failed_check_cannot_send_twice(self):
        from app.tools import execute_tool_call
        await self.session.evaluate("""(() => {let form=document.createElement('form');form.id='contact';
            form.innerHTML='<input name="message" value="Fixture message"><button>Send Message</button>';
            form.onsubmit=event=>{event.preventDefault();window.sends=(window.sends||0)+1;
                form.reset();form.querySelector('button').textContent='Sent ✓'};
            document.body.append(form);})()""")
        await self.session.extract_interactive_tree()
        ref = next(c['id'] for c in self.session.interactive_elements if c.get('text')=='Send Message')
        blocked = await self.action(action='click',element_id=ref)
        self.assertEqual(blocked['recovery']['reason'],'outside_test_scope',blocked)
        self.assertIsNone(await self.session.evaluate('window.sends'))
        self.session.audit_read_only = False
        self.session.task_context = {'goal':'Send the message'}
        first = await self.action(action='click',element_id=ref)
        self.assertEqual(first.get('consequential_dispatch'),'dispatched_once',first)
        failed = await execute_tool_call('browser_assert', {'session_id':self.session.session_id,
            'expectations':[{'kind':'text','element_id':ref,'expected':'Send Message'}],'timeout_seconds':0},'fixture')
        self.assertEqual(failed['status'],'failed')
        await self.session.evaluate("document.querySelector('#contact input').value='Fixture retry'")
        replay = await self.action(action='click',element_id=ref)
        self.assertEqual(replay['recovery']['reason'],'submission_already_dispatched',replay)
        self.assertEqual(await self.session.evaluate('window.sends'),1)
