import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.browser_testing.permissions import (approval_requirement, authorization_scope,
    authorized_browser_step, authorized, harmless_ui, permission_reason, public_arguments,
    resolve_browser_arguments)
from app.browser_testing.assertions import BrowserExpectation


class BrowserPermissionTests(unittest.IsolatedAsyncioTestCase):
    def control(self, **values):
        return {'id':7,'tag':'button','type':'submit','label':'Send message','form':True,
                'url':'https://fixture.invalid/contact','name':'send','input_id':'send',**values}

    async def test_exact_one_step_approval_cannot_cover_other_actions_or_page(self):
        control = self.control()
        session = SimpleNamespace(evaluate=AsyncMock(return_value=control), current_url=control['url'])
        args = {'action':'click','element_id':7,'session_id':'fixture','include_frame':False}
        requirement = await approval_requirement(session,'browser_interact',args,True)
        token = authorized_browser_step.set(authorization_scope('browser_interact',args,requirement))
        try:
            self.assertTrue(authorized(args,control))
            self.assertFalse(authorized({**args,'element_id':8},control))
            self.assertFalse(authorized(args,{**control,'url':'https://fixture.invalid/other'}))
            self.assertFalse(authorized(args,{**control,'input_id':'new-button'}))
        finally:
            authorized_browser_step.reset(token)

    async def test_nested_batch_authorizes_only_the_critical_substep(self):
        control = self.control()
        session = SimpleNamespace(evaluate=AsyncMock(return_value=control), current_url=control['url'])
        args = {'session_id':'fixture','actions':[{'action':'click','element_id':7},
            {'action':'click','element_id':8}], 'include_frame':False}
        requirement = await approval_requirement(session,'browser_interact_batch',args,True)
        token = authorized_browser_step.set(authorization_scope('browser_interact_batch',args,requirement))
        try:
            self.assertTrue(authorized({'action':'click','element_id':7,'session_id':'fixture','include_frame':False},control))
            self.assertFalse(authorized({'action':'click','element_id':8,'session_id':'fixture','include_frame':False},control))
        finally:
            authorized_browser_step.reset(token)

    async def test_missing_or_ambiguous_target_never_approves_focused_body(self):
        session = SimpleNamespace(evaluate=AsyncMock(return_value={'tag':'body','label':''}),
            current_url='https://fixture.invalid/', interactive_elements=[{'id':1,'text':'Send'}, {'id':2,'text':'Send'}])
        for args in ({'action':'click'}, {'action':'click','selector':'#send'},
                     {'action':'click','text':'Missing'}, {'action':'click','text':'Send'}):
            self.assertIsNone(await approval_requirement(session,'browser_interact',args,True))
        session.evaluate.assert_not_awaited()

    async def test_unique_observed_label_binds_same_exact_id_before_approval(self):
        control=self.control(text='Send',label='Send')
        session=SimpleNamespace(evaluate=AsyncMock(return_value=control),current_url=control['url'],
            interactive_elements=[control])
        original={'action':'click','text':'Send','session_id':'fixture','include_frame':False}
        args=resolve_browser_arguments(session,'browser_interact',original)
        self.assertEqual(args['element_id'],7)
        self.assertNotIn('element_id',original)
        requirement=await approval_requirement(session,'browser_interact',args,True)
        self.assertEqual(requirement['label'],'Send')
        scope=authorized_browser_step.set(authorization_scope('browser_interact',args,requirement))
        try:
            self.assertTrue(authorized(args,control))
            self.assertFalse(authorized(original,control))
        finally:
            authorized_browser_step.reset(scope)

    async def test_invalid_batch_has_no_approval_ticket_for_later_step(self):
        session=SimpleNamespace(evaluate=AsyncMock(return_value=self.control()),current_url='https://fixture.invalid/')
        self.assertIsNone(await approval_requirement(session,'browser_interact_batch',{'actions':[
            {'action':'invented_action'},{'action':'click','element_id':7}]},True))
        session.evaluate.assert_not_awaited()

    def test_form_enter_and_consequential_labels_require_permission(self):
        for action,control in (({'action':'press_key','key':'Enter'},self.control(type='email',label='Email')),
                               ({'action':'click'},self.control(type='button',label='Delete account',form=False)),
                               ({'action':'click'},self.control(type='button',label='Purchase',form=False))):
            self.assertTrue(permission_reason(action,control))

    def test_gestures_and_mutating_shortcuts_cannot_bypass_scope(self):
        for action in ({'action':'drag_and_drop'},{'action':'press_key','key':'Enter','modifiers':['Control']},
                       {'action':'press_key','key':'Delete'}, {'action':'select_option','value':'yes'}):
            self.assertTrue(permission_reason(action,self.control(label='Subscribe',type='button',form=False),True))
        self.assertFalse(permission_reason({'action':'press_key','key':'Tab','modifiers':['Shift']},self.control(),True))

    def test_safe_ui_and_unsent_test_input_do_not_pause(self):
        for label in ('Toggle theme','View all work','Back to home','Show more'):
            c=self.control(type='button',label=label,form=False)
            self.assertTrue(harmless_ui(c))
            self.assertFalse(permission_reason({'action':'click'},c,True))
        self.assertFalse(permission_reason({'action':'type','text':'qa@example.test'},
                                          self.control(tag='input',type='email',label='Email'),True))
        self.assertTrue(permission_reason({'action':'click'},self.control(type='button',label='Perform action',form=False),True))

    def test_native_validation_is_strict_boolean_and_explicit_target(self):
        spec=BrowserExpectation(kind='validity',element_id=7,expected=False)
        self.assertFalse(spec.expected)
        for args in ({'expected':'false','element_id':7},{'expected':False}):
            with self.assertRaises(ValueError):
                BrowserExpectation(kind='validity',**args)

    def test_credential_preview_never_changes_private_exact_arguments(self):
        args={'action':'type','element_id':9,'text':'fixture-secret','password':'fixture-secret'}
        preview=public_arguments(args,{'reason':'Entering credentials requires approval','step_index':0})
        self.assertEqual(preview['text'],'[redacted]')
        self.assertEqual(preview['password'],'[redacted]')
        self.assertEqual(args['text'],'fixture-secret')
