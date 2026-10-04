"""Measure a configured remote producer with an owned animated page.

Run inside ai-service with PYTHONPATH=/app while browser diagnostics show no
active runs or viewers. No provider calls or synthetic viewer feedback are used.
This qualifies producer capture through SSH, not a frontend's presented FPS.
"""
import argparse
import asyncio
import json
from pathlib import Path
import statistics
import struct
import time
import urllib.parse
import uuid

import av

from app.browser_driver import browser_manager


SOURCE = """<!doctype html><title>Owned remote frame-rate probe</title>
<style>body{margin:0;overflow:hidden}</style><canvas width=1280 height=720></canvas>
<script>window.n=0;const ctx=document.querySelector('canvas').getContext('2d');
const colors=['#e6194b','#3cb44b','#ffe119','#4363d8','#f58231','#911eb4'];
function paint(){n++;ctx.fillStyle=colors[n%colors.length];ctx.fillRect(0,0,1280,720);
ctx.fillStyle='white';ctx.font='48px sans-serif';ctx.fillText('Owned live frame '+n,360,360);
requestAnimationFrame(paint)}paint();</script>"""


async def main(args):
    session_id = 'remote-capture-qa-' + uuid.uuid4().hex
    session = None
    arrivals = []
    packets = []
    statuses = []
    measuring = False

    def listener(event):
        if measuring and (event.get('metadata') or {}).get('codec') == 'h264':
            arrivals.append(time.monotonic())
            if len(packets) < 180 and (packets or event['metadata'].get('isKeyFrame')):
                raw = event['raw_bytes']
                offset = 16 + struct.unpack_from('>H', raw, 14)[0]
                packets.append(raw[offset:])

    async def activity():
        while session and session.is_connected:
            session.mark_activity()
            await asyncio.sleep(.5)

    task = None
    try:
        browser_manager.configure_session(session_id, 'remote')
        session = await browser_manager.get_or_create_session(session_id,
            'data:text/html,' + urllib.parse.quote(SOURCE))
        session.add_listener(listener)
        session.viewer_codecs[listener] = 'h264'
        await browser_manager.activate_display(session_id)
        await session.sync_capture_mode()
        task = asyncio.create_task(activity())
        deadline = time.monotonic() + 15
        while not session.h264_active and time.monotonic() < deadline:
            await asyncio.sleep(.1)
        if not session.h264_active:
            raise RuntimeError('Remote H.264 producer did not start')
        await asyncio.sleep(3)
        paint_before = await session.evaluate('n')
        measuring = True
        started = time.monotonic()
        for _ in range(args.seconds):
            await asyncio.sleep(1)
            statuses.append(session.media_status())
        elapsed = time.monotonic() - started
        measuring = False
        paint_after = await session.evaluate('n')
        gaps = sorted((b-a)*1000 for a,b in zip(arrivals, arrivals[1:]))
        decoder = av.CodecContext.create('h264', 'r')
        pixels = []
        for packet in packets:
            for frame in decoder.decode(av.Packet(packet)):
                rgb = frame.reformat(format='rgb24')
                plane = rgb.planes[0]
                offset = 10 * plane.line_size + 10 * 3
                pixels.append(tuple(memoryview(plane)[offset:offset+3]))
        changed = sum(a != b for a, b in zip(pixels, pixels[1:]))
        result = {
            'profile': args.label,
            'scope': 'Remote owned-page producer and SSH arrivals; no frontend viewer qualification.',
            'seconds': round(elapsed, 3), 'encoded_frames': len(arrivals),
            'arrival_fps': round(len(arrivals)/elapsed, 2),
            'median_gap_ms': round(statistics.median(gaps), 2) if gaps else None,
            'p95_gap_ms': round(gaps[min(len(gaps)-1, int(len(gaps)*.95))], 2) if gaps else None,
            'max_gap_ms': round(max(gaps), 2) if gaps else None,
            'page_animation_fps': round((paint_after-paint_before)/elapsed, 2),
            'decoded_sample_frames': len(pixels), 'decoded_sample_color_changes': changed,
            'capture_samples': statuses,
            'producer_60fps_met': len(arrivals)/elapsed >= 57,
            'presented_60fps_qualified': False,
        }
        if args.output:
            Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({k: v for k,v in result.items() if k != 'capture_samples'}), flush=True)
        if len(arrivals) < 10 or len(pixels) < 10 or changed < 2:
            raise RuntimeError('Live encoded animation was not verified')
    finally:
        measuring = False
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if session:
            session.remove_listener(listener)
            await browser_manager.close_session(session_id)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--seconds', type=int, default=20)
    parser.add_argument('--label', default='remote')
    parser.add_argument('--output')
    args = parser.parse_args()
    if not 5 <= args.seconds <= 60:
        parser.error('--seconds must be between 5 and 60')
    asyncio.run(main(args))
