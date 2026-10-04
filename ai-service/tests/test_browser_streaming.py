import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.browser_streaming import LiveFrameBuffer
from app.browser_driver import BrowserManager
from app.browser_driver import browser_manager


def video(key=False, seq=0):
    return {"seq": seq, "metadata": {"codec": "h264", "isKeyFrame": key}}


class StreamBufferTests(unittest.IsolatedAsyncioTestCase):
    async def test_remote_burst_preserves_dependency_chain_without_overflow(self):
        buffer = LiveFrameBuffer()
        for seq in range(8):
            self.assertTrue(buffer.push(video(seq == 0,seq)))
        self.assertEqual([ (await buffer.get())['seq'] for _ in range(8)],list(range(8)))
        self.assertEqual(buffer.overflow_resets,0)

    async def test_delayed_chain_expires_then_requires_fresh_keyframe(self):
        buffer = LiveFrameBuffer(max_residence_ms=150)
        with patch('app.browser_streaming.time.monotonic',return_value=1.0):
            buffer.push(video(True,1))
            buffer.push(video(seq=2))
        with patch('app.browser_streaming.time.monotonic',return_value=1.2):
            waiter = asyncio.create_task(buffer.get())
            await asyncio.sleep(0)
            self.assertTrue(buffer.waiting_for_keyframe)
            self.assertFalse(buffer.push(video(seq=3)))
            buffer.push(video(True,4))
            self.assertEqual((await asyncio.wait_for(waiter,1))['seq'],4)
        self.assertEqual(buffer.overflow_resets,1)
        self.assertEqual(buffer.emitted_frames,1)

    async def test_stale_tab_record_does_not_prevent_socket_attach_recovery(self):
        from fastapi import WebSocketDisconnect
        from app.main import websocket_browser_stream
        messages=[]
        class Socket:
            client_state=SimpleNamespace(name='CONNECTED')
            query_params={}
            first=True
            async def accept(self): pass
            async def send_json(self,data): messages.append(data)
            async def send_bytes(self,data): pass
            async def receive_text(self):
                if self.first:
                    self.first=False
                    return json.dumps({'type':'attach','url':'https://fixture.invalid/'})
                raise WebSocketDisconnect()
        stale=SimpleNamespace(is_connected=False)
        fresh=SimpleNamespace(session_id='stale-socket-fixture',is_connected=True,h264_active=False,
            config=SimpleNamespace(mode='local'),
            current_url='https://fixture.invalid/',page_title='Fixture',interactive_elements=[],latest_frame=None,_frame_seq=0,
            add_listener=lambda _:None,remove_listener=lambda _:None,
            capture_screenshot=AsyncMock(return_value=None))
        async def recreate(**kwargs):
            browser_manager.sessions[kwargs['session_id']]=fresh
            return fresh
        async def activate(session_id):
            self.assertTrue(browser_manager.sessions[session_id].is_connected)
        with patch.dict(browser_manager.sessions,{'stale-socket-fixture':stale},clear=True), \
             patch('app.browser_ticket.verify',return_value={'control':True,'user_id':'fixture','expires':__import__('time').time()+300}), \
             patch.object(browser_manager,'get_or_create_session',AsyncMock(side_effect=recreate)) as create, \
             patch.object(browser_manager,'activate_display',AsyncMock(side_effect=activate)) as display:
            await websocket_browser_stream(Socket(),'stale-socket-fixture')
        create.assert_awaited_once()
        display.assert_awaited_once()
        self.assertTrue(any(m.get('type')=='page_state' and m.get('url')==fresh.current_url for m in messages))
        self.assertTrue(any(m.get('type')=='stream_capabilities' for m in messages))

    async def test_action_feedback_does_not_capture_images_without_jpeg_demand(self):
        from app.browser_driver import BrowserSession
        session=BrowserSession('capture-on-demand')
        session.is_connected=True
        session.cdp_ws=object()
        session.send_command=AsyncMock(return_value={})
        await session.force_fresh_frame()
        session.send_command.assert_not_awaited()
        viewer=lambda _:None
        session.add_listener(viewer)
        session.viewer_codecs[viewer]='h264'
        session.h264_active=True
        await session.force_fresh_frame()
        session.send_command.assert_not_awaited()
        session.viewer_codecs[viewer]='jpeg'
        await session.force_fresh_frame()
        self.assertEqual(session.send_command.call_args.args[0],'Page.captureScreenshot')
    async def test_native_video_stops_duplicate_jpeg_and_fallback_restarts_it(self):
        from app.browser_driver import BrowserSession
        session = BrowserSession('capture-demand')
        session.is_connected = True
        session.h264_active = True
        session._jpeg_streaming = True
        viewer = lambda _:None
        session.add_listener(viewer)
        session.viewer_codecs[viewer] = 'h264'
        session.send_command = AsyncMock()
        with patch.object(browser_manager,'display_session_id',session.session_id):
            await session.sync_capture_mode()
            session.send_command.assert_awaited_once_with('Page.stopScreencast')
            session.send_command.reset_mock()
            session.viewer_codecs[viewer] = 'jpeg'
            await session.sync_capture_mode()
            self.assertEqual(session.send_command.call_args.args[0],'Page.startScreencast')
            session.send_command.reset_mock()
            await session.sync_capture_mode()
            session.send_command.assert_not_awaited()
            session.remove_listener(viewer)
            await session.sync_capture_mode()
            session.send_command.assert_awaited_once_with('Page.stopScreencast')

    async def test_video_loss_restarts_tab_specific_images(self):
        from app.browser_driver import BrowserSession
        session = BrowserSession('video-loss')
        session.is_connected = True
        session.add_listener(lambda _:None)
        session.send_command = AsyncMock()
        await session.sync_capture_mode()
        self.assertEqual(session.send_command.call_args.args[0],'Page.startScreencast')
    async def test_unviewed_session_does_not_read_desktop_video(self):
        from app.browser_driver import BrowserSession
        session = BrowserSession('not-displayed')
        session.is_connected = True
        session.listeners.add(lambda _:None)
        with patch.object(browser_manager,'display_session_id','another-session'), \
             patch('app.browser_driver.asyncio.open_connection',AsyncMock()) as connect:
            task = asyncio.create_task(session._h264_stream_loop())
            await asyncio.sleep(0.025)
            session.is_connected = False
            await asyncio.wait_for(task,0.3)
        connect.assert_not_awaited()
        self.assertFalse(session.h264_active)

    async def test_displayed_session_without_viewers_does_not_read_video(self):
        from app.browser_driver import BrowserSession
        session = BrowserSession('no-viewers')
        session.is_connected = True
        with patch.object(browser_manager,'display_session_id',session.session_id), \
             patch('app.browser_driver.asyncio.open_connection',AsyncMock()) as connect:
            task = asyncio.create_task(session._h264_stream_loop())
            await asyncio.sleep(0.025)
            session.is_connected = False
            await asyncio.wait_for(task,0.3)
        connect.assert_not_awaited()
    async def test_idle_video_fallback_keeps_capturing_current_tab_without_navigation(self):
        from fastapi import WebSocketDisconnect
        from app.main import websocket_browser_stream
        stop = asyncio.Event()
        messages = []
        class Socket:
            client_state = SimpleNamespace(name="CONNECTED")
            query_params = {}
            first = True
            async def accept(self): pass
            async def send_json(self, data): messages.append(data)
            async def send_bytes(self, data): pass
            async def receive_text(self):
                if self.first:
                    self.first = False
                    return json.dumps({"type": "stream_recover"})
                await stop.wait()
                raise WebSocketDisconnect()
        session = SimpleNamespace(
            session_id="fallback", is_connected=True, h264_active=True, current_url="https://fixture.invalid/",
            page_title="Fixture", interactive_elements=[], latest_frame=None, _frame_seq=8,
            add_listener=lambda _: None, remove_listener=lambda _: None,
            start_jpeg_stream=AsyncMock(side_effect=RuntimeError("Screencast is already active")), capture_screenshot=AsyncMock(return_value="/9j/"))
        with patch.dict(browser_manager.sessions, {"fallback": session}, clear=True), \
             patch('app.browser_ticket.verify',return_value={'control':True,'expires':__import__('time').time()+300}), \
             patch.object(browser_manager, "activate_display", AsyncMock()), \
             patch.object(browser_manager, "get_or_create_session", AsyncMock()) as navigate:
            task = asyncio.create_task(websocket_browser_stream(Socket(), "fallback"))
            try:
                async with asyncio.timeout(2):
                    while sum(m.get("type") == "frame" for m in messages) < 3:
                        await asyncio.sleep(0.05)
            finally:
                stop.set()
                await asyncio.wait_for(task, 1)
            navigate.assert_not_awaited()
        self.assertGreaterEqual(session.capture_screenshot.await_count, 3)
        self.assertTrue(any(m.get("type") == "stream_reset" for m in messages))
        self.assertTrue(any(m.get("type") == "stream_health" for m in messages))

    async def test_new_and_overloaded_viewers_wait_for_fresh_keyframe(self):
        buffer = LiveFrameBuffer(capacity=2)
        buffer.push(video(seq=1))
        self.assertTrue(buffer.queue.empty())
        buffer.push(video(True, 2))
        buffer.push(video(seq=3))
        buffer.push(video(seq=4))
        self.assertTrue(buffer.queue.empty())
        buffer.push(video(seq=5))
        self.assertTrue(buffer.queue.empty())
        buffer.push(video(True, 6))
        self.assertEqual((await buffer.get())["seq"], 6)

    async def test_jpeg_keeps_only_latest_independent_frame(self):
        buffer = LiveFrameBuffer()
        for seq in range(500):
            buffer.push({"seq": seq, "metadata": {}})
        self.assertEqual(buffer.queue.qsize(), 1)
        self.assertEqual((await buffer.get())["seq"], 499)

    async def test_display_activation_selects_exact_tab_and_invalidates_old_video(self):
        manager = BrowserManager()
        old = SimpleNamespace(is_connected=True, h264_active=True, _last_keyframe_packet=b"stale", send_command=AsyncMock())
        selected = SimpleNamespace(is_connected=True, send_command=AsyncMock())
        manager.sessions.update(old=old, selected=selected)
        await manager.activate_display("selected")
        selected.send_command.assert_awaited_once_with("Page.bringToFront")
        old.send_command.assert_not_awaited()
        self.assertEqual(manager.display_session_id, "selected")
        self.assertFalse(old.h264_active)
        self.assertIsNone(old._last_keyframe_packet)
        self.assertTrue(selected._video_needs_keyframe)

    async def test_background_session_creation_restores_display_without_aliasing(self):
        manager = BrowserManager()
        displayed = SimpleNamespace(is_connected=True, send_command=AsyncMock(),listeners={object()})
        manager.sessions["displayed"] = displayed
        manager.display_session_id = "displayed"
        with patch("app.browser_driver.BrowserSession.connect", AsyncMock()):
            created = await manager.get_or_create_session("background")
        self.assertIsNot(created, displayed)
        displayed.send_command.assert_awaited_once_with("Page.bringToFront")
        self.assertEqual(manager.display_session_id, "displayed")
