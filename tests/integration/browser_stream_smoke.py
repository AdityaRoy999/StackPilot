"""Run in the browser-sandbox container against a TEMPORARY Next dev fixture route.

Uses a separate headless Chromium viewer, the real canvas component, real AI-service
WebSocket, shared encoder and a disposable source tab. Never navigates an existing tab.
No provider calls. See tests/README.md for route setup and cleanup.
"""
import asyncio
import base64
import json
import os
import shutil
import signal
import socket
import statistics
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

import websockets

SOURCE_CDP_URL = os.getenv('STACKPILOT_STREAM_QA_SOURCE_CDP_URL', 'http://127.0.0.1:9223').rstrip('/')
SANDBOX_MODE = os.getenv('STACKPILOT_STREAM_QA_MODE', 'local')

def http_json(url, method="GET"):
    source_request = url.startswith(SOURCE_CDP_URL + '/')
    headers = {'Host': 'localhost'} if source_request else {}
    with urllib.request.urlopen(urllib.request.Request(url, method=method, headers=headers), timeout=5) as response:
        result = json.load(response)
    # CDP advertises its server's loopback address. Cross-host tests connect
    # through the same pinned SSH forwarder used by the AI service.
    if source_request:
        for target in result if isinstance(result, list) else [result]:
            if isinstance(target, dict) and target.get('webSocketDebuggerUrl'):
                parsed = urllib.parse.urlparse(target['webSocketDebuggerUrl'])
                target['webSocketDebuggerUrl'] = urllib.parse.urlunparse(parsed._replace(
                    netloc=urllib.parse.urlparse(SOURCE_CDP_URL).netloc))
    return result


class CDP:
    def __init__(self, ws, ticket=None):
        self.ws, self.pending, self.serial = ws, {}, 0
        self.ticket = ticket
        self.errors = []
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        async for raw in self.ws:
            result = json.loads(raw)
            if result.get('method') == 'Fetch.requestPaused' and self.ticket:
                asyncio.create_task(self.fulfill_capability(result['params']))
                continue
            if result.get("method") == "Runtime.exceptionThrown":
                self.errors.append(result.get("params", {}))
            future = self.pending.pop(result.get("id"), None)
            if future:
                if "error" in result:
                    future.set_exception(RuntimeError(result["error"]))
                else:
                    future.set_result(result.get("result", {}))

    async def fulfill_capability(self, params):
        # Only this fixture's capability URL is intercepted. The AI WebSocket
        # still verifies the actual short-lived, owner-scoped signature.
        body = json.dumps({'ticket': self.ticket}).encode()
        await self.call('Fetch.fulfillRequest', {'requestId': params['requestId'], 'responseCode': 200,
            'responseHeaders': [{'name': 'Content-Type', 'value': 'application/json'},
                {'name': 'Access-Control-Allow-Origin', 'value': 'http://127.0.0.1:3000'},
                {'name': 'Access-Control-Allow-Credentials', 'value': 'true'},
                {'name': 'Access-Control-Allow-Headers', 'value': 'Content-Type,X-stackpilot-CSRF'},
                {'name': 'Access-Control-Allow-Methods', 'value': 'GET,OPTIONS'}],
            'body': base64.b64encode(body).decode()})

    async def call(self, method, params=None):
        self.serial += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.serial] = future
        await self.ws.send(json.dumps({"id": self.serial, "method": method, "params": params or {}}))
        return await asyncio.wait_for(future, 45)

    async def evaluate(self, expression):
        result = await self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        if result.get("exceptionDetails"):
            raise RuntimeError(result["exceptionDetails"])
        return result.get("result", {}).get("value")


async def proxy(reader, writer, host, port):
    remote_reader, remote_writer = await asyncio.open_connection(host, port)
    async def forward(source, dest):
        try:
            while data := await source.read(65536):
                dest.write(data)
                await dest.drain()
        finally:
            dest.close()
    await asyncio.gather(forward(reader, remote_writer), forward(remote_reader, writer), return_exceptions=True)


SOURCE = """<!doctype html><title>Disposable stream QA</title>
<style>body{margin:0;overflow:hidden}</style><canvas width=1280 height=720></canvas>
<script>let n=0,clicked=false;const c=document.querySelector('canvas'),ctx=c.getContext('2d');
window.__qaClicks=[];c.onclick=()=>{clicked=!clicked;window.__qaClicks.push({click_at:Date.now(),paint_at:null,green:clicked})};function paint(){n++;ctx.fillStyle=`rgb(${n%200},40,80)`;
ctx.fillRect(0,0,1280,720);ctx.fillStyle=clicked?'#00ff00':'#ff0000';ctx.fillRect(100,100,180,180);
ctx.fillStyle='white';ctx.font='50px sans-serif';ctx.fillText('Live frame '+n,400,200);
const last=window.__qaClicks.at(-1);if(last && !last.paint_at)last.paint_at=Date.now();
requestAnimationFrame(paint)}paint();</script>"""

INSTRUMENT = """(() => {
window.__qa={id:crypto.randomUUID(),draws:[],colors:[],codecs:{},sockets:[],peers:[],decoded:0,jsonFrames:0,controls:{},outgoing:[],
videoPresented:0,videoCallbacks:[],lastVideoKey:'',videoMetadata:[],images:0,imagesDecoded:0,imageErrors:[],messages:[],capture:[],health:[],pendingClick:null,inputSamples:[]};
const ib=createImageBitmap;window.createImageBitmap=(...args)=>{__qa.images++;
return ib(...args).then(bitmap=>{__qa.imagesDecoded++;return bitmap},e=>{__qa.imageErrors.push(String(e));throw e});};
const vfc=HTMLVideoElement.prototype.requestVideoFrameCallback;
if(vfc)HTMLVideoElement.prototype.requestVideoFrameCallback=function(fn){return vfc.call(this,(t,m)=>{
 const key=String(m.presentationTime)+'|'+String(m.mediaTime);
 if(this===document.querySelector('video') && this.style.visibility==='visible' && key!==__qa.lastVideoKey){
  __qa.lastVideoKey=key;__qa.videoPresented++;__qa.videoCallbacks.push(t);
  __qa.videoMetadata.push({processingDuration:m.processingDuration,captureTime:m.captureTime,
    receiveTime:m.receiveTime,presentationTime:m.presentationTime,expectedDisplayTime:m.expectedDisplayTime});
  __qaCheckClick();
 }
 fn(t,m);});};
if(window.RTCPeerConnection){const PC=RTCPeerConnection;window.RTCPeerConnection=class extends PC {
 constructor(...args){super(...args);__qa.peers.push(this);}
 setRemoteDescription(description){
  // This viewer runs inside Docker. Published Windows loopback is replaced only
  // inside this disposable fixture with the corresponding private container IP.
  const sdp=description.sdp?.replace(/^(a=candidate:[^\\r\\n]*? )127\\.0\\.0\\.1( \\d+ typ host)/gm,'$1__QA_RTC_PRIVATE_IP__$2');
  return super.setRemoteDescription({...description,sdp});
 }
};}
window.__qaPixel=(x,y)=>{const v=document.querySelector('video'),c=document.querySelector('canvas');
if(v && v.style.visibility==='visible' && v.readyState>=2){const p=document.createElement('canvas');
p.width=1;p.height=1;const ctx=p.getContext('2d');ctx.drawImage(v,x,y,1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];}
return [...c.getContext('2d').getImageData(x,y,1,1).data];};
if(window.VideoDecoder){const VD=VideoDecoder;window.VideoDecoder=class extends VD {
 constructor(callbacks){super({...callbacks,output:frame=>{__qa.decoded++;callbacks.output(frame)}});}};}
const draw=CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage=function(...args){
const result=draw.apply(this,args);if(this.canvas===document.querySelector('canvas')){
  __qa.draws.push(performance.now());__qaCheckClick();}return result;};
window.__qaCheckClick=()=>{const pending=__qa.pendingClick;if(!pending)return;
 const p=__qaPixel(150,150),green=p[1]>p[0]+80,red=p[0]>p[1]+80;
 if((pending.green&&green)||(!pending.green&&red)){
  __qa.inputSamples.push({id:pending.id,visible_ms:performance.now()-pending.started,
   sent_at:pending.sent_at,visible_at:Date.now(),green:pending.green});__qa.pendingClick=null;
 }};
const WS=WebSocket;window.WebSocket=class extends WS { constructor(...args){super(...args);
 __qa.sockets.push(this);this.addEventListener('message',e=>{if(typeof e.data==='string'){try {const m=JSON.parse(e.data);__qa.controls[m.type]=(__qa.controls[m.type]||0)+1;if(m.type==='frame')__qa.jsonFrames++;if(m.type==='stream_health'){if(m.capture)__qa.capture.push(m.capture);__qa.health.push({at:performance.now(),capture:m.capture,rtc_sender:m.rtc_sender,websocket_queue:m.websocket_queue});}if(!['frame','console','stream_health'].includes(m.type))__qa.messages.push({at:performance.now(),type:m.type,dispatch_ms:m.dispatch_ms});}catch{}}
 if(e.data instanceof ArrayBuffer && e.data.byteLength>=16){
 const v=new DataView(e.data),n=v.getUint16(14);if(n && n+16<e.data.byteLength){try {
 const m=JSON.parse(new TextDecoder().decode(new Uint8Array(e.data,16,n)));
 const codec=m.codec||'jpeg';__qa.codecs[codec]=(__qa.codecs[codec]||0)+1;}catch{}}}});}
 send(data){try {__qa.outgoing.push(JSON.parse(data).type);}catch{}return super.send(data);}};
})();"""


async def wait_until(cdp, expression, timeout=45, poll_seconds=.2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if await cdp.evaluate(expression):
            return
        await asyncio.sleep(poll_seconds)
    detail = await cdp.evaluate("({draws:window.__qa?.draws.length,video:window.__qa?.videoPresented,images:window.__qa?.images,imagesDecoded:window.__qa?.imagesDecoded,imageErrors:window.__qa?.imageErrors,decoded:window.__qa?.decoded,codecs:window.__qa?.codecs,jsonFrames:window.__qa?.jsonFrames,controls:window.__qa?.controls,outgoing:window.__qa?.outgoing,text:document.body.innerText.slice(0,700)})")
    raise AssertionError(f"Timed out: {expression}; state={detail}; errors={cdp.errors[-3:]}")


async def measure(cdp, label, minimum_frames=30, seconds=15):
    await cdp.evaluate("__qa.draws=[];__qa.colors=[];__qa.videoPresented=0;__qa.videoCallbacks=[];__qa.videoMetadata=[];__qa.startedAt=performance.now()")
    for _ in range(seconds):
        await asyncio.sleep(1)
        await cdp.evaluate("(() => {const p=__qaPixel(600,400);__qa.colors.push([p[0],p[1],p[2]].join(','));})()")
    metrics = await cdp.evaluate("""(() => {
const native=__qa.videoPresented>0,a=native?__qa.videoCallbacks:__qa.draws,g=a.slice(1).map((t,i)=>t-a[i]).sort((x,y)=>x-y);
const video=document.querySelector('video'),track=video?.srcObject?.getVideoTracks?.()[0];
const rtc=track && __qa.peers.some(p=>p.connectionState==='connected' && p.getReceivers().some(r=>r.track?.id===track.id));
return {native,presented:a.length,submitted:__qa.videoPresented,
fps:a.length*1000/(performance.now()-__qa.startedAt),
p95_gap_ms:g[Math.floor(g.length*.95)]||0,unique_colors:new Set(__qa.colors).size,
max_gap_ms:g.at(-1)||0,transport:(native && rtc && video.style.visibility==='visible')?'webrtc':'websocket',
codecs:__qa.codecs,decoded:__qa.decoded,telemetry:document.body.innerText.match(/Live[^\\n]*fps/)?.[0]||''};})()""")
    metrics['receiver'] = await cdp.evaluate("""(async () => {
const p=__qa.peers.filter(p=>p.connectionState==='connected').at(-1);if(!p)return null;
const all=await p.getStats(),out={};all.forEach(s=>{if(s.type==='inbound-rtp' && s.kind==='video'){
 for(const k of ['framesReceived','framesDecoded','framesDropped','jitter','jitterBufferDelay','jitterBufferEmittedCount','jitterBufferMinimumDelay','totalDecodeTime','totalProcessingDelay','packetsLost'])out[k]=s[k];
}if(s.type==='candidate-pair'&&s.state==='succeeded')out.rtt=s.currentRoundTripTime;});
return out;})()""")
    metrics['video_metadata_tail'] = await cdp.evaluate('__qa.videoMetadata.slice(-3)')
    metrics['capture_tail'] = await cdp.evaluate('__qa.capture.slice(-3)')
    metrics['media_health_tail'] = await cdp.evaluate('__qa.health.slice(-3)')
    # Functional recovery and smoothness are separate qualification outcomes.
    metrics['target_720p30_met'] = metrics['fps'] >= 27 and metrics['p95_gap_ms'] <= 67 and metrics['max_gap_ms'] <= 250
    metrics['target_720p60_met'] = metrics['fps'] >= 57 and metrics['p95_gap_ms'] <= 33 and metrics['max_gap_ms'] <= 100
    print(label + ": " + json.dumps(metrics), flush=True)
    assert metrics["presented"] >= minimum_frames, metrics
    assert metrics["unique_colors"] >= 2, metrics
    return metrics


async def main():
    capability_path = os.getenv('STACKPILOT_STREAM_QA_CAPABILITY_FILE')
    capability = json.loads(Path(capability_path).read_text()) if capability_path else {}
    session = capability.get('session') or "stream-qa-" + uuid.uuid4().hex
    ticket = capability.get('ticket')
    owned_source = SOURCE.replace('Disposable stream QA', 'Disposable stream QA ' + session)
    source_url = "data:text/html," + urllib.parse.quote(owned_source)
    before = http_json(SOURCE_CDP_URL + "/json/list")
    focused = []
    for target in before:
        if target.get('type') != 'page' or not target.get('webSocketDebuggerUrl'):
            continue
        async with websockets.connect(target['webSocketDebuggerUrl']) as ws:
            probe = CDP(ws)
            try:
                if await probe.evaluate('document.hasFocus()'):
                    focused.append(target['id'])
            finally:
                probe.reader.cancel()
    previous = focused[0] if len(focused) == 1 else None
    profile = tempfile.mkdtemp(prefix="stackpilot-stream-qa-")
    proc = None
    servers = []
    results = {}
    source = {}
    second_url = None
    try:
        for local, host, remote in ((3000, "frontend", 3000), (8010, "ai-service", 8010)):
            servers.append(await asyncio.start_server(lambda r,w,h=host,p=remote: proxy(r,w,h,p), "127.0.0.1", local))
        # Warm the temporary Next dev route before opening a real viewer. A request
        # during a manifest rewrite can otherwise catch the dev compiler mid-write.
        for attempt in range(5):
            try:
                await asyncio.to_thread(lambda: urllib.request.urlopen(
                    "http://frontend:3000/stream-regression-fixture", timeout=45).read())
                break
            except OSError:
                if attempt == 4:
                    raise
                await asyncio.sleep(1)
        proc = subprocess.Popen(["/usr/lib/chromium/chromium", "--headless", "--no-sandbox",
            "--disable-dev-shm-usage", "--disable-gpu", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
            "--remote-debugging-port=9224", "--remote-allow-origins=*",
            "--autoplay-policy=no-user-gesture-required", "--user-data-dir="+profile, "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(60):
            try:
                tabs = http_json("http://127.0.0.1:9224/json/list")
                break
            except OSError:
                await asyncio.sleep(0.2)
        tab = next(t for t in tabs if t.get("type") == "page")
        async with websockets.connect(tab["webSocketDebuggerUrl"], max_size=10*1024*1024) as ws:
            cdp = CDP(ws, ticket=ticket)
            await cdp.call("Page.enable")
            await cdp.call("Runtime.enable")
            if ticket:
                await cdp.call('Fetch.enable', {'patterns': [{'urlPattern': '*/ai/browser-ticket/' + session}]})
            await cdp.call("Emulation.setDeviceMetricsOverride", {"width":1280,"height":900,"deviceScaleFactor":1,"mobile":False})
            instrument = INSTRUMENT.replace('__QA_RTC_PRIVATE_IP__', socket.gethostbyname('ai-service'))
            await cdp.call("Page.addScriptToEvaluateOnNewDocument", {"source": instrument})
            viewer_url = "http://127.0.0.1:3000/stream-regression-fixture?" + urllib.parse.urlencode({"session":session,"url":source_url,"mode":SANDBOX_MODE})
            await cdp.call("Page.navigate", {"url": viewer_url})
            # Track the owned source before measuring so a failed first frame
            # still disposes its browser context in finally.
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                source = next((t for t in http_json(SOURCE_CDP_URL + "/json/list")
                               if t.get('url') == source_url), {})
                if source:
                    break
                await asyncio.sleep(.2)
            assert source, 'Owned source tab did not open'
            await wait_until(cdp, "!!window.__qa && (__qa.draws.length>20 || __qa.videoPresented>20)")
            await wait_until(cdp, "__qa.peers.some(p=>p.connectionState==='connected') || (__qa.decoded>20 && (__qa.videoPresented>20 || __qa.draws.length>20))")
            results["video"] = await measure(cdp, "H264 visible animation")
            assert results['video']['transport']=='webrtc' or results["video"]["decoded"] > 20
            source = next(t for t in http_json(SOURCE_CDP_URL + "/json/list") if t.get("url") == source_url)
            async with websockets.connect(source["webSocketDebuggerUrl"]) as source_ws:
                agent = CDP(source_ws)
                try:
                    sync_started = time.perf_counter()
                    await agent.evaluate("history.pushState({}, '', '#LiveRoute');document.title='Live route title'")
                    await wait_until(cdp, "document.querySelector('input').value.endsWith('#LiveRoute') && document.body.innerText.includes('Live route title')", 5)
                    results["page_sync"] = {"route_and_title_ms": round((time.perf_counter()-sync_started)*1000,2)}
                    await agent.evaluate("document.title=''")
                    await wait_until(cdp, "!document.body.innerText.includes('Live route title')", 5)
                    second_url = "data:text/html," + urllib.parse.quote(owned_source.replace("Disposable stream QA", "Second page QA"))
                    await agent.call("Page.navigate", {"url": second_url})
                    await wait_until(cdp, "document.querySelector('input').value === " + json.dumps(second_url) + " && document.body.innerText.includes('Second page QA')", 10)
                    # The viewer still has the original initialUrl prop. A reconnect
                    # must attach to this new document, not navigate back to that prop.
                    results["page_sync"]["empty_title"] = True
                    results["page_sync"]["full_navigation"] = True
                    await wait_until(agent, "typeof n==='number' && n>2", 5)
                finally:
                    agent.reader.cancel()
            # A second control socket would change capture demand and bias the sample.
            input_samples = []
            await cdp.evaluate('__qa.health=[]')
            for index in range(8):
                green = index % 2 == 0
                click_started = time.monotonic()
                input_id = 'qa-visible-click-' + str(index)
                await cdp.evaluate("__qa.pendingClick={id:" + json.dumps(input_id) + ",green:" + json.dumps(green) + ",started:performance.now(),sent_at:Date.now()};__qa.sockets.at(-1).send(JSON.stringify({type:'user_click',x:180,y:180,input_id:" + json.dumps(input_id) + "}))")
                await wait_until(cdp, "__qa.inputSamples.some(s=>s.id===" + json.dumps(input_id) + ")", 10, poll_seconds=.04)
                input_samples.append(round((time.monotonic()-click_started)*1000, 1))
                await asyncio.sleep(.15)
            ordered = sorted(input_samples)
            results['input'] = {'controller_upper_bound_samples_ms': input_samples, 'controller_upper_bound_median_ms': statistics.median(ordered),
                'controller_upper_bound_p95_ms': ordered[min(len(ordered)-1, int(len(ordered)*.95))], 'poll_seconds': .04,
                'last_dispatch': await cdp.evaluate("__qa.messages.filter(m=>m.type==='input_applied').at(-1)")}
            native_samples = await cdp.evaluate('__qa.inputSamples')
            ordered_native = sorted(s['visible_ms'] for s in native_samples)
            results['input'].update({'viewer_clock_samples': native_samples,
                'viewer_clock_median_ms': statistics.median(ordered_native),
                'viewer_clock_p95_ms': ordered_native[min(len(ordered_native)-1, int(len(ordered_native)*.95))]})
            async with websockets.connect(source['webSocketDebuggerUrl']) as source_ws:
                source_probe = CDP(source_ws)
                try:
                    source_clicks = await source_probe.evaluate('window.__qaClicks')
                finally:
                    source_probe.reader.cancel()
            assert len(source_clicks) == len(native_samples), 'Native clicks were lost or duplicated'
            results['input']['source_clicks'] = source_clicks
            if SANDBOX_MODE == 'local':
                results['input']['source_paint_to_visible_ms'] = [view['visible_at']-src['paint_at']
                    for src, view in zip(source_clicks, native_samples)]
            else:
                # EC2 and the local viewer do not share a clock. The viewer's
                # click-to-visible samples remain valid; cross-host subtraction
                # would report misleading or even negative timings.
                results['input']['source_paint_to_visible_ms'] = None
                results['input']['source_clock_note'] = 'Remote source and local viewer clocks are not synchronized.'
            results['input']['media_health'] = await cdp.evaluate('__qa.health')
            print("Click feedback visible in live canvas: PASS", flush=True)
            await cdp.evaluate("__qa.sockets.at(-1).close()")
            await wait_until(cdp, "__qa.sockets.length>=2 && __qa.sockets.at(-1).readyState===1", 15)
            if results['video']['transport'] == 'webrtc':
                await wait_until(cdp, "__qa.peers.some(p=>p.connectionState==='connected') && document.querySelector('video')?.style.visibility==='visible'", 20)
            results["reconnect"] = await measure(cdp, "Reconnect")
            if results['video']['transport'] == 'webrtc':
                assert results['reconnect']['transport'] == 'webrtc', 'Reconnect lost its working RTC path'
            results['reconnect_controls'] = await cdp.evaluate('__qa.messages.slice(-30)')
            assert await cdp.evaluate("document.querySelector('input').value === " + json.dumps(second_url)), "Reconnect rewound the page"
            results["page_sync"]["reconnect_preserved_route"] = True
            # A client decoder that fails must recover using real tab-specific images.
            await cdp.call("Page.addScriptToEvaluateOnNewDocument", {"source": "window.RTCPeerConnection=undefined;window.VideoDecoder=class {configure(){} decode(){throw Error('fixture decoder failure')} close(){} get state(){return 'configured'} get decodeQueueSize(){return 0}}"})
            previous_load = await cdp.evaluate("__qa.id")
            await cdp.call("Page.reload")
            await wait_until(cdp, f"!!window.__qa && __qa.id!=={json.dumps(previous_load)} && __qa.codecs.jpeg>10 && __qa.draws.length>10", 30)
            results["fallback"] = await measure(cdp, "Decoder-failure JPEG recovery", minimum_frames=5, seconds=4)
            cdp.reader.cancel()
        results['scope'] = {'viewer': 'software headless Chromium inside Docker', 'source': 'owned animated 1280x720 canvas',
            'sandbox_mode': SANDBOX_MODE,
            'existing_user_contexts_mutated': False, 'docker_only_ice_candidate_rewrite': True,
            'functional_recovery_passed': True, 'windows_browser_qualified': False}
        output_path = os.getenv('STACKPILOT_STREAM_QA_RESULT_FILE')
        if output_path:
            Path(output_path).write_text(json.dumps(results, indent=2) + '\n')
        print("STREAM_SMOKE_PASS " + json.dumps(results), flush=True)
    finally:
        for server in servers:
            server.close()
            await server.wait_closed()
        if proc:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.to_thread(proc.wait, 5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                await asyncio.to_thread(proc.wait)
        original_ids = {tab["id"] for tab in before}
        owned = [tab for tab in http_json(SOURCE_CDP_URL + "/json/list")
                 if tab["id"] not in original_ids and (tab.get("id") == source.get("id") or
                    tab.get('url') in {source_url, second_url})]
        if owned:
            version = http_json(SOURCE_CDP_URL + "/json/version")
            async with websockets.connect(version['webSocketDebuggerUrl']) as cleanup_socket:
                cleanup = CDP(cleanup_socket)
                try:
                    for tab in owned:
                        info = (await cleanup.call('Target.getTargetInfo',{'targetId':tab['id']}))['targetInfo']
                        context = info.get('browserContextId')
                        if context:
                            await cleanup.call('Target.disposeBrowserContext',{'browserContextId':context})
                        else:
                            await cleanup.call('Target.closeTarget',{'targetId':tab['id']})
                finally:
                    cleanup.reader.cancel()
        if previous:
            request = urllib.request.Request(SOURCE_CDP_URL + "/json/activate/"+previous,
                headers={'Host': 'localhost'})
            urllib.request.urlopen(request).close()
        # Chromium's child processes can finish writing briefly after its parent
        # exits. Remove only this mkdtemp profile, with a bounded retry.
        for attempt in range(20):
            try:
                shutil.rmtree(profile)
                break
            except FileNotFoundError:
                break
            except OSError:
                if attempt == 19:
                    print('Owned viewer profile cleanup incomplete: ' + profile, flush=True)
                await asyncio.sleep(.25)


if __name__ == "__main__":
    asyncio.run(main())
