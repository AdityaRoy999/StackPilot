"""Local, single-device Android executor. Never executes repository code on the host.

The owned AVD is a development lane, not hostile-tenant production isolation.
All installation/control APIs require the internal service credential. Viewers
receive short-lived deployment-scoped capabilities, never that credential.
"""
import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
from urllib.parse import quote, urlsplit
import uuid
import xml.etree.ElementTree as ET

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import HTMLResponse, JSONResponse

ROOT=Path(os.environ.get('STACKPILOT_NATIVE_STATE',str(Path(os.environ.get('LOCALAPPDATA','.'))/'StackPilot'/'native-worker'))).resolve()
SDK=Path(os.environ.get('ANDROID_HOME',str(Path(os.environ.get('LOCALAPPDATA','.'))/'Android'/'Sdk')))
ADB=SDK/'platform-tools'/('adb.exe' if os.name=='nt' else 'adb')
SERIAL=os.getenv('STACKPILOT_ANDROID_SERIAL','emulator-5580')
TOKEN=os.getenv('STACKPILOT_AI_SERVICE_TOKEN','').strip()
app=FastAPI(docs_url=None,redoc_url=None,openapi_url=None)
device_lock=asyncio.Lock()
active=None


def owned_packages():
    """Recover only package identities previously installed by this worker."""
    result=set()
    if ROOT.exists():
        for path in list(ROOT.glob('*/result.json'))[:5000]:
            try:
                record=json.loads(path.read_text())
                package=record.get('package','')
                if record.get('verified') is True and record.get('deployment_id')==path.parent.name and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+',package):result.add(package)
            except (OSError,ValueError,TypeError):pass
        try:
            inventory=json.loads((ROOT/'installed.json').read_text())
            if isinstance(inventory,list):result.update(p for p in inventory if isinstance(p,str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+',p))
        except (OSError,ValueError,TypeError):pass
    return result


def remember_active(value):
    ROOT.mkdir(parents=True,exist_ok=True)
    temporary=ROOT/'active.pending.json';temporary.write_text(json.dumps(value))
    os.replace(temporary,ROOT/'active.json')


def recover_active():
    try:
        record=json.loads((ROOT/'active.json').read_text())
        if not isinstance(record,dict) or record.get('package') not in owned_packages():return None
        deployment=str(uuid.UUID(record['deployment_id']))
        apk=ROOT/deployment/'application.apk'
        if not 0<apk.stat().st_size<=512*1024**2:return None
        with apk.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
        if digest!=record.get('artifact_digest') or not foreground(record['package']):return None
        return record
    except (OSError,ValueError,TypeError,KeyError,RuntimeError,subprocess.TimeoutExpired):return None


def adb(*args,timeout=20,binary=False):
    result=subprocess.run([str(ADB),'-s',SERIAL,*args],capture_output=True,timeout=timeout,
                          creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    if result.returncode:raise RuntimeError('Android '+str(args[0])+' command failed: '+str(result.returncode))
    return result.stdout if binary else result.stdout.decode('utf-8',errors='replace').strip()


def nodes():
    adb('shell','uiautomator','dump','--compressed','/sdcard/stackpilot-window.xml')
    xml=adb('exec-out','cat','/sdcard/stackpilot-window.xml')
    root=ET.fromstring(xml)
    return [dict(node.attrib) for node in root.iter('node')]


def target(observation,selector):
    if not isinstance(selector,dict) or not selector or set(selector)-{'resource_id','text','description'}:
        raise ValueError('Native selectors require resource_id, text or description')
    keys={'resource_id':'resource-id','text':'text','description':'content-desc'}
    matches=[node for node in observation if all(node.get(keys[key])==value for key,value in selector.items())]
    if len(matches)!=1:raise ValueError('Native target is missing or ambiguous')
    bounds=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',matches[0].get('bounds',''))
    if not bounds or matches[0].get('enabled')=='false':raise ValueError('Native target is not actionable')
    left,top,right,bottom=map(int,bounds.groups())
    if right<=left or bottom<=top:raise ValueError('Native target has no visible bounds')
    return (left+right)//2,(top+bottom)//2


def ticket(value,deployment):
    try:
        raw,signature=value.split('.')
        encoded=bytes.fromhex(raw)
        if not TOKEN or len(value)>4096 or not hmac.compare_digest(hmac.new(TOKEN.encode(),encoded,hashlib.sha256).hexdigest(),signature):return None
        claims=json.loads(encoded);now=time.time()
        if not isinstance(claims,dict):return None
        if claims.get('kind')!='native' or claims.get('session_id')!=deployment or type(claims.get('control')) is not bool or type(claims.get('expires')) is not int or not now<claims.get('expires',0)<=now+305:return None
        return claims
    except (ValueError,TypeError,KeyError):return None


@app.middleware('http')
async def authenticate(request:Request,call_next):
    if request.url.path.startswith('/preview/'):
        return await call_next(request)
    if not TOKEN or not secrets.compare_digest(request.headers.get('x-stackpilot-service-token',''),TOKEN):
        return JSONResponse({'detail':'Worker authentication required'},status_code=401)
    return await call_next(request)


@app.get('/capabilities')
async def capabilities():
    try:
        boot=await asyncio.to_thread(adb,'shell','getprop','sys.boot_completed',timeout=5)
        ready=boot=='1'
    except (RuntimeError,subprocess.TimeoutExpired,FileNotFoundError):ready=False
    return {'os':os.name,'android':ready,'serial':SERIAL,'capacity':1,
            'stream':'png_latest_frame','production_tenant_isolation':False}


@app.get('/observe/{deployment}')
async def observe(deployment:str):
    if device_lock.locked() or not active or active['deployment_id']!=deployment:
        return {'verified':False,'status':'unverified','scope':'native_launch_observation','reason':'This release does not currently own the single local Android worker'}
    async with device_lock:
        try:
            running=await asyncio.to_thread(foreground,active['package'])
            return {'verified':running,'status':'passed' if running else 'failed','scope':'native_launch_observation','reason':'Native application is in the foreground' if running else 'Native application is no longer in the foreground','workflow_verified':False}
        except Exception:return {'verified':False,'status':'unverified','scope':'native_launch_observation','reason':'Device observation unavailable'}


@app.post('/release/{deployment}')
async def release(deployment:str):
    global active
    try:deployment=str(uuid.UUID(deployment))
    except ValueError:raise HTTPException(400,'Invalid deployment identity')
    try:await asyncio.wait_for(device_lock.acquire(),timeout=10)
    except asyncio.TimeoutError:raise HTTPException(409,'Android worker is busy')
    try:
        record=active
        if not record:
            try:record=json.loads((ROOT/'active.json').read_text())
            except (OSError,ValueError):record=None
        if not isinstance(record,dict) or record.get('deployment_id')!=deployment:
            return {'released':True,'scope':'native_runtime_cleanup','status':'not_active'}
        package=record.get('package')
        if package not in owned_packages():raise HTTPException(409,'Package ownership cannot be established')
        installed=set((await asyncio.to_thread(adb,'shell','pm','list','packages','-3')).splitlines())
        if 'package:'+package in installed:await asyncio.to_thread(adb,'uninstall',package,timeout=30)
        remember_active(None);active=None
        return {'released':True,'scope':'native_runtime_cleanup','status':'released'}
    except (RuntimeError,subprocess.TimeoutExpired,OSError):raise HTTPException(503,'Owned native runtime cleanup failed; retry after worker recovery')
    finally:device_lock.release()


def foreground(package):
    text=adb('shell','dumpsys','activity','activities',timeout=8)
    return bool(re.search(r'(?:mResumedActivity:|topResumedActivity=|ResumedActivity:).*\s'+re.escape(package)+r'/',text))


def validate_scenarios(scenarios):
    if not isinstance(scenarios,list) or len(scenarios)>20:raise ValueError('Native scenarios must be a bounded list')
    total=0
    for scenario in scenarios:
        steps=scenario.get('steps') if isinstance(scenario,dict) else None
        if not isinstance(steps,list) or not steps or any(not isinstance(s,dict) for s in steps) or steps[-1].get('action')!='assert':raise ValueError('Native scenarios require a final assertion')
        total+=len(steps)
        for step in steps:
            if step.get('action') not in {'tap','input','swipe','key','assert'}:raise ValueError('Unsupported native action')
            if step['action']=='assert' and (not isinstance(step.get('expectations'),list) or not step['expectations']):raise ValueError('Native assertions need expected outcomes')
    if total>100:raise ValueError('Too many native scenario steps')


async def action(step):
    kind=step.get('action')
    if kind=='assert':
        observation=await asyncio.to_thread(nodes)
        for expected in step['expectations']:
            target(observation,expected)
    elif kind in {'tap','input'}:
        x,y=target(await asyncio.to_thread(nodes),step['selector'])
        await asyncio.to_thread(adb,'shell','input','tap',str(x),str(y))
        if kind=='input':
            value=step.get('value','')
            if not isinstance(value,str) or len(value)>1000 or not re.fullmatch(r'[A-Za-z0-9 @._+/-]*',value):raise ValueError('This ADB input adapter supports bounded ASCII text; use an IME adapter for other characters')
            await asyncio.to_thread(adb,'shell','input','text',"'"+value.replace(' ','%s')+"'")
    elif kind=='key':
        key=step.get('key')
        if key not in {'BACK','ENTER','TAB','DEL'}:raise ValueError('Unsupported native key')
        await asyncio.to_thread(adb,'shell','input','keyevent','KEYCODE_'+key)
    elif kind=='swipe':
        coords=step.get('coordinates')
        if not isinstance(coords,list) or len(coords)!=4 or any(type(c) is not int or not 0<=c<=1280 for c in coords):raise ValueError('Invalid swipe coordinates')
        await asyncio.to_thread(adb,'shell','input','swipe',*(str(c) for c in coords),'300')
    else:raise ValueError('Unsupported native action')


@app.post('/verify')
async def verify(request:Request):
    global active
    body=await request.json()
    try:
        if not isinstance(body,dict):raise ValueError('Native request must be an object')
        deployment=str(uuid.UUID(body['deployment_id']));artifact=body['artifact']
        parts=urlsplit(body['artifact_url'])
        if parts.scheme!='http' or parts.hostname not in {'localhost','127.0.0.1','host.docker.internal'} or not parts.port or parts.username:raise ValueError('Artifact source must be an allocated local runtime')
        if not isinstance(artifact,dict) or not re.fullmatch(r'[A-Za-z0-9._-]+\.apk',artifact.get('name','')) or not re.fullmatch(r'[a-f0-9]{64}',artifact.get('sha256','')) or type(artifact.get('size')) is not int or not 0<artifact['size']<=512*1024**2:raise ValueError('An APK with a bound size and SHA-256 is required')
        scenarios=body.get('native_scenarios',[]);validate_scenarios(scenarios)
        package=body.get('app_id')
        if package and not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+',package):raise ValueError('Invalid application ID')
    except (KeyError,TypeError,ValueError):raise HTTPException(400,'Invalid native verification contract')
    try:await asyncio.wait_for(device_lock.acquire(),timeout=10)
    except asyncio.TimeoutError:return {'verified':False,'status':'unverified','scope':'native_launch','reason':'Android worker is busy'}
    try:
        if await asyncio.to_thread(adb,'shell','getprop','sys.boot_completed')!='1':raise RuntimeError('Android worker has not booted')
        directory=ROOT/deployment;directory.mkdir(parents=True,exist_ok=True);apk=directory/'application.apk'
        digest=hashlib.sha256();size=0
        local=f'http://127.0.0.1:{parts.port}/artifacts/{quote(artifact["name"])}'
        async with httpx.AsyncClient(timeout=60,follow_redirects=False,trust_env=False) as client:
            async with client.stream('GET',local) as response:
                if response.status_code!=200:raise RuntimeError('APK download failed')
                with apk.open('wb') as output:
                    async for chunk in response.aiter_bytes():
                        size+=len(chunk)
                        if size>artifact['size']:raise RuntimeError('APK exceeds declared size')
                        digest.update(chunk);output.write(chunk)
        if size!=artifact['size'] or digest.hexdigest()!=artifact['sha256']:raise RuntimeError('APK integrity check failed')
        # Only remove packages installed by this worker on its own emulator.
        remember_active(None)
        if active:
            await asyncio.to_thread(adb,'uninstall',active['package'],timeout=30)
            active=None
        before=set((await asyncio.to_thread(adb,'shell','pm','list','packages','-3')).splitlines())
        known=owned_packages()
        if package and 'package:'+package in before:
            if package not in known:raise RuntimeError('Application ID is already installed outside this worker; use a clean dedicated emulator')
            # Debug signing keys can change between isolated Gradle builds.
            # Reinstall a known owned package rather than assuming -r succeeds.
            await asyncio.to_thread(adb,'uninstall',package,timeout=30)
            before.discard('package:'+package)
        await asyncio.to_thread(adb,'install','-r','-t',str(apk),timeout=90)
        after=set((await asyncio.to_thread(adb,'shell','pm','list','packages','-3')).splitlines())
        if not package:
            added=after-before
            if len(added)!=1:raise ValueError('Declare app_id when APK package discovery is ambiguous')
            package=added.pop().removeprefix('package:')
        if 'package:'+package not in after:raise ValueError('Declared app_id does not match an installed APK')
        known.add(package)
        temporary=ROOT/'installed.pending.json';temporary.write_text(json.dumps(sorted(known)))
        os.replace(temporary,ROOT/'installed.json')
        await asyncio.to_thread(adb,'shell','pm','clear',package)
        resolved=await asyncio.to_thread(adb,'shell','cmd','package','resolve-activity','--brief','-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER',package)
        component=resolved.splitlines()[-1]
        if not component.startswith(package+'/'):raise RuntimeError('APK has no resolved launcher activity')
        await asyncio.to_thread(adb,'shell','am','start','-W','-n',component,timeout=30)
        await asyncio.to_thread(adb,'shell','input','keyevent','KEYCODE_WAKEUP')
        await asyncio.to_thread(adb,'shell','wm','dismiss-keyguard')
        deadline=time.monotonic()+15
        while not await asyncio.to_thread(foreground,package):
            if time.monotonic()>deadline:raise RuntimeError('Application did not reach the foreground')
            await asyncio.sleep(.25)
        observation=await asyncio.to_thread(nodes)
        # A cold emulator can show a system ANR dialog while services warm up.
        # Wait once, then require the real app UI; never treat the dialog as ready.
        if any(n.get('resource-id')=='android:id/aerr_wait' for n in observation):
            x,y=target(observation,{'resource_id':'android:id/aerr_wait'})
            await asyncio.to_thread(adb,'shell','input','tap',str(x),str(y))
            observation=await asyncio.to_thread(nodes)
        if not any(n.get('package')==package for n in observation):raise RuntimeError('No application UI was observed')
        active={'deployment_id':deployment,'package':package,'artifact_digest':artifact['sha256']}
        evidence=[]
        for scenario in scenarios:
            steps=[]
            for step in scenario['steps']:
                await action(step);steps.append({'action':step['action'],'status':'executed'})
            evidence.append({'name':scenario.get('name','scenario'),'status':'passed','steps':steps})
        screenshot=await asyncio.to_thread(adb,'exec-out','screencap','-p',binary=True)
        (directory/'launch.png').write_bytes(screenshot)
        proof={'verified':True,'status':'passed','scope':'native_scenarios' if evidence else 'native_launch',
               **active,'serial':SERIAL,'scenarios':evidence,'workflow_verified':bool(evidence),
               'preview_available':True,'screen_capture':'launch.png'}
        (directory/'result.json').write_text(json.dumps(proof))
        remember_active(active)
        return proof
    except Exception as exc:
        return {'verified':False,'status':'failed','scope':'native_launch','reason':str(exc) if isinstance(exc,(RuntimeError,ValueError)) else type(exc).__name__}
    finally:device_lock.release()


PREVIEW='''<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Android emulator</title>
<style>body{margin:0;background:#101416;color:#ddd;font:14px system-ui;display:grid;place-items:center}canvas{max-height:calc(100vh - 50px);max-width:100%;touch-action:none}nav{padding:10px}button{margin:0 4px;padding:5px 12px}</style>
<nav><button id="back">Back</button><span id="status">Connecting to Android…</span></nav><canvas id="screen" width="720" height="1280"></canvas>
<script>const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),status=document.querySelector('#status');
const ws=new WebSocket(location.href.replace(/^http/,'ws').replace('/preview/','/stream/'));ws.binaryType='blob';
ws.onmessage=async e=>{if(typeof e.data==='string'){status.textContent=JSON.parse(e.data).reason||'Live Android';return}const bitmap=await createImageBitmap(e.data);canvas.width=bitmap.width;canvas.height=bitmap.height;ctx.drawImage(bitmap,0,0);bitmap.close();status.textContent='Live Android · latest captured frame'};
ws.onclose=()=>status.textContent='Preview disconnected or ticket expired. Reopen preview to reconnect.';
canvas.onclick=e=>{const r=canvas.getBoundingClientRect();ws.send(JSON.stringify({action:'tap_at',x:Math.round((e.clientX-r.left)*canvas.width/r.width),y:Math.round((e.clientY-r.top)*canvas.height/r.height)}))};
document.querySelector('#back').onclick=()=>ws.send(JSON.stringify({action:'key',key:'BACK'}));</script>'''


@app.get('/preview/{deployment}')
async def preview(deployment:str,request:Request):
    if not ticket(request.query_params.get('ticket',''),deployment):raise HTTPException(401,'Preview ticket required')
    return HTMLResponse(PREVIEW,headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer'})


@app.websocket('/stream/{deployment}')
async def stream(websocket:WebSocket,deployment:str):
    claims=ticket(websocket.query_params.get('ticket',''),deployment)
    if not claims:await websocket.close(code=1008);return
    await websocket.accept()
    async def frames():
        while time.time()<claims['expires']:
            if not active or active['deployment_id']!=deployment:
                await websocket.send_json({'reason':'This deployment is not active on the Android worker'});return
            async with device_lock:
                if not active or active['deployment_id']!=deployment:return
                png=await asyncio.to_thread(adb,'exec-out','screencap','-p',binary=True)
            await websocket.send_bytes(png)
            await asyncio.sleep(.1)  # Bounded capture; do not claim a fabricated 60 FPS.
    sender=asyncio.create_task(frames())
    try:
        while not sender.done() and time.time()<claims['expires']:
            try:message=await asyncio.wait_for(websocket.receive_json(),timeout=5)
            except asyncio.TimeoutError:continue
            if not claims.get('control') or not active or active['deployment_id']!=deployment:continue
            async with device_lock:
                if message.get('action')=='tap_at':
                    x,y=message.get('x'),message.get('y')
                    if type(x) is int and type(y) is int and 0<=x<720 and 0<=y<1280:await asyncio.to_thread(adb,'shell','input','tap',str(x),str(y))
                elif message.get('action')=='key':await action(message)
    except Exception:pass
    finally:
        sender.cancel();await asyncio.gather(sender,return_exceptions=True)
        await websocket.close()


if __name__=='__main__':
    if not TOKEN:raise SystemExit('Configure STACKPILOT_AI_SERVICE_TOKEN before starting the native worker')
    if SERIAL!='emulator-5580' and os.getenv('STACKPILOT_ALLOW_CUSTOM_DEVICE')!='true':raise SystemExit('Custom devices require explicit worker configuration')
    active=recover_active()
    import uvicorn
    uvicorn.run(app,host='127.0.0.1',port=int(os.getenv('STACKPILOT_NATIVE_PORT','8077')),access_log=False)
