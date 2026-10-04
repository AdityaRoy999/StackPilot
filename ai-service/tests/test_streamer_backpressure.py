"""Producer-side overload must not freeze healthy viewers or corrupt H.264."""
import importlib.util
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, AsyncMock, patch
import unittest

path = Path(__file__).with_name('streamer_module.py')
if not path.exists():
    path = Path(__file__).resolve().parents[2] / 'browser-sandbox' / 'streamer.py'


@unittest.skipUnless(path.exists(), 'Video producer source must be available')
class StreamerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        spec = importlib.util.spec_from_file_location('qa_streamer', path)
        self.streamer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.streamer)

    def writer(self, buffered=0, closing=False):
        return Mock(transport=SimpleNamespace(get_write_buffer_size=lambda:buffered),
                    is_closing=Mock(return_value=closing))

    async def test_slow_client_is_disconnected_without_blocking_healthy_client(self):
        healthy, slow = self.writer(), self.writer(self.streamer.MAX_CLIENT_BUFFER)
        self.streamer.active_clients.update([healthy,slow])
        await self.streamer.broadcast_packet(b'frame')
        healthy.write.assert_called_once_with(b'frame')
        slow.write.assert_not_called()
        slow.close.assert_called_once()
        self.assertEqual(self.streamer.active_clients, {healthy})

    async def test_closing_client_does_not_receive_delta_packets(self):
        closing = self.writer(closing=True)
        self.streamer.active_clients.add(closing)
        await self.streamer.broadcast_packet(b'delta')
        closing.write.assert_not_called()
        self.assertFalse(self.streamer.active_clients)

    async def test_new_client_waits_for_live_keyframe_not_cached_gop(self):
        client = self.writer()
        self.streamer.active_clients.add(client)
        self.streamer.waiting_for_keyframe.add(client)
        await self.streamer.broadcast_packet(b'\x00\x00\x00\x01\x00P')
        client.write.assert_not_called()
        key = b'\x00\x00\x00\x01\x01I'
        await self.streamer.broadcast_packet(key)
        client.write.assert_called_once_with(key)
        await self.streamer.broadcast_packet(b'\x00\x00\x00\x01\x00P')
        self.assertEqual(client.write.call_count,2)
        self.assertNotIn(client,self.streamer.waiting_for_keyframe)

    async def test_source_timestamps_are_opt_in_and_preserve_payload(self):
        import struct
        legacy,timed=self.writer(),self.writer()
        self.streamer.active_clients.update([legacy,timed])
        self.streamer.timestamp_clients.add(timed)
        original=struct.pack('>IB',1,1)+b'I'
        await self.streamer.broadcast_packet(original,source_timestamp_us=123456789)
        legacy.write.assert_called_once_with(original)
        timed.write.assert_called_once_with(struct.pack('>IBQ',1,0x81,123456789)+b'I')

    async def test_encoder_is_terminated_and_reaped(self):
        proc = Mock(returncode=None, wait=AsyncMock(return_value=0))
        await self.streamer.terminate_encoder(proc)
        proc.terminate.assert_called_once()
        proc.wait.assert_awaited_once()
        proc.kill.assert_not_called()

    async def test_unresponsive_encoder_is_killed_then_reaped(self):
        import asyncio
        proc = Mock(returncode=None, wait=AsyncMock(return_value=0))
        async def timeout(awaitable,timeout):
            awaitable.close()
            raise asyncio.TimeoutError
        with patch.object(self.streamer.asyncio,'wait_for',timeout):
            await self.streamer.terminate_encoder(proc)
        proc.terminate.assert_called_once()
        proc.kill.assert_called_once()
        self.assertEqual(proc.wait.await_count,1)

    async def test_encoder_warmup_zero_does_not_trigger_overload(self):
        stream = Mock(read=AsyncMock(side_effect=[b"speed=0x\n", b""]))
        await self.streamer.drain_encoder_errors(stream)
        self.assertEqual(self.streamer.policy.speed, 1)
        stream = Mock(read=AsyncMock(side_effect=[b"speed=0.6x\n", b""]))
        await self.streamer.drain_encoder_errors(stream)
        self.assertEqual(self.streamer.policy.speed, .6)

    async def test_progress_reports_split_across_reads_are_not_lost(self):
        stream = Mock(read=AsyncMock(side_effect=[b"spe", b"ed=0.7", b"x\nfra", b"me=20\nfps=60\n", b""]))
        with patch.object(self.streamer.policy, 'record_encoder_frame_count') as fps:
            await self.streamer.drain_encoder_errors(stream)
        self.assertEqual(self.streamer.policy.speed, .7)
        fps.assert_called_once_with(20)

    def test_capture_adapts_to_activity_visibility_and_real_client_pressure(self):
        policy = self.streamer.CapturePolicy()
        client = self.writer()
        self.streamer.active_clients.add(client)
        policy.update(client, {"type": "activity"}, now=10)
        self.assertEqual(policy.rate(now=11), self.streamer.FPS)
        self.assertEqual(policy.rate(now=18), self.streamer.IDLE_FPS)
        policy.update(client, {"type": "activity"}, now=20)
        policy.update(client, {"type": "feedback", "gap_ms": 0, "presentation_interval_ms": 16,
                               "frames_presented": 30, "decode_queue": 0, "rtt_ms": 20}, now=20)
        self.assertEqual(policy.rate(now=21), self.streamer.MAX_FPS)
        policy.update(client, {"type": "feedback", "gap_ms": 200}, now=21)
        self.assertEqual(policy.rate(now=22), 15)
        policy.update(client, {"type": "feedback", "visible": False}, now=22)
        self.assertEqual(policy.rate(now=23), self.streamer.IDLE_FPS)

    def test_slow_encoder_prevents_fps_boost_and_expired_feedback_is_ignored(self):
        policy = self.streamer.CapturePolicy()
        client = self.writer()
        self.streamer.active_clients.add(client)
        policy.update(client, {"type": "activity"}, now=20)
        policy.update(client, {"type": "feedback", "gap_ms": 0, "presentation_interval_ms": 16,
                               "frames_presented": 30, "rtt_ms": 20}, now=20)
        policy.speed = .6
        self.assertEqual(policy.rate(now=21), 15)
        policy.speed = 1
        policy.update(client, {"type": "activity"}, now=30)
        self.assertEqual(policy.rate(now=31), self.streamer.FPS)

    def test_visible_animated_page_stays_smooth_without_mouse_activity(self):
        policy = self.streamer.CapturePolicy()
        client = self.writer()
        self.streamer.active_clients.add(client)
        policy.update(client, {"type": "activity"}, now=10)
        policy.update(client, {"type": "feedback", "visible": True, "gap_ms": 0,
                               "presentation_interval_ms": 125, "frames_presented": 8,
                               "rtt_ms": 20}, now=100)
        self.assertEqual(policy.rate(now=101), self.streamer.FPS)

    def test_empty_measurements_cannot_qualify_a_boost(self):
        policy = self.streamer.CapturePolicy()
        client = self.writer()
        self.streamer.active_clients.add(client)
        policy.update(client, {"type": "activity"}, now=10)
        for feedback in [{}, {"gap_ms": 0, "rtt_ms": 20},
                         {"gap_ms": 0, "rtt_ms": 20, "presentation_interval_ms": 16, "frames_presented": 1}]:
            policy.update(client, {"type": "feedback", **feedback}, now=10)
            self.assertEqual(policy.rate(now=11), self.streamer.FPS)

    def test_hidden_slow_viewer_does_not_throttle_a_visible_viewer(self):
        policy = self.streamer.CapturePolicy()
        visible, hidden = self.writer(), self.writer()
        self.streamer.active_clients.update([visible, hidden])
        policy.update(visible, {"type": "activity"}, now=10)
        policy.update(visible, {"type": "feedback", "visible": True}, now=10)
        policy.update(hidden, {"type": "feedback", "visible": False, "gap_ms": 500,
                               "rtt_ms": 500, "decode_queue": 10}, now=10)
        self.assertEqual(policy.rate(now=11), self.streamer.FPS)

    def test_real_jitter_buffer_congestion_reduces_rate(self):
        policy = self.streamer.CapturePolicy()
        client = self.writer()
        self.streamer.active_clients.add(client)
        policy.update(client, {"type": "activity"}, now=10)
        policy.update(client, {"type": "feedback", "visible": True, "jitter_buffer_ms": 300}, now=10)
        self.assertEqual(policy.rate(now=11), 15)

    def test_nonfinite_feedback_cannot_force_bad_rate(self):
        policy = self.streamer.CapturePolicy()
        client = self.writer()
        self.streamer.active_clients.add(client)
        policy.update(client, {"type": "activity"}, now=10)
        policy.update(client, {"type": "feedback", "gap_ms": float('nan'),
                               "rtt_ms": float('inf'), "frames_presented": True}, now=10)
        self.assertEqual(policy.rate(now=11), self.streamer.FPS)

    def test_encoder_transition_requires_sustained_feedback(self):
        transition = self.streamer.CaptureRateTransition(30, now=10)
        self.assertFalse(transition.should_restart(60, now=11))
        self.assertFalse(transition.should_restart(30, now=12))
        self.assertFalse(transition.should_restart(60, now=16))
        self.assertFalse(transition.should_restart(60, now=17))
        self.assertTrue(transition.should_restart(60, now=17.5))

    def test_new_encoder_is_not_restarted_during_warmup(self):
        transition = self.streamer.CaptureRateTransition(30, now=10)
        self.assertFalse(transition.should_restart(15, now=10))
        self.assertFalse(transition.should_restart(15, now=15.5))
        self.assertTrue(transition.should_restart(15, now=16))

    def test_sustained_encoder_fps_deficit_cools_down_60_fps_boost(self):
        policy = self.streamer.CapturePolicy()
        client = self.writer()
        self.streamer.active_clients.add(client)
        policy.begin_encoder(60, now=10)
        feedback = {"type": "feedback", "gap_ms": 0, "presentation_interval_ms": 16,
                    "frames_presented": 45, "rtt_ms": 20}
        policy.update(client, {"type": "activity"}, now=15)
        policy.update(client, feedback, now=15)
        policy.record_encoder_fps(45, now=13)
        self.assertEqual(policy.rate(now=14), self.streamer.MAX_FPS)
        self.assertEqual(policy.rate(now=15), self.streamer.FPS)
        policy.begin_encoder(30, now=16)
        policy.update(client, feedback, now=18)
        self.assertEqual(policy.rate(now=19), self.streamer.FPS)
        policy.update(client, {"type": "activity"}, now=47)
        policy.update(client, feedback, now=47)
        self.assertEqual(policy.rate(now=48), self.streamer.MAX_FPS)

    def test_encoder_warmup_and_single_bad_report_do_not_change_rate(self):
        policy = self.streamer.CapturePolicy()
        policy.begin_encoder(30, now=10)
        policy.record_encoder_fps(1, now=11)
        self.assertIsNone(policy.low_fps_since)
        policy.record_encoder_fps(20, now=13)
        policy.record_encoder_fps(30, now=14)
        self.assertIsNone(policy.low_fps_since)

    def test_recent_slowdown_is_not_hidden_by_a_long_healthy_average(self):
        policy = self.streamer.CapturePolicy()
        client = self.writer()
        self.streamer.active_clients.add(client)
        policy.begin_encoder(60, now=10)
        policy.record_encoder_frame_count(0, now=10)
        policy.record_encoder_frame_count(60000, now=1010)
        policy.update(client, {"type": "activity"}, now=1011)
        policy.update(client, {"type": "feedback", "gap_ms": 0, "presentation_interval_ms": 16,
                               "frames_presented": 60, "rtt_ms": 20}, now=1011)
        for second in range(1, 4):
            policy.record_encoder_frame_count(60000 + second * 10, now=1010 + second)
        self.assertEqual(policy.rate(now=1013), self.streamer.FPS)
        self.assertGreater(policy.boost_blocked_until, 1013)

    def test_encoder_stop_after_warmup_is_an_actual_zero_fps_deficit(self):
        policy = self.streamer.CapturePolicy()
        policy.begin_encoder(30, now=10)
        policy.record_encoder_frame_count(0, now=10)
        policy.record_encoder_frame_count(90, now=13)
        policy.record_encoder_frame_count(90, now=14)
        policy.record_encoder_frame_count(90, now=16)
        self.assertEqual(policy.low_fps_since, 14)

    def test_counter_resets_and_tiny_report_intervals_do_not_create_bad_rates(self):
        policy = self.streamer.CapturePolicy()
        policy.begin_encoder(30, now=10)
        policy.record_encoder_frame_count(0, now=10)
        policy.record_encoder_frame_count(1, now=10.01)
        self.assertEqual(policy.last_frame_report, (10, 0))
        policy.record_encoder_frame_count(90, now=13)
        policy.record_encoder_frame_count(1, now=14)
        self.assertEqual(policy.last_frame_report, (14, 1))
        self.assertIsNone(policy.low_fps_since)

    def test_h264_keeps_multiple_slices_and_headers_in_one_picture(self):
        units = self.streamer.H264AccessUnits()
        def nal(kind, data=b'x'):
            return b'\x00\x00\x00\x01' + bytes([kind]) + data
        aud, sps, pps = nal(9), nal(7), nal(8)
        first, second = nal(5, b'first'), nal(5, b'second')
        for kind, payload in [(9, aud), (7, sps), (8, pps), (5, first), (5, second)]:
            self.assertIsNone(units.push(kind, payload))
        self.assertEqual(units.push(9, aud), (True, aud + sps + pps + first + second))
        delta = nal(1, b'delta')
        self.assertIsNone(units.push(1, delta))
        self.assertEqual(units.push(9, aud), (False, aud + delta))

    def test_keyframes_repeat_cached_headers_when_encoder_omits_them(self):
        units = self.streamer.H264AccessUnits()
        def nal(kind):
            return b'\x00\x00\x00\x01' + bytes([kind]) + b'x'
        for kind in [7, 8, 9, 1]:
            units.push(kind, nal(kind))
        units.push(9, nal(9))
        units.push(5, nal(5))
        self.assertEqual(units.push(9, nal(9)), (True, nal(7) + nal(8) + nal(9) + nal(5)))

    def test_both_encoders_insert_access_unit_boundaries(self):
        for encoder in ['libx264', 'h264_nvenc']:
            command = self.streamer.encoder_command(encoder, 30)
            self.assertIn('h264_metadata=aud=insert', command)

    def test_software_encoder_parallelizes_slices_without_buffering_future_frames(self):
        command = self.streamer.encoder_command('libx264', 30)
        options = dict(option.split('=', 1) for option in command[command.index('-x264-params') + 1].split(':'))
        self.assertEqual(options['sliced-threads'], '1')
        self.assertEqual(options['sync-lookahead'], '0')
        self.assertEqual(options['rc-lookahead'], '0')
        self.assertEqual(command[command.index('-threads') + 1], '2')
        self.assertEqual(command[command.index('-slices') + 1], '2')

    @unittest.skipUnless(shutil.which('ffmpeg'), 'Requires FFmpeg with libx264 for real access-unit decoding')
    def test_actual_two_slice_video_survives_chunk_boundaries_and_decodes_every_picture(self):
        # Synthetic CPU input only: no X display, browser session, or live viewer.
        command = self.streamer.encoder_command('libx264', 30)
        command[command.index('-f'):command.index('-fps_mode')] = [
            '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30']
        command[command.index('-c:v'):command.index('-c:v')] = ['-frames:v', '24']
        encoded = subprocess.run(command, capture_output=True, timeout=15)
        self.assertEqual(encoded.returncode, 0, encoded.stderr.decode(errors='replace')[-2000:])
        # An extra AUD/EOS marks the final picture's end on the raw Annex B pipe.
        stream = encoded.stdout + b'\x00\x00\x00\x01\x09\xf0\x00\x00\x00\x01\x0a'
        buffer, pictures = bytearray(), []
        assembler = self.streamer.H264AccessUnits()
        sizes, offset, index = [1, 2, 3, 17, 4096], 0, 0
        while offset < len(stream):
            size = sizes[index % len(sizes)]
            buffer.extend(stream[offset:offset + size])
            offset += size
            index += 1
            units, buffer = self.streamer.find_annexb_units(buffer)
            for kind, payload in units:
                picture = assembler.push(kind, payload)
                if picture:
                    pictures.append(picture)
        self.assertEqual(len(pictures), 24)
        for keyframe, payload in pictures:
            units, _ = self.streamer.find_annexb_units(bytearray(payload + b'\x00\x00\x00\x01\x09\xf0'))
            kinds = [kind for kind, _ in units]
            self.assertEqual(sum(kind in {1, 5} for kind in kinds), 2)
            if keyframe:
                self.assertIn(7, kinds)
                self.assertIn(8, kinds)
        decoded = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-f', 'h264', '-i', 'pipe:0', '-vf', 'setpts=N/30/TB', '-fps_mode', 'passthrough',
            '-progress', 'pipe:1', '-f', 'null', '-'],
            input=b''.join(payload for _, payload in pictures), capture_output=True, timeout=15)
        self.assertEqual(decoded.returncode, 0, decoded.stderr.decode(errors='replace')[-2000:])
        decoded_frames = [int(line.split('=', 1)[1]) for line in decoded.stdout.decode().splitlines()
                          if line.startswith('frame=')]
        self.assertTrue(decoded_frames)
        self.assertEqual(decoded_frames[-1], len(pictures))

    def test_nvenc_requires_a_successful_real_encode(self):
        with patch.dict(self.streamer.os.environ, {"STREAM_ENCODER": "auto"}):
            with patch.object(self.streamer.subprocess, 'run', return_value=SimpleNamespace(returncode=1)):
                self.assertEqual(self.streamer.select_encoder(), 'libx264')
            with patch.object(self.streamer.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
                self.assertEqual(self.streamer.select_encoder(), 'h264_nvenc')
