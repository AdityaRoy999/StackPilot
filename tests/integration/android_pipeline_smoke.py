"""Opt-in real Gradle -> APK -> emulator workflow -> authenticated preview test."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid

import release_pipeline_smoke as release


async def frame(url):
    import websockets
    websocket_url=url.replace('http://','ws://',1).replace('/preview/','/stream/')
    async with websockets.connect(websocket_url,proxy=None,open_timeout=10,max_size=4*1024**2) as socket:
        data=await asyncio.wait_for(socket.recv(),timeout=15)
        if not isinstance(data,bytes) or not data.startswith(b'\x89PNG'):raise AssertionError('Native preview did not deliver a real PNG frame')
        return data


def main(restart_worker=False,cleanup_project=False):
    run=uuid.uuid4().hex[:12];source=release.ROOT/'local-projects'/'android-qualification'/run
    shutil.copytree(release.ROOT/'tests'/'fixtures'/'deployment'/'native-android',source)
    contract={'workload':'android','app_id':'dev.stackpilot.qualification','tests_required':True,'native_preview_required':True,
        'native_scenarios':[{'name':'Submit a native form','steps':[
            {'action':'assert','expectations':[{'text':'StackPilot native APK'}]},
            {'action':'input','selector':{'description':'Recipient'},'value':'Alice'},
            {'action':'key','key':'BACK'},
            {'action':'tap','selector':{'description':'Submit'}},
            {'action':'assert','expectations':[{'text':'Hello Alice'}]}]}]}
    (source/'stackpilot.json').write_text(json.dumps(contract))
    import secrets
    release.api('POST','/auth/register',{'username':'android-'+run,'email':'android-'+run+'@example.test','password':'Fixture-'+secrets.token_hex(16)+'!aA1'})
    project=release.api('POST','/projects',{'name':'Android qualification '+run,'source_type':'local',
        'source_path':'/app/local-projects/android-qualification/'+run,'execution_mode':'local'})['project']
    deployment=release.api('POST','/projects/'+project['id']+'/deployments',{'version':'v1'})['deployment']['id']
    release.api('POST','/deployments/'+deployment+'/trigger',{})
    deadline=time.monotonic()+1200;last=None;result=None
    while time.monotonic()<deadline:
        result=release.api('GET','/deployments/'+deployment)
        if result['status']!=last:print('ANDROID_STATE '+result['status'],flush=True);last=result['status']
        if result['status']=='failed':
            logs=release.api('GET','/deployments/'+deployment+'/logs')
            raise RuntimeError('Android pipeline failed: '+str(logs)[-2500:])
        if result['status']=='running' and result.get('runtime_snapshot',{}).get('routed_verification',{}).get('verified'):break
        time.sleep(2)
    else:raise TimeoutError('Android pipeline qualification deadline exceeded')
    proof=result['runtime_snapshot']['runtime_verification'];native=proof.get('native',{})
    assert native.get('verified') and native.get('workflow_verified') and native.get('preview_available'),native
    ticket=release.api('GET','/deployments/'+deployment+'/native-preview-ticket')
    url=ticket['preview_url'];screen=asyncio.run(frame(url))
    directory=release.ROOT/'docs'/'screenshots';directory.mkdir(exist_ok=True)
    screenshot=directory/'android-workflow-qualified.png';screenshot.write_bytes(screen)
    # A ticket from another deployment must not grant access to this device.
    other=url.replace(deployment,str(uuid.uuid4()))
    try:
        urllib.request.urlopen(other,timeout=10)
    except urllib.error.HTTPError as exc:assert exc.code==401
    else:raise AssertionError('Preview accepted a ticket for another deployment')
    recovered=False
    if restart_worker:
        if os.name!='nt':raise RuntimeError('Restart qualification currently requires the owned Windows Android worker')
        subprocess.run(['powershell.exe','-NoProfile','-File',str(release.ROOT/'native-worker'/'restart.ps1')],check=True)
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            try:
                screen=asyncio.run(frame(release.api('GET','/deployments/'+deployment+'/native-preview-ticket')['preview_url']))
                break
            except (OSError,TimeoutError):time.sleep(1)
        else:raise TimeoutError('Native frame was not recovered after worker restart')
        service_key=os.getenv('STACKPILOT_AI_SERVICE_TOKEN','')
        if not service_key:
            service_key=next(line.split('=',1)[1].strip().strip('\"').strip("'") for line in (release.ROOT/'.env').read_text().splitlines() if line.startswith('STACKPILOT_AI_SERVICE_TOKEN='))
        request=urllib.request.Request('http://127.0.0.1:8077/observe/'+deployment,headers={'x-stackpilot-service-token':service_key})
        with urllib.request.urlopen(request,timeout=12) as response:observed=json.load(response)
        assert observed.get('verified') and observed.get('workflow_verified') is False,observed
        recovered=True
    cleanup=False
    if cleanup_project:
        url=release.api('GET','/deployments/'+deployment+'/native-preview-ticket')['preview_url']
        release.api('DELETE','/projects/'+project['id'],expected=(200,204))
        assert release.api('GET','/deployments/'+deployment+'/native-preview-ticket',expected=(404,)).get('error'),'Deleted deployment could obtain a preview ticket'
        # Previously issued capabilities must not keep showing an unowned device.
        try:asyncio.run(frame(url))
        except AssertionError:pass
        else:raise AssertionError('Native runtime survived project deletion')
        cleanup=True
    evidence={'verified':True,'scope':'local_android_pipeline','project_id':project['id'],'deployment_id':deployment,
        'runtime_url':result['runtime_url'],'native':native,'authenticated_png_stream':True,'wrong_deployment_ticket_rejected':True,
        'worker_restart_recovered_frame_and_fresh_foreground_observation':recovered,
        'project_deleted_and_existing_preview_revoked':cleanup,
        'screenshot':str(screenshot),'limitations':['Single local emulator','PNG latest-frame capture, not qualified 60 FPS','No production signing or store publication']}
    (release.ROOT/'docs'/'android-pipeline-qualification.json').write_text(json.dumps(evidence,indent=2))
    print('ANDROID_PIPELINE_PASS '+json.dumps(evidence),flush=True)


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--restart-worker',action='store_true');parser.add_argument('--cleanup-project',action='store_true')
    args=parser.parse_args();main(args.restart_worker,args.cleanup_project)
