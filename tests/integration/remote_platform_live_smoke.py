"""The complete platform on a paired HTTPS phone, with disposable account data.

Run inside ai-service. Temporarily enables the managed tunnel only if it was off,
then restores its state. No AI provider calls or existing browser tabs are used.
"""
import asyncio
import base64
import json
import os
import secrets
import time
import uuid
from pathlib import Path
import urllib.error
import urllib.request
import websockets
from remote_session_smoke import API
from mobile_layout_smoke import CDP, wait_for
from app.browser_config import browser_config
from app.browser_testing.isolation import open_context_owner, create_isolated_target, dispose_context, command
from app.tools import get_db_connection


async def main():
    tag=uuid.uuid4().hex[:12]
    owner=API('http://backend:8090/api/v1')
    uid=None; enabled=False; context=None; browser=None; source_context=None; session=None
    config=browser_config('local')
    source_url=''
    output={}
    try:
        account=owner.call('POST','/auth/register',dict(username='remote-live-qa-'+tag,email='remote-live-qa-'+tag+'@example.test',password='Fixture-'+secrets.token_hex(20)+'!aA1'))
        uid=account['user']['id']
        access=owner.call('GET','/remote/access')
        assert access['available'], 'Managed tunnel container is unavailable'
        if not access['running']:
            enabled=True
            owner.call('POST','/remote/access',dict(action='start'))
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            access=owner.call('GET','/remote/access')
            if access['running'] and access['url']:break
            await asyncio.sleep(2)
        else:raise AssertionError('Managed HTTPS link did not become ready')
        origin=access['url']
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        # The relay can advertise its hostname before the edge connection is ready.
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            try:
                with opener.open(origin+'/remote',timeout=15) as response:
                    if response.status==200:break
            except Exception:pass
            await asyncio.sleep(2)
        else:raise AssertionError('Managed tunnel has a URL but cannot serve the phone page')
        for path in ['/dashboard','/api/v1/auth/login','/api/v1/remote/devices','/api/v1/ai/tools/execute','/json/version']:
            try:opener.open(origin+path,timeout=20)
            except urllib.error.HTTPError as exc:assert exc.code==(404 if path.startswith('/json/') else 401), (path,exc.code)
            else:raise AssertionError('Private route exposed through gateway: '+path)
        output['public_gateway_blocks_private_routes']=True
        pair=owner.call('POST','/remote/pairings',{})
        phone=API(origin+'/api/v1')
        browser=await open_context_owner(config.endpoint,config.headers)
        context,target=await create_isolated_target(config.endpoint,browser,fullscreen=False)
        address=config.endpoint.replace('http://','ws://')+'/devtools/page/'+target
        async with websockets.connect(address,additional_headers=config.headers,max_size=16*1024*1024) as socket:
            cdp=CDP(socket)
            await cdp.call('Page.enable');await cdp.call('Runtime.enable')
            instrument="""window.__remoteLive={draws:0,frames:0,video:0,types:{},health:null,sockets:[]};
const draw=CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage=function(...args){window.__remoteLive.draws++;return draw.apply(this,args)};
const OriginalSocket=WebSocket;window.WebSocket=class extends OriginalSocket {
 constructor(...args){super(...args);this.addEventListener('message',e=>{
  if(e.data instanceof ArrayBuffer)window.__remoteLive.frames++;
  else if(typeof e.data==='string'){try{const msg=JSON.parse(e.data);window.__remoteLive.types[msg.type]=(window.__remoteLive.types[msg.type]||0)+1;if(msg.type==='stream_health')window.__remoteLive.health={video_active:msg.video_active,capture:msg.capture,websocket_queue:msg.websocket_queue};}catch{}}
 });const url=new URL(args[0]);const state={path:url.pathname,control:url.searchParams.has('control_only'),opened:false,closed:null,errors:0,sent:[]};window.__remoteLive.sockets.push(state);this.__qaState=state;this.addEventListener('open',()=>state.opened=true);this.addEventListener('close',e=>state.closed=e.code);this.addEventListener('error',()=>state.errors++);}
 send(message){try{this.__qaState.sent.push(JSON.parse(message).type)}catch{}return super.send(message)}
};
"""
            instrument += """
window.__platformRequests=[];
const oldFetch=window.fetch;window.fetch=async function(input,init){const response=await oldFetch.call(this,input,init);window.__platformRequests.push({url:String(input.url||input),status:response.status});return response};
const oldOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...args){this.__qaUrl=String(url);this.addEventListener('loadend',()=>window.__platformRequests.push({url:this.__qaUrl,status:this.status}));return oldOpen.call(this,method,url,...args)};
"""
            await cdp.call('Page.addScriptToEvaluateOnNewDocument',dict(source="localStorage.setItem('theme','dark');"+instrument))
            await cdp.call('Emulation.setDeviceMetricsOverride',dict(width=390,height=844,deviceScaleFactor=1,mobile=True))
            await cdp.call('Page.navigate',dict(url=origin+'/remote#pair='+pair['secret']))
            await wait_for(cdp,"document.body?.innerText.includes('Connect this phone')",45)
            await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Connect this phone')).click()")
            await wait_for(cdp,"document.body?.innerText.includes('Confirm this phone')",30)
            token=await cdp.evaluate("localStorage.getItem('stackpilot_remote_device')")
            pending=next(d for d in owner.call('GET','/remote/devices')['devices'] if d['status']=='pending')
            assert await cdp.evaluate("document.body?.innerText.includes("+json.dumps(pending['confirmation_code'])+")")
            owner.call('POST','/remote/devices',dict(id=pending['id'],action='approve',confirmation_code=pending['confirmation_code']))
            await wait_for(cdp,"location.pathname==='/dashboard' && !!document.querySelector('[aria-label=\"Open navigation\"]')",40)
            cookies=(await cdp.call('Network.getCookies',dict(urls=[origin])))['cookies']
            assert any(c['name']=='stackpilot_remote_device' and c['secure'] and c['httpOnly'] and c['path']=='/' for c in cookies)
            output['pairing_opens_full_dashboard_with_revocable_secure_cookie']=True
            assert await cdp.evaluate('window.isSecureContext')
            project=phone.call('POST','/projects',dict(name='Phone fixture '+tag,repo_url='https://github.com/example/phone-fixture',source_type='github'),token=token)['project']
            pid=project['id']
            phone.call('PUT','/projects/'+pid,dict(name='Phone fixture '+tag,description='Edited from the phone'),token=token)
            phone.call('POST','/projects/'+pid+'/secrets',dict(key='PHONE_FIXTURE',value='owned-fixture-value'),token=token)
            secret=phone.call('GET','/projects/'+pid+'/secrets',token=token)['secrets'][0]
            assert phone.call('POST','/projects/'+pid+'/secrets/'+secret['id']+'/reveal',{},token=token)['value']=='owned-fixture-value'
            phone.call('DELETE','/projects/'+pid+'/secrets/'+secret['id'],token=token)
            phone.call('PUT','/auth/preferences',dict(sidebar_collapsed=False),token=token)
            phone.call('GET','/remote/devices',token=token)
            output['phone_project_edit_secret_reveal_delete_and_settings_work']=True
            tools=phone.call('POST','/ai/tools/execute',dict(tool_name='list_projects',arguments={}),token=token)
            assert pid in json.dumps(tools), 'Dashboard tool could not see its account project'
            phone.call('POST','/ai/tools/execute',dict(tool_name='_internal_agent_authorize',arguments={}),token=token,expected=(403,))
            output['dashboard_tools_work_and_service_only_tools_stay_private']=True
            routes=['','deployments','logging-monitoring','logging-monitoring/visualization','logging-monitoring/infrastructure','logging-monitoring/clusters','ai','ai/history','secrets','organization','remote','settings','projects/'+pid]
            if os.getenv('REMOTE_PLATFORM_BROWSER_ONLY')=='1': routes=['']
            output['routes']=[]
            for route in routes:
                cdp.errors.clear()
                await cdp.call('Page.navigate',dict(url=origin+'/dashboard'+('/'+route if route else '')))
                await wait_for(cdp,"!!document.querySelector('[aria-label=\"Open navigation\"]')",35)
                # The mobile header is server-rendered; its presence alone does
                # not mean the dashboard chunks and click handlers hydrated.
                await wait_for(cdp,"window.__platformRequests?.some(r=>r.url.includes('/auth/me') && r.status===200)",35)
                await asyncio.sleep(2)
                metrics=await cdp.evaluate("({path:location.pathname,width:innerWidth,body:document.documentElement.scrollWidth,pageError:document.body?.innerText.includes('This page hit an error'),requests:__platformRequests})")
                assert metrics['body']<=metrics['width']+1,metrics
                assert not metrics['pageError'] and not cdp.errors,(route,metrics,cdp.errors)
                assert metrics['path'].startswith('/dashboard'),metrics
                assert not any('localhost:8090' in r['url'] or ':8010' in r['url'] for r in metrics['requests']),metrics
                failed=[r for r in metrics['requests'] if r['status']>=500 or r['status']==401]
                assert not failed,(route,failed)
                output['routes'].append(dict(path=metrics['path'],width=metrics['width'],body=metrics['body'],runtime_errors=0))
                print('PHONE_ROUTE_PASS '+metrics['path'],flush=True)
            await cdp.evaluate("document.querySelector('[aria-label=\"Open navigation\"]').click()")
            await wait_for(cdp,"!!document.querySelector('[data-mobile-navigation]')",15)
            links=await cdp.evaluate("[...document.querySelectorAll('[data-mobile-navigation] a')].map(a=>a.getAttribute('href'))")
            assert len(set(links))>=11 and links.index('/dashboard/remote')<links.index('/dashboard/settings'),links
            await cdp.evaluate("document.querySelector('[data-mobile-navigation] a[href=\"/dashboard\"]').click()")
            await wait_for(cdp,"location.pathname==='/dashboard' && !document.querySelector('[data-mobile-navigation]')",20)
            await wait_for(cdp,"document.body?.innerText.includes('Phone fixture '+"+json.dumps(tag)+")",20)
            output['mobile_sidebar_has_entire_platform_and_navigation_works']=True
            await cdp.evaluate("document.querySelector('[aria-label=\"Open navigation\"]').click()")
            await wait_for(cdp,"!!document.querySelector('[data-mobile-navigation]')",15)
            await asyncio.sleep(.4)
            shot=await cdp.call('Page.captureScreenshot',dict(format='png'))
            Path('/tmp/stackpilot-remote-platform.png').write_bytes(base64.b64decode(shot['data']))
            await cdp.call('Input.dispatchKeyEvent',dict(type='keyDown',key='Escape',code='Escape',windowsVirtualKeyCode=27))
            await cdp.call('Input.dispatchKeyEvent',dict(type='keyUp',key='Escape',code='Escape',windowsVirtualKeyCode=27))
            # Cookie-only navigation/API requests cannot become unscoped JWTs.
            phone.call('POST','/remote/session',{},token=token)
            assert phone.call('GET','/auth/me')['user']['id']==uid
            async with websockets.connect(origin.replace('https://','wss://')+'/ws/logs?stream=deployments',additional_headers={'Cookie':'stackpilot_remote_device='+token},open_timeout=20) as logs:
                owner.call('POST','/remote/devices',dict(id=pending['id'],action='revoke'))
                try:await asyncio.wait_for(logs.recv(),5)
                except websockets.exceptions.ConnectionClosed:pass
                else:raise AssertionError('Revoked live logs remained connected')
            phone.call('GET','/projects',token=token,expected=(401,))
            # Finish the revoked device's sign-out before pairing again, as a
            # real phone does. Never transplant credentials into a stale page.
            await cdp.call('Page.navigate',dict(url=origin+'/remote'))
            await wait_for(cdp,"location.pathname==='/remote' && !localStorage.getItem('stackpilot_remote_device') && document.body?.innerText.includes('On your computer')",30)
            # A new fixture device is used for video after revocation was proved.
            pair2=owner.call('POST','/remote/pairings',{})
            token2='sp_remote_'+secrets.token_hex(32)
            device2=phone.call('POST','/remote/connect',dict(secret=pair2['secret'],name='Owned phone video fixture'),token=token2)
            owner.call('POST','/remote/devices',dict(id=device2['id'],action='approve',confirmation_code=device2['confirmation_code']))
            session=phone.call('POST','/ai/sessions',{},token=token2)['session']['id']
            await cdp.evaluate("localStorage.setItem('stackpilot_remote_device',"+json.dumps(token2)+")")
            # Open the shared AI dashboard directly on this owned fixture URL.
            source_url='http://remote-gateway:8094/remote-icon.svg?qa='+tag
            destination='/dashboard/ai?'+urllib.parse.urlencode(dict(session_id=session,browser='open',custom_url=source_url))
            await cdp.call('Page.navigate',dict(url=origin+'/remote?next='+urllib.parse.quote(destination)))
            await wait_for(cdp,"location.pathname==='/dashboard/ai'",35)
            await wait_for(cdp,"!!document.querySelector('[aria-label=\"Browser address\"]')",35)
            try:
                await wait_for(cdp,"window.__remoteLive.frames>0 || window.__remoteLive.draws>0 || [...document.querySelectorAll('video')].some(v=>v.readyState>=2)",60)
            except AssertionError:
                print('PHONE_VIDEO_DIAGNOSTICS '+json.dumps(await cdp.evaluate("({address:document.querySelector('[aria-label=\"Browser address\"]')?.value,types:__remoteLive.types,health:__remoteLive.health,sockets:__remoteLive.sockets,requests:__platformRequests.filter(r=>r.url.includes('/browser-ticket/')).map(r=>({path:r.url.split('?')[0],status:r.status}))})")),flush=True)
                raise
            await wait_for(cdp,"window.__remoteLive.draws>0 || [...document.querySelectorAll('video')].some(v=>v.readyState>=2)",30)
            data=await cdp.evaluate("({secure:isSecureContext,frames:__remoteLive.frames,draws:__remoteLive.draws,video:[...document.querySelectorAll('video')].some(v=>v.readyState>=2),width:innerWidth,body:document.body.scrollWidth})")
            assert data['body']<=data['width']+1,data
            assert not cdp.errors,cdp.errors
            output.update(https_full_platform_ui_loads=True,authenticated_live_browser_frames_render=True,phone_video_no_horizontal_overflow=True,no_runtime_errors=True,revocation_closes_live_logs=True,transport=data)
            # Only this fixture's exact URL may be used to identify and dispose a source context.
            targets=await command(browser,'Target.getTargets')
            for info in targets.get('targetInfos',[]):
                if info.get('url')==source_url and info.get('browserContextId'):
                    source_context=info['browserContextId'];break
        print('REMOTE_PLATFORM_LIVE_PASS '+json.dumps(output),flush=True)
        Path('/tmp/remote-platform-live-qualification.json').write_text(json.dumps(output,indent=2),encoding='utf-8')
    finally:
        if session:
            # Disposing the Chrome target alone leaves a managed worker record
            # until its TTL. Explicitly close only this fixture's own session.
            request=urllib.request.Request('http://127.0.0.1:8010/tools/execute',method='POST',headers={'Content-Type':'application/json','X-StackPilot-Service-Token':os.environ['STACKPILOT_AI_SERVICE_TOKEN']},data=json.dumps(dict(tool_name='browser_close_session',arguments=dict(session_id=session),user_id=uid)).encode())
            with urllib.request.urlopen(request,timeout=15) as response: json.load(response)
        if not source_context and browser and source_url:
            targets=await command(browser,'Target.getTargets')
            source_context=next((info.get('browserContextId') for info in targets.get('targetInfos',[]) if info.get('url')==source_url),None)
        # The managed session close above normally disposes its context too.
        if source_context:
            contexts=(await command(browser,'Target.getBrowserContexts')).get('browserContextIds',[])
            if source_context in contexts:await dispose_context(config.endpoint,source_context,config.headers)
        if context:await dispose_context(config.endpoint,context,config.headers)
        if browser:await browser.close()
        if enabled:
            owner.call('POST','/remote/access',dict(action='stop'))
        if uid:
            assert str(uuid.UUID(uid))==uid
            connection=get_db_connection()
            try:
                with connection.cursor() as cursor:
                    cursor.execute('DELETE FROM projects WHERE user_id=%s',(uid,))
                    cursor.execute('DELETE FROM users WHERE id=%s',(uid,))
                connection.commit()
            finally:connection.close()


if __name__=='__main__':asyncio.run(main())
