"""Measure the deployed React viewer during actual agent browser tool execution.

Run inside ai-service with mobile_layout_smoke.py and browser_stream_smoke.py in
/tmp. Uses owned contexts, signed fixture tickets, synthetic UI API data and a
data-URL source. No model calls, user cookies, project writes or external actions.
"""
import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import statistics
import time
from urllib.parse import quote, urlsplit
import uuid

import httpx
import websockets
from mobile_layout_smoke import CDP, wait_for
from browser_stream_smoke import INSTRUMENT
from app.browser_config import browser_config
from app.browser_testing.isolation import open_context_owner, create_isolated_target, dispose_context

SOURCE = """<!doctype html><title>Owned interaction performance fixture</title>
<style>body{margin:0;height:4000px;font:16px sans-serif;background:#202020;color:white}
canvas{position:fixed;inset:0;z-index:0;pointer-events:none}
#panel{position:fixed;left:30px;top:30px;z-index:2;background:#333;padding:20px}
button,input{padding:12px;margin:5px}#rows{position:relative;top:850px}
.row{height:40px;display:flex;gap:5px}body[data-theme=light] #panel{background:#666}</style>
<canvas width=1280 height=720></canvas><div id=panel>
<button id=toggle onclick="document.body.dataset.theme=document.body.dataset.theme==='light'?'dark':'light';window.clicks++">Toggle preview</button>
<input id=field aria-label="Probe field" placeholder="Probe field"><span id=count></span></div>
<div id=rows></div><script>
window.clicks=0;window.drawTimes=[];window.observationWrites=0;
new MutationObserver(m=>{window.observationWrites+=m.filter(x=>x.attributeName==='data-sp-id').length}).observe(document,{subtree:true,attributes:true});
rows.innerHTML=Array.from({length:240},(_,i)=>'<div class=row><button>Item '+i+'</button>'+('<span>Layout content</span>'.repeat(12))+'</div>').join('');
const c=document.querySelector('canvas'),ctx=c.getContext('2d');let n=0;
function draw(){window.drawTimes.push(performance.now());n++;ctx.fillStyle=`rgb(${n%200},40,80)`;ctx.fillRect(0,0,1280,720);
ctx.fillStyle='white';ctx.font='22px sans-serif';ctx.fillText('Animated fixture',400,200);requestAnimationFrame(draw)}draw();
</script>"""


class ViewerCDP(CDP):
    def __init__(self, socket, session, ticket):
        self.session, self.ticket = session, ticket
        super().__init__(socket)

    async def fulfill(self, params):
        url = params['request']['url']
        if '/ai/browser-ticket/' in url:
            data = dict(ticket=self.ticket, control=True)
        elif '/ai/sessions' in url:
            data = dict(session=dict(id=self.session, title='Owned interaction QA', messages=[], session_type='agent_chat'), sessions=[])
        else:
            data = dict(user=dict(id='owned-interaction-qa', username='Interaction QA', preferences={}),
                projects=[], deployments=[], organizations=[], servers=[], sessions=[], models=[],
                providers=[], connections=[], settings={})
        await self.call('Fetch.fulfillRequest', dict(requestId=params['requestId'], responseCode=200,
            responseHeaders=[dict(name='Content-Type',value='application/json'),
                dict(name='Access-Control-Allow-Origin',value='http://127.0.0.1:3000'),
                dict(name='Access-Control-Allow-Credentials',value='true'),
                dict(name='Access-Control-Allow-Headers',value='Content-Type,X-stackpilot-CSRF'),
                dict(name='Access-Control-Allow-Methods',value='GET,POST,PUT,DELETE,OPTIONS')],
            body=base64.b64encode(json.dumps(data).encode()).decode()))


async def metrics(cdp):
    return {m['name']:m['value'] for m in (await cdp.call('Performance.getMetrics'))['metrics']}


async def measure(viewer, source, client, session, label, seconds, controls, with_frames=False):
    stats_js="""(async () => {const result=[];for(const p of __qa.peers){if(p.connectionState!=='connected')continue;
      const stats=await p.getStats();for(const s of stats.values())if(s.type==='inbound-rtp'&&s.kind==='video')result.push({...s});}return result;})()"""
    receiver_before=await viewer.evaluate(stats_js)
    await viewer.evaluate('__qa.videoCallbacks=[];__qa.draws=[];__qa.videoMetadata=[];__qa.capture=[];__qa.health=[];__qa.videoPresented=0;__qa.startedAt=performance.now()')
    await source.evaluate('window.drawTimes=[];window.observationWrites=0')
    before = await metrics(source)
    started = time.monotonic()
    actions = []
    index = 0
    while time.monotonic() - started < seconds:
        if label == 'idle':
            await asyncio.sleep(.25)
            continue
        options = [dict(action='click',element_id=controls['toggle']),
                   dict(action='type',element_id=controls['field'],text='Fixture '+str(index)),
                   dict(action='scroll',delta_y=220 if (index//3)%2==0 else -220)]
        arguments = dict(session_id=session,include_frame=with_frames,**options[index%3])
        at = time.monotonic()
        response = await client.post('/tools/execute',json=dict(tool_name='browser_interact',arguments=arguments,user_id='owned-interaction-qa'))
        response.raise_for_status()
        result = response.json()
        actions.append(dict(action=arguments['action'],seconds=round(time.monotonic()-at,3),status=result.get('status'),error=result.get('error')))
        index += 1
        await asyncio.sleep(.1)
    after = await metrics(source)
    output = await viewer.evaluate("""(() => {const a=__qa.videoCallbacks.length?__qa.videoCallbacks:__qa.draws;
      const gaps=a.slice(1).map((x,i)=>x-a[i]).sort((a,b)=>a-b),elapsed=performance.now()-__qa.startedAt;
      return {presented:a.length,fps:a.length*1000/elapsed,p95_gap_ms:gaps[Math.floor(gaps.length*.95)]||0,max_gap_ms:gaps.at(-1)||0,
        capture_tail:__qa.capture.slice(-2),health_tail:__qa.health.slice(-2),video_visible:document.querySelector('video')?.style.visibility==='visible'};})()""")
    output.update(await source.evaluate("({source_draws:window.drawTimes.length,observation_attribute_writes:window.observationWrites,clicks:window.clicks})"))
    elapsed = time.monotonic()-started
    output['source_cpu_seconds'] = {key:round(after.get(key,0)-before.get(key,0),4) for key in ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration']}
    output['elapsed_seconds']=round(elapsed,3)
    output['actions']=actions
    output['receiver_before']=receiver_before
    output['receiver_after']=await viewer.evaluate(stats_js)
    output['action_count']=len(actions)
    output['action_median_seconds']=round(statistics.median(a['seconds'] for a in actions),3) if actions else None
    assert output['presented'] > 5,output
    assert all(a['status']=='passed' for a in actions),actions
    print(label+': '+json.dumps({k:v for k,v in output.items() if k not in {'health_tail','capture_tail','actions'}}),flush=True)
    return output


async def main(args):
    session=str(uuid.uuid4())
    payload=json.dumps(dict(session_id=session,kind='browser',user_id='owned-interaction-qa',control=True,expires=int(time.time())+300),separators=(',',':')).encode()
    ticket=payload.hex()+'.'+hmac.new(os.environ['STACKPILOT_AI_SERVICE_TOKEN'].encode(),payload,hashlib.sha256).hexdigest()
    source_url='data:text/html,'+quote(SOURCE)
    host=browser_config('host')
    source_config=browser_config(args.mode)
    owner=await open_context_owner(host.endpoint,host.headers)
    context,target=await create_isolated_target(host.endpoint,owner,fullscreen=False)
    headers={'x-stackpilot-service-token':os.environ['STACKPILOT_AI_SERVICE_TOKEN']}
    output=dict(mode=args.mode,scope='Production viewer and real agent tools; fixture APIs; no provider calls',phases={})
    async with httpx.AsyncClient(base_url='http://127.0.0.1:8010',headers=headers,trust_env=False,timeout=35) as client:
        try:
            diagnostics=(await client.get('/browser/diagnostics')).json()
            if diagnostics['active_runs'] or diagnostics['viewers']:
                raise RuntimeError('Run this qualification when user browser runs/viewers are idle.')
            async with websockets.connect(f'ws://127.0.0.1:8010/ws/browser/{session}?ticket={ticket}&control_only=1') as settings:
                await settings.send(json.dumps(dict(type='switch_mode',sandbox_mode=args.mode,url=source_url)))
                ack=json.loads(await settings.recv())
                assert ack.get('browser_mode')==args.mode,ack
            response=await client.post('/tools/execute',json=dict(tool_name='browser_observe',arguments=dict(session_id=session,include_frame=False),user_id='owned-interaction-qa'))
            response.raise_for_status()
            async with httpx.AsyncClient(trust_env=False,headers={'Host':'localhost',**source_config.headers}) as worker:
                targets=(await worker.get(source_config.endpoint+'/json/list')).json()
            source_target=next(t for t in targets if t.get('url')==source_url)
            controls_ws='ws://'+urlsplit(source_config.endpoint).netloc+'/devtools/page/'+source_target['id']
            viewer_ws='ws://'+urlsplit(host.endpoint).netloc+'/devtools/page/'+target
            async with websockets.connect(controls_ws,additional_headers=source_config.headers,max_size=16*1024*1024) as source_socket, \
                websockets.connect(viewer_ws,additional_headers=host.headers,max_size=16*1024*1024) as viewer_socket:
                source=CDP(source_socket)
                viewer=ViewerCDP(viewer_socket,session,ticket)
                await source.call('Runtime.enable')
                await source.call('Performance.enable')
                controls=await source.evaluate("({toggle:window.__spFast.ids.get(document.getElementById('toggle')),field:window.__spFast.ids.get(document.getElementById('field'))})")
                assert len(controls)==2,controls
                await viewer.call('Page.enable')
                await viewer.call('Runtime.enable')
                await viewer.call('Emulation.setDeviceMetricsOverride',dict(width=1700,height=1000,deviceScaleFactor=1,mobile=False))
                await viewer.call('Fetch.enable',dict(patterns=[dict(urlPattern='*api/v1/*')]))
                instrument=INSTRUMENT.replace('__QA_RTC_PRIVATE_IP__','127.0.0.1')
                await viewer.call('Page.addScriptToEvaluateOnNewDocument',dict(source="localStorage.setItem('theme','dark');localStorage.setItem('sidebar-collapsed','true');"+instrument))
                await viewer.call('Page.navigate',dict(url='http://127.0.0.1:3000/dashboard/ai?session_id='+session))
                await wait_for(viewer,"!!document.querySelector('[aria-label=\"Agent settings\"]')",30)
                # The current-session URL opens Live App automatically. Toggling
                # the button races hydration and can close the panel instead.
                await wait_for(viewer,"!!document.querySelector('video')",30)
                await wait_for(viewer,'__qa.videoCallbacks.length>15 || __qa.draws.length>15',40)
                await asyncio.sleep(3)
                for label in ['idle','agent_dom','agent_vision']:
                    output['phases'][label]=await measure(viewer,source,client,session,label,args.seconds,controls,with_frames=label=='agent_vision')
                    Path(args.output).write_text(json.dumps(output,indent=2))
                output['page_errors']=viewer.errors
                assert not viewer.errors,viewer.errors
                source.reader.cancel()
                viewer.reader.cancel()
        finally:
            await client.post('/tools/execute',json=dict(tool_name='browser_close_session',arguments=dict(session_id=session),user_id='owned-interaction-qa'))
            await dispose_context(host.endpoint,context,host.headers)
            await owner.close()
    output['owned_contexts_cleaned']=True
    Path(args.output).write_text(json.dumps(output,indent=2))
    print('Saved '+args.output,flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--mode',choices=['local','remote','host'],default='local')
    parser.add_argument('--seconds',type=int,default=12)
    parser.add_argument('--output',required=True)
    asyncio.run(main(parser.parse_args()))
