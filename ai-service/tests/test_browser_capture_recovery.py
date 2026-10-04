"""Capture recovery must restore media without replaying actions or navigation."""
import asyncio
import json
import struct
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from app.browser_driver import BrowserSession, browser_manager
from app.browser_streaming import LiveFrameBuffer


class CaptureRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_rtc_keeps_source_cadence_when_network_delivers_a_burst(self):
        from app.browser_rtc import BrowserVideoTrack
        session,_=self.session()
        track=BrowserVideoTrack(session)
        self.addCleanup(track.stop)
        for seq,source_us in enumerate((1000000,1016667,1033334)):
            raw=struct.pack('>2sIQH',b'SP',seq,100,2)+b'{}'+b'\x00\x00\x00\x01\x65picture'
            track.on_event({'type':'frame','seq':seq,'raw_bytes':raw,
                'metadata':{'codec':'h264','isKeyFrame':seq==0,'source_timestamp_us':source_us}})
        packets=[await track.recv() for _ in range(3)]
        self.assertEqual([p.pts-packets[0].pts for p in packets],[0,1500,3000])

    def session(self, name='capture-recovery'):
        session = BrowserSession(name)
        session.is_connected = True
        session.config = SimpleNamespace(stream_host='fixture', stream_port=8099)
        session.send_command = AsyncMock(return_value={})
        viewer = Mock()
        session.add_listener(viewer)
        session.viewer_codecs[viewer] = 'jpeg'
        return session, viewer

    async def test_all_jpeg_viewers_do_not_start_desktop_encoder(self):
        session, viewer = self.session()
        with patch.object(browser_manager, 'display_session_id', session.session_id), \
                patch('app.browser_driver.asyncio.open_connection', AsyncMock()) as connect:
            task = asyncio.create_task(session._h264_stream_loop())
            await asyncio.sleep(0.025)
            session.is_connected = False
            await asyncio.wait_for(task, 0.3)
            session.viewer_codecs[lambda _: None] = 'h264'  # orphan entries cannot force capture
            self.assertFalse(session.needs_h264_capture())
        connect.assert_not_awaited()

    async def test_switch_to_jpeg_closes_existing_tcp_producer_connection(self):
        session, viewer = self.session()
        session.viewer_codecs[viewer] = 'h264'
        frame_received = asyncio.Event()
        viewer.side_effect = lambda event: frame_received.set() if event.get('type') == 'frame' else None
        reader = asyncio.StreamReader()
        reader.feed_data(struct.pack('>IB', 5, 1) + b'video')
        writer = Mock()
        writer.get_extra_info.return_value = None
        writer.is_closing.return_value = False
        writer.wait_closed = AsyncMock()
        writer.close.side_effect = reader.feed_eof
        with patch.object(browser_manager, 'display_session_id', session.session_id), \
                patch('app.browser_driver.asyncio.open_connection', AsyncMock(return_value=(reader, writer))):
            task = asyncio.create_task(session._h264_stream_loop())
            try:
                await asyncio.wait_for(frame_received.wait(), 0.3)
                self.assertTrue(session.h264_active)
                session.viewer_codecs[viewer] = 'jpeg'
                await session.sync_capture_mode()
                self.assertFalse(session.h264_active)
                self.assertTrue(session._jpeg_streaming)
                self.assertGreaterEqual(writer.close.call_count, 1)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertIsNone(session._stream_writer)

    async def test_temporary_media_worker_outage_is_retried_without_action_replay(self):
        session, viewer = self.session()
        session.viewer_codecs[viewer] = 'h264'
        received = asyncio.Event()
        viewer.side_effect = lambda event: received.set() if event.get('type') == 'frame' else None
        reader = asyncio.StreamReader()
        reader.feed_data(struct.pack('>IB', 5, 1) + b'video')
        writer = Mock()
        writer.get_extra_info.return_value = None
        writer.wait_closed = AsyncMock()
        with patch.object(browser_manager, 'display_session_id', session.session_id), \
                patch('app.browser_driver.asyncio.open_connection',
                      AsyncMock(side_effect=[ConnectionRefusedError(), (reader, writer)])) as connect:
            task = asyncio.create_task(session._h264_stream_loop())
            try:
                await asyncio.wait_for(received.wait(), 1)
                self.assertEqual(connect.await_count, 2)
                self.assertTrue(session.h264_active)
                session.send_command.assert_not_awaited()
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_new_viewer_restarts_stale_jpeg_once_and_cooldown_bounds_recovery(self):
        session, _ = self.session()
        session._jpeg_streaming = True
        session._jpeg_started_at = 10
        session._last_jpeg_frame_at = 11
        session._last_activity = 10
        with patch('app.browser_driver.time.monotonic', return_value=20):
            await session.sync_capture_mode()
            self.assertEqual([call.args[0] for call in session.send_command.await_args_list],
                             ['Page.stopScreencast', 'Page.startScreencast'])
        session.send_command.reset_mock()
        with patch('app.browser_driver.time.monotonic', return_value=22.5):
            await session.sync_capture_mode()
            await session.restart_jpeg_stream()
        session.send_command.assert_not_awaited()

    async def test_static_jpeg_pause_does_not_restart_without_fresh_demand(self):
        session, _ = self.session()
        session._jpeg_streaming = True
        session._jpeg_started_at = 10
        session._jpeg_demand_since = 10
        session._last_jpeg_frame_at = 11
        session._last_activity = 10
        with patch('app.browser_driver.time.monotonic', return_value=100):
            await session.sync_capture_mode()
        session.send_command.assert_not_awaited()
        # A new input must produce a fresh frame; this is genuine stalled demand.
        session._last_activity = 101
        with patch('app.browser_driver.time.monotonic', return_value=103.2):
            await session.sync_capture_mode()
        self.assertEqual(session.send_command.await_args_list[0].args[0], 'Page.stopScreencast')

    async def test_startup_grace_and_actual_new_jpeg_suppress_restart(self):
        session, _ = self.session()
        session._last_activity = 20
        with patch('app.browser_driver.time.monotonic', return_value=20):
            await session.sync_capture_mode()
        session.send_command.reset_mock()
        with patch('app.browser_driver.time.monotonic', return_value=21):
            await session.sync_capture_mode()
            session._record_media_frame('jpeg')
        with patch('app.browser_driver.time.monotonic', return_value=23.5):
            await session.sync_capture_mode()
        session.send_command.assert_not_awaited()

    async def test_failed_restart_does_not_leave_capture_flag_stuck(self):
        session, _ = self.session()
        session._jpeg_streaming = True
        session.send_command.side_effect = [RuntimeError('CDP timeout'), {}]
        with self.assertRaises(RuntimeError):
            await session.restart_jpeg_stream()
        self.assertFalse(session._jpeg_streaming)
        await session.start_jpeg_stream()
        self.assertTrue(session._jpeg_streaming)

    async def test_capture_metrics_distinguish_screencast_from_cached_snapshots(self):
        session, _ = self.session()
        session._last_frame_time = 50  # snapshot/heartbeat bookkeeping is not a source sample
        with patch('app.browser_driver.time.monotonic', return_value=50):
            self.assertEqual(session.media_status()['jpeg_screencast_fps'], 0)
            self.assertIsNone(session.media_status()['last_jpeg_age_ms'])
            session._record_media_frame('jpeg')
            session._record_media_frame('h264')
        with patch('app.browser_driver.time.monotonic', return_value=50.1):
            session._record_media_frame('jpeg')
            session._record_media_frame('h264')
            status = session.media_status()
            self.assertEqual(status['jpeg_screencast_fps'], 10)
            self.assertEqual(status['h264_source_fps'], 10)
        with patch('app.browser_driver.time.monotonic', return_value=53):
            self.assertEqual(session.media_status()['jpeg_screencast_fps'], 0)
            self.assertEqual(session.media_status()['last_jpeg_age_ms'], 2900)

    async def test_gop_overflow_diagnostics_preserve_dependency_recovery(self):
        clock = [10.0]
        with patch('app.browser_streaming.time.monotonic', side_effect=lambda: clock[0]):
            buffer = LiveFrameBuffer(capacity=2)
            def frame(seq, key=False):
                return {'seq': seq, 'metadata': {'codec': 'h264', 'isKeyFrame': key}}
            self.assertTrue(buffer.push(frame(1, True)))
            self.assertTrue(buffer.push(frame(2)))
            clock[0] = 10.2
            self.assertFalse(buffer.push(frame(3)))
            self.assertTrue(buffer.queue.empty())
            self.assertFalse(buffer.push(frame(4)))
            clock[0] = 10.8
            self.assertTrue(buffer.push(frame(5, True)))
            clock[0] = 10.85
            self.assertEqual((await buffer.get())['seq'], 5)
            status = buffer.status()
        self.assertEqual(status['overflow_resets'], 1)
        self.assertEqual(status['rejected_deltas'], 2)
        self.assertEqual(status['discarded_frames'], 2)
        self.assertEqual(status['received_frames'], 5)
        self.assertEqual(status['emitted_frames'], 1)
        self.assertFalse(status['waiting_for_keyframe'])
        self.assertAlmostEqual(status['max_keyframe_wait_ms'], 600)
        self.assertAlmostEqual(status['last_residence_ms'], 50)

    async def test_shared_event_has_independent_per_viewer_queue_residence(self):
        first, second = LiveFrameBuffer(), LiveFrameBuffer()
        event = {'seq': 1, 'metadata': {}}
        with patch('app.browser_streaming.time.monotonic', return_value=10):
            first.push(event)
        with patch('app.browser_streaming.time.monotonic', return_value=20):
            second.push(event)
        with patch('app.browser_streaming.time.monotonic', return_value=20.1):
            await first.get()
            await second.get()
        self.assertNotIn('_buffer_enqueued_at', event)
        self.assertAlmostEqual(first.last_residence_ms, 10100)
        self.assertAlmostEqual(second.last_residence_ms, 100)

    async def test_rtc_diagnostics_measure_receipt_age_separately_from_queue_residence(self):
        from app.browser_rtc import BrowserVideoTrack
        session, _ = self.session()
        track = BrowserVideoTrack(session)
        self.addCleanup(track.stop)
        track.started = 100
        payload = b'\x00\x00\x00\x01\x65keyframe'
        raw = struct.pack('>2sIQH', b'SP', 7, 100, 2) + b'{}' + payload
        with patch('app.browser_rtc.time.monotonic', return_value=100.6):
            track.on_event({'type': 'frame', 'seq': 7, 'metadata': {'codec': 'h264', 'isKeyFrame': True},
                            'raw_bytes': raw, '_media_received_at': 100})
        with patch('app.browser_rtc.time.monotonic', return_value=100.7):
            packet = await asyncio.wait_for(track.recv(), 0.3)
            status = track.media_status()
        self.assertEqual(bytes(packet), payload)
        self.assertEqual(status['last_source_seq'], 7)
        self.assertEqual(status['submitted_frames'], 1)
        self.assertAlmostEqual(status['last_source_received_age_ms'], 700)
        self.assertAlmostEqual(status['queue']['last_residence_ms'], 100)

    async def test_capture_diagnostics_expose_pending_tcp_bytes(self):
        session, _ = self.session()
        reader = asyncio.StreamReader()
        reader.feed_data(b'pending')
        session._stream_reader = reader
        self.assertEqual(session.media_status()['h264_tcp_buffered_bytes'], 7)

    async def test_native_rtc_viewer_does_not_keep_jpeg_backup_capture_running(self):
        from fastapi import WebSocketDisconnect
        from app.main import websocket_browser_stream
        answered = asyncio.Event()
        codecs, messages = [], []
        class Peer:
            connected = True
            track = SimpleNamespace(encoded=True)
            def __init__(self, session): pass
            async def answer(self, sdp): return {'type': 'rtc_answer', 'sdp': 'answer'}
            async def close(self): pass
        session = SimpleNamespace(session_id='native-with-jpeg-backup', is_connected=True, h264_active=True,
            config=SimpleNamespace(mode='local'), current_url='https://fixture.invalid/', page_title='Fixture',
            interactive_elements=[], latest_frame=None, _frame_seq=0, viewer_codecs={},
            add_listener=lambda _: None, remove_listener=lambda _: None,
            capture_screenshot=AsyncMock(return_value=None),
            media_status=lambda: {'jpeg_screencast_fps': 0, 'h264_source_fps': 30})
        async def sync_capture_mode():
            codecs.append(list(session.viewer_codecs.values()))
        session.sync_capture_mode = sync_capture_mode
        fixture = self
        class Socket:
            client_state = SimpleNamespace(name='CONNECTED')
            query_params = {}
            index = 0
            async def accept(self): pass
            async def send_bytes(self, data): pass
            async def send_json(self, data):
                messages.append(data)
                if data.get('type') == 'rtc_answer': answered.set()
            async def receive_text(self):
                self.index += 1
                if self.index == 1:
                    value = {'type': 'attach', 'url': session.current_url, 'video_codec': 'jpeg'}
                elif self.index == 2:
                    value = {'type': 'rtc_offer', 'sdp': 'offer'}
                elif self.index == 3:
                    await answered.wait()
                    value = {'type': 'rtc_ready'}
                else:
                    captures = session.capture_screenshot.await_count
                    await asyncio.sleep(0.2)
                    fixture.assertEqual(session.capture_screenshot.await_count, captures)
                    fixture.assertEqual(codecs[-1], ['h264'])
                    raise WebSocketDisconnect()
                return json.dumps(value)
        with patch.dict(browser_manager.sessions, {session.session_id: session}, clear=True), \
                patch('app.browser_ticket.verify', return_value={'control': True, 'expires': time.time()+300}), \
                patch.object(browser_manager, 'activate_display', AsyncMock()), \
                patch.object(browser_manager, 'get_or_create_session', AsyncMock(return_value=session)), \
                patch('app.browser_rtc.BrowserPeer', Peer):
            async with asyncio.timeout(3):
                await websocket_browser_stream(Socket(), session.session_id)
        self.assertTrue(any(message.get('capture', {}).get('h264_source_fps') == 30
                            for message in messages if message.get('type') == 'stream_health'))


if __name__ == '__main__':
    unittest.main()
