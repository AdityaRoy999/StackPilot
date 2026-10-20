"""Real input progresses visibly; animations never claim an unfinished fill passed."""
import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock, Mock

from app.browser_driver import BrowserSession
from app.browser_testing.motion import typing_plan


class TypingMotionTests(unittest.IsolatedAsyncioTestCase):
    def session(self, text, input_type='text', value=''):
        session=BrowserSession('typing-fixture')
        session.scroll_to_element=AsyncMock()
        session._notify_listeners=Mock()
        current=[value]
        async def dispatch(method,params):
            if method=='Input.insertText': current[0]+=params['text']
            if method=='Input.dispatchKeyEvent' and params.get('key')=='Backspace': current[0]=''
            return {}
        async def observe(script):
            if 'view.focus();' in script:
                return {'type':input_type,'value':current[0],'autocomplete':False}
            if 'normalizeCode(view.read())===' in script:
                return True
            if "el.type==='password'" in script and 'el.value===' in script:
                return current[0] == text
            return {'kind':'native','value':current[0]}
        session.send_command=AsyncMock(side_effect=dispatch)
        session.evaluate=AsyncMock(side_effect=observe)
        session.extract_interactive_tree=AsyncMock()
        return session,current

    def test_unicode_clusters_and_large_documents_stay_bounded(self):
        family='👨\u200d👩\u200d👧\u200d👦'
        text=('e\u0301'+family+'🇮🇳\r\n')*10
        chunks,delay=typing_plan(text)
        self.assertEqual(''.join(chunks),text)
        self.assertTrue(all(not chunk.startswith(('\u200d','\u0301','\n')) for chunk in chunks))
        self.assertTrue(all(chunk.count('👨')==chunk.count(family) for chunk in chunks))
        self.assertTrue(all(chunk.count('🇮')==chunk.count('🇮🇳') for chunk in chunks))
        chunks,delay=typing_plan('x'*32000)
        self.assertLessEqual(len(chunks),40)
        self.assertLessEqual(delay*(len(chunks)-1),1.4)
        self.assertEqual(typing_plan('-1.25e2',atomic=True),(['-1.25e2'],0))

    async def test_progress_is_real_and_finishes_only_after_exact_readback(self):
        text='Hello from StackPilot'
        session,current=self.session(text)
        observed=[]
        session._notify_listeners.side_effect=lambda event: observed.append((event.copy(),current[0]))
        await session.type_text(text,1)
        inserted=[c.args[1]['text'] for c in session.send_command.call_args_list if c.args[0]=='Input.insertText']
        self.assertGreater(len(inserted),1)
        self.assertEqual(''.join(inserted),text)
        self.assertEqual(current[0],text)
        self.assertTrue(any(e['phase']=='progress' and 0<len(value)<len(text) for e,value in observed))
        self.assertEqual(observed[-1][0]['phase'],'applied')
        self.assertEqual(observed[-1][1],text)

    async def test_cancel_stops_remaining_batches_without_success(self):
        session,current=self.session('Never finish this input')
        original=session.send_command.side_effect
        async def dispatch(method,params):
            await original(method,params)
            if method=='Input.insertText': session._input_generation+=1
            return {}
        session.send_command.side_effect=dispatch
        with self.assertRaises(asyncio.CancelledError): await session.type_text('Never finish this input',1)
        self.assertEqual(current[0],'Ne')
        self.assertEqual(session._notify_listeners.call_args.args[0]['phase'],'interrupted')
        self.assertFalse(any(c.args[0].get('phase')=='applied' for c in session._notify_listeners.call_args_list))

    async def test_focus_loss_stops_without_inserting_into_another_control(self):
        session,current=self.session('abcdef')
        original=session.evaluate.side_effect
        async def observe(script):
            if current[0] and 'normalizeCode(view.read())===' in script: return False
            return await original(script)
        session.evaluate.side_effect=observe
        with self.assertRaisesRegex(RuntimeError,'lost focus'): await session.type_text('abcdef',1)
        self.assertEqual(current[0],'ab')
        self.assertEqual(session._notify_listeners.call_args.args[0]['phase'],'interrupted')

    async def test_password_feedback_contains_no_secret_or_length(self):
        text='Secret!Private123'
        session,current=self.session(text,'password')
        await session.type_text(text,1)
        events=[c.args[0] for c in session._notify_listeners.call_args_list]
        self.assertNotIn(text,json.dumps(events))
        self.assertTrue(all('text' not in e and 'length' not in e and 'progress' not in e for e in events))
        self.assertTrue(all(e['private'] for e in events))

    async def test_numeric_atomic_fill_and_append_keep_exact_values(self):
        session,current=self.session('-1.25e2','number')
        await session.type_text('-1.25e2',1)
        self.assertEqual(sum(c.args[0]=='Input.insertText' for c in session.send_command.call_args_list),1)
        session,current=self.session(' world',value='Hello')
        await session.type_text(' world',1,clear_first=False)
        self.assertEqual(current[0],'Hello world')

    async def test_stop_during_selection_does_not_clear_the_field(self):
        session,current=self.session('replacement',value='Keep original')
        original=session.send_command.side_effect
        async def dispatch(method,params):
            await original(method,params)
            if params.get('key')=='a': session._input_generation+=1
            return {}
        session.send_command.side_effect=dispatch
        with self.assertRaises(asyncio.CancelledError): await session.type_text('replacement',1)
        self.assertEqual(current[0],'Keep original')
        self.assertFalse(any(c.args[0]=='Input.insertText' for c in session.send_command.call_args_list))


@unittest.skipUnless(os.getenv('AI_BROWSER_LIVE_TESTS')=='1','Opt-in isolated Chromium fixtures')
class LiveTypingMotionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session=BrowserSession('typing-live-'+self._testMethodName)
        await self.session.connect()
        self.addAsyncCleanup(self.session.close)
        tree=await self.session.send_command('Page.getFrameTree')
        html='''<html><body><input id="name"><input id="other"><textarea id="source"></textarea><input id="secret" type="password">
          <script>window.values=[];nameInput=document.getElementById('name');
          nameInput.addEventListener('input',()=>values.push({value:nameInput.value,at:performance.now()}));</script></body></html>'''
        await self.session.send_command('Page.setDocumentContent',{'frameId':tree['frameTree']['frame']['id'],'html':html})
        await self.session.extract_interactive_tree()
        self.ids={e.get('input_id'):e['id'] for e in self.session.interactive_elements}

    async def test_field_updates_are_visible_before_completion_and_multiline_is_exact(self):
        await self.session.type_text('StackPilot types live',self.ids['name'])
        values=await self.session.evaluate('window.values')
        actual=[v for v in values if v['value']]
        self.assertGreater(len(actual),3)
        self.assertEqual(actual[-1]['value'],'StackPilot types live')
        self.assertGreater(actual[-1]['at']-actual[0]['at'],200)
        self.assertTrue(all('StackPilot types live'.startswith(v['value']) for v in actual))
        code='#include <iostream>\nint main() {\n  std::cout << "👨‍👩‍👧‍👦";\n}\n'
        await self.session.type_text(code,self.ids['source'])
        self.assertEqual(await self.session.evaluate('document.getElementById("source").value'),code)

    async def test_page_that_steals_focus_does_not_receive_remaining_text(self):
        await self.session.evaluate('nameInput.addEventListener("input",()=>document.getElementById("other").focus(),{once:true})')
        with self.assertRaisesRegex(RuntimeError,'lost focus'):
            await self.session.type_text('Must stay in name',self.ids['name'])
        self.assertEqual(await self.session.evaluate('document.getElementById("other").value'),'')
        self.assertNotEqual(await self.session.evaluate('nameInput.value'),'Must stay in name')
