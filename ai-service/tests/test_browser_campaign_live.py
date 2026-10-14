"""Opt-in real Chromium: 120 routes, durable recordings and editor readback.

All normal cases use owned synthetic pages. No paid provider is required.
"""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest

from app.browser_driver import BrowserSession,browser_manager
from app.browser_testing.campaign_store import CampaignStore
from app.browser_testing.campaigns import CampaignRuntime
from app.browser_testing.editors import read_editor
from app.browser_testing.assertions import assert_browser_state
from app.browser_testing.session_checkpoint import capture_session,restore_session
from app.tools import execute_tool_call


@unittest.skipUnless(os.getenv('AI_BROWSER_LIVE_TESTS')=='1','Opt-in isolated Chromium fixtures')
class LiveCampaignTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        class Fixture(BaseHTTPRequestHandler):
            def do_GET(self):
                try: page=int(self.path.rsplit('/',1)[-1])
                except ValueError: page=0
                links=''.join(f'<a href="/p/{n}">Page {n}</a> ' for n in (page-1,page+1) if 0<=n<120)
                html=f'<html><head><title>Page {page}</title></head><body><main><h1>Page {page}</h1>{links}</main></body></html>'
                self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(html.encode())
            def log_message(self,*args): pass
        self.server=ThreadingHTTPServer(('0.0.0.0',0),Fixture)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.addAsyncCleanup(self.stop_server)
        self.root=f'http://ai-service:{self.server.server_port}/p/0'
        self.store=CampaignStore(Path(self.directory.name)/'state.sqlite3','live-fixture-key')
        self.sid='campaign-live-'+self._testMethodName
        self.addAsyncCleanup(browser_manager.close_session,self.sid)

    async def stop_server(self):
        await asyncio.to_thread(self.server.shutdown);self.server.server_close();self.thread.join(2)

    async def test_120_pages_without_a_chat_connection_and_recording_stops(self):
        job,_=self.store.create('fixture',self.sid,{'goal':'Test 120 pages','message':'Test 120 pages','custom_url':self.root,
            'session_id':self.sid,'user_id':'fixture','sandbox_mode':'local','agent_access_mode':'full_access','allow_agent_questions':False},max_pages=150)
        self.store.add_task(job,'page',self.root,{'url':self.root})
        runtime=CampaignRuntime(self.store,browser_manager,execute_tool_call)
        self.assertTrue(self.store.claim_job(job,runtime.worker))
        runtime.sessions[self.sid]=job
        await asyncio.wait_for(runtime.run({'id':job,'user_id':'fixture','session_id':self.sid}),timeout=480)
        status=self.store.status(job,'fixture')
        self.assertEqual(status['state'],'completed',status)
        completed=sum(t['count'] for t in status['tasks'] if t['kind']=='page' and t['state']=='completed')
        self.assertEqual(completed,120,self.store.results(job,'fixture'))
        self.assertGreater(status['recording']['count'],0)
        frames=status['recording']['count']
        await asyncio.sleep(2.1)
        self.assertEqual(self.store.status(job,'fixture')['recording']['count'],frames)
        self.assertTrue(self.store.read_frame(job,'fixture',1).startswith(b'\xff\xd8'))
        with self.store.connection() as db:
            last=db.execute('SELECT payload FROM campaign_frames WHERE campaign_id=? ORDER BY sequence DESC LIMIT 1',(job,)).fetchone()
        self.assertTrue(self.store.open(last['payload'],job)['metadata']['url'].endswith('/p/119'))
        self.assertFalse(runtime.tasks);self.assertFalse(runtime.cancellations)

    async def test_contenteditable_multiline_and_wrong_output_target(self):
        session=BrowserSession(self.sid)
        await session.connect();browser_manager.sessions[self.sid]=session
        tree=await session.send_command('Page.getFrameTree')
        html='<html><body><div id="source" contenteditable="true" role="textbox" style="white-space:pre-wrap;width:500px;height:200px">old code</div><div id="output" role="textbox" aria-readonly="true">1 -> 2 -> 3</div></body></html>'
        await session.send_command('Page.setDocumentContent',{'frameId':tree['frameTree']['frame']['id'],'html':html})
        await session.extract_interactive_tree()
        source=next(e['id'] for e in session.interactive_elements if e['input_id']=='source')
        code='#include <iostream>\nint main() {\n  std::cout << "1 -> 2 -> 3";\n}\n'
        try: await session.type_text(code,source)
        except RuntimeError as exc: self.fail(f'{exc} Expected {code!r}; document: {await read_editor(session,source)!r}; DOM: {await session.evaluate("document.getElementById('source').innerHTML")!r}')
        self.assertEqual((await read_editor(session,source))['value'],code)
        check=await assert_browser_state(session,[{'kind':'editor_value','element_id':source,'expected':code}],0)
        self.assertEqual(check['status'],'passed',check)
        output=next(e['id'] for e in session.interactive_elements if e['input_id']=='output')
        with self.assertRaisesRegex(RuntimeError,'not an editable|readonly'): await session.type_text(code,output)
        self.assertEqual(await session.evaluate("document.getElementById('output').innerText"),'1 -> 2 -> 3')

    async def test_login_storage_restores_into_new_owned_context(self):
        session=await browser_manager.get_or_create_session(self.sid,self.root)
        await session.navigate(self.root)
        await session.evaluate("localStorage.setItem('login','fixture-user');sessionStorage.setItem('flow','step-two');document.cookie='login=fixture; path=/'")
        session.consequential_dispatches={('owned-tab',None,'click','state-digest'):3}
        saved=await capture_session(session)
        await browser_manager.close_session(self.sid)
        replacement=await browser_manager.get_or_create_session(self.sid,'about:blank')
        await restore_session(replacement,saved,self.root)
        self.assertEqual(await replacement.evaluate("localStorage.getItem('login')"),'fixture-user')
        self.assertEqual(await replacement.evaluate("sessionStorage.getItem('flow')"),'step-two')
        self.assertIn('login=fixture',await replacement.evaluate('document.cookie'))
        self.assertEqual(replacement.consequential_dispatches,{('owned-tab',None,'click','state-digest'):3})

    @unittest.skipUnless(os.getenv('AI_BROWSER_EXTERNAL_TESTS')=='1','External compiler smoke is opt-in')
    async def test_programiz_linked_list_execution_preserves_the_requested_program(self):
        session=await browser_manager.get_or_create_session(self.sid,'https://www.programiz.com/cpp-programming/online-compiler/')
        session.agent_access_mode='full_access';session.allow_agent_questions=False
        candidates=[];deadline=time.monotonic()+20
        while not candidates and time.monotonic()<deadline:
            await session.extract_interactive_tree()
            for element in session.interactive_elements:
                if element.get('editor_kind'):
                    document=await read_editor(session,element['id'])
                    if document and not document.get('readonly') and '#include' in document.get('value',''):
                        candidates.append(element)
            if not candidates: await asyncio.sleep(.5)
        self.assertTrue(candidates,{'url':session.current_url,'title':session.page_title,'page':await session.evaluate('document.body.innerText.slice(0,1000)')})
        source=candidates[0]['id']
        code='#include <iostream>\nstruct Node { int value; Node* next; };\nint main() {\n  Node third{30, nullptr}, second{20, &third}, first{10, &second};\n  for (Node* node = &first; node; node = node->next) {\n    std::cout << node->value;\n    if (node->next) std::cout << " -> ";\n  }\n  std::cout << "\\n";\n}\n'
        await session.type_text(code,source)
        self.assertEqual((await read_editor(session,source))['value'],code)
        await session.extract_interactive_tree()
        run=next(e for e in session.interactive_elements if (e.get('text') or e.get('aria_label') or '').strip().lower()=='run')
        action=await execute_tool_call('browser_interact',{'session_id':self.sid,'action':'click','element_id':run['id'],'include_frame':False},'fixture')
        self.assertNotIn('error',action,action)
        outcome=await assert_browser_state(session,[{'kind':'text','expected':'10 -> 20 -> 30','match':'contains'}],30,'outcome')
        self.assertEqual(outcome['status'],'passed',outcome)
        self.assertEqual((await read_editor(session,source))['value'],code)


if __name__=='__main__': unittest.main()
