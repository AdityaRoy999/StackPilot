"""Phone/desktop production rendering in an owned Chromium context, with fixture APIs."""
import asyncio
import base64
import json
import time
from pathlib import Path
import websockets
from mobile_layout_smoke import CDP, wait_for
from app.browser_config import browser_config
from app.browser_testing.isolation import open_context_owner, create_isolated_target, dispose_context

SESSION='a5ec02c3-ec55-4b50-925a-1e1eab5c01ae'
RUN='b5ec02c3-ec55-4b50-925a-1e1eab5c01ae'

class RemoteCDP(CDP):
    def __init__(self,socket):
        super().__init__(socket);self.requests=[];self.claimed=False;self.approved=False;self.state='working';self.run=None;self.events=[]
    async def fulfill(self,params):
        request=params['request'];url=request['url'];method=request['method'];body=json.loads(request.get('postData') or '{}')
        self.requests.append(dict(path=url.split('/api/v1/')[-1],method=method,body=body))
        device=dict(id=RUN,name='Owned phone',status='approved' if self.approved else 'pending',confirmation_code='123456',email='owned@example.test',expires_at='2099-01-01',last_seen_at=None)
        if '/remote/access' in url:data=dict(available=True,running=True,url='https://remote.fixture.invalid')
        elif '/remote/pairings' in url:data=dict(secret='a'*64,expires_at='2099-01-01')
        elif '/remote/devices' in url:
            if method=='POST':self.approved=True;data=dict(ok=True)
            else:data=dict(devices=[device] if self.claimed else [])
        elif '/remote/connect' in url:self.claimed=True;data=device
        elif '/remote/device' in url:data=device
        elif '/chat/stream' in url:
            self.run=body['request_id']
            if body.get('approval_token') or body['message'].startswith('[System]'):
                self.state='completed';self.events=[dict(sequence=1,type='done',content='Owned continuation result.')]
            else:
                self.state='awaiting_approval';self.events=[dict(sequence=1,type='content',delta='Owned phone result.'),dict(sequence=2,type='permission_request',tool_name='fixture_submit',token='exact-step-token',arguments=dict(action='submit'),description='Submit this exact fixture step.'),dict(sequence=3,type='done',content='Review this step.')]
            data=dict(run_id=self.run,session_id=SESSION,state=self.state)
        elif '/chat/stop' in url:self.state='cancelled';data=dict(status='ok')
        elif '/remote/runs/' in url:
            events=self.events
            after=int(url.split('after=')[-1]) if 'after=' in url else 0
            data=dict(run=dict(id=self.run,session_id=SESSION,state=self.state,last_sequence=str(len(self.events))),events=[e for e in events if e['sequence']>after])
        elif '/remote/runs' in url:data=dict(runs=[dict(id=self.run,session_id=SESSION,state=self.state,last_sequence=str(len(self.events)),context={})] if self.run else [])
        elif '/ai/sessions/' in url:data=dict(session=dict(id=SESSION,title='Owned remote chat'),messages=[])
        elif '/ai/sessions' in url:data=dict(session=dict(id=SESSION,title='Owned remote chat'),sessions=[dict(id=SESSION,title='Owned remote chat')])
        elif '/ai/browser-ticket/' in url:data=dict(ticket='owned-fixture',control=True)
        elif '/auth/me' in url:data=dict(user=dict(id=SESSION,username='Owned QA',preferences={}))
        else:data=dict(projects=[],deployments=[],organizations=[])
        await self.call('Fetch.fulfillRequest',dict(requestId=params['requestId'],responseCode=200,responseHeaders=[dict(name='Content-Type',value='application/json'),dict(name='Access-Control-Allow-Origin',value=getattr(self,'origin','http://frontend:3000')),dict(name='Access-Control-Allow-Credentials',value='true'),dict(name='Access-Control-Allow-Headers',value='Content-Type,Authorization,X-stackpilot-CSRF')],body=base64.b64encode(json.dumps(data).encode()).decode()))

async def main():
    config=browser_config('local');owner=await open_context_owner(config.endpoint,config.headers)
    context,target=await create_isolated_target(config.endpoint,owner,fullscreen=False)
    output={}
    try:
        address=config.endpoint.replace('http://','ws://')+'/devtools/page/'+target
        async with websockets.connect(address,additional_headers=config.headers,max_size=16*1024*1024) as socket:
            cdp=RemoteCDP(socket)
            await cdp.call('Page.enable');await cdp.call('Runtime.enable')
            await cdp.call('Fetch.enable',dict(patterns=[dict(urlPattern='*api/v1/*')]))
            await cdp.call('Page.addScriptToEvaluateOnNewDocument',dict(source="""localStorage.setItem('theme','dark');
let fixtureSerial=0;Object.defineProperty(crypto,'randomUUID',{value:()=> 'c5ec02c3-ec55-4b50-925a-'+String(++fixtureSerial).padStart(12,'0')});
const OriginalSocket=window.WebSocket;
window.WebSocket=class {
 constructor(url){if(!url.includes('control_only'))return new OriginalSocket(url);setTimeout(()=>this.onopen?.({}),10);}
 send(){setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'browser_mode',browser_mode:'local'})}),10);}
 close(){}
};"""))
            await cdp.call('Emulation.setDeviceMetricsOverride',dict(width=1440,height=1000,deviceScaleFactor=1,mobile=False))
            await cdp.call('Page.navigate',dict(url='http://frontend:3000/dashboard/remote'))
            await wait_for(cdp,"document.body?.innerText.includes('Pair a phone')",30)
            await wait_for(cdp,"document.querySelector('#remote-origin')?.value.includes('fixture')",30)
            sidebar=await cdp.evaluate("[...document.querySelectorAll('aside a')].map(a=>a.getAttribute('href'))")
            assert sidebar.index('/dashboard/remote')<sidebar.index('/dashboard/settings'),sidebar
            await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Pair a phone')).click()")
            await wait_for(cdp,"document.body?.innerText.includes('Scan with your phone')",20)
            output['sidebar_above_settings']=True;output['qr_pairing_renders']=True
            await cdp.call('Emulation.setDeviceMetricsOverride',dict(width=390,height=844,deviceScaleFactor=1,mobile=True))
            await cdp.call('Page.navigate',dict(url='http://frontend:3000/remote#pair='+'a'*64))
            await wait_for(cdp,"document.body?.innerText.includes('Connect this phone')",30)
            assert await cdp.evaluate("location.hash===''")
            await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Connect this phone')).click()")
            await wait_for(cdp,"document.body?.innerText.includes('123456')",20)
            output['phone_waits_for_desktop_confirmation']=True
            cdp.approved=True
            await wait_for(cdp,"location.pathname==='/dashboard' && !!document.querySelector('[aria-label=\"Open navigation\"]')",20)
            await cdp.evaluate("document.querySelector('[aria-label=\"Open navigation\"]').click()")
            await wait_for(cdp,"!!document.querySelector('[data-mobile-navigation]')",15)
            links=await cdp.evaluate("[...document.querySelectorAll('[data-mobile-navigation] a')].map(a=>a.getAttribute('href'))")
            assert len(set(links))>=11,links
            output['pairing_opens_full_platform_and_all_sidebar_pages']=True
            await cdp.call('Page.navigate',dict(url='http://frontend:3000/dashboard/ai?session_id='+SESSION))
            await wait_for(cdp,"!!document.querySelector('textarea')",30)
            await wait_for(cdp,"!!document.querySelector('[aria-label=\"Close browser\"]')",30)
            await cdp.evaluate("document.querySelector('[aria-label=\"Close browser\"]').click()")
            await cdp.evaluate("const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Run an owned fixture');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));")
            await cdp.evaluate("const send=document.querySelector('[aria-label=\"Send message\"]')||[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Send');send.click()")
            await wait_for(cdp,"document.body?.innerText.includes('Approve & continue')",20)
            await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Approve & continue')).click()")
            await asyncio.sleep(2)
            commands=[r['body'] for r in cdp.requests if r['path'].endswith('chat/stream') and r['method']=='POST']
            assert len(commands)==2 and commands[1]['approval_token']=='exact-step-token',commands
            assert all(c.get('background') for c in commands),commands
            output['full_ai_dashboard_approval_is_one_exact_step']=True
            cdp.run='d5ec02c3-ec55-4b50-925a-1e1eab5c01ae';cdp.state='awaiting_input'
            cdp.events=[dict(sequence=1,type='agent_question',question_id='fixture-question',question='Choose the fixture destination',fields=[dict(id='destination',label='Destination',type='text')]),dict(sequence=2,type='done',content='Desktop run needs your input.')]
            await wait_for(cdp,"document.body?.innerText.includes('Choose the fixture destination')",20)
            output['desktop_run_handoff_and_question_restore_on_full_platform']=True
            overflow=await cdp.evaluate("({viewport:innerWidth,body:document.body.scrollWidth,root:document.documentElement.scrollWidth})")
            assert overflow['body']<=overflow['viewport']+1 and overflow['root']<=overflow['viewport']+1,overflow
            output['phone_has_no_horizontal_overflow']=True
            shot=await cdp.call('Page.captureScreenshot',dict(format='png'))
            Path('/tmp/stackpilot-remote-phone.png').write_bytes(base64.b64decode(shot['data']))
            assert not cdp.errors,cdp.errors
            output['no_runtime_errors']=True
            print('REMOTE_PHONE_UI_PASS '+json.dumps(output),flush=True)
            Path('/tmp/remote-phone-ui-qualification.json').write_text(json.dumps(output,indent=2))
    finally:
        await dispose_context(config.endpoint,context,config.headers)
        await owner.close()

if __name__=='__main__':asyncio.run(main())
