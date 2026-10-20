"""Input/control semantic regressions from the unseen symptom-checker run."""
import os
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.browser_driver import BrowserSession, browser_manager
from app.browser_testing.control_contract import (
    control_contract_result, exact_native_option, normalize_control_action,
)
from app.browser_testing.editors import focus_editor_script
from app.browser_testing.transactions import compile_batch, validate_batch
from app.browser_testing.result_contract import classify_browser_result
from app.browser_testing.widgets import choose_option
from app.tools import execute_tool_call


def select_control(**extra):
    return {'id':7, 'tag':'select', 'type':'select-one', 'options':[
        {'text':'Choose a gender', 'value':'', 'disabled':True},
        {'text':'Male', 'value':'male'}, {'text':'Female', 'value':'female'},
        {'text':'Other', 'value':'other'},
    ], **extra}


class ControlContractTests(unittest.IsolatedAsyncioTestCase):
    def test_exact_observed_select_label_is_compiled_before_batch_dispatch(self):
        plan = [{'action':'click','element_id':7}, {'action':'type','element_id':7,'text':'Female'},
                {'action':'assert','expectations':[{'kind':'value','element_id':7,'expected':'female'}]}]
        compiled = compile_batch(plan, [select_control()])
        self.assertEqual(compiled[0], {'action':'select_option','element_id':7,'value':'female'})
        self.assertEqual(len(compiled), 2)
        self.assertIsNone(validate_batch(compiled))
        self.assertEqual(plan[1]['action'], 'type')

    def test_choose_option_native_label_uses_value_and_keeps_session_metadata(self):
        args = {'session_id':'qa','action':'choose_option','element_id':7,'text':'irrelevant search',
                'option_text':'Female','include_frame':False}
        self.assertEqual(normalize_control_action(args, [select_control()]),
                         {'session_id':'qa','action':'select_option','element_id':7,'value':'female','include_frame':False})
        self.assertEqual(args['option_text'], 'Female')

    def test_exact_match_normalizes_label_whitespace_and_case_but_not_partial_names(self):
        self.assertEqual(exact_native_option(select_control(), ' female ')['value'], 'female')
        self.assertIsNone(exact_native_option(select_control(), 'fem'))
        self.assertIsNone(exact_native_option(select_control(), 'Choose a gender'))

    def test_ambiguous_disabled_or_multiple_choices_are_not_invented(self):
        args = {'action':'type','element_id':7,'text':'Female'}
        controls = [select_control(options=[{'text':'Female','value':'a'}, {'text':'Female','value':'b'}]),
                    select_control(options=[{'text':'Female','value':'female','disabled':True}]),
                    select_control(multiple=True), select_control(type='select-multiple'),
                    select_control(disabled=True)]
        for control in controls:
            self.assertEqual(normalize_control_action(args, [control]), args)
            result = control_contract_result(args, [control])
            self.assertEqual(result['recovery']['expected_action'], 'select_option')
            self.assertEqual(result['verification']['effect_type'], 'not_dispatched')

    def test_exact_value_and_another_options_equal_label_is_ambiguous(self):
        control = select_control(options=[{'text':'First','value':'female'}, {'text':'female','value':'other'}])
        self.assertIsNone(exact_native_option(control, 'female'))

    def test_no_unobserved_target_is_repaired(self):
        for args in ({'action':'type','element_id':8,'text':'Female'},
                     {'action':'type','element_id':'7','text':'Female'},
                     {'action':'type','text':'Female'},
                     {'action':'type','element_id':7,'text':None}):
            self.assertEqual(normalize_control_action(args, [select_control()]), args)

    def test_ordinary_text_and_autocomplete_inputs_keep_their_operation(self):
        args = {'action':'type','element_id':7,'text':'Female'}
        for control in ({'id':7,'tag':'input','type':'text'}, {'id':7,'tag':'input','role':'combobox'}):
            self.assertEqual(normalize_control_action(args, [control]), args)
            self.assertIsNone(control_contract_result(args, [control]))

    def test_checkbox_upload_and_range_are_not_treated_as_text_inputs(self):
        for input_type, operation in [('checkbox','set_checked'),('radio','set_checked'),('file','upload'),('range','press_key')]:
            result = control_contract_result({'action':'type','element_id':7,'text':'yes'},
                                             [{'id':7,'tag':'input','type':input_type}])
            self.assertEqual(result['recovery']['expected_action'], operation)
        self.assertIn('Native select requires select_option', focus_editor_script('document.activeElement'))

    def test_native_selection_dispatch_is_independent_of_cdp_input_count(self):
        for changed, verified, status in [(True,True,'passed'), (False,True,'passed'), (True,False,'failed')]:
            result = {'status':status, 'action':'select_option', 'verification':{
                'control_kind':'native_select','changed':changed,'verified':verified,
                'effect_type':'control_change' if changed else 'value_already_set'}}
            self.assertEqual(classify_browser_result('browser_interact', result, 0)['dispatch_state'],
                             'dispatched' if changed else 'not_dispatched')

    async def test_native_choose_option_never_types_into_select(self):
        session = SimpleNamespace(evaluate=AsyncMock(return_value=select_control()),
                                  select_option=AsyncMock(return_value=True), type_text=AsyncMock())
        result = await choose_option(session, {'element_id':7,'option_text':'Female','text':'fem'})
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['value'], 'female')
        session.select_option.assert_awaited_once_with(7, 'female')
        session.type_text.assert_not_awaited()

    async def test_native_choose_missing_choice_returns_choices_without_dispatch_or_question(self):
        session = SimpleNamespace(evaluate=AsyncMock(return_value=select_control()), select_option=AsyncMock())
        result = await choose_option(session, {'element_id':7,'option_text':'Unknown'})
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['recovery']['options'][1]['value'], 'male')
        self.assertNotIn('question', result)
        session.select_option.assert_not_awaited()


@unittest.skipUnless(os.getenv('AI_BROWSER_LIVE_TESTS') == '1', 'Opt-in isolated native control Chromium tests')
class LiveControlContractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session = BrowserSession('native-contract-' + self._testMethodName)
        await self.session.connect()
        browser_manager.sessions[self.session.session_id] = self.session
        self.addAsyncCleanup(browser_manager.close_session, self.session.session_id)
        fixture = '''<!doctype html><title>Native control contract</title><style>body{font:16px sans-serif}select,input{margin:12px;width:200px;height:35px}</style>
        <label>Gender<select id="gender" required oninput="window.inputs=(window.inputs||0)+1" onchange="window.changes=(window.changes||0)+1">
        <option value="" disabled selected>Choose gender</option><option value="male">Male</option><option value="female" label="Female">F</option><option value="other">Other</option></select></label>
        <input id="name" aria-label="Name"><input id="checkbox" type="checkbox">
        <select id="group"><option value="none">None</option><optgroup label="Blocked" disabled><option value="no">Unavailable</option></optgroup></select>
        <select id="many" multiple><option value="a" selected>A</option><option value="b" selected>B</option></select>
        <form id="sign-in" onsubmit="event.preventDefault();window.submits=(window.submits||0)+1;document.getElementById('sign-in-outcome').textContent='Fixture sign-in accepted'">
          <label>Password<input id="password" type="password" autocomplete="current-password"></label><button id="sign-in-button" type="submit">Sign in fixture</button>
        </form><div id="sign-in-outcome" role="status">Awaiting fixture sign-in</div>'''
        frame = (await self.session.send_command('Page.getFrameTree'))['frameTree']['frame']['id']
        await self.session.send_command('Page.setDocumentContent', {'frameId':frame,'html':fixture})
        await self.session.extract_interactive_tree()

    def ref(self, name):
        return next(control['id'] for control in self.session.interactive_elements if control.get('input_id') == name)

    async def test_bad_model_type_is_compiled_and_checkpoint_passes_without_retry(self):
        result = await execute_tool_call('browser_interact_batch', {'session_id':self.session.session_id,'include_frame':False,
            'actions':[{'action':'click','element_id':self.ref('gender')},
                       {'action':'type','element_id':self.ref('gender'),'text':'Female'},
                       {'action':'type','element_id':self.ref('name'),'text':'Ada'},
                       {'action':'assert','expectations':[{'kind':'value','element_id':self.ref('gender'),'expected':'female'},
                                                         {'kind':'value','element_id':self.ref('name'),'expected':'Ada'}]}]}, 'native-contract-fixture')
        self.assertEqual(result['status'], 'passed', result)
        self.assertEqual(await self.session.evaluate('[document.getElementById("gender").value,window.inputs,window.changes]'), ['female',1,1])

    async def test_choose_native_label_commits_and_repeated_choice_dispatches_no_extra_events(self):
        for _ in range(2):
            result = await choose_option(self.session, {'element_id':self.ref('gender'),'option_text':'Female'})
            self.assertEqual(result['status'], 'passed', result)
        self.assertEqual(await self.session.evaluate('[window.inputs,window.changes]'), [1,1])

    async def test_observation_uses_the_option_label_visible_in_browser(self):
        option = next(c for c in self.session.interactive_elements if c.get('input_id') == 'gender')['options'][2]
        self.assertEqual(option['text'], 'Female')

    async def test_wrapping_native_label_names_gender_without_concatenating_its_options(self):
        control = next(c for c in self.session.interactive_elements if c.get('input_id') == 'gender')
        self.assertEqual(control['text'], 'Gender')
        self.assertNotIn('Female', control['text'])

    async def test_aria_labelledby_has_precedence_and_resolves_inside_shadow_root(self):
        await self.session.evaluate('document.body.insertAdjacentHTML("beforeend",\'<span id="first-name">Given</span><span id="name-label">name</span><input id="labelled" aria-label="Ignored" aria-labelledby="first-name name-label"><div id="shadow-label-host"></div>\');document.getElementById("shadow-label-host").attachShadow({mode:"open"}).innerHTML=\'<span id="shadow-name">Shadow gender</span><select id="shadow-gender" aria-labelledby="shadow-name"><option>A</option><option>B</option></select>\'')
        await self.session.extract_interactive_tree()
        labels = {control.get('input_id'):control['text'] for control in self.session.interactive_elements}
        self.assertEqual(labels['labelled'], 'Given name')
        self.assertEqual(labels['shadow-gender'], 'Shadow gender')

    async def test_disabled_group_and_multiple_select_never_change(self):
        with self.assertRaisesRegex(RuntimeError, 'disabled|ambiguous'):
            await self.session.select_option(self.ref('group'), 'no')
        with self.assertRaisesRegex(RuntimeError, 'multiple-select'):
            await self.session.select_option(self.ref('many'), 'a')
        self.assertEqual(await self.session.evaluate('[...document.getElementById("many").selectedOptions].map(o=>o.value)'), ['a','b'])

    async def test_covered_select_is_not_mutated_behind_modal(self):
        await self.session.evaluate('document.body.insertAdjacentHTML("beforeend",\'<div role="dialog" style="position:fixed;inset:0;background:white;z-index:999"><button>Modal choice</button></div>\')')
        with self.assertRaisesRegex(RuntimeError, 'blocked|unavailable'):
            await self.session.select_option(self.ref('gender'), 'male')
        self.assertEqual(await self.session.evaluate('[document.getElementById("gender").value,window.changes||0]'), ['',0])

    async def test_checkbox_cannot_receive_text_from_type_fallback(self):
        with self.assertRaisesRegex(RuntimeError, 'set_checked'):
            await self.session.type_text('yes', self.ref('checkbox'))
        self.assertFalse(await self.session.evaluate('document.getElementById("checkbox").checked'))

    async def test_controlled_select_revert_is_not_reported_as_a_pass(self):
        await self.session.evaluate('document.getElementById("gender").addEventListener("change",()=>setTimeout(()=>{document.getElementById("gender").value=""},10))')
        with self.assertRaisesRegex(RuntimeError, 'reverted'):
            await self.session.select_option(self.ref('gender'), 'male')
        self.assertFalse(self.session.last_action_verification['verified'])
        self.assertEqual(await self.session.evaluate('window.changes'), 1)

    async def test_replaced_control_rebinds_only_to_the_same_unique_observed_field(self):
        await self.session.evaluate('document.getElementById("gender").addEventListener("change",event=>{const copy=event.target.cloneNode(true);copy.value=event.target.value;event.target.replaceWith(copy)})')
        self.assertTrue(await self.session.select_option(self.ref('gender'), 'male'))
        self.assertTrue(self.session.last_action_verification['verified'])
        self.assertEqual(self.session.last_action_verification['selected_value'], 'male')

    async def test_idempotent_native_select_is_a_verified_checkpoint_without_dispatch(self):
        self.assertTrue(await self.session.select_option(self.ref('gender'), 'male'))
        self.assertTrue(await self.session.select_option(self.ref('gender'), 'male'))
        verification = self.session.last_action_verification
        self.assertTrue(verification['verified'])
        self.assertTrue(verification['already_satisfied'])
        self.assertEqual(verification['effect_type'], 'value_already_set')
        self.assertEqual(await self.session.evaluate('window.changes'), 1)

    async def test_password_fill_emits_only_private_equality_evidence(self):
        secret = 'Synthetic-password-qa-537!'
        await self.session.type_text(secret, self.ref('password'))
        evidence = self.session.last_action_verification
        self.assertTrue(evidence['verified'])
        self.assertTrue(evidence['private'])
        self.assertTrue(evidence['value_matches'])
        serialized = json.dumps(evidence)
        self.assertNotIn(secret, serialized)
        for field in ('value','length','hash','prefix','selected_value'):
            self.assertNotIn(field, evidence)
        self.assertNotIn('sha', serialized)

    async def test_successful_password_checkpoint_allows_login_batch_to_continue_once(self):
        secret = 'Synthetic-password-qa-537!'
        # Explicit isolated-fixture authorization exercises the normal native
        # executor without granting any production/browser-wide permission.
        self.session.agent_access_mode = 'full_access'
        result = await execute_tool_call('browser_interact_batch', {'session_id':self.session.session_id,'include_frame':False,'complete_task':True,
            'actions':[{'action':'type','element_id':self.ref('password'),'text':secret},
                       {'action':'click','element_id':self.ref('sign-in-button')},
                       {'action':'assert','purpose':'outcome','expectations':[{'kind':'text','element_id':self.ref('sign-in-outcome'),'expected':'Fixture sign-in accepted'}]}]}, 'native-contract-fixture')
        self.assertEqual(result['status'], 'passed', result)
        self.assertEqual(result['executed_count'], 3, result)
        self.assertEqual(await self.session.evaluate('window.submits'), 1)
        self.assertNotIn(secret, json.dumps(result))


if __name__ == '__main__':
    unittest.main()
