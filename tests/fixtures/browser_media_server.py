"""Disposable synthetic WebRTC source for Docker-to-host transport qualification."""
import asyncio
from contextlib import asynccontextmanager
from fractions import Fraction
import json
import struct
from types import SimpleNamespace

import av
from fastapi import FastAPI, Request
from app.browser_rtc import BrowserPeer

resources = []


@asynccontextmanager
async def lifespan(app):
    yield
    for peer, producer in resources:
        producer.cancel()
        await asyncio.gather(producer, return_exceptions=True)
        await peer.close()


app = FastAPI(lifespan=lifespan)


@app.get('/health')
def health():
    return {'ready': True}


@app.post('/offer')
async def offer(request: Request):
    if resources:
        return {'error': 'Only one owned qualification viewer'}
    class Session:
        config = SimpleNamespace(stream_host='fixture')
        is_connected = True
        def __init__(self): self.listeners, self.viewer_codecs = set(), {}
        def add_listener(self, listener): self.listeners.add(listener)
        def remove_listener(self, listener):
            self.listeners.discard(listener)
            self.viewer_codecs.pop(listener, None)
        async def sync_capture_mode(self): pass
    session = Session()
    peer = BrowserPeer(session)
    async def produce():
        encoder = av.CodecContext.create('libx264', 'w')
        encoder.width, encoder.height, encoder.pix_fmt = 128, 72, 'yuv420p'
        encoder.time_base, encoder.framerate = Fraction(1, 30), Fraction(30, 1)
        encoder.options = {'preset': 'ultrafast', 'tune': 'zerolatency', 'profile': 'baseline',
                           'x264-params': 'keyint=10:repeat-headers=1'}
        sequence = 0
        while True:
            frame = av.VideoFrame(128, 72, 'yuv420p')
            for index, plane in enumerate(frame.planes):
                plane.update(bytes([40 + sequence % 120 if index == 0 else 128]) * plane.buffer_size)
            frame.pts, frame.time_base = sequence, Fraction(1, 30)
            for packet in encoder.encode(frame):
                metadata = {'codec': 'h264', 'isKeyFrame': packet.is_keyframe}
                meta = json.dumps(metadata).encode()
                event = {'type': 'frame', 'metadata': metadata,
                         'raw_bytes': struct.pack('>2sIQH', b'SP', sequence, 1, len(meta)) + meta + bytes(packet)}
                for listener in list(session.listeners): listener(event)
            sequence += 1
            await asyncio.sleep(1 / 30)
    producer = asyncio.create_task(produce())
    resources.append((peer, producer))
    data = await request.json()
    return await peer.answer(data['sdp'])
