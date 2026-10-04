"""Opt-in Chromium regression tests, using a new tab and an in-memory fixture.

AI_BROWSER_LIVE_TESTS=1 PYTHONPATH=ai-service python -m unittest discover -s ai-service/tests
Uses BROWSER_SANDBOX_URL; never loads or clicks a real application.
"""
import asyncio
import os
import time
import unittest
from urllib.parse import urlparse

import httpx
import websockets

from app.browser_driver import BrowserSession, CHROME_HOST, browser_manager
from app.tools import execute_tool_call


FIXTURE = """<!doctype html><html><head><title>Agent QA Fixture</title></head><body>
<h1>Agent QA Fixture</h1>
<button id="option" role="option" onclick="window.optionClicks=(window.optionClicks||0)+1;this.setAttribute('aria-selected','true')">Choose option</button>
<input id="checkbox" type="checkbox" aria-label="Toggle flag">
<input id="email" name="email" placeholder="Email">
<input id="autocomplete" role="combobox" aria-autocomplete="list" oninput="fixtureSuggest()">
<ul id="suggestions" role="listbox"></ul>
<input id="readonly" readonly value="locked">
<button id="noop">No effect</button>
<button id="validate" onclick="document.getElementById('feedback').innerHTML='<p role=alert>Email is required</p>'">Submit validation</button>
<button id="disabled" disabled>Disabled button</button>
<div id="feedback"></div>
<div id="results" hidden></div>
<button id="slow" onclick="document.getElementById('feedback').textContent='Unrelated mutation';setTimeout(()=>{let r=document.getElementById('results');r.hidden=false;r.textContent='Mumbai to Delhi | 2027-01-02';},400)">Search fixture</button>
<input id="travel-date" type="date" oninput="window.dateInputs=(window.dateInputs||0)+1" onchange="window.dateChanges=(window.dateChanges||0)+1">
<input id="password" type="password" value="fixture-secret">
<div class="ambiguous">First</div><div class="ambiguous">Second</div>
<script>
function fixtureSuggest() {
  setTimeout(() => {
    const option = document.createElement('li');
    option.setAttribute('role', 'option'); option.textContent = 'Mumbai';
    option.onclick = () => { window.suggestionClicks = (window.suggestionClicks || 0) + 1; };
    document.getElementById('suggestions').replaceChildren(option);
  }, 180);
}
</script>
</body></html>"""


@unittest.skipUnless(os.getenv("AI_BROWSER_LIVE_TESTS") == "1", "Opt-in live Chromium fixture suite")
class LiveBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session = BrowserSession("qa-regression-fixture")
        self.client = httpx.AsyncClient(timeout=6, headers={"Host": "localhost"})
        self.addAsyncCleanup(self.cleanup_fixture)
        response = await self.client.put(f"{CHROME_HOST}/json/new?about:blank")
        response.raise_for_status()
        tab = response.json()
        self.session.target_id = tab["id"]
        url = "ws://" + urlparse(CHROME_HOST).netloc + "/devtools/" + tab["webSocketDebuggerUrl"].split("/devtools/")[1]
        self.session.cdp_ws = await websockets.connect(url, max_size=10 * 1024 * 1024)
        self.session.is_connected = True
        self.session._send_task = asyncio.create_task(self.session._send_loop())
        self.session._read_task = asyncio.create_task(self.session._listen_loop())
        await self.session.send_command("Page.enable")
        await self.session.send_command("Runtime.enable")
        await self.session.send_command("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 720, "deviceScaleFactor": 1, "mobile": False})
        tree = await self.session.send_command("Page.getFrameTree")
        await self.session.send_command("Page.setDocumentContent", {"frameId": tree["frameTree"]["frame"]["id"], "html": FIXTURE})
        await self.session.extract_interactive_tree()
        browser_manager.sessions[self.session.session_id] = self.session

    async def cleanup_fixture(self):
        browser_manager.sessions.pop(self.session.session_id, None)
        tasks = [self.session._send_task, self.session._read_task]
        await self.session.close()
        await asyncio.gather(*(t for t in tasks if t is not None), return_exceptions=True)
        await self.client.aclose()

    def element_id(self, dom_id):
        return next(e["id"] for e in self.session.interactive_elements if e.get("input_id") == dom_id)

    async def interact(self, action, dom_id=None, approved=False, **kwargs):
        args = {"session_id": self.session.session_id, "action": action, "include_frame": False, **kwargs}
        if dom_id:
            args["element_id"] = self.element_id(dom_id)
        started = time.perf_counter()
        from app.browser_testing.permissions import approval_requirement,authorization_scope,authorized_browser_step
        token = None
        if approved:
            requirement=await approval_requirement(self.session,'browser_interact',args)
            self.assertIsNotNone(requirement)
            token=authorized_browser_step.set(authorization_scope('browser_interact',args,requirement))
        try:
            result = await execute_tool_call("browser_interact", args, "fixture")
        finally:
            if token is not None:
                authorized_browser_step.reset(token)
        print(f"fixture {action}/{dom_id}: {1000 * (time.perf_counter()-started):.0f}ms, {result.get('status')}")
        return result

    async def test_each_batch_step_publishes_fresh_screenshot_before_next_action(self):
        from app.tool_progress import progress_sink
        events, observed = [], []
        async def sink(event):
            events.append(event)
            observed.append(await self.session.evaluate("({checked:document.getElementById('checkbox').checked,email:document.getElementById('email').value})"))
        token = progress_sink.set(sink)
        try:
            result = await execute_tool_call('browser_interact_batch', {
                'session_id':self.session.session_id, 'include_frame':True,
                'actions':[
                    {'action':'set_checked','element_id':self.element_id('checkbox'),'checked':True},
                    {'action':'type','element_id':self.element_id('email'),'text':'qa@example.com'},
                ]}, 'fixture')
        finally:
            progress_sink.reset(token)
        self.assertEqual(len(events), 2)
        self.assertTrue(all(e['result']['frame'].startswith('data:image/jpeg;base64,/9j/') for e in events))
        self.assertEqual(observed, [{'checked':True,'email':''}, {'checked':True,'email':'qa@example.com'}])
        self.assertNotIn('error', result)

    async def test_option_handler_runs_once(self):
        result = await self.interact("click", "option")
        self.assertEqual(await self.session.evaluate("window.optionClicks"), 1)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["verification"]["effect_type"], "control_change")

    async def test_checkbox_remains_checked(self):
        result = await self.interact("click", "checkbox")
        self.assertTrue(await self.session.evaluate("document.getElementById('checkbox').checked"))
        self.assertEqual(result["status"], "passed")

    async def test_no_effect_is_unverified(self):
        result = await self.interact("click", "noop")
        self.assertEqual(result["status"], "unverified")

    async def test_validation_is_failed(self):
        result = await self.interact("click", "validate",approved=True)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["verification"]["effect_type"], "validation_error")

    async def test_typed_input_has_fresh_evidence(self):
        await self.interact("click", "checkbox")
        result = await self.interact("type", "email", text="qa@example.com")
        self.assertEqual(await self.session.evaluate("document.getElementById('email').value"), "qa@example.com")
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["verification"]["action"], "type")

    async def test_missing_input_does_not_type_into_focused_field(self):
        await self.session.evaluate("document.getElementById('email').focus()")
        result = await self.interact("type", element_id=999999, text="wrong field")
        self.assertEqual(result["status"], "stale_element")
        self.assertEqual(await self.session.evaluate("document.getElementById('email').value"), "")

    async def test_replaced_control_cannot_inherit_old_reference(self):
        old = self.element_id('checkbox')
        await self.session.evaluate("document.getElementById('checkbox').replaceWith(document.getElementById('checkbox').cloneNode(true))")
        await self.session.extract_interactive_tree()
        self.assertNotEqual(old,self.element_id('checkbox'))
        result = await self.interact('click',element_id=old)
        self.assertIn(result['status'],{'stale_element','failed'})
        self.assertFalse(await self.session.evaluate("document.getElementById('checkbox').checked"))
        result = await execute_tool_call('browser_assert',{'session_id':self.session.session_id,
            'timeout_seconds':0,'expectations':[{'kind':'checked','element_id':old,'expected':False}]},'fixture')
        self.assertNotEqual(result['status'],'passed')

    async def test_repeated_observation_is_fresh_without_rewriting_control_ids(self):
        old = self.element_id('checkbox')
        await self.session.evaluate("""window.observationWrites=0;
            new MutationObserver(records => window.observationWrites += records.filter(
                record => record.attributeName === 'data-sp-id').length
            ).observe(document, {subtree:true, attributes:true});""")
        for _ in range(3):
            await self.session.extract_interactive_tree()
            self.assertEqual(self.element_id('checkbox'), old)
        self.assertEqual(await self.session.evaluate('window.observationWrites'), 0)
        await self.session.evaluate("document.getElementById('checkbox').checked=true")
        await self.session.extract_interactive_tree()
        self.assertTrue(next(e for e in self.session.interactive_elements if e['id']==old)['checked'])
        self.assertEqual(await self.session.evaluate('window.observationWrites'), 0)

    async def test_ambiguous_labels_never_choose_first_control(self):
        await self.session.evaluate("document.body.insertAdjacentHTML('beforeend','<button onclick=\"window.wrongChoice=true\">Duplicate target</button><button onclick=\"window.wrongChoice=true\">Duplicate target</button>')")
        await self.session.extract_interactive_tree()
        result = await self.interact('click',text='Duplicate target')
        self.assertEqual(result['status'],'failed')
        self.assertFalse(await self.session.evaluate('Boolean(window.wrongChoice)'))

    async def test_other_pointer_actions_do_not_dispatch_through_overlay(self):
        await self.session.evaluate("document.body.insertAdjacentHTML('beforeend','<div style=\"position:fixed;inset:0;z-index:99999;background:white\"></div>')")
        for action in ('hover','double_click','right_click'):
            result = await self.interact(action,'checkbox')
            self.assertEqual(result['status'],'failed')
            self.assertEqual(result['recovery']['reason'],'occluded')
        self.assertFalse(await self.session.evaluate("document.getElementById('checkbox').checked"))

    async def test_navigation_never_reuses_previous_document_references(self):
        old = self.element_id('checkbox')
        await self.session.send_command('Page.navigate',{'url':'data:text/html,<input id="checkbox" type="checkbox" aria-label="Toggle flag">'})
        for _ in range(30):
            if await self.session.evaluate("document.URL.startsWith('data:')"):
                break
            await asyncio.sleep(0.02)
        await self.session.extract_interactive_tree()
        self.assertNotEqual(old,self.element_id('checkbox'))
        result = await self.interact('click',element_id=old)
        self.assertIn(result['status'],{'stale_element','failed'})
        self.assertFalse(await self.session.evaluate("document.getElementById('checkbox').checked"))

    async def test_disabled_target_not_clicked(self):
        result = await self.interact("click", "disabled")
        self.assertIn(result["status"], {"failed", "stale_element"})

    async def test_async_autocomplete_is_selected_once(self):
        result = await self.interact("type", "autocomplete", text="Mumbai", auto_select_suggestion="Mumbai")
        self.assertEqual(await self.session.evaluate("window.suggestionClicks"), 1)
        self.assertEqual(result["status"], "passed")

    async def test_set_checked_is_idempotent_and_never_undoes_selection(self):
        await self.session.evaluate("document.getElementById('checkbox').onchange=()=>{window.checkChanges=(window.checkChanges||0)+1}")
        for _ in range(2):
            result=await self.interact('set_checked','checkbox',checked=True)
            self.assertEqual(result['status'],'passed')
        self.assertTrue(await self.session.evaluate("document.getElementById('checkbox').checked"))
        self.assertEqual(await self.session.evaluate('window.checkChanges'),1)

    async def test_complete_batch_executes_and_verifies_current_control_states(self):
        result=await execute_tool_call('browser_interact_batch',{'session_id':self.session.session_id,'include_frame':False,'complete_task':True,
                    'actions':[{'action':'set_checked','element_id':self.element_id('checkbox'),'checked':True},
                               {'action':'type','element_id':self.element_id('email'),'text':'qa@example.com'},
                               {'action':'assert','purpose':'outcome','expectations':[{'kind':'checked','element_id':self.element_id('checkbox'),'expected':True},
                                                                                  {'kind':'value','element_id':self.element_id('email'),'expected':'qa@example.com'}]}]},'fixture')
        self.assertTrue(result['completion_verified'])
        self.assertEqual(result['executed_count'],3)
        self.assertEqual(result['frame'],'')

    async def test_invalid_completion_does_not_partially_mutate_form(self):
        result=await execute_tool_call('browser_interact_batch',{'session_id':self.session.session_id,'complete_task':True,
                    'actions':[{'action':'type','element_id':self.element_id('email'),'text':'wrong'},
                               {'action':'assert','purpose':'outcome','expectations':[{'kind':'value','element_id':self.element_id('checkbox'),'expected':True}]}]},'fixture')
        self.assertEqual(result['executed_count'],0)
        self.assertEqual(await self.session.evaluate("document.getElementById('email').value"),'')

    async def test_autocomplete_typing_returns_options_without_guessing_selection(self):
        result = await self.interact("type", "autocomplete", text="Mumbai")
        self.assertEqual(await self.session.evaluate("window.suggestionClicks || 0"), 0)
        self.assertEqual(result["autocomplete_suggestions"][0]["text"], "Mumbai")
        self.assertIsNotNone(result["autocomplete_suggestions"][0]["id"])

    async def test_ambiguous_autocomplete_does_not_choose_shorter_result(self):
        await self.session.evaluate("fixtureSuggest=()=>{document.getElementById('suggestions').innerHTML='<li role=option onclick=\"window.suggestionClicks=1\">Mumbai Central</li><li role=option onclick=\"window.suggestionClicks=2\">Mumbai West</li>'}")
        result = await self.interact("type", "autocomplete", text="Mumbai", auto_select_suggestion="Mumbai")
        self.assertIn("ambiguous", result.get("error", ""))
        self.assertEqual(await self.session.evaluate("window.suggestionClicks || 0"), 0)

    async def test_nested_scroll_target_is_honored_and_clicked_once(self):
        await self.session.evaluate("document.body.insertAdjacentHTML('afterbegin', '<div id=panel style=\"height:120px;overflow:auto\"><div style=\"height:800px\"></div><button id=nested onclick=\"window.nestedClicks=(window.nestedClicks||0)+1\">Nested action</button></div>')")
        await self.session.extract_interactive_tree()
        await self.interact("scroll_to", "nested")
        self.assertGreater(await self.session.evaluate("document.getElementById('panel').scrollTop"), 0)
        result = await self.interact("click", "nested")
        self.assertEqual(await self.session.evaluate("window.nestedClicks"), 1)
        self.assertNotIn("error", result)

    async def test_partially_occluded_button_uses_exposed_point(self):
        await self.session.evaluate("document.body.insertAdjacentHTML('beforeend','<button id=partial style=\"position:fixed;left:100px;top:500px;width:240px;height:100px\" onclick=\"window.partialClicks=(window.partialClicks||0)+1\">Partial</button><div style=\"position:fixed;left:185px;top:535px;width:70px;height:30px;background:black;z-index:100\"></div>')")
        await self.session.extract_interactive_tree()
        await self.interact("click", "partial")
        self.assertEqual(await self.session.evaluate("window.partialClicks"), 1)

    async def test_covering_dialog_is_reported_without_accepting_or_removing_it(self):
        await self.session.evaluate("document.body.insertAdjacentHTML('beforeend','<button id=covered style=\"position:fixed;left:100px;top:500px;width:200px;height:60px\" onclick=\"window.coveredClicks=1\">Covered</button><div id=dialog role=dialog style=\"position:fixed;left:80px;top:480px;width:250px;height:100px;background:white;z-index:100\">Confirm transfer <button onclick=\"window.confirmed=1\">Confirm</button></div>')")
        await self.session.extract_interactive_tree()
        result = await self.interact("click", "covered")
        self.assertEqual(result["recovery"]["reason"], "occluded")
        self.assertTrue(result["recovery"]["blocker"]["dialog"])
        self.assertEqual(await self.session.evaluate("[!!document.getElementById('dialog'),window.coveredClicks||0,window.confirmed||0]"), [True,0,0])

    async def test_hover_navigation_is_left_before_clicking_scrolled_summary(self):
        await self.session.evaluate("""document.body.insertAdjacentHTML('beforeend',`
            <style>#hover-nav{position:fixed;left:400px;top:0;width:300px;height:60px;z-index:100}
              #flyout{display:none;position:absolute;left:-400px;top:60px;width:1280px;height:430px;background:white}
              #hover-nav:hover #flyout{display:block}</style>
            <header><nav id="hover-nav">Services<div id="flyout">Navigation flyout</div></nav></header>
            <div style="height:2500px"></div>
            <details id="faq"><summary id="faq-hover" onclick="window.faqClicks=(window.faqClicks||0)+1">FAQ question</summary>Answer</details>
            <div style="height:900px"></div>`)
        """)
        await self.session.extract_interactive_tree()
        await self.session.send_command('Input.dispatchMouseEvent',{'type':'mouseMoved','x':500,'y':30})
        await self.session.scroll_to_element(self.element_id('faq-hover'))
        from app.browser_testing.actionability import inspect_actionability
        before = await inspect_actionability(self.session,self.element_id('faq-hover'))
        self.assertEqual(before['reason'],'occluded')
        self.assertTrue(before['navigation_hover_blocker'])
        result = await self.interact('click','faq-hover')
        self.assertEqual(result['status'],'passed')
        self.assertEqual(await self.session.evaluate("[document.getElementById('faq').open,window.faqClicks]"),[True,1])

    async def test_disabled_submit_reports_invalid_required_fields(self):
        await self.session.evaluate("document.body.insertAdjacentHTML('beforeend','<form><input name=postal required aria-label=\"Postal code\"><button id=dependent disabled>Continue</button></form>')")
        await self.session.extract_interactive_tree()
        result = await self.interact("click", "dependent")
        self.assertEqual(result["recovery"]["reason"], "disabled")
        self.assertEqual(result["recovery"]["invalid_fields"][0]["label"], "Postal code")

    async def test_native_select_exact_quoted_value_dispatches_once(self):
        await self.session.evaluate("document.body.insertAdjacentHTML('beforeend','<select id=choice onchange=\"window.selectChanges=(window.selectChanges||0)+1\"><option value=none>None</option><option value=two>Second</option></select>');document.getElementById('choice').options[1].text='A \"quoted\" choice'")
        await self.session.extract_interactive_tree()
        result = await self.interact("select_option", "choice", value='A "quoted" choice')
        self.assertNotIn("error", result)
        self.assertEqual(await self.session.evaluate("[document.getElementById('choice').value,window.selectChanges]"), ['two',1])

    async def test_unknown_or_duplicate_select_option_never_changes_value(self):
        await self.session.evaluate("document.body.insertAdjacentHTML('beforeend','<select id=choice><option value=none>None</option><option value=a>Duplicate</option><option value=b>Duplicate</option></select>')")
        await self.session.extract_interactive_tree()
        for value in ('missing', 'Duplicate'):
            result = await self.interact("select_option", "choice", value=value)
            self.assertIn("error", result)
            self.assertEqual(await self.session.evaluate("document.getElementById('choice').value"), 'none')

    async def test_defined_shadow_control_is_observed_and_clickable(self):
        await self.session.evaluate("customElements.define('qa-widget',class extends HTMLElement {connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<button id=shadow>Shadow action</button>';this.shadowRoot.querySelector('button').onclick=()=>{window.shadowClicks=(window.shadowClicks||0)+1}}});document.body.insertAdjacentHTML('afterbegin','<qa-widget></qa-widget>')")
        await self.session.extract_interactive_tree()
        await self.interact("click", "shadow")
        self.assertEqual(await self.session.evaluate("window.shadowClicks"), 1)

    async def test_shadow_input_is_focused_and_typed_natively(self):
        await self.session.evaluate("document.body.insertAdjacentHTML('afterbegin','<div id=shadowhost></div>');document.getElementById('shadowhost').attachShadow({mode:'open'}).innerHTML='<input id=shadowinput aria-label=Name>'")
        await self.session.extract_interactive_tree()
        result = await self.interact("type", "shadowinput", text="Ada")
        self.assertNotIn("error", result)
        self.assertEqual(await self.session.evaluate("document.getElementById('shadowhost').shadowRoot.querySelector('input').value"), "Ada")
        asserted = await self.assert_state([{"kind":"value","element_id":self.element_id('shadowinput'),"expected":"Ada"}])
        self.assertEqual(asserted['status'], 'passed')

    async def test_autocomplete_uses_associated_popup_instead_of_unrelated_list(self):
        await self.session.evaluate("document.getElementById('autocomplete').setAttribute('aria-controls','suggestions');document.body.insertAdjacentHTML('afterbegin','<ul role=listbox><li role=option onclick=\"window.wrongOption=1\">Mumbai</li></ul>')")
        result = await self.interact("type", "autocomplete", text="Mumbai", auto_select_suggestion="Mumbai")
        self.assertNotIn("error", result)
        self.assertEqual(await self.session.evaluate("[window.suggestionClicks||0,window.wrongOption||0]"), [1,0])

    async def test_readonly_input_is_not_overridden(self):
        result = await self.interact("type", "readonly", text="changed")
        self.assertIn("error", result)
        self.assertEqual(await self.session.evaluate("document.getElementById('readonly').value"), "locked")

    async def assert_state(self, expectations, timeout=1, purpose="outcome"):
        return await execute_tool_call("browser_assert", {"session_id": self.session.session_id,
                                      "expectations": expectations, "timeout_seconds": timeout, "purpose": purpose}, "fixture")

    async def test_delayed_results_verified_with_exact_route_and_date(self):
        await self.interact("click", "slow")
        result = await self.assert_state([{"kind": "text", "selector": "#results", "expected": "Mumbai to Delhi | 2027-01-02"}])
        self.assertEqual(result["status"], "passed")
        # The click itself may wait through the delay on a busy browser.
        # Verify the outcome; deterministic assertion tests pin retry behavior.

    async def test_unrelated_dom_mutation_does_not_pass_wrong_route(self):
        await self.interact("click", "slow")
        result = await self.assert_state([{"kind": "text", "selector": "#results", "expected": "Mumbai to Chennai | 2027-01-02"}], .6)
        self.assertEqual(result["status"], "failed")

    async def test_expected_validation_rejection_passes_negative_case(self):
        await self.interact("click", "validate",approved=True)
        result = await self.assert_state([{"kind": "text", "selector": "[role=alert]", "expected": "Email is required"},
                                         {"kind": "absent", "selector": "#results"}])
        self.assertEqual(result["status"], "passed")

    async def test_date_and_checkbox_readback(self):
        filled = await self.interact("type", "travel-date", text="02/01/2027")
        self.assertEqual(filled["status"], "passed")
        self.assertEqual(await self.session.evaluate("window.dateInputs"), 1)
        self.assertEqual(await self.session.evaluate("window.dateChanges"), 1)
        await self.interact("click", "checkbox")
        result = await self.assert_state([{"kind": "value", "selector": "#travel-date", "expected": "2027-01-02"},
                                         {"kind": "checked", "selector": "#checkbox", "expected": True}])
        self.assertEqual(result["status"], "passed")

    async def test_checkbox_value_on_cannot_prove_checked_state(self):
        result = await self.assert_state([{"kind":"value","selector":"#checkbox","expected":"on"}], 0)
        self.assertEqual(result['status'], 'unverified')
        self.assertIn('checked', result['assertions'][0]['reason'])
        self.assertFalse(await self.session.evaluate("document.getElementById('checkbox').checked"))

    async def test_invalid_date_preserves_existing_value(self):
        await self.interact("type", "travel-date", text="2027-01-02")
        result = await self.interact("type", "travel-date", text="2027-02-29")
        self.assertIn("error", result)
        self.assertEqual(await self.session.evaluate("document.getElementById('travel-date').value"), "2027-01-02")

    async def test_observe_captures_fresh_image_without_action(self):
        result = await execute_tool_call("browser_observe", {"session_id": self.session.session_id}, "fixture")
        self.assertTrue(result["visual_captured"])
        self.assertTrue(result["frame"].startswith("data:image/jpeg;base64,"))
        self.assertIsNone(await self.session.evaluate("window.optionClicks"))

    async def test_ambiguous_target_does_not_pass(self):
        result = await self.assert_state([{"kind": "text", "selector": ".ambiguous", "expected": "First"}], 0)
        self.assertEqual(result["status"], "failed")

    async def test_invalid_selector_is_unverified(self):
        result = await self.assert_state([{"kind": "visible", "selector": "["}], 0)
        self.assertEqual(result["status"], "unverified")

    async def test_password_assertion_does_not_leak_expected_value(self):
        result = await self.assert_state([{"kind": "value", "selector": "#password", "expected": "fixture-secret"}], 0)
        self.assertEqual(result["status"], "unverified")
        self.assertNotIn("fixture-secret", str(result))

    async def test_batch_stops_before_mutation_after_failed_assertion(self):
        result = await execute_tool_call("browser_interact_batch", {"session_id": self.session.session_id,
                                        "actions": [{"action": "assert", "expectations": [{"kind": "visible", "selector": "#missing"}], "timeout_seconds": 0},
                                                    {"action": "click", "element_id": self.element_id("option")}]}, "fixture")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["executed_count"], 1)
        self.assertIsNone(await self.session.evaluate("window.optionClicks"))

    async def test_batch_retains_recovery_evidence_and_skips_dependent_action(self):
        result = await execute_tool_call('browser_interact_batch', {'session_id':self.session.session_id,
                                        'actions':[{'action':'click','element_id':self.element_id('disabled')},
                                                   {'action':'click','element_id':self.element_id('option')}]}, 'fixture')
        self.assertEqual(result['executed_count'], 1)
        self.assertEqual(result['results'][0]['recovery']['reason'], 'disabled')
        self.assertIsNone(await self.session.evaluate('window.optionClicks'))

    async def test_coordinate_click_has_its_own_fresh_effect_evidence(self):
        el = next(e for e in self.session.interactive_elements if e.get("input_id") == "checkbox")
        result = await self.interact("click", x=round(el["x"]), y=round(el["y"]))
        self.assertEqual(result["verification"]["action"], "click")
        self.assertTrue(await self.session.evaluate("document.getElementById('checkbox').checked"))


if __name__ == "__main__":
    unittest.main()
