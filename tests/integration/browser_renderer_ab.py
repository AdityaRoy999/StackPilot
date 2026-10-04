"""Owned X11/profile A/B: issued canvas paint, composed pixels, encoded delivery.

Run in browser-sandbox, with no other performance qualification in flight. Never
uses the shared display, Chromium profiles, CDP targets, ports, or live viewers.
The decoder maps one low-delay output frame to each complete producer access unit;
reported producer times are packet arrivals, not decoder completion timestamps.
"""
import argparse
import asyncio
from collections import deque
from contextlib import ExitStack
import ctypes
import ctypes.util
import importlib.util
import json
import os
from pathlib import Path
import signal
import statistics
import struct
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

import websockets


SOURCE = """<!doctype html><title>Owned renderer latency A/B</title>
<style>body{margin:0;overflow:hidden}</style><canvas width=1280 height=720></canvas>
<script>window.__qa={n:0,id:0,green:false,traces:[]};const c=document.querySelector('canvas'),ctx=c.getContext('2d');
c.onclick=()=>{__qa.green=!__qa.green;__qa.id++;__qa.traces.push({id:__qa.id,green:__qa.green,click_at:Date.now()})};
function paint(){__qa.n++;ctx.fillStyle=`rgb(${__qa.n%200},40,80)`;ctx.fillRect(0,0,1280,720);
ctx.fillStyle=__qa.green?'#00ff00':'#ff0000';ctx.fillRect(100,100,180,180);
ctx.fillStyle='white';ctx.font='50px sans-serif';ctx.fillText('Live frame '+__qa.n,400,200);
const last=__qa.traces.at(-1);if(last&&!last.draw_issued_at)last.draw_issued_at=Date.now();
requestAnimationFrame(paint)}paint();</script>"""


def http_json(url):
    with urllib.request.urlopen(url, timeout=2) as response:
        return json.load(response)


class CDP:
    def __init__(self, ws):
        self.ws, self.serial, self.pending = ws, 0, {}
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        async for raw in self.ws:
            message = json.loads(raw)
            future = self.pending.pop(message.get('id'), None)
            if future:
                if 'error' in message:
                    future.set_exception(RuntimeError(message['error']))
                else:
                    future.set_result(message.get('result', {}))

    async def call(self, method, params=None):
        self.serial += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.serial] = future
        await self.ws.send(json.dumps({'id': self.serial, 'method': method, 'params': params or {}}))
        return await asyncio.wait_for(future, 10)

    async def evaluate(self, expression):
        result = await self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True})
        if result.get('exceptionDetails'):
            raise RuntimeError(result['exceptionDetails'])
        return result.get('result', {}).get('value')


class XPixel:
    """Read composed Xvfb pixels; does not flush Chromium canvas/GPU commands."""
    def __init__(self, display):
        self.lib = ctypes.CDLL(ctypes.util.find_library('X11'))
        self.lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        self.lib.XOpenDisplay.restype = ctypes.c_void_p
        self.lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        self.lib.XDefaultRootWindow.restype = ctypes.c_ulong
        self.lib.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                                      ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
        self.lib.XGetImage.restype = ctypes.c_void_p
        self.lib.XGetPixel.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
        self.lib.XGetPixel.restype = ctypes.c_ulong
        self.lib.XDestroyImage.argtypes = [ctypes.c_void_p]
        self.lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
        self.display = self.lib.XOpenDisplay(display.encode())
        if not self.display:
            raise RuntimeError('Cannot open owned X display')
        self.root = self.lib.XDefaultRootWindow(self.display)

    def read(self):
        image = self.lib.XGetImage(self.display, self.root, 150, 150, 1, 1, ctypes.c_ulong(-1).value, 2)
        if not image:
            raise RuntimeError('Cannot read owned X display pixel')
        try:
            value = self.lib.XGetPixel(image, 0, 0)
            return (value >> 16) & 255, (value >> 8) & 255, value & 255
        finally:
            self.lib.XDestroyImage(image)

    def close(self):
        self.lib.XCloseDisplay(self.display)


def process_ticks(root):
    records = {}
    for file in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = file.read_text().rsplit(')', 1)[1].split()
            records[int(file.parent.name)] = (int(fields[1]), int(fields[11]) + int(fields[12]))
        except (OSError, ValueError, IndexError):
            pass
    descendants = {root}
    while True:
        updated = descendants | {pid for pid, (parent, _) in records.items() if parent in descendants}
        if updated == descendants:
            break
        descendants = updated
    return sum(records[pid][1] for pid in descendants if pid in records)


def stop_owned(process):
    if process is None or process.poll() is not None:
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)


def summary(values):
    ordered = sorted(values)
    return {'median': round(statistics.median(values), 2), 'max': round(max(values), 2),
            'p95': round(ordered[min(len(ordered)-1, int(len(ordered)*.95))], 2)}


async def variant(name, flags, display, port, streamer_path, clicks):
    chrome = decoder = server = capture = writer = pixels = None
    tasks = []
    pending = [None]
    arrivals = []
    decode_map = deque()
    raw_color, encoded_color = [None], [None]
    try:
        with tempfile.TemporaryDirectory(prefix='stackpilot-renderer-ab-') as profile, ExitStack() as cleanup:
            chrome = subprocess.Popen(['/usr/lib/chromium/chromium', '--no-sandbox', '--test-type',
                '--no-first-run', '--no-default-browser-check', '--disable-infobars', '--disable-breakpad',
                '--disable-session-crashed-bubble', '--kiosk', '--remote-debugging-port='+str(port),
                '--remote-allow-origins=*', '--window-size=1280,720', '--window-position=0,0', '--start-maximized',
                '--enable-threaded-compositing', '--force-color-profile=srgb', '--user-data-dir='+profile,
                *flags, 'about:blank'], env={**os.environ, 'DISPLAY': display},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            # This inner context exits before profile removal, including failures.
            cleanup.callback(stop_owned, chrome)
            version = None
            for _ in range(80):
                if chrome.poll() is not None:
                    raise RuntimeError(name + ': owned Chromium exited')
                try:
                    version = http_json('http://127.0.0.1:'+str(port)+'/json/version')
                    break
                except OSError:
                    await asyncio.sleep(.1)
            if version is None:
                raise RuntimeError('Owned Chromium CDP did not start')
            target = next(item for item in http_json('http://127.0.0.1:'+str(port)+'/json/list') if item['type'] == 'page')
            async with websockets.connect(target['webSocketDebuggerUrl']) as ws:
                cdp = CDP(ws)
                tasks.append(cdp.reader)
                await cdp.call('Page.enable')
                await cdp.call('Runtime.enable')
                await cdp.call('Emulation.setDeviceMetricsOverride',
                    {'width': 1280, 'height': 720, 'deviceScaleFactor': 1, 'mobile': False})
                await cdp.call('Page.navigate', {'url': 'data:text/html,'+urllib.parse.quote(SOURCE)})
                await cdp.call('Page.bringToFront')
                pixels = XPixel(display)
                os.environ.update(DISPLAY=display, STREAM_FPS='30', STREAM_MAX_FPS='30', STREAM_ENCODER='software')
                spec = importlib.util.spec_from_file_location('owned_producer_'+name, streamer_path)
                producer = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(producer)
                server = await asyncio.start_server(producer.handle_client, '127.0.0.1', 0)
                capture = asyncio.create_task(producer.ffmpeg_capture_loop())
                reader, writer = await asyncio.open_connection('127.0.0.1', server.sockets[0].getsockname()[1])
                decoder = await asyncio.create_subprocess_exec('ffmpeg', '-hide_banner', '-loglevel', 'error',
                    '-probesize', '32', '-analyzeduration', '0', '-f', 'h264', '-threads', '1', '-thread_type', 'slice',
                    '-flags', 'low_delay', '-i', 'pipe:0', '-vf', 'crop=2:2:150:150,format=rgb24',
                    '-fps_mode', 'passthrough', '-flush_packets', '1', '-f', 'rawvideo', 'pipe:1',
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                def detect(color, stage, at_wall, at_mono):
                    sample = pending[0]
                    if sample is not None and at_mono >= sample['sent_mono'] and stage not in sample:
                        r, g, _ = color
                        matches = g > r + 80 if sample['green'] else r > g + 80
                        if matches:
                            sample[stage] = at_wall
                            sample[stage+'_ready'].set()
                async def raw_pixels():
                    while True:
                        color = pixels.read()
                        raw_color[0] = color
                        detect(color, 'x11_at', time.time()*1000, time.monotonic())
                        await asyncio.sleep(.004)
                async def encoded_packets():
                    while True:
                        size, key = struct.unpack('>IB', await reader.readexactly(5))
                        if not 0 < size <= 16*1024*1024:
                            raise RuntimeError('Invalid owned producer packet')
                        payload = await reader.readexactly(size)
                        at = time.monotonic()
                        arrivals.append(at)
                        decode_map.append((time.time()*1000, at))
                        decoder.stdin.write(payload)
                        await decoder.stdin.drain()
                async def decoded_colors():
                    while True:
                        rgb = await decoder.stdout.readexactly(12)
                        if not decode_map:
                            raise RuntimeError('Decoder emitted an unmatched output frame')
                        at_wall, at_mono = decode_map.popleft()
                        color = tuple(rgb[:3])
                        encoded_color[0] = color
                        detect(color, 'producer_at', at_wall, at_mono)
                async def feedback():
                    while True:
                        writer.write(b'{"type":"feedback","visible":true,"gap_ms":0,"decode_queue":0,"rtt_ms":20,"frames_presented":30,"presentation_interval_ms":33}\n')
                        await writer.drain()
                        await asyncio.sleep(.5)
                tasks.extend(asyncio.create_task(fn()) for fn in (raw_pixels, encoded_packets, decoded_colors, feedback))
                deadline = time.monotonic()+12
                while time.monotonic() < deadline:
                    for task in tasks:
                        if task.done(): task.result()
                    if raw_color[0] and encoded_color[0] and raw_color[0][0] > 200 and encoded_color[0][0] > 200:
                        break
                    await asyncio.sleep(.1)
                else:
                    raise RuntimeError('Owned source or decoder did not show its initial red state: '+str((raw_color, encoded_color)))
                await asyncio.sleep(2)
                started, cpu_started, chrome_cpu_started = time.monotonic(), process_ticks(os.getpid()), process_ticks(chrome.pid)
                samples = []
                for index in range(clicks):
                    sample = {'id': index+1, 'green': index%2 == 0, 'sent_at': time.time()*1000,
                              'sent_mono': time.monotonic(), 'x11_at_ready': asyncio.Event(), 'producer_at_ready': asyncio.Event()}
                    pending[0] = sample
                    writer.write(b'{"type":"activity"}\n')
                    for event_type in ('mouseMoved', 'mousePressed', 'mouseReleased'):
                        await cdp.call('Input.dispatchMouseEvent', {'type': event_type, 'x': 180, 'y': 180,
                            **({'button': 'left', 'clickCount': 1} if event_type != 'mouseMoved' else {})})
                    await asyncio.wait_for(asyncio.gather(sample['x11_at_ready'].wait(), sample['producer_at_ready'].wait()), 8)
                    trace = await cdp.evaluate('__qa.traces.find(t=>t.id=='+str(index+1)+')')
                    if not trace or not trace.get('draw_issued_at'):
                        raise RuntimeError('Owned source click trace missing')
                    samples.append({'id': index+1, 'send_to_click_ms': round(trace['click_at']-sample['sent_at'], 2),
                        'click_to_draw_issued_ms': trace['draw_issued_at']-trace['click_at'],
                        'draw_issued_to_x11_ms': round(sample['x11_at']-trace['draw_issued_at'], 2),
                        'draw_issued_to_producer_ms': round(sample['producer_at']-trace['draw_issued_at'], 2),
                        'x11_to_producer_ms': round(sample['producer_at']-sample['x11_at'], 2),
                        'send_to_x11_ms': round(sample['x11_at']-sample['sent_at'], 2)})
                    pending[0] = None
                    print(name+' click '+str(index+1)+': '+json.dumps(samples[-1]), flush=True)
                    await asyncio.sleep(.15)
                elapsed = time.monotonic()-started
                ticks_per_second = os.sysconf('SC_CLK_TCK')
                cpu_percent = (process_ticks(os.getpid())-cpu_started)/ticks_per_second/elapsed*100
                chrome_cpu_percent = (process_ticks(chrome.pid)-chrome_cpu_started)/ticks_per_second/elapsed*100
                webgl = await cdp.evaluate("(() => {const gl=document.createElement('canvas').getContext('webgl');return !!gl})()")
                feature_status = {}
                async with websockets.connect(version['webSocketDebuggerUrl']) as browser_ws:
                    browser_cdp = CDP(browser_ws)
                    try:
                        gpu = (await browser_cdp.call('SystemInfo.getInfo')).get('gpu', {})
                        feature_status = gpu.get('featureStatus', {})
                    finally:
                        browser_cdp.reader.cancel()
                        await asyncio.gather(browser_cdp.reader, return_exceptions=True)
                active_arrivals = [at for at in arrivals if at >= started]
                result = {'variant': name, 'flags': flags, 'samples': samples, 'cpu_percent_all_probe_processes': round(cpu_percent, 2),
                    'cpu_percent_chromium_tree': round(chrome_cpu_percent, 2), 'producer_fps': round(len(active_arrivals)/elapsed, 2),
                    'decoder_pending_access_units': len(decode_map), 'webgl_available': webgl, 'gpu_feature_status': feature_status,
                    'summary_ms': {key: summary([sample[key] for sample in samples]) for key in
                        ('send_to_click_ms', 'click_to_draw_issued_ms', 'draw_issued_to_x11_ms', 'draw_issued_to_producer_ms', 'x11_to_producer_ms', 'send_to_x11_ms')}}
                print('RENDERER_VARIANT_RESULT '+json.dumps(result), flush=True)
                # Close Chromium before TemporaryDirectory removes its owned profile.
                stop_owned(chrome)
                chrome = None
                return result
    finally:
        pending[0] = None
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if writer:
            writer.close()
            await writer.wait_closed()
        if server:
            server.close()
            await server.wait_closed()
        if capture:
            producer.running = False
            capture.cancel()
            await asyncio.gather(capture, return_exceptions=True)
        try:
            if decoder:
                if decoder.returncode is None:
                    decoder.terminate()
                try:
                    await asyncio.wait_for(decoder.communicate(), 3)
                except asyncio.TimeoutError:
                    if decoder.returncode is None: decoder.kill()
                    await asyncio.wait_for(decoder.communicate(), 3)
        finally:
            if pixels: pixels.close()
            stop_owned(chrome)


async def main(args):
    socket = Path('/tmp/.X11-unix/X'+args.display.lstrip(':'))
    if socket.exists():
        raise RuntimeError('Refusing to reuse an existing display: '+args.display)
    xvfb = wm = None
    try:
        xvfb = subprocess.Popen(['Xvfb', args.display, '-screen', '0', '1280x720x24', '-nocursor', '-nolisten', 'tcp', '+extension', 'MIT-SHM'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(50):
            if xvfb.poll() is not None: raise RuntimeError('Owned Xvfb failed')
            if socket.exists(): break
            await asyncio.sleep(.1)
        wm = subprocess.Popen(['openbox', '--sm-disable'], env={**os.environ, 'DISPLAY': args.display},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        await asyncio.sleep(.3)
        results = []
        variants = [('swiftshader_gpu', ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
            '--ignore-gpu-blocklist', '--enable-webgl', '--enable-features=CanvasOopRasterization', '--enable-gpu-rasterization', '--enable-zero-copy',
            '--disable-features=Translate,OptimizationGuideModelDownloading']),
            ('software_page_webgl', ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader-webgl',
                '--disable-gpu-rasterization', '--disable-accelerated-2d-canvas',
                '--disable-features=Translate,OptimizationGuideModelDownloading,CanvasOopRasterization'])]
        for name, flags in variants:
            print('Starting owned renderer variant: '+name, flush=True)
            results.append(await variant(name, flags, args.display, args.port, args.streamer, args.clicks))
            await asyncio.sleep(1)
        report = {'scope': {'display': args.display, 'shared_browser_restarted': False, 'existing_user_contexts_mutated': False,
            'source': 'owned full-surface1280x720 Canvas2D animation', 'raw_pixels': 'XGetImage actual X11 root pixels',
            'producer': 'current software H264 producer fixed30 target', 'receiver': 'single-thread FFmpeg decode with1:1 access-unit arrival mapping',
            'draw_issued_is_not_composition': True, 'cpu_percent_100_equals_one_core': True}, 'variants': results}
        if args.output: Path(args.output).write_text(json.dumps(report, indent=2)+'\n')
        print('RENDERER_AB_RESULT '+json.dumps(report), flush=True)
    finally:
        stop_owned(wm)
        stop_owned(xvfb)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--display', default=':103')
    parser.add_argument('--port', type=int, default=9227)
    parser.add_argument('--clicks', type=int, default=8)
    parser.add_argument('--streamer', default='/usr/local/bin/streamer.py')
    parser.add_argument('--output')
    asyncio.run(main(parser.parse_args()))
