"""Receive a disposable Docker WebRTC fixture on the host; no browser automation.

Run with aiortc installed and the owned fixture at --url. Uses actual ICE, DTLS,
SRTP, H.264 decoding and changing pixels. This is transport qualification, not
Chrome UI/frame-pacing or full input-to-visible-response qualification.
"""
import argparse
import asyncio
import json
import time

from aiortc import RTCPeerConnection, RTCConfiguration, RTCSessionDescription, RTCRtpSender
import httpx


async def run(url):
    peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    transceiver = peer.addTransceiver('video', direction='recvonly')
    transceiver.setCodecPreferences([codec for codec in RTCRtpSender.getCapabilities('video').codecs
                                    if codec.mimeType == 'video/H264'])
    frames = asyncio.Queue(maxsize=3)
    tasks = []
    @peer.on('track')
    def track_received(track):
        async def consume():
            while True:
                frame = await track.recv()
                if frames.full(): frames.get_nowait()
                await frames.put(frame)
        tasks.append(asyncio.create_task(consume()))
    started = time.monotonic()
    try:
        await peer.setLocalDescription(await peer.createOffer())
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(url.rstrip('/') + '/offer', json={'sdp': peer.localDescription.sdp})
            response.raise_for_status()
            answer = response.json()
        await peer.setRemoteDescription(RTCSessionDescription(sdp=answer['sdp'], type='answer'))
        first = await asyncio.wait_for(frames.get(), 15)
        first_pixels = bytes(first.planes[0])
        changed, count = False, 1
        received_at = time.monotonic()
        while time.monotonic() - received_at < 3:
            frame = await asyncio.wait_for(frames.get(), 3)
            changed |= bytes(frame.planes[0]) != first_pixels
            count += 1
        if not changed: raise AssertionError('Decoded video did not change')
        result = {'verified': True, 'source': 'synthetic fixture', 'transport': 'Docker-to-host WebRTC',
                  'changing_pixels': changed, 'decoded_frames': count,
                  'first_frame_seconds': round(received_at - started, 3), 'dimensions': [first.width, first.height],
                  'visible_presentation_verified': False}
        print(json.dumps(result, indent=2))
        return result
    finally:
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await peer.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:18010')
    args = parser.parse_args()
    asyncio.run(run(args.url))
