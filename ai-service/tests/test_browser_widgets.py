"""Deterministic widget regressions; live tests use isolated synthetic pages only."""
import asyncio
import json
import os
import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.browser_driver import BrowserSession, browser_manager
from app.browser_testing.permissions import permission_reason, approval_requirement, authorization_scope, authorized_browser_step
from app.browser_testing.planning import browser_reasoning_policy, compact_browser_messages
from app.browser_testing.widgets import date_commit, outcome_contract_error
from app.browser_testing.frames import frame_offset,frame_point_is_clear
from app.tools import execute_tool_call


class WidgetContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_nested_frame_process_offsets_and_parent_occlusion(self):
        boxes={100:(100,50),200:(20,10),300:(5,7)}
        blocked=set()
        async def command(method,params,cdp_session_id=None):
            if method=='DOM.getFrameOwner':return {'backendNodeId':{'a':100,'b':200,'c':300}[params['frameId']]}
            if method=='DOM.getBoxModel':
                x,y=boxes[params['backendNodeId']]
                return {'model':{'content':[x,y,x+400,y,x+400,y+200,x,y+200]}}
            if method=='DOM.getNodeForLocation':
                if cdp_session_id in blocked:return {'backendNodeId':444,'frameId':{None:'main','A':'a','B':'b'}[cdp_session_id]}
                return {None:{'backendNodeId':100,'frameId':'main'},'A':{'backendNodeId':200,'frameId':'a'},'B':{'backendNodeId':900,'frameId':'c'}}[cdp_session_id]
            raise AssertionError(method)
        session=SimpleNamespace(_main_frame_id='main',frame_parents={'a':'main','b':'a','c':'b'},
            frame_contexts={'main':{'session_id':None},'a':{'session_id':'A'},'b':{'session_id':'B'},'c':{'session_id':'B'}},
            frame_session_roots={'A':'a','B':'b'},send_command=command)
        self.assertEqual(await frame_offset(session,'c'),(125,67))
        self.assertTrue(await frame_point_is_clear(session,'c',140,80))
        for root in (None,'A','B'):
            blocked.clear();blocked.add(root)
            self.assertFalse(await frame_point_is_clear(session,'c',140,80))
    async def test_date_cannot_pass_under_an_alternative_locale(self):
        session=SimpleNamespace(evaluate=AsyncMock(return_value={'value':'07/10/2026','invalid':False}))
        result=await date_commit(session,1,date(2026,7,10),'%d/%m/%Y')
        self.assertEqual(result['status'],'unverified')
        self.assertEqual((await date_commit(session,1,date(2026,10,7),'%d/%m/%Y'))['status'],'passed')

    def test_query_is_not_a_payment_or_credential_submission(self):
        search={'label':'Search Trains','form':True,'type':'submit','form_method':'get'}
        self.assertFalse(permission_reason({'action':'click'},search))
        for update in ({'label':'Search and Pay'},{'sensitive_fields':True},{'form_method':'post'}):
            self.assertTrue(permission_reason({'action':'click'},{**search,**update}))
        self.assertTrue(permission_reason({'action':'choose_option'},{'type':'password'}))

    def test_native_dialog_permission_depends_on_decision(self):
        self.assertTrue(permission_reason({'action':'handle_dialog','accept':True},{'type':'confirm'}))
        self.assertFalse(permission_reason({'action':'handle_dialog','accept':False},{'type':'confirm'}))
        self.assertFalse(permission_reason({'action':'handle_dialog','accept':True},{'type':'alert'}))

    def test_input_checks_cannot_complete_a_booking(self):
        session=SimpleNamespace(task_context={'goal':'book a train tomorrow'})
        self.assertTrue(outcome_contract_error(session,[{'kind':'value'}],'outcome'))
        self.assertFalse(outcome_contract_error(session,[{'kind':'text'}],'outcome'))
        self.assertFalse(outcome_contract_error(session,[{'kind':'value'}],'checkpoint'))
        session.task_context={'goal':'Test invalid train search form validation'}
        self.assertFalse(outcome_contract_error(session,[{'kind':'validity','expected':False}],'outcome'))

    def test_fast_browser_policy_uses_reasoning_only_for_recovery_or_thinking(self):
        model='nvidia/nemotron-3-super-120b-a12b'
        base={'chat_template_kwargs':{'other':True}}
        self.assertFalse(browser_reasoning_policy(base,model,'fast')['chat_template_kwargs']['enable_thinking'])
        self.assertTrue(browser_reasoning_policy(base,model,'fast',True)['chat_template_kwargs']['enable_thinking'])
        self.assertTrue(browser_reasoning_policy(base,model,'thinking')['chat_template_kwargs']['enable_thinking'])
        self.assertNotIn('enable_thinking',base['chat_template_kwargs'])

    def test_compaction_keeps_current_evidence_and_tool_pairing(self):
        messages=[{'role':'system','content':'Instructions'}, {'role':'assistant','content':'','tool_calls':[{'id':'a'}]},
            {'role':'tool','tool_call_id':'a','content':json.dumps({'status':'passed','interactive_elements':[{'text':'x'*500}]*300})}]
        messages += [{'role':'user','content':'Continue'}]*9
        result=compact_browser_messages(messages)
        self.assertEqual(result[1]['tool_calls'],messages[1]['tool_calls'])
        self.assertEqual(result[2]['tool_call_id'],'a')
        self.assertEqual(json.loads(result[2]['content']),{'status':'passed'})
        self.assertLess(len(json.dumps(result)),2000)


FIXTURE=r'''<!doctype html><html lang="en"><head><title>Widget QA</title><style>
body{font:16px sans-serif;padding:12px} input{width:180px} button{margin:4px;padding:8px}
[role=dialog]{position:fixed;left:120px;top:40px;padding:20px;background:white;border:2px solid black;z-index:100}
#top{z-index:200} [hidden]{display:none!important} [role=option]{padding:8px;cursor:pointer}
#behind{position:fixed;left:150px;top:80px}
#calendar{top:150px;left:20px} iframe{width:400px;height:120px;display:block;margin:10px}
</style></head><body>
<h1>Widget QA</h1>
<button id="behind" onclick="window.behindClicks=(window.behindClicks||0)+1">Behind overlay</button>
<button id="keyboard" onkeydown="if(event.key===' '){event.preventDefault();window.keys=(window.keys||0)+1;this.textContent='Activated'}">Keyboard target</button>
<input id="other" aria-label="Other field">
<input id="combo" role="combobox" aria-controls="choices" aria-expanded="false" placeholder="Station" oninput="suggest(this.value)">
<ul id="choices" role="listbox" hidden><li role="option" id="old-option">Old</li></ul>
<input id="native-combo" list="station-values"><datalist id="station-values"><option value="MMCT" label="Mumbai Central"><option value="LKO" label="Lucknow"></datalist>
<input id="native" type="date" min="2026-10-01" max="2028-12-31">
<input id="custom" readonly placeholder="DD/MM/YYYY" onclick="document.getElementById('calendar').hidden=false;renderCalendar()">
<div id="calendar" role="dialog" data-calendar hidden></div>
<form id="query" method="get" onsubmit="event.preventDefault();document.getElementById('results').textContent='Train results: Mumbai to Lucknow';window.searches=(window.searches||0)+1">
 <input name="from" value="Mumbai"><button id="search" type="submit">Search Trains</button>
</form><div id="results"></div>
<button id="confirm" onclick="window.confirmed=confirm('Commit fixture decision?')">Open confirmation</button>
<button id="critical-noop" onclick="window.sends=(window.sends||0)+1">Send fixture</button>
<button id="newtab" onclick="window.open('about:blank','_blank')">Open fixture tab</button>
<div id="bottom" role="dialog"><h2>Advisory</h2><button id="close-bottom" onclick="this.parentElement.remove()">Close advisory</button></div>
<div id="top" role="dialog"><h2>Language</h2><button id="english" aria-label="SafeValue must use [property]=binding" onclick="this.parentElement.remove()">English</button></div>
<script>
let suggestionTimer,calendarYear=2026,calendarMonth=11;
function suggest(query){clearTimeout(suggestionTimer);const list=document.getElementById('choices');
 suggestionTimer=setTimeout(()=>{let labels=query==='Ambiguous'?['Mumbai Central','Mumbai East']:['Mumbai Central'];
 list.replaceChildren(...labels.map(text=>{let item=document.createElement('li');item.role='option';item.textContent=text;
 const old=document.getElementById('old-option');if(old)item.dataset.spId=old.dataset.spId;
 item.onclick=()=>{window.optionClicks=(window.optionClicks||0)+1;
 if(query==='Noop')return;
 document.getElementById('combo').value=text;document.getElementById('combo').setAttribute('aria-expanded','false');
 item.setAttribute('aria-selected','true');list.hidden=true};return item}));
 list.hidden=false;document.getElementById('combo').setAttribute('aria-expanded','true');},130)}
function renderCalendar(){const root=document.getElementById('calendar');root.replaceChildren();
 let header=document.createElement('h2');header.className='calendar-title';header.textContent=new Intl.DateTimeFormat('en',{month:'long',year:'numeric'}).format(new Date(calendarYear,calendarMonth,1));root.append(header);
 for(const [label,delta] of [['Previous month',-1],['Next month',1]]){let btn=document.createElement('button');btn.type='button';btn.textContent=label;
 btn.onclick=()=>{let d=new Date(calendarYear,calendarMonth+delta,1);calendarYear=d.getFullYear();calendarMonth=d.getMonth();renderCalendar()};root.append(btn)}
 let table=document.createElement('table'),row=document.createElement('tr');table.append(row);root.append(table);
 const days=new Date(calendarYear,calendarMonth+1,0).getDate();
 for(let day=1;day<=days;day++){if(day%7===1){row=document.createElement('tr');table.append(row)}let cell=document.createElement('td');cell.role='gridcell';
 let btn=document.createElement('button');btn.type='button';btn.textContent=day;btn.dataset.date=`${calendarYear}-${String(calendarMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
 if(calendarYear===2027&&calendarMonth===0&&day===1)btn.disabled=true;
 btn.onclick=()=>{document.getElementById('custom').value=`${String(day).padStart(2,'0')}/${String(calendarMonth+1).padStart(2,'0')}/${calendarYear}`;root.hidden=true;window.dateClicks=(window.dateClicks||0)+1};cell.append(btn);row.append(cell)}}
</script></body></html>'''


@unittest.skipUnless(os.getenv('AI_BROWSER_LIVE_TESTS')=='1','Opt-in isolated Chromium widget fixtures')
class LiveWidgetTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session=BrowserSession('widget-qa-'+self._testMethodName)
        self.addAsyncCleanup(self.cleanup_fixture)
        await self.session.connect()
        tree=await self.session.send_command('Page.getFrameTree')
        await self.session.send_command('Page.setDocumentContent',{'frameId':tree['frameTree']['frame']['id'],'html':FIXTURE})
        await self.session.extract_interactive_tree()
        browser_manager.sessions[self.session.session_id]=self.session

    async def cleanup_fixture(self):
        browser_manager.sessions.pop(self.session.session_id,None)
        await self.session.close()

    def ref(self,dom_id):
        return next(e['id'] for e in self.session.interactive_elements if e.get('input_id')==dom_id)

    async def act(self,action,dom_id=None,**kwargs):
        args={'session_id':self.session.session_id,'action':action,'include_frame':False,**kwargs}
        if dom_id:args['element_id']=self.ref(dom_id)
        return await execute_tool_call('browser_interact',args,'widget-qa')

    async def dismiss(self):
        self.assertEqual((await self.act('click','english'))['status'],'passed')
        self.assertEqual((await self.act('click','close-bottom'))['status'],'passed')

    async def test_stacked_overlays_have_visible_labels_and_no_click_through(self):
        observation=await execute_tool_call('browser_observe',{'session_id':self.session.session_id,'include_frame':False},'widget-qa')
        self.assertEqual(observation['widget_state']['active_overlay']['title'],'Language')
        self.assertEqual(next(e for e in observation['interactive_elements'] if e['id']==self.ref('english'))['text'],'English')
        blocked=await self.act('click','behind')
        self.assertEqual(blocked['status'],'failed')
        self.assertIsNone(await self.session.evaluate('window.behindClicks'))
        result=await self.act('click','english')
        self.assertEqual(result['widget_state']['active_overlay']['title'],'Advisory')

    async def popup_fixture(self, named=False):
        links=''.join(f'<a href="#item-{i}">Background {i}</a><br>' for i in range(520))
        html='''<style>body{font:16px sans-serif}#behind{position:fixed;left:180px;top:180px}
          #portal{position:fixed;inset:0;z-index:300;background:#0008}
          #panel{position:absolute;left:120px;top:100px;padding:24px;width:320px;background:white}
          .icClose{display:inline-block;width:24px;height:24px;background:#ccc}
          #close{cursor:pointer;display:inline-block}input{display:block;margin:12px 0}</style>
          <button id="behind" onclick="window.behindClicks=(window.behindClicks||0)+1">Login launcher</button>'''+links+'''
          <div id="portal" CLASS><div id="panel"><h2>Login/Signup</h2>
          <span id="close" aria-hidden="true" onclick="document.getElementById('portal').remove()"><span class="icClose"></span></span>
          <form onsubmit="event.preventDefault();window.submissions=(window.submissions||0)+1"><label>Mobile number<input name="phone" id="phone"></label>
          <button type="button" id="continue" onclick="document.getElementById('feedback').textContent='Input received'">Continue</button><div id="feedback"></div></form></div></div>'''
        html=html.replace('CLASS','class="modal-wrapper"' if named else '')
        tree=await self.session.send_command('Page.getFrameTree')
        await self.session.send_command('Page.setDocumentContent',{'frameId':tree['frameTree']['frame']['id'],'html':html})
        return await execute_tool_call('browser_observe',{'session_id':self.session.session_id,'include_frame':False},'widget-qa')

    async def test_custom_login_popup_precedes_hundreds_of_background_links(self):
        observation=await self.popup_fixture(named=True)
        overlay=observation['widget_state']['active_overlay']
        self.assertEqual(overlay['title'],'Login/Signup')
        phone=self.ref('phone')
        self.assertIn(phone,[e['id'] for e in observation['interactive_elements'][:5]])
        self.assertIn(phone,[e['id'] for e in overlay['controls']])
        blocked=await self.act('click','behind')
        self.assertEqual(blocked['status'],'failed')
        self.assertTrue(blocked['recovery']['blocker']['dialog'])
        self.assertEqual(blocked['widget_state']['active_overlay']['id'],overlay['id'])
        self.assertIsNone(await self.session.evaluate('window.behindClicks'))
        typed=await self.act('type','phone',text='5550101234')
        self.assertEqual(typed['status'],'passed',typed)
        self.assertEqual(await self.session.evaluate('document.getElementById("phone").value'),'5550101234')
        self.assertEqual((await self.act('click','continue'))['status'],'passed')
        self.assertIsNone(await self.session.evaluate('window.submissions'))

    async def test_unlabelled_portal_can_close_a_delegated_icon_without_dom_mutation(self):
        observation=await self.popup_fixture()
        self.assertEqual(observation['widget_state']['active_overlay']['title'],'Login/Signup')
        close=next(e for e in observation['interactive_elements'] if e['id']==self.ref('close'))
        self.assertEqual(close['text'],'Close')
        result=await self.act('click','close')
        self.assertEqual(result['status'],'passed',result)
        self.assertEqual(result['verification']['effect_type'],'modal_close')
        self.assertIsNone(result['widget_state']['active_overlay'])
        self.assertIsNone(await self.session.evaluate('document.getElementById("portal")'))

    async def test_dismissed_workflow_field_returns_recovery_and_can_be_reopened(self):
        await self.popup_fixture(named=True)
        old_phone=self.ref('phone')
        await self.session.evaluate("window.savedPopup=document.getElementById('portal').outerHTML;document.getElementById('behind').onclick=()=>document.body.insertAdjacentHTML('beforeend',window.savedPopup)")
        self.assertEqual((await self.act('click','close'))['status'],'passed')
        stale=await self.act('type',element_id=old_phone,text='5550101234')
        self.assertEqual(stale['status'],'stale_element')
        self.assertEqual(stale['recovery']['reason'],'dismissed_overlay')
        self.assertEqual(stale['target'],'Mobile number')
        self.assertIsNone(stale['widget_state']['active_overlay'])
        observation=await execute_tool_call('browser_observe',{'session_id':self.session.session_id,
            'query':'login','scope':'viewport','include_frame':False},'widget-qa')
        launcher=next(e['id'] for e in observation['interactive_elements'] if e['text']=='Login launcher')
        self.assertEqual((await self.act('click',element_id=launcher))['status'],'passed')
        self.assertNotEqual(self.ref('phone'),old_phone)
        # A new popup is a new workflow reference, even when it renders an
        # identically named field. The old ref must not silently type into it.
        stale=await self.act('type',element_id=old_phone,text='5550101234')
        self.assertEqual(stale['status'],'stale_element')
        self.assertEqual(await self.session.evaluate('document.getElementById("phone").value'),'')
        self.assertEqual((await self.act('type','phone',text='5550101234'))['status'],'passed')
        self.assertEqual(await self.session.evaluate('document.getElementById("phone").value'),'5550101234')
        self.assertIsNone(await self.session.evaluate('window.submissions'))

    async def test_replaced_input_within_same_popup_rebinds_uniquely(self):
        await self.popup_fixture(named=True)
        old_phone=self.ref('phone')
        await self.session.evaluate("const node=document.getElementById('phone');node.replaceWith(node.cloneNode(true))")
        self.assertEqual((await self.act('type',element_id=old_phone,text='5550101234'))['status'],'passed')
        self.assertNotEqual(self.ref('phone'),old_phone)
        self.assertEqual(await self.session.evaluate('document.getElementById("phone").value'),'5550101234')

    async def test_normal_form_and_fixed_toolbar_are_not_popups(self):
        await self.dismiss()
        await self.session.evaluate("document.body.insertAdjacentHTML('beforeend','<div style=\"position:fixed;top:0;height:55px;z-index:100;width:100%;background:white\"><form><input aria-label=\"Header search\"><button>Search</button></form></div><section><h2>Account</h2><form><input aria-label=\"Name\"></form></section>')")
        observation=await execute_tool_call('browser_observe',{'session_id':self.session.session_id,'include_frame':False},'widget-qa')
        self.assertIsNone(observation['widget_state']['active_overlay'])

    async def test_legacy_dismissal_cannot_choose_a_language_or_hide_the_overlay(self):
        self.assertFalse(await self.session.auto_dismiss_startup_modals())
        self.assertTrue(await self.session.evaluate("!!document.getElementById('top')"))
        self.assertEqual((await self.act('click','english'))['status'],'passed')
        self.assertTrue(await self.session.dismiss_active_modal())
        self.assertFalse(await self.session.evaluate("!!document.getElementById('bottom')"))

    async def test_typing_cannot_focus_through_an_active_overlay(self):
        await self.session.evaluate("document.getElementById('combo').style='position:fixed;left:150px;top:80px'")
        result=await self.act('choose_option','combo',text='Mum',option_text='Mumbai Central')
        self.assertIn('covered',result['error'])
        self.assertEqual(await self.session.evaluate("document.getElementById('combo').value"),'')

    async def test_autocomplete_waits_and_commits_exactly_once(self):
        await self.dismiss()
        result=await self.act('choose_option','combo',text='Mum',option_text='Mumbai Central')
        self.assertEqual(result['status'],'passed',result)
        self.assertEqual(result['value'],'Mumbai Central')
        self.assertEqual(await self.session.evaluate('window.optionClicks'),1)

    async def test_native_datalist_commits_the_observed_value_for_its_label(self):
        await self.dismiss()
        result=await self.act('choose_option','native-combo',text='Mum',option_text='Mumbai Central')
        self.assertEqual(result['status'],'passed',result)
        self.assertEqual(result['value'],'MMCT')

    async def test_ambiguous_autocomplete_requests_information_without_a_click(self):
        await self.dismiss()
        result=await self.act('choose_option','combo',text='Ambiguous',option_text='Mumbai')
        self.assertEqual(result['status'],'needs_information',result)
        self.assertEqual(result['choices'],['Mumbai Central','Mumbai East'])
        self.assertIsNone(await self.session.evaluate('window.optionClicks'))

    async def test_noop_autocomplete_does_not_pass(self):
        await self.dismiss()
        result=await self.act('choose_option','combo',text='Noop',option_text='Mumbai Central')
        self.assertEqual(result['status'],'unverified',result)
        self.assertEqual(await self.session.evaluate('window.optionClicks'),1)

    async def test_replaced_option_never_inherits_a_copied_reference(self):
        await self.dismiss()
        await self.session.evaluate("document.getElementById('choices').hidden=false")
        await self.session.extract_interactive_tree()
        old=self.ref('old-option')
        await self.session.evaluate("const old=document.getElementById('old-option'),clone=old.cloneNode(true);clone.textContent='Replacement';clone.id='replacement-option';old.replaceWith(clone)")
        await self.session.extract_interactive_tree()
        self.assertNotEqual(self.ref('replacement-option'),old)
        result=await self.act('click',element_id=old)
        self.assertEqual(result['status'],'stale_element')

    async def test_native_date_leap_day_and_bounds(self):
        await self.dismiss()
        result=await self.act('choose_date','native',value='2028-02-29')
        self.assertEqual(result['status'],'passed',result)
        self.assertEqual((await self.act('choose_date','native',value='2027-02-29'))['status'],'failed')
        self.assertEqual((await self.act('choose_date','native',value='2026-09-30'))['status'],'failed')
        self.assertEqual(await self.session.evaluate("document.getElementById('native').value"),'2028-02-29')

    async def test_calendar_crosses_year_and_selects_nested_day_button(self):
        await self.dismiss()
        result=await self.act('choose_date','custom',value='2027-01-02')
        self.assertEqual(result['status'],'passed',result)
        self.assertEqual(result['value'],'02/01/2027')
        self.assertEqual(await self.session.evaluate('window.dateClicks'),1)

    async def test_calendar_disabled_date_is_not_dispatched(self):
        await self.dismiss()
        result=await self.act('choose_date','custom',value='2027-01-01')
        self.assertEqual(result['status'],'failed',result)
        self.assertIn('disabled',result['error'])
        self.assertIsNone(await self.session.evaluate('window.dateClicks'))

    async def test_key_gesture_uses_its_target_instead_of_the_previous_field(self):
        await self.dismiss()
        await self.session.evaluate("document.getElementById('other').focus()")
        result=await self.act('press_key','keyboard',key='Space')
        self.assertNotIn('error',result)
        self.assertEqual(await self.session.evaluate('window.keys'),1)
        self.assertEqual(await self.session.evaluate('document.activeElement.id'),'keyboard')

    async def test_query_runs_once_and_requires_business_result_assertions(self):
        await self.dismiss()
        result=await self.act('click','search')
        self.assertEqual(result['status'],'unverified',result)
        self.assertTrue(result['requires_outcome'],result)
        self.assertEqual(await self.session.evaluate('window.searches'),1)
        self.session.task_context={'goal':'search trains from Mumbai to Lucknow'}
        outcome=await execute_tool_call('browser_assert',{'session_id':self.session.session_id,'purpose':'outcome',
            'expectations':[{'kind':'text','selector':'#results','expected':'Mumbai to Lucknow','match':'contains'}]},'widget-qa')
        self.assertEqual(outcome['status'],'passed',outcome)

    async def test_native_confirmation_has_one_bound_approval_and_no_replay(self):
        await self.dismiss()
        result=await self.act('click','confirm')
        self.assertEqual(result['widget_state']['native_dialog']['type'],'confirm',result)
        dialog_id=self.session.native_dialog['dialog_id']
        denied=await self.act('handle_dialog',dialog_id=dialog_id,accept=True)
        self.assertEqual(denied['status'],'requires_approval')
        args={'session_id':self.session.session_id,'action':'handle_dialog','include_frame':False,'dialog_id':dialog_id,'accept':True}
        requirement=await approval_requirement(self.session,'browser_interact',args)
        token=authorized_browser_step.set(authorization_scope('browser_interact',args,requirement))
        try:accepted=await execute_tool_call('browser_interact',args,'widget-qa')
        finally:authorized_browser_step.reset(token)
        self.assertEqual(accepted['status'],'passed',accepted)
        self.assertTrue(await self.session.evaluate('window.confirmed'))
        self.assertEqual((await self.act('handle_dialog',dialog_id=dialog_id,accept=True))['status'],'failed')

    async def test_full_access_does_not_replay_an_unchanged_consequential_step(self):
        await self.dismiss()
        self.session.agent_access_mode='full_access'
        first=await self.act('click','critical-noop')
        self.assertEqual(first['status'],'unverified',first)
        second=await self.act('click','critical-noop')
        self.assertEqual(second['status'],'blocked',second)
        self.assertEqual(second['verification']['effect_type'],'replay_prevented')
        self.assertEqual(await self.session.evaluate('window.sends'),1)

    async def test_session_owned_tab_can_switch_and_return(self):
        await self.dismiss()
        original=self.session.target_id
        await self.act('click','newtab')
        for _ in range(20):
            ids=[i for i in self.session.related_targets if i!=original]
            if ids:break
            await asyncio.sleep(.05)
        self.assertTrue(ids)
        self.assertEqual((await self.act('switch_tab',target_id=ids[0]))['status'],'passed')
        self.assertEqual((await self.act('switch_tab',target_id=original))['status'],'passed')
        self.assertEqual(await self.session.evaluate('document.title'),'Widget QA')

    async def test_frame_input_preserves_parent_identity_and_does_not_click_parent_overlay(self):
        await self.dismiss()
        child_html='''<title>Child</title><button id="child" onclick="this.textContent='Child clicked'">Child target</button>'''
        await self.session.evaluate("const f=document.createElement('iframe');f.name='qa-child';f.srcdoc="+json.dumps(child_html)+";document.body.prepend(f)")
        for _ in range(20):
            frames=[i for i in self.session.frame_contexts if i!=self.session._main_frame_id]
            if frames:break
            await asyncio.sleep(.05)
        self.assertTrue(frames)
        self.assertEqual((await self.act('switch_frame',frame_id=frames[0]))['status'],'passed')
        self.assertEqual(self.session.page_title,'Widget QA')
        result=await self.act('click','child')
        self.assertEqual(result['status'],'passed',result)
        self.assertEqual(self.session.page_title,'Widget QA')
        self.assertEqual((await self.act('switch_frame',frame_id='main'))['status'],'passed')
        await self.session.evaluate("const overlay=document.createElement('div');overlay.style='position:fixed;inset:0;background:white;z-index:999';document.body.append(overlay)")
        self.assertEqual((await self.act('switch_frame',frame_id=frames[0]))['status'],'passed')
        blocked=await self.act('click','child')
        self.assertEqual(blocked['status'],'failed',blocked)
