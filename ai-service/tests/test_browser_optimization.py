"""Adaptive policy, per-session endpoints and actual WebRTC media qualification."""
import asyncio
from fractions import Fraction
import importlib.util
import json
import os
from pathlib import Path
import struct
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from app.browser_config import browser_config


class ConfigTests(unittest.TestCase):
    def test_host_urls_and_auth_are_separate_from_docker(self):
        with patch.dict(os.environ, {"HOST_BROWSER_CDP_URL": "http://host.docker.internal:9225", "HOST_BROWSER_TOKEN": "x" * 32}):
            host = browser_config("host")
            docker = browser_config("local")
            self.assertEqual(host.resolve_url("http://frontend:3000/a"), "http://localhost:3000/a")
            self.assertEqual(host.resolve_url("http://localhost:3000/a"), "http://localhost:3000/a")
            self.assertEqual(docker.resolve_url("http://localhost:3000/a"), "http://frontend:3000/a")
            self.assertFalse(host.stream_host)
            self.assertNotIn("Authorization", docker.headers)
            self.assertIn("Authorization", host.headers)

    def test_unconfigured_host_and_remote_do_not_silently_use_docker(self):
        with patch.dict(os.environ, {"HOST_BROWSER_CDP_URL": "", "HOST_BROWSER_TOKEN": "", "REMOTE_BROWSER_SANDBOX_URL": ""}):
            for mode in ["remote", "host", "invalid"]:
                with self.assertRaises(ValueError):
                    browser_config(mode)

    def test_connected_session_cannot_switch_worker_while_running(self):
        from app.browser_driver import BrowserManager
        manager = BrowserManager()
        manager.sessions["one"] = SimpleNamespace(is_connected=True, config=browser_config("local"))
        with patch.dict(os.environ, {"REMOTE_BROWSER_SANDBOX_URL": "http://remote:9222"}):
            manager.configure_session("two", "remote")
            with self.assertRaisesRegex(ValueError, "Apply the sandbox change"):
                manager.configure_session("one", "remote")
        self.assertEqual(manager.session_modes, {"two": "remote"})


class SandboxSwitchTests(unittest.IsolatedAsyncioTestCase):
    def session(self, mode="local"):
        return SimpleNamespace(is_connected=True, config=browser_config(mode),
            current_url="https://fixture.invalid/current", connect=AsyncMock(),
            navigate=AsyncMock(), close=AsyncMock(), send_command=AsyncMock(),listeners={object()})

    async def test_same_mode_keeps_existing_tab(self):
        from app.browser_driver import BrowserManager
        manager = BrowserManager()
        old = manager.sessions["one"] = self.session()
        self.assertIs(await manager.switch_session("one", "local"), old)
        old.close.assert_not_awaited()

    async def test_switch_preserves_current_url_and_other_chat(self):
        from app.browser_driver import BrowserManager
        manager = BrowserManager()
        old = manager.sessions["one"] = self.session()
        other = manager.sessions["two"] = self.session()
        with patch.dict(os.environ, {"REMOTE_BROWSER_SANDBOX_URL": "http://remote:9222"}):
            replacement = self.session("remote")
            with patch("app.browser_driver.BrowserSession", return_value=replacement) as factory:
                result = await manager.switch_session("one", "remote", "https://fixture.invalid/original")
            factory.assert_called_once_with("one", old.current_url, sandbox_mode="remote")
            replacement.navigate.assert_awaited_once_with(old.current_url)
            self.assertIs(result, replacement)
            self.assertIs(manager.sessions["two"], other)
            self.assertEqual(manager.session_modes["one"], "remote")
            old.close.assert_awaited_once()
            other.close.assert_not_awaited()
            self.assertFalse(manager.switching_sessions)

    async def test_unreachable_worker_keeps_previous_tab_and_mode(self):
        from app.browser_driver import BrowserManager
        manager = BrowserManager()
        old = manager.sessions["one"] = self.session()
        manager.session_modes["one"] = "local"
        with patch.dict(os.environ, {"REMOTE_BROWSER_SANDBOX_URL": "http://remote:9222"}):
            replacement = self.session("remote")
            replacement.connect.side_effect = OSError("unreachable")
            with patch("app.browser_driver.BrowserSession", return_value=replacement):
                with self.assertRaises(OSError):
                    await manager.switch_session("one", "remote")
            replacement.close.assert_awaited_once()
        self.assertIs(manager.sessions["one"], old)
        self.assertEqual(manager.session_modes["one"], "local")
        old.close.assert_not_awaited()
        self.assertFalse(manager.switching_sessions)

    async def test_unconfigured_host_leaves_existing_tab_untouched(self):
        from app.browser_driver import BrowserManager
        manager = BrowserManager()
        old = manager.sessions["one"] = self.session()
        with patch.dict(os.environ, {"HOST_BROWSER_CDP_URL": "", "HOST_BROWSER_TOKEN": ""}):
            with self.assertRaisesRegex(ValueError, "Host Chrome is not configured"):
                await manager.switch_session("one", "host")
        self.assertIs(manager.sessions["one"], old)
        old.close.assert_not_awaited()


@unittest.skipUnless(importlib.util.find_spec("aiortc"), "Requires the AI image's media dependencies")
class ViewerCapabilityTests(unittest.TestCase):
    def test_settings_lookup_does_not_create_a_tab_or_viewer(self):
        from fastapi.testclient import TestClient
        from app.main import app, browser_manager
        claims = {"expires": time.time() + 60, "control": False, "user_id": "fixture"}
        with patch.dict(browser_manager.sessions, {}, clear=True), \
             patch.dict(browser_manager.session_modes, {"settings-fixture": "remote"}, clear=True), \
             patch("app.browser_ticket.verify", return_value=claims), \
             patch.object(browser_manager, "switch_session", AsyncMock()) as switch:
            with TestClient(app).websocket_connect("/ws/browser/settings-fixture?ticket=fixture&control_only=1") as socket:
                socket.send_json({"type": "get_mode"})
                self.assertEqual(socket.receive_json()["browser_mode"], "remote")
            switch.assert_not_awaited()
            self.assertFalse(browser_manager.sessions)

    def test_view_only_settings_cannot_change_the_worker(self):
        from fastapi.testclient import TestClient
        from app.main import app, browser_manager
        claims = {"expires": time.time() + 60, "control": False, "user_id": "fixture"}
        with patch("app.browser_ticket.verify", return_value=claims), \
             patch.object(browser_manager, "switch_session", AsyncMock()) as switch:
            with TestClient(app).websocket_connect("/ws/browser/settings-fixture?ticket=fixture&control_only=1") as socket:
                socket.send_json({"type": "switch_mode", "sandbox_mode": "remote"})
                result = socket.receive_json()
                self.assertEqual(result["type"], "browser_error")
                self.assertIn("administration access", result["message"])
            switch.assert_not_awaited()

    def test_view_only_ticket_gets_media_capabilities_but_cannot_control_tab(self):
        from fastapi.testclient import TestClient
        from app.main import app, browser_manager
        listeners = set()
        session = SimpleNamespace(config=browser_config("local"), is_connected=True, h264_active=False,
            current_url="https://fixture.invalid", page_title="Fixture", interactive_elements=[],
            latest_frame=None, viewer_codecs={}, add_listener=listeners.add,
            remove_listener=listeners.discard, sync_capture_mode=AsyncMock(), stream_control=Mock(),
            click=AsyncMock(), close=AsyncMock(), last_used=time.monotonic())
        claims = {"expires": time.time() + 60, "control": False, "user_id": "fixture"}
        with patch.dict(browser_manager.sessions, {"media-viewer": session}, clear=True), \
             patch.dict(os.environ, {"STACKPILOT_AGENT_TEAMS_ENABLED": "false", "STACKPILOT_DEPLOYMENT_WORKERS_ENABLED": "false"}), \
             patch.object(browser_manager, "activate_display", AsyncMock()), \
             patch("app.browser_ticket.verify", return_value=claims), \
             TestClient(app) as client:
            with client.websocket_connect("/ws/browser/media-viewer?ticket=fixture") as socket:
                self.assertEqual(socket.receive_json()["type"], "page_state")
                capabilities = socket.receive_json()
                self.assertEqual(capabilities["type"], "stream_capabilities")
                self.assertEqual(capabilities["browser_mode"], "local")
                socket.send_json({"type": "user_click", "x": 1, "y": 1})
                while True:
                    message = socket.receive_json()
                    if message["type"] != "stream_health":
                        break
                self.assertEqual(message["type"], "permission_denied")
                session.click.assert_not_awaited()
        self.assertFalse(listeners)


@unittest.skipUnless(importlib.util.find_spec("aiortc"), "Requires the AI image's media dependencies")
class MediaTests(unittest.IsolatedAsyncioTestCase):
    def session(self, encoded=False):
        class Session:
            config = SimpleNamespace(stream_host="encoder" if encoded else "")
            is_connected = True
            def __init__(self):
                self.listeners, self.viewer_codecs = set(), {}
            def add_listener(self, listener): self.listeners.add(listener)
            def remove_listener(self, listener):
                self.listeners.discard(listener)
                self.viewer_codecs.pop(listener, None)
            async def sync_capture_mode(self): pass
            def publish(self, event):
                for listener in list(self.listeners): listener(event)
        return Session()

    def frame(self, value=80):
        import av
        frame = av.VideoFrame(128, 72, "yuv420p")
        for index, plane in enumerate(frame.planes):
            plane.update(bytes([value if index == 0 else 128]) * plane.buffer_size)
        return frame

    async def test_direct_h264_preserves_bytes_and_waits_for_keyframe(self):
        from app.browser_rtc import BrowserVideoTrack
        track = BrowserVideoTrack(self.session(encoded=True))
        self.addCleanup(track.stop)
        metadata = {"codec": "h264", "isKeyFrame": False}
        track.on_event({"type": "frame", "metadata": metadata, "raw_bytes": b"delta"})
        self.assertTrue(track.buffer.queue.empty())
        payload = b"\x00\x00\x00\x01\x65keyframe"
        header = struct.pack(">2sIQH", b"SP", 1, 100, 2) + b"{}"
        track.on_event({"type": "frame", "metadata": {**metadata, "isKeyFrame": True}, "raw_bytes": header + payload})
        packet = await asyncio.wait_for(track.recv(), 1)
        self.assertEqual(bytes(packet), payload)
        self.assertEqual(packet.time_base, Fraction(1, 90000))

    async def qualify_peer(self, encoded, published=False, slices=1):
        import av
        from aiortc import RTCPeerConnection, RTCConfiguration, RTCSessionDescription, RTCRtpSender
        from app.browser_rtc import BrowserPeer
        session = self.session(encoded)
        from aioice.ice import get_host_addresses
        local_ip = get_host_addresses(use_ipv4=True, use_ipv6=False)[0]
        with patch.dict(os.environ, {"BROWSER_RTC_ICE_SERVERS": "[]", "BROWSER_RTC_ADVERTISED_IP": local_ip if published else "",
                                     "BROWSER_RTC_UDP_MIN": "15011", "BROWSER_RTC_UDP_MAX": "15014"}):
            server = BrowserPeer(session)
        client = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        transceiver = client.addTransceiver("video", direction="recvonly")
        transceiver.setCodecPreferences([codec for codec in RTCRtpSender.getCapabilities("video").codecs if codec.mimeType == "video/H264"])
        received = asyncio.Queue()
        tasks = []
        @client.on("track")
        def on_track(track):
            async def consume():
                while True:
                    await received.put(await track.recv())
            tasks.append(asyncio.create_task(consume()))
        producer = None
        try:
            await client.setLocalDescription(await client.createOffer())
            answer = await server.answer(client.localDescription.sdp)
            if published:
                self.assertIn(local_ip, answer["sdp"])
                self.assertRegex(answer["sdp"], r"1501[1-4] typ host")
            await client.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type="answer"))
            codec = av.CodecContext.create("libx264" if encoded else "mjpeg", "w")
            codec.width, codec.height = 128, 72
            codec.pix_fmt = "yuv420p" if encoded else "yuvj420p"
            codec.time_base, codec.framerate = Fraction(1, 30), Fraction(30, 1)
            if encoded:
                codec.options = {"preset": "ultrafast", "tune": "zerolatency", "profile": "baseline",
                                 "x264-params": f"keyint=10:repeat-headers=1:slices={slices}"}
            async def produce():
                sequence = 0
                while True:
                    frame = self.frame(40 + sequence % 120)
                    frame.pts, frame.time_base = sequence, Fraction(1, 30)
                    for packet in codec.encode(frame):
                        metadata = {"codec": "h264", "isKeyFrame": packet.is_keyframe} if encoded else {}
                        meta = json.dumps(metadata).encode()
                        session.publish({"type": "frame", "metadata": metadata,
                                         "raw_bytes": struct.pack(">2sIQH", b"SP", sequence, 1, len(meta)) + meta + bytes(packet)})
                    sequence += 1
                    await asyncio.sleep(1 / 30)
            producer = asyncio.create_task(produce())
            first = await asyncio.wait_for(received.get(), 10)
            second = await asyncio.wait_for(received.get(), 3)
            self.assertEqual((first.width, first.height), (128, 72))
            self.assertNotEqual(bytes(first.planes[0]), bytes(second.planes[0]))
            self.assertTrue(server.connected)
        finally:
            for task in [producer, *tasks]:
                if task: task.cancel()
            await asyncio.gather(*[task for task in [producer, *tasks] if task], return_exceptions=True)
            await server.close()
            await client.close()
        self.assertFalse(session.listeners)
        self.assertFalse(session.viewer_codecs)

    async def test_webrtc_direct_h264_is_received_and_decoded(self):
        await self.qualify_peer(True)

    async def test_webrtc_multislice_picture_is_received_and_decoded(self):
        await self.qualify_peer(True, slices=3)

    async def test_webrtc_host_jpeg_is_received_and_decoded(self):
        await self.qualify_peer(False)

    async def test_webrtc_published_udp_range_carries_actual_video(self):
        await self.qualify_peer(True, published=True)

    async def test_invalid_ice_configuration_releases_capture_listener(self):
        from app.browser_rtc import BrowserPeer
        session = self.session(encoded=True)
        with patch.dict(os.environ, {"BROWSER_RTC_ADVERTISED_IP": "invalid"}):
            with self.assertRaises(ValueError):
                BrowserPeer(session)
        await asyncio.sleep(0)
        self.assertFalse(session.listeners)
        self.assertFalse(session.viewer_codecs)
