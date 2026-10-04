import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.browser_driver import BrowserSession
from app.tool_progress import progress_sink,snapshot_step
from app.browser_testing.actionability import prepare_pointer_target


class InputRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_non_navigation_occlusion_never_moves_pointer_or_forces_input(self):
        for reason in ('occluded','disabled','stale_element'):
            session=SimpleNamespace(evaluate=AsyncMock(return_value={'reason':reason,'navigation_hover_blocker':False}),
                                    send_command=AsyncMock())
            result=await prepare_pointer_target(session,1)
            self.assertEqual(result['reason'],reason)
            session.send_command.assert_not_awaited()

    async def test_lost_focus_observation_retries_probe_then_inserts_only_once(self):
        session=BrowserSession('input-recovery')
        session.scroll_to_element=AsyncMock(return_value=True)
        session.send_command=AsyncMock(return_value={})
        session.evaluate=AsyncMock(side_effect=[None,{'type':'email','value':'','autocomplete':False},'qa@example.com'])
        await session.type_text('qa@example.com',element_id=1)
        calls=session.send_command.call_args_list
        self.assertEqual(sum(c.args[0]=='Input.insertText' for c in calls),1)
        self.assertEqual(session.evaluate.call_args_list[0],session.evaluate.call_args_list[1])

    async def test_missing_or_disabled_input_never_retries_or_dispatches_text(self):
        for probe in ({'error':'Requested input is disabled.'},{'error':'Requested input is missing.'},None):
            session=BrowserSession('no-input-dispatch')
            session.scroll_to_element=AsyncMock(return_value=False)
            session.send_command=AsyncMock()
            session.evaluate=AsyncMock(return_value=probe)
            with self.assertRaisesRegex(RuntimeError,'No text input was dispatched'):
                await session.type_text('private',element_id=1)
            session.send_command.assert_not_awaited()
            self.assertEqual(session.evaluate.await_count,2 if probe is None else 1)

    async def test_dom_progress_skips_images_but_keeps_evidence(self):
        session=SimpleNamespace(current_url='https://fixture.invalid/',page_title='Fixture',capture_screenshot=AsyncMock(return_value='fresh'))
        sink=AsyncMock()
        token=progress_sink.set(sink)
        try:
            await snapshot_step(session,'browser_interact',{'action':'type'},{'status':'passed','verification':{'verified':True}},include_frame=False)
            session.capture_screenshot.assert_not_awaited()
            self.assertEqual(sink.call_args.args[0]['result']['verification'],{'verified':True})
            self.assertEqual(sink.call_args.args[0]['result']['frame'],'')
            await snapshot_step(session,'browser_interact',{'action':'type'},{'status':'passed'},include_frame=True)
            session.capture_screenshot.assert_awaited_once_with(quality=45,use_cache=False)
            self.assertEqual(sink.call_args.args[0]['result']['frame'],'data:image/jpeg;base64,fresh')
        finally:
            progress_sink.reset(token)
