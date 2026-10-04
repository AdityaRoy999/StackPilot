"""Transport resets must not let old negotiation messages close a newer peer."""
import asyncio
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.browser_driver import browser_manager


class RTCSignalingTests(unittest.IsolatedAsyncioTestCase):
    async def test_new_offer_supersedes_pending_offer_and_stale_stop_is_ignored(self):
        from fastapi import WebSocketDisconnect
        from app.main import websocket_browser_stream
        old_started = asyncio.Event()
        new_answered = asyncio.Event()
        messages, peers = [], []

        class Peer:
            def __init__(self, _session):
                self.closed = False
                self.connected = True
                self.track = SimpleNamespace(encoded=True)
                self.index = len(peers)
                peers.append(self)
            async def answer(self, sdp):
                if self.index == 0:
                    old_started.set()
                    await asyncio.Event().wait()
                return {'type':'rtc_answer','sdp':'answer-'+sdp}
            async def close(self):
                self.closed = True

        fixture = self
        class Socket:
            client_state = SimpleNamespace(name='CONNECTED')
            query_params = {}
            index = 0
            async def accept(self): pass
            async def send_json(self, data):
                messages.append(data)
                if data.get('type') == 'rtc_answer' and data.get('negotiation_id') == 'new':
                    new_answered.set()
            async def send_bytes(self, data): pass
            async def receive_text(self):
                self.index += 1
                if self.index == 1:
                    value = {'type':'rtc_offer','sdp':'old','negotiation_id':'old'}
                elif self.index == 2:
                    await old_started.wait()
                    value = {'type':'rtc_offer','sdp':'new','negotiation_id':'new'}
                elif self.index == 3:
                    await new_answered.wait()
                    value = {'type':'rtc_stop','negotiation_id':'old'}
                elif self.index == 4:
                    fixture.assertTrue(peers[0].closed)
                    fixture.assertFalse(peers[1].closed, 'A stale stop closed the replacement peer')
                    value = {'type':'rtc_ready','negotiation_id':'new'}
                elif self.index == 5:
                    value = {'type':'rtc_stop','negotiation_id':'new'}
                else:
                    fixture.assertTrue(peers[1].closed)
                    raise WebSocketDisconnect()
                return json.dumps(value)

        session = SimpleNamespace(session_id='rtc-generation-fixture',is_connected=True,h264_active=True,
            config=SimpleNamespace(mode='local'),current_url='https://fixture.invalid/',page_title='Fixture',
            interactive_elements=[],latest_frame=None,_frame_seq=0,viewer_codecs={},
            add_listener=lambda _:None,remove_listener=lambda _:None,
            sync_capture_mode=AsyncMock(),capture_screenshot=AsyncMock(return_value=None))
        with patch.dict(browser_manager.sessions,{session.session_id:session},clear=True), \
             patch('app.browser_ticket.verify',return_value={'control':True,'expires':time.time()+300}), \
             patch.object(browser_manager,'activate_display',AsyncMock()), \
             patch('app.browser_rtc.BrowserPeer',Peer):
            async with asyncio.timeout(3):
                await websocket_browser_stream(Socket(),session.session_id)
        answers = [message for message in messages if message.get('type') == 'rtc_answer']
        self.assertEqual([(message['sdp'],message['negotiation_id']) for message in answers],[('answer-new','new')])

    async def test_legacy_offer_is_still_answered_without_generation_id(self):
        from fastapi import WebSocketDisconnect
        from app.main import websocket_browser_stream
        answered = asyncio.Event()
        messages = []
        class Peer:
            connected = True
            track = SimpleNamespace(encoded=True)
            def __init__(self, session): pass
            async def answer(self, sdp): return {'type':'rtc_answer','sdp':'legacy-answer'}
            async def close(self): pass
        class Socket:
            client_state = SimpleNamespace(name='CONNECTED')
            query_params = {}
            first = True
            async def accept(self): pass
            async def send_bytes(self, data): pass
            async def send_json(self, data):
                messages.append(data)
                if data.get('type') == 'rtc_answer': answered.set()
            async def receive_text(self):
                if self.first:
                    self.first = False
                    return json.dumps({'type':'rtc_offer','sdp':'legacy'})
                await answered.wait()
                raise WebSocketDisconnect()
        session = SimpleNamespace(session_id='rtc-legacy-fixture',is_connected=True,h264_active=True,
            config=SimpleNamespace(mode='local'),current_url='https://fixture.invalid/',page_title='Fixture',
            interactive_elements=[],latest_frame=None,_frame_seq=0,viewer_codecs={},
            add_listener=lambda _:None,remove_listener=lambda _:None,
            sync_capture_mode=AsyncMock(),capture_screenshot=AsyncMock(return_value=None))
        with patch.dict(browser_manager.sessions,{session.session_id:session},clear=True), \
             patch('app.browser_ticket.verify',return_value={'control':True,'expires':time.time()+300}), \
             patch.object(browser_manager,'activate_display',AsyncMock()), \
             patch('app.browser_rtc.BrowserPeer',Peer):
            async with asyncio.timeout(3):
                await websocket_browser_stream(Socket(),session.session_id)
        answer = next(message for message in messages if message.get('type') == 'rtc_answer')
        self.assertNotIn('negotiation_id',answer)
