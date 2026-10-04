"""Responsive production UI audit in an isolated context with intercepted fixture APIs.

No user account, repository, provider, deployment or browser action is used.
Run inside ai-service with PYTHONPATH=/app and the two CDP helper files alongside.
MOBILE_QA_BASELINE=1 reports pre-change measurements without enforcing new assertions.
"""
import asyncio
import base64
import json
import os
from pathlib import Path

import websockets
from remote_phone_ui_smoke import RemoteCDP, SESSION
from mobile_layout_smoke import PROJECTS, wait_for
from app.browser_config import browser_config
from app.browser_testing.isolation import open_context_owner, create_isolated_target, dispose_context

ORIGIN = os.getenv('MOBILE_QA_ORIGIN', 'http://frontend:3000')
BASELINE = os.getenv('MOBILE_QA_BASELINE') == '1'
OUT = Path('/tmp/mobile-platform-qa')
LONG_NAME = 'production-application-with-a-long-resource-name'
RESOURCE = dict(name=LONG_NAME, namespace='production', ownership_state='external', provider_type='kubernetes',
                resource_type='pod', resource_key='fixture', managed_by_stackpilot=False, claimed_by_StackPilot=False)
INVENTORY = dict(status='ok', mode='local', warnings=[], timestamp='2026-10-04T00:00:00Z',
    docker=dict(available=True, container_count=1, image_count=0, images=[], stats=[],
                containers=[dict(RESOURCE, id='fixture-container', provider_type='docker', resource_type='container',
                                 image='registry.example.test/team/long-service:latest', status='running', ports='8080:80')]),
    kubernetes=dict(available=True, node_count=1, pod_count=1, namespace_count=1, deployment_count=0,
                    service_count=0, event_count=0, deployments=[], services=[], events=[], metrics=[],
                    namespaces=[dict(RESOURCE, name='production', status='Active', resource_type='namespace')],
                    nodes=[dict(RESOURCE, resource_type='node', ready=True, capacity={}, allocatable={}, conditions=[])],
                    pods=[dict(RESOURCE, phase='Running', node=LONG_NAME, restart_count=0, containers_ready=1, container_count=1)]))
ROUTES = ['/dashboard', '/dashboard/projects', '/dashboard/projects/0', '/dashboard/deployments',
          '/dashboard/logging-monitoring', '/dashboard/logging-monitoring/visualization',
          '/dashboard/logging-monitoring/infrastructure', '/dashboard/logging-monitoring/clusters',
          '/dashboard/infrastructure', '/dashboard/clusters', '/dashboard/observability',
          '/dashboard/ai?session_id='+SESSION, '/dashboard/ai/history', '/dashboard/secrets',
          '/dashboard/organization', '/dashboard/remote', '/dashboard/settings',
          '/dashboard/theme-builder', '/dashboard/change-icon', '/theme-builder', '/change-icon',
          '/auth/login', '/auth/register', '/auth/forgot-password', '/auth/github/callback',
          '/invite/fixture', '/preview/fixture', '/remote', '/']


class LayoutCDP(RemoteCDP):
    async def fulfill(self, params):
        url = params['request']['url']
        deployment = dict(id='fixture-deployment', project_id='0', project_name=LONG_NAME, version='v1',
                          status='built', created_at='2026-10-04', commit_hash='a'*40, image_name='fixture:latest',
                          runtime_url='', runtime_exposure='direct', runtime_provider='local_docker',
                          k8s_namespace='', k8s_deployment_name='', k8s_service_name='', k8s_ingress_name='', desired_replicas=1)
        data = dict(projects=PROJECTS, project=PROJECTS[0], deployments=[deployment], deployment=deployment,
                    organizations=[], secrets=[],
                    connections=[], clusters=[], sessions=[], models=[], providers=[], templates=[], applications=[],
                    events=[], logs=[], members=[], invitations=[], environments=[], settings={},
                    user=dict(id=SESSION, username='Responsive fixture', email='fixture@example.test', preferences={}))
        if '/infrastructure/inventory' in url:
            if getattr(self, 'slow_inventory', False): await asyncio.sleep(.8)
            data = INVENTORY
        elif '/logging-monitoring/summary' in url:
            data = dict(status='ok', database_connected=True, projects=dict(active=3), stack={},
                        deployments=dict(total=0, by_status={}, by_runtime={}), jobs=dict(by_status={}), recent_failures=[])
        elif '/organizations/invitations/fixture' in url:
            data = dict(organization_name='Responsive fixture workspace', role='member', expires_at='2099-01-01', valid=True)
        elif '/ai/sessions/' in url:
            data = dict(session=dict(id=SESSION, title='Mobile layout fixture'), messages=[
                dict(id='question', role='user', content='Inspect the application.', metadata={}),
                dict(id='answer', role='assistant', content='**Inspection finished.**\n\n- A short, readable result.\n\n' +
                     'Averylongunbrokentoken'*8, metadata=dict(reasoning=('Checking the fixture application and its controls.\n'*65)))])
        elif '/ai/sessions' in url:
            data = dict(session=dict(id=SESSION, title='Mobile fixture'), sessions=[dict(id=SESSION, title='Mobile fixture',
                        memory_summary='**Saved context**\n\n- A bounded Markdown note.')])
        elif '/remote/' in url or '/ai/browser-ticket/' in url:
            return await super().fulfill(params)
        await self.call('Fetch.fulfillRequest', dict(requestId=params['requestId'], responseCode=200,
            responseHeaders=[dict(name='Content-Type', value='application/json'),
                             dict(name='Access-Control-Allow-Origin', value=ORIGIN),
                             dict(name='Access-Control-Allow-Credentials', value='true'),
                             dict(name='Access-Control-Allow-Headers', value='Content-Type,Authorization,X-stackpilot-CSRF')],
            body=base64.b64encode(json.dumps(data).encode()).decode()))


INSTRUMENT = r"""
localStorage.setItem('theme','dark');localStorage.removeItem('stackpilot_remote_device');
window.__layoutSockets=[];
window.WebSocket=class {
 static OPEN=1; static CONNECTING=0; static CLOSED=3;
 constructor(url){this.url=String(url);this.readyState=1;this.messages=[];__layoutSockets.push(this);setTimeout(()=>this.onopen?.({}),20);}
 send(raw){this.messages.push(JSON.parse(raw));setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'browser_mode',browser_mode:'local'})}),10);}
 close(){this.readyState=3;} addEventListener(){} removeEventListener(){}
};
"""
MEASURE = r"""(()=>{
 const main=document.querySelector('main'), root=document.documentElement;
 const clips=[...document.querySelectorAll('main button,main [role=tab],main h1')].filter(e=>{
   const r=e.getBoundingClientRect();if(!r.width||!r.height)return false;
   let p=e.parentElement;while(p&&p!==main){if(['auto','scroll'].includes(getComputedStyle(p).overflowX))return false;p=p.parentElement;}
   return r.left < -1 || r.right > innerWidth+1;
 }).map(e=>e.textContent.trim().slice(0,70));
 return {width:innerWidth,root:root.scrollWidth,body:document.body.scrollWidth,main:main?.scrollWidth,
         mainWidth:main?.clientWidth,clipped:clips,title:document.querySelector('h1')?.textContent||document.title};
})()"""


async def main():
    OUT.mkdir(exist_ok=True)
    config = browser_config('local')
    owner = await open_context_owner(config.endpoint, config.headers)
    context, target = await create_isolated_target(config.endpoint, owner, fullscreen=False)
    results, features = [], {}
    try:
        async with websockets.connect(config.endpoint.replace('http://', 'ws://')+'/devtools/page/'+target,
                                      additional_headers=config.headers, max_size=16*1024*1024) as socket:
            cdp = LayoutCDP(socket); cdp.origin = ORIGIN
            await cdp.call('Page.enable'); await cdp.call('Runtime.enable')
            await cdp.call('Fetch.enable', dict(patterns=[dict(urlPattern='*api/v1/*')]))
            await cdp.call('Page.addScriptToEvaluateOnNewDocument', dict(source=INSTRUMENT))
            for width, height in [(320,740), (375,812), (390,844), (844,390), (768,1024), (1280,800)]:
                await cdp.call('Emulation.setDeviceMetricsOverride', dict(width=width,height=height,deviceScaleFactor=1,mobile=width<640))
                await cdp.call('Emulation.setEmulatedMedia',dict(features=[dict(name='prefers-reduced-motion',value='reduce' if width==375 else 'no-preference')]))
                for route in ROUTES:
                    cdp.errors.clear()
                    await cdp.call('Page.navigate', dict(url=ORIGIN+route))
                    await wait_for(cdp, "document.readyState==='complete' && (!!document.querySelector('button') || !!document.querySelector('a'))", 45)
                    await asyncio.sleep(.6)
                    if width == 375:
                        await cdp.evaluate("document.documentElement.style.fontSize='20px'")
                        await asyncio.sleep(.15)
                    # Do not leave the computer open over the chat while measuring message layout.
                    await cdp.evaluate("document.querySelector('[aria-label=\"Close browser\"]')?.click()")
                    sample = await cdp.evaluate(MEASURE)
                    sample.update(route=route, configuredWidth=width, fontScale=1.25 if width==375 else 1, errors=list(cdp.errors))
                    results.append(sample)
                    print('LAYOUT '+json.dumps(sample), flush=True)
                    if route.startswith('/dashboard/ai?') and width<640:
                        await wait_for(cdp, "!!document.querySelector('[data-chat-message=assistant]')",20)
                        if not BASELINE:
                            features[f'thinking_default_{width}'] = await cdp.evaluate("[...document.querySelectorAll('[data-chat-message=assistant] button')].find(e=>e.textContent.includes('Show thinking'))?.getAttribute('aria-expanded')==='false'")
                        await cdp.evaluate("[...document.querySelectorAll('[data-chat-message=assistant] button')].find(e=>e.textContent.includes('Show thinking'))?.click()")
                        features[f'chat_{width}'] = await cdp.evaluate("({bubble:document.querySelector('[data-chat-message=assistant] .prose-ai').parentElement.getBoundingClientRect().width,reasoning:document.querySelector('[data-thinking-content]')?.getBoundingClientRect().height,font:getComputedStyle(document.querySelector('[data-chat-message=assistant] .prose-ai p')).fontSize})")
                        await cdp.evaluate("const t=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'Keep my phone draft');t.dispatchEvent(new Event('input',{bubbles:true}));")
                        await cdp.evaluate("[...document.querySelectorAll('button')].find(e=>e.title.includes('Toggle Live Application')).click()")
                        await wait_for(cdp, "!!document.querySelector('[aria-label=\"Close browser\"]')",20)
                        await asyncio.sleep(.25)
                        features[f'computer_{width}'] = await cdp.evaluate("(()=>{const e=document.querySelector('[aria-label=\"Close browser\"]').closest('[data-browser-view]')||document.querySelector('[aria-label=\"Close browser\"]').parentElement.parentElement.parentElement;const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight,chatVisible:[...document.querySelectorAll('textarea')].some(t=>t.getBoundingClientRect().height>0)}})()")
                        if not BASELINE:
                            await cdp.evaluate("document.querySelector('[aria-label=\"Zoom browser 2 times\"]').click()")
                            await asyncio.sleep(.2)
                            features[f'zoom_{width}'] = await cdp.evaluate("({screen:document.querySelector('[data-browser-screen]').getBoundingClientRect().width,viewer:document.querySelector('[data-browser-viewport]').clientWidth,root:document.documentElement.scrollWidth})")
                            await cdp.evaluate("document.querySelector('[aria-label=\"Browser options\"]').click()")
                            await wait_for(cdp,"[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.includes('Show console'))",10)
                            await cdp.evaluate("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('Show console')).click()")
                            assert await cdp.evaluate("document.querySelector('[data-browser-viewport]').clientHeight>100")
                            await cdp.evaluate("document.querySelector('[aria-label=\"Fit browser to screen\"]').click()")
                            await asyncio.sleep(.3)
                            assert await cdp.evaluate("(()=>{const b=document.querySelector('[aria-label=\"Close browser\"]'),r=b.getBoundingClientRect();return b.scrollWidth<=b.clientWidth+1&&r.right<=innerWidth})()")
                        shot = await cdp.call('Page.captureScreenshot', dict(format='png'))
                        (OUT/f'computer-{width}.png').write_bytes(base64.b64decode(shot['data']))
                        await cdp.evaluate("document.querySelector('[aria-label=\"Close browser\"]').click()")
                        if not BASELINE:
                            assert await cdp.evaluate("document.querySelector('textarea').value==='Keep my phone draft'")
                            await cdp.evaluate("[...document.querySelectorAll('[data-chat-message=assistant] button')].find(e=>e.textContent.includes('Hide thinking'))?.click()")
                            await asyncio.sleep(.2)
                        shot = await cdp.call('Page.captureScreenshot', dict(format='png'))
                        (OUT/f'chat-{width}.png').write_bytes(base64.b64decode(shot['data']))
                    if route.endswith('/infrastructure') and width<640:
                        if not BASELINE:
                            cdp.slow_inventory = True
                            await cdp.evaluate("document.querySelector('[data-inventory-toolbar] button[aria-busy]').click()")
                            await wait_for(cdp,"document.querySelector('[data-inventory-toolbar] button[aria-busy=true]')!==null",10)
                            assert not await cdp.evaluate("document.body.innerText.includes('Reading target')")
                            assert await cdp.evaluate("(()=>{const t=document.querySelector('[data-inventory-toolbar]'),r=t.getBoundingClientRect(),b=t.querySelector('button[aria-busy]').getBoundingClientRect();return Math.abs(b.right-r.right)<2})()")
                            cdp.slow_inventory = False
                        features[f'infrastructure_{width}'] = await cdp.evaluate("(()=>{const tabs=[...document.querySelectorAll('[role=tab]')];return {reading:document.body.innerText.includes('Reading target'),tabs:tabs.map(t=>({text:t.textContent,width:t.getBoundingClientRect().width,content:t.scrollWidth})),refresh:[...document.querySelectorAll('button')].find(t=>t.textContent.trim()==='Refresh')?.getBoundingClientRect().right}})()")
                        await cdp.evaluate("document.querySelector('[role=tab]')?.scrollIntoView({block:'center'})")
                        shot = await cdp.call('Page.captureScreenshot',dict(format='png'))
                        (OUT/f'infrastructure-{width}.png').write_bytes(base64.b64decode(shot['data']))
            report = dict(routes=results, features=features)
            (OUT/'qualification.json').write_text(json.dumps(report,indent=2))
            failures = [r for r in results if r['root']>r['configuredWidth']+1 or r['body']>r['configuredWidth']+1 or
                        (r.get('main') and r['main']>r['mainWidth']+1) or r['clipped'] or r['errors']]
            if not BASELINE:
                assert not failures, failures
                for key, value in features.items():
                    if key.startswith('computer_'):
                        assert value['left']>=0 and value['right']<=int(key.split('_')[1])+1 and not value['chatVisible'],(key,value)
                    if key.startswith('infrastructure_'):
                        assert not value['reading'] and all(t['content']<=t['width']+1 for t in value['tabs']),(key,value)
                    if key.startswith('chat_'):
                        height={320:740,375:812,390:844}[int(key.split('_')[1])]
                        assert value['reasoning'] is not None and value['reasoning']<=height*.28+1,(key,value)
                    if key.startswith('zoom_'):
                        assert value['screen']>value['viewer']*1.8 and value['root']<=int(key.split('_')[1])+1,(key,value)
                    if key.startswith('thinking_default_'):
                        assert value,(key,value)
            print('MOBILE_PLATFORM_'+('BASELINE' if BASELINE else 'PASS')+' '+json.dumps(dict(count=len(results),failures=failures,features=features)),flush=True)
    finally:
        await dispose_context(config.endpoint,context,config.headers)
        await owner.close()


if __name__=='__main__':
    asyncio.run(main())
