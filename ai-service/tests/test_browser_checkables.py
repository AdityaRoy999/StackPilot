"""Native checked state through styled, normally hit-tested pointer surfaces."""
import asyncio
import os
import unittest

from app.browser_testing.actionability import inspect_actionability
from app.browser_testing.assertions import assert_browser_state
from app.apv_engine import ActionPerceptionVerification
import test_browser_live as live_fixture


HTML = """<!doctype html><title>Styled native controls</title>
<style>
body {margin:30px;font:16px sans-serif} .row {position:relative;width:350px;height:55px}
.transparent {position:absolute;left:0;top:0;width:40px;height:40px;opacity:0}
.row label {display:block;padding:12px 12px 12px 55px;background:#ddd}
.tiny {position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
</style>
<div class=row><input id=todo class=transparent type=checkbox><label>StackPilot unseen QA</label></div>
<div class=row><input id=proxy class=tiny type=checkbox><label for=proxy>Label-backed checkbox</label></div>
<div class=row><input id=radio class=tiny type=radio name=group><label for=radio>Label-backed radio</label></div>
<div class=row style=margin-top:900px><input id=offscreen style="position:absolute;left:-9999px" type=checkbox><label for=offscreen>Offscreen native styled checkbox</label></div>
<div class=row><input id=disabled class=transparent type=checkbox disabled><label for=disabled>Disabled checkbox</label></div>
<div class=row><input id=hidden style=display:none type=checkbox><label for=hidden>Hidden checkbox</label></div>
<div class=row style=opacity:0><input id=ancestor-hidden class=transparent type=checkbox><label for=ancestor-hidden>Invisible parent</label></div>
<div class=row inert><input id=inert class=transparent type=checkbox><label for=inert>Inert</label></div>
<div class=row aria-hidden=true><input id=aria-hidden class=transparent type=checkbox><label for=aria-hidden>ARIA hidden</label></div>
<script>window.changed=0; document.addEventListener('change',()=>window.changed++);</script>
"""


@unittest.skipUnless(os.getenv('AI_BROWSER_LIVE_TESTS') == '1', 'Opt-in isolated Chromium fixture')
class StyledNativeCheckableTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = live_fixture.LiveBrowserTests.asyncSetUp
    cleanup_fixture = live_fixture.LiveBrowserTests.cleanup_fixture
    element_id = live_fixture.LiveBrowserTests.element_id

    async def fixture(self):
        tree=await self.session.send_command('Page.getFrameTree')
        await self.session.send_command('Page.setDocumentContent', {
            'frameId':tree['frameTree']['frame']['id'], 'html':HTML})
        await self.session.extract_interactive_tree()

    async def test_transparent_toggle_is_observed_and_clicks_once(self):
        await self.fixture()
        toggle=next(e for e in self.session.interactive_elements if e.get('input_id')=='todo')
        self.assertEqual(toggle['text'], 'StackPilot unseen QA')
        self.assertFalse(toggle['checked'])
        self.assertFalse(toggle['is_occluded'])
        self.assertEqual((await inspect_actionability(self.session,toggle['id']))['reason'],'ready')
        before=await ActionPerceptionVerification.capture_snapshot(self.session)
        self.assertTrue(await self.session.set_checked(toggle['id'],True))
        self.assertTrue(await self.session.evaluate("document.getElementById('todo').checked"))
        self.assertTrue(await self.session.set_checked(toggle['id'],True))
        self.assertEqual(await self.session.evaluate('window.changed'),1)
        after=await ActionPerceptionVerification.capture_snapshot(self.session)
        self.assertNotEqual(before.control_state,after.control_state)
        assertion=await assert_browser_state(self.session,[{'kind':'checked','element_id':toggle['id'],'expected':True}],0)
        self.assertEqual(assertion['status'],'passed',assertion)

    async def test_associated_label_pointer_toggles_checkbox_and_radio(self):
        await self.fixture()
        for dom_id in ('proxy','radio','offscreen'):
            ref=self.element_id(dom_id)
            await self.session.scroll_to_element(ref)
            actionable=await inspect_actionability(self.session,ref)
            self.assertEqual(actionable['reason'],'ready',actionable)
            self.assertTrue(actionable['checkable_label_proxy'])
            self.assertTrue(await self.session.set_checked(ref,True))
            self.assertTrue(await self.session.evaluate(f"document.getElementById('{dom_id}').checked"))
            assertion=await assert_browser_state(self.session,[{'kind':'checked','element_id':ref,'expected':True}],0)
            self.assertEqual(assertion['status'],'passed',assertion)

    async def test_hidden_inert_and_disabled_controls_remain_blocked(self):
        await self.fixture()
        observed={e.get('input_id') for e in self.session.interactive_elements}
        for dom_id in ('hidden','ancestor-hidden','inert','aria-hidden'):
            self.assertNotIn(dom_id,observed)
        ref=self.element_id('disabled')
        self.assertEqual((await inspect_actionability(self.session,ref))['reason'],'disabled')
        self.assertFalse(await self.session.set_checked(ref,True))
        self.assertFalse(await self.session.evaluate("document.getElementById('disabled').checked"))

    async def test_modal_or_overlay_cannot_be_clicked_through(self):
        await self.fixture()
        ref=self.element_id('proxy')
        await self.session.evaluate("document.body.insertAdjacentHTML('beforeend','<div role=dialog aria-modal=true style=position:fixed;inset:0;background:white;z-index:100><button>Close</button></div>')")
        state=await inspect_actionability(self.session,ref)
        self.assertEqual(state['reason'],'occluded',state)
        self.assertFalse(await self.session.set_checked(ref,True))
        self.assertFalse(await self.session.evaluate("document.getElementById('proxy').checked"))
        await self.session.evaluate("document.querySelector('[role=dialog]').remove();document.body.insertAdjacentHTML('beforeend','<div style=position:fixed;inset:0;background:white;z-index:100>Covering panel</div>')")
        state=await inspect_actionability(self.session,ref)
        self.assertEqual(state['reason'],'occluded',state)
        self.assertFalse(await self.session.set_checked(ref,True))
        self.assertFalse(await self.session.evaluate("document.getElementById('proxy').checked"))

    async def test_shadow_host_visibility_and_native_label_hit_surface(self):
        await self.fixture()
        await self.session.evaluate("""(() => {
          for(const [id,opacity] of [['visible-shadow','1'],['hidden-shadow','0']]) {
            const host=document.createElement('div');host.style.opacity=opacity;
            host.attachShadow({mode:'open'}).innerHTML=`<input id=${id} type=checkbox style="opacity:0;position:absolute;width:1px;height:1px;pointer-events:none"><label for=${id} style="display:block;width:250px;height:45px;background:#ddd">Shadow checkbox</label>`;
            document.body.prepend(host);
          }
        })()""")
        await self.session.extract_interactive_tree()
        observed={e.get('input_id') for e in self.session.interactive_elements}
        self.assertNotIn('hidden-shadow',observed)
        ref=self.element_id('visible-shadow')
        observed_target=next(e for e in self.session.interactive_elements if e['id']==ref)
        self.assertFalse(observed_target['is_occluded'])
        self.assertTrue(await self.session.set_checked(ref,True))
        result=await assert_browser_state(self.session,[{'kind':'checked','element_id':ref,'expected':True}],0)
        self.assertEqual(result['status'],'passed',result)

    @unittest.skipUnless(os.getenv('AI_BROWSER_UNSEEN_CHECKABLE') == '1','Opt-in public TodoMVC sample')
    async def test_public_todomvc_has_actionable_named_native_toggle(self):
        self.session.target_url='https://todomvc.com/examples/react/dist/'
        await self.session.navigate('https://todomvc.com/examples/react/dist/')
        for _ in range(30):
            await self.session.extract_interactive_tree()
            fields=[e for e in self.session.interactive_elements if e.get('placeholder')=='What needs to be done?']
            if fields:break
            await asyncio.sleep(.1)
        self.assertEqual(len(fields),1)
        await self.session.type_text('StackPilot unseen QA',element_id=fields[0]['id'])
        await self.session.press_key('Enter')
        await self.session.extract_interactive_tree()
        toggles=[e for e in self.session.interactive_elements if e.get('type')=='checkbox' and e.get('text')=='StackPilot unseen QA']
        self.assertEqual(len(toggles),1,self.session.interactive_elements)
        self.assertTrue(await self.session.set_checked(toggles[0]['id'],True))
        assertion=await assert_browser_state(self.session,[{'kind':'checked','element_id':toggles[0]['id'],'expected':True}],0)
        self.assertEqual(assertion['status'],'passed',assertion)
        await self.session.extract_interactive_tree()
        completed=next(e for e in self.session.interactive_elements if e.get('text')=='Completed')
        self.assertTrue(await self.session.click_element(completed['id']))
        self.assertEqual(await self.session.evaluate("[...document.querySelectorAll('.todo-list li')].map(n=>({text:n.innerText.trim(),complete:n.classList.contains('completed')}))"),
                         [{'text':'StackPilot unseen QA','complete':True}])
