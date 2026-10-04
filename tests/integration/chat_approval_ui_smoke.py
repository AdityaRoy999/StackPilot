"""Production chat rendering with owned mocked APIs; no provider or deployment actions."""
import asyncio
import base64
import json
import os
from pathlib import Path
import websockets
from remote_phone_ui_smoke import RemoteCDP, SESSION
from mobile_layout_smoke import wait_for
from app.browser_config import browser_config
from app.browser_testing.isolation import open_context_owner, create_isolated_target, dispose_context

FRONTEND_ORIGIN=os.getenv('CHAT_QA_ORIGIN','http://frontend:3000')

class ChatCDP(RemoteCDP):
    def __init__(self,socket):
        super().__init__(socket);self.origin=FRONTEND_ORIGIN
    async def fulfill(self,params):
        url=params['request']['url']
        if '/ai/sessions/' in url:
            messages=[dict(id=f'old-{i}',role='assistant',content=('**Verified fixture**\n\n- A saved result.\n\n' * 6),metadata={}) for i in range(15)]
            data=dict(session=dict(id=SESSION,title='Owned chat fixture'),messages=messages)
        elif '/ai/sessions' in url:
            data=dict(sessions=[dict(id=SESSION,title='Owned fixture',memory_summary='**Next step**\n\n- Verify exact job\n\n```json\n{"job_id":"fixture"}\n```')])
        else:return await super().fulfill(params)
        await self.call('Fetch.fulfillRequest',dict(requestId=params['requestId'],responseCode=200,responseHeaders=[dict(name='Content-Type',value='application/json'),dict(name='Access-Control-Allow-Origin',value=FRONTEND_ORIGIN),dict(name='Access-Control-Allow-Credentials',value='true'),dict(name='Access-Control-Allow-Headers',value='Content-Type,Authorization,X-stackpilot-CSRF'),dict(name='Access-Control-Allow-Methods',value='GET,POST,PUT,DELETE,OPTIONS')],body=base64.b64encode(json.dumps(data).encode()).decode()))

INSTRUMENT=r"""
localStorage.setItem('theme','dark');localStorage.removeItem('stackpilot_remote_device');
window.__chatQA={requests:[],longTasks:[],frames:[],animations:0};
new PerformanceObserver(list=>{for(const entry of list.getEntries())__chatQA.longTasks.push(entry.duration)}).observe({type:'longtask',buffered:false});
const originalFetch=window.fetch;
window.fetch=async(input,init)=>{
 if(String(input).includes('/ai/chat/stream')) {
  const body=JSON.parse(init.body);__chatQA.requests.push(body);
  let frames;
  if(body.approval_token) frames=[{type:'tool_call',name:'workspace_trigger_rebuild',id:'approved-build',arguments:{deployment_id:'owned'}},{type:'tool_result',name:'workspace_trigger_rebuild',id:'approved-build',result:{status:'rebuild_queued',job_id:'owned-job'}},{type:'content',delta:'Rebuild queued. Job `owned-job`.'},{type:'done',content:'Rebuild queued. Job `owned-job`.',status:'completed'}];
  else frames=[...Array.from({length:160},(_,i)=>({type:'content',delta:`Streaming sentence ${i}. `})),{type:'tool_call',name:'workspace_trigger_rebuild',id:'owned-build',arguments:{deployment_id:'owned'}},{type:'tool_result',name:'workspace_trigger_rebuild',id:'owned-build',result:{status:'requires_approval',approval_required:true}},{type:'permission_request',id:'owned-build',tool_name:'workspace_trigger_rebuild',arguments:{deployment_id:'owned'},token:'owned-approval'},{type:'done',content:'Source inspected. Waiting for approval.',status:'waiting_for_permission'}];
  return new Response(new ReadableStream({start(controller){let i=0;function tick(){if(i===frames.length){controller.close();return}controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(frames[i++])+'\n\n'));setTimeout(tick,8)}tick()}}),{status:200,headers:{'Content-Type':'text/event-stream'}});
 }
 return originalFetch(input,init);
};
const OriginalSocket=window.WebSocket;
window.WebSocket=class {constructor(url){if(!url.includes('control_only'))return new OriginalSocket(url);setTimeout(()=>this.onopen?.({}),10)}send(){setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'browser_mode',browser_mode:'local'})}),10)}close(){}};
"""

async def main():
    config=browser_config('local');owner=await open_context_owner(config.endpoint,config.headers)
    context,target=await create_isolated_target(config.endpoint,owner,fullscreen=False)
    result={}
    try:
        async with websockets.connect(config.endpoint.replace('http://','ws://')+'/devtools/page/'+target,additional_headers=config.headers,max_size=16*1024*1024) as socket:
            cdp=ChatCDP(socket)
            await cdp.call('Page.enable');await cdp.call('Runtime.enable')
            await cdp.call('Fetch.enable',dict(patterns=[dict(urlPattern='*api/v1/*')]))
            # Remove double escapes only in the JS wire delimiter.
            await cdp.call('Page.addScriptToEvaluateOnNewDocument',dict(source=INSTRUMENT.replace(r"'\\n\\n'",r"'\n\n'")))
            if os.getenv('CHAT_QA_SECURE_UUID')=='1':
                await cdp.call('Page.addScriptToEvaluateOnNewDocument',dict(source="Object.defineProperty(crypto,'randomUUID',{value:()=> 'qa-message-'+Math.random().toString(16).slice(2)});"))
            await cdp.call('Emulation.setDeviceMetricsOverride',dict(width=1440,height=1000,deviceScaleFactor=1,mobile=False))
            await cdp.call('Page.navigate',dict(url=FRONTEND_ORIGIN+'/dashboard/ai?session_id='+SESSION))
            await wait_for(cdp,"document.querySelector('textarea') && document.body.innerText.includes('Verified fixture')",45)
            await wait_for(cdp,"!!document.querySelector('[aria-label=\"Close browser\"]')",30)
            await cdp.evaluate("document.querySelector('[aria-label=\"Close browser\"]').click()")
            await cdp.evaluate("const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Repair owned fixture');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));")
            await asyncio.sleep(.15)
            await cdp.evaluate("__chatQA.longTasks=[];__chatQA.frames=[];let last=performance.now();function frame(now){__chatQA.frames.push(now-last);last=now;if(__chatQA.requests.length<2)requestAnimationFrame(frame)}requestAnimationFrame(frame);[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Send').click()")
            await asyncio.sleep(.7)
            await cdp.evaluate("const scroller=[...document.querySelectorAll('div')].find(e=>e.className.includes('overscroll-y-contain') && e.scrollHeight>e.clientHeight);scroller.scrollTop=400;__chatQA.scrollTop=scroller.scrollTop;")
            await asyncio.sleep(.8)
            result['scroll_position_retained']=await cdp.evaluate("Math.abs([...document.querySelectorAll('div')].find(e=>e.className.includes('overscroll-y-contain')).scrollTop-__chatQA.scrollTop)<5")
            await wait_for(cdp,"document.body.innerText.includes('Source inspected.')",30)
            await asyncio.sleep(.3)
            result['performance']=await cdp.evaluate("({longTasks:__chatQA.longTasks.length,longTaskMs:Math.round(__chatQA.longTasks.reduce((a,b)=>a+b,0)),maxLongTaskMs:Math.round(Math.max(0,...__chatQA.longTasks)),frameP95:__chatQA.frames.sort((a,b)=>a-b)[Math.floor(__chatQA.frames.length*.95)],animationNodes:document.getAnimations().length})")
            if os.getenv('CHAT_QA_BASELINE')=='1':
                print('CHAT_BASELINE '+json.dumps(result));Path('/tmp/chat-baseline.json').write_text(json.dumps(result,indent=2));return
            await wait_for(cdp,"!!document.querySelector('[data-permissions-section] button:not(:disabled)')",15)
            assert not await cdp.evaluate("document.body.innerText.includes('Rebuild queued') || document.body.innerText.includes('Queued container rebuild')")
            result['permission_inside_assistant']=await cdp.evaluate("!!document.querySelector('[data-permissions-section]')?.closest('[data-chat-message=assistant]')")
            await cdp.evaluate("document.querySelector('[data-permissions-section]').scrollIntoView({block:'center'})")
            shot=await cdp.call('Page.captureScreenshot',dict(format='png'));Path('/tmp/chat-permission-pending.png').write_bytes(base64.b64decode(shot['data']))
            before=await cdp.evaluate("({count:document.querySelectorAll('[data-chat-message=assistant]').length,id:document.querySelector('[data-permissions-section]').closest('[data-chat-message]').dataset.messageId,userCount:document.querySelectorAll('[data-chat-message=user]').length})")
            await cdp.evaluate("[...document.querySelectorAll('[data-permissions-section] button')].find(b=>b.textContent.includes('Approve')).click()")
            await wait_for(cdp,"document.body.innerText.includes('owned-job')",20)
            after=await cdp.evaluate("({count:document.querySelectorAll('[data-chat-message=assistant]').length,id:document.querySelector('[data-permissions-section]').closest('[data-chat-message]').dataset.messageId,userCount:document.querySelectorAll('[data-chat-message=user]').length,requests:__chatQA.requests.length,continuation:__chatQA.requests[1]?.continuation})")
            assert before['count']==after['count'] and before['id']==after['id'] and before['userCount']==after['userCount'],(before,after)
            assert after['requests']==2 and after['continuation'],after
            result['same_bubble_after_approval']=True;result['approval_dispatch_once']=True
            assert not await cdp.evaluate("document.body.innerText.includes('awaiting authorization')")
            result['neutral_permission_card']=await cdp.evaluate("![...document.querySelectorAll('[data-permissions-section] *')].some(e=>/amber|orange/.test(String(e.className)))")
            assert result['scroll_position_retained'] and result['permission_inside_assistant'] and result['neutral_permission_card'],result
            shot=await cdp.call('Page.captureScreenshot',dict(format='png'));Path('/tmp/chat-permissions.png').write_bytes(base64.b64decode(shot['data']))
            await cdp.call('Page.navigate',dict(url=FRONTEND_ORIGIN+'/dashboard/ai/history'))
            await wait_for(cdp,"document.body.innerText.includes('Saved conversation context')",30)
            result['saved_context_markdown']=await cdp.evaluate("document.querySelector('details strong')?.textContent==='Next step' && !!document.querySelector('details li') && !!document.querySelector('details pre code')")
            assert result['saved_context_markdown'],result
            assert not cdp.errors,cdp.errors
            result['runtime_errors']=0
            Path('/tmp/chat-ui-qualification.json').write_text(json.dumps(result,indent=2))
            print('CHAT_UI_PASS '+json.dumps(result),flush=True)
    finally:
        await dispose_context(config.endpoint,context,config.headers);await owner.close()

if __name__=='__main__':asyncio.run(main())
