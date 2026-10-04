"""WebRTC media for an authorized viewer; controls stay on the WebSocket.

H.264 is packetized directly without decoding/re-encoding. Host browsers without
a desktop encoder use tab-specific JPEG capture and H.264 encoding.
"""
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
import json
import os
import struct
import time

from aiortc import MediaStreamTrack, RTCPeerConnection, RTCConfiguration, RTCIceServer, RTCSessionDescription, RTCRtpSender
from aiortc.mediastreams import MediaStreamError
import av

from .browser_streaming import LiveFrameBuffer


class JpegPacketEncoder:
    """Bounded, low-latency host media codec, isolated from agent executor work.

    Return H.264 packets so aiortc packetizes them instead of applying its generic
    video encoder's more expensive default preset and automatic thread count.
    """
    def __init__(self):
        self.rate = max(5, min(60, int(os.getenv('BROWSER_HOST_MEDIA_FPS', '30'))))
        self.decoder = av.CodecContext.create('mjpeg', 'r')
        self.decoder.thread_count = 1
        self.encoder = None

    def encode(self, jpeg, pts):
        frames = self.decoder.decode(av.Packet(jpeg))
        if not frames:
            return b''
        frame = frames[0]
        if self.encoder is None or (frame.width, frame.height) != (self.encoder.width, self.encoder.height):
            codec = av.CodecContext.create('libx264', 'w')
            codec.width, codec.height = frame.width, frame.height
            codec.pix_fmt = 'yuv420p'
            codec.time_base, codec.framerate = Fraction(1, 90000), Fraction(self.rate, 1)
            codec.bit_rate = max(128000, min(8000000, int(os.getenv('BROWSER_HOST_MEDIA_BITRATE', '2000000'))))
            codec.thread_count = 2
            codec.gop_size, codec.max_b_frames = max(2, self.rate // 2), 0
            codec.options = {'preset':'ultrafast', 'tune':'zerolatency', 'profile':'baseline',
                'x264-params':'sliced-threads=1:sync-lookahead=0:rc-lookahead=0:no-mbtree=1:repeat-headers=1:scenecut=0'}
            self.encoder = codec
        frame.pts, frame.time_base = pts, Fraction(1, 90000)
        return b''.join(bytes(packet) for packet in self.encoder.encode(frame))


def ice_servers():
    raw = json.loads(os.getenv("BROWSER_RTC_ICE_SERVERS", "[]"))
    if not isinstance(raw, list) or len(raw) > 8:
        raise ValueError("Invalid browser ICE configuration")
    return raw


class BrowserVideoTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, session):
        super().__init__()
        self.session = session
        self.encoded = bool(session.config.stream_host)
        self.buffer = LiveFrameBuffer()
        self.started = time.monotonic()
        self.last_pts = -1
        self._source_base_us = None
        self._source_base_pts = 0
        self._source_last_us = None
        self.received_frames = 0
        self.submitted_frames = 0
        self.last_source_received_age_ms = 0.0
        self.max_source_received_age_ms = 0.0
        self.last_source_seq = None
        self.last_submitted_at = None
        self.jpeg_encoder = None if self.encoded else JpegPacketEncoder()
        self._media_executor = (None if self.encoded else
            ThreadPoolExecutor(max_workers=1, thread_name_prefix='browser-media'))
        self._last_host_frame_at = 0.0
        session.add_listener(self.on_event)
        session.viewer_codecs[self.on_event] = "h264" if self.encoded else "jpeg"

    def on_event(self, event):
        if event.get("type") != "frame":
            return
        encoded = (event.get("metadata") or {}).get("codec") in {"h264", "avc1"}
        if encoded != self.encoded:
            return
        raw = event.get("raw_bytes")
        if raw and len(raw) >= 16:
            offset = 16 + struct.unpack_from(">H", raw, 14)[0] if raw[:2] == b"SP" else 0
            if offset >= len(raw):
                return
        elif not event.get("data"):
            return
        self.received_frames += 1
        self.buffer.push(event)

    def media_status(self):
        return {
            'encoded': self.encoded, 'received_frames': self.received_frames,
            'host_media_fps_limit': self.jpeg_encoder.rate if self.jpeg_encoder else None,
            'submitted_frames': self.submitted_frames, 'last_source_seq': self.last_source_seq,
            'last_source_received_age_ms': round(self.last_source_received_age_ms, 2),
            'max_source_received_age_ms': round(self.max_source_received_age_ms, 2),
            'last_submitted_age_ms': (round((time.monotonic() - self.last_submitted_at) * 1000, 2)
                                      if self.last_submitted_at is not None else None),
            'queue': self.buffer.status(),
        }

    def _record_submission(self, event):
        now = time.monotonic()
        self.submitted_frames += 1
        self.last_submitted_at = now
        self.last_source_seq = event.get('seq')
        received_at = event.get('_media_received_at', event.get('_buffer_enqueued_at', now))
        self.last_source_received_age_ms = max(0.0, (now - received_at) * 1000)
        self.max_source_received_age_ms = max(self.max_source_received_age_ms, self.last_source_received_age_ms)

    async def recv(self):
        while self.readyState == "live":
            if self.jpeg_encoder:
                # Wait before reading so the independent-image buffer supplies
                # the newest capture, not an old image waiting for encoding.
                delay = self._last_host_frame_at + 1 / self.jpeg_encoder.rate - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
            event = await self.buffer.get()
            raw = event.get("raw_bytes")
            if raw:
                offset = 16 + struct.unpack_from(">H", raw, 14)[0] if raw[:2] == b"SP" else 0
                payload = raw[offset:]
            else:
                payload = base64.b64decode(event["data"])
            pts = int((time.monotonic() - self.started) * 90000)
            source_us = (event.get('metadata') or {}).get('source_timestamp_us')
            if self.encoded and type(source_us) is int and source_us >= 0:
                if self._source_base_us is None or source_us < self._source_last_us:
                    self._source_base_us = source_us
                    self._source_base_pts = max(self.last_pts+1,pts)
                self._source_last_us = source_us
                pts = self._source_base_pts + (source_us-self._source_base_us)*90000//1000000
            pts = max(self.last_pts + 1,pts)
            self.last_pts = pts
            if self.encoded:
                packet = av.Packet(payload)
                packet.pts = packet.dts = pts
                packet.time_base = Fraction(1, 90000)
                self._record_submission(event)
                return packet
            encoded_started = time.monotonic()
            encoded = await asyncio.get_running_loop().run_in_executor(
                self._media_executor, self.jpeg_encoder.encode, payload, pts)
            if self.readyState != 'live':
                raise MediaStreamError
            if encoded:
                packet = av.Packet(encoded)
                packet.pts = packet.dts = pts
                packet.time_base = Fraction(1, 90000)
                self._last_host_frame_at = encoded_started
                self._record_submission(event)
                return packet
        raise MediaStreamError

    def stop(self):
        self.session.remove_listener(self.on_event)
        self.buffer.reset()
        super().stop()
        if self._media_executor:
            self._media_executor.shutdown(wait=False, cancel_futures=True)


class BrowserPeer:
    def __init__(self, session):
        self.session = session
        servers = [RTCIceServer(**item) for item in ice_servers()]
        self.peer = RTCPeerConnection(RTCConfiguration(iceServers=servers))
        self.track = BrowserVideoTrack(session)
        try:
            sender = self.peer.addTrack(self.track)
            transceiver = next(item for item in self.peer.getTransceivers() if item.sender == sender)
            transceiver.setCodecPreferences([codec for codec in RTCRtpSender.getCapabilities("video").codecs
                                            if codec.mimeType.lower() == "video/h264"])
            from .browser_ice import published_udp
            published_udp(self.peer)
        except Exception:
            self.track.stop()
            asyncio.get_running_loop().create_task(self.peer.close())
            raise

    async def answer(self, sdp):
        if not isinstance(sdp, str) or len(sdp) > 65536:
            raise ValueError("Invalid WebRTC offer")
        await self.peer.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
        await self.peer.setLocalDescription(await self.peer.createAnswer())
        await self.session.sync_capture_mode()
        return {"type": "rtc_answer", "sdp": self.peer.localDescription.sdp,
                "description_type": self.peer.localDescription.type}

    @property
    def connected(self):
        return self.peer.connectionState == "connected"

    async def close(self):
        self.track.stop()
        await self.peer.close()
        if self.session.is_connected:
            await self.session.sync_capture_mode()
