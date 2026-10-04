"""Live SDK broker, task lease, scoped digest execution and terminal cleanup.

Creates only a disposable account/project and controlled non-model task rows.
Uses the production SDK/command tools, backend and real lease HTTP endpoint.
"""
from stackpilot_test_artifacts import artifact_path
import asyncio
import contextlib
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
import uuid


async def inside(user,project,session):
    from app.agent_runtime.context import Actor
    from app.agent_runtime.runtime import TeamRuntime
    from app.main import AgentRequest
    runtime=TeamRuntime();runtime.store.initialize()
    runs=[];heartbeats=[];image=None
    evidence={'scope':'live_sdk_broker_and_real_docker_lease','model_calls':0,'cases':[],'passed':False}
    async def actor_for(identity):
        lead=await runtime.attach(AgentRequest(message='Qualify an owned Linux SDK command without changing application source',
            user_id=user,project_id=project,session_id=identity,agent_access_mode='full_access'))
        runs.append(lead.run_id)
        task_id=str(uuid.uuid4());owner='sdk-qa-'+uuid.uuid4().hex;now=time.time()
        with runtime.store.transaction() as tx:
            tx.execute('INSERT INTO agent_tasks(id,run_id,parent_id,role,goal,spec,state,attempt,lease_owner,lease_until,created_at,updated_at) '
                'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (task_id,lead.run_id,'lead','Controlled SDK qualification','Execute only the explicit fixture SDK calls',
                 json.dumps({'write_scope':[]}), 'running',1,owner,now+120,now,now))
        actor=Actor(runtime,lead.run_id,task_id,user,1,owner)
        await asyncio.to_thread(runtime.allocate_task,actor)
        async def heartbeat():
            while True:
                await asyncio.sleep(10)
                await asyncio.to_thread(runtime.store.fence,task_id,owner,1,None,True)
        heartbeats.append(asyncio.create_task(heartbeat()))
        return actor
    try:
        actor=await actor_for(session)
        settings=json.loads(runtime.store.run(actor.run_id)['settings'])
        settings['sdk_cleanup']={'next_at':time.time()+3600,'completed':False}
        with runtime.store.transaction() as tx:tx.execute('UPDATE agent_runs SET settings=%s WHERE id=%s',(json.dumps(settings),actor.run_id))
        build=await runtime.handle(actor,'build_worker_image',{'dockerfile':'Dockerfile','network':False,'timeout_seconds':120})
        assert build.get('status')=='completed' and build.get('verified') is False,build
        image=build['image_id'];assert build['labels']['stackpilot.agent-run']==actor.run_id,build
        evidence['image_id']=image;evidence['run_id']=actor.run_id;evidence['labels']=build['labels']
        evidence['cases'].append('Real task lease authorized source-only SDK build and observed immutable owned digest')
        result=await runtime.handle(actor,'run_worker_command',{'image':image,'argv':['sdk-only'],'network':False,'timeout_seconds':30})
        assert result.get('status')=='completed' and result.get('exit_code')==0 and result.get('output','').strip()=='42',result
        assert result.get('image_id')==image and result.get('verified') is False and result.get('changed_paths')==[],result
        evidence['command']={key:result.get(key) for key in ('status','exit_code','output','image_id','verified','scope')}
        evidence['cases'].append('Actual scoped SDK command returned42 with no host/socket/platform environment and no source changes')
        foreign=await actor_for(str(uuid.uuid4()))
        rejected=await runtime.handle(foreign,'run_worker_command',{'image':image,'argv':['sdk-only'],'network':False,'timeout_seconds':30})
        assert rejected.get('status')=='blocked' and rejected.get('scope')=='sandbox_admission',rejected
        evidence['foreign_task_id']=foreign.agent_id
        evidence['cases'].append('Same digest rejected for a different live run before worker creation')
        runtime.store.cancel(actor.run_id,actor.agent_id)
        try:
            await runtime.broker('_internal_agent_process',{'run_id':actor.run_id,'task_id':actor.agent_id,
                'lease_owner':actor.owner,'attempt':1,'image':image,'argv':['sdk-only']},user)
        except RuntimeError as error:assert 'revoked' in str(error).lower(),str(error)
        else:raise AssertionError('Revoked task entered the Docker worker broker')
        evidence['cases'].append('Backend independently rejected revoked task lease')
        try:await runtime.broker('_internal_agent_image_cleanup',{'run_id':actor.run_id},user)
        except RuntimeError as error:assert 'terminal' in str(error).lower(),str(error)
        else:raise AssertionError('Working run allowed SDK cleanup')
        evidence['cases'].append('Working run cannot invoke terminal SDK cleanup')
        runtime.store.cancel(actor.run_id)
        cleaned=await runtime.broker('_internal_agent_image_cleanup',{'run_id':actor.run_id},user)
        assert cleaned.get('status')=='completed' and image in cleaned.get('removed',[]) and not cleaned.get('retained'),cleaned
        evidence['cleanup']=cleaned;evidence['cases'].append('Canceled owned run released unused SDK image through the gated broker')
        evidence['passed']=True
    except Exception as error:
        evidence['error']=type(error).__name__+': '+str(error)
    finally:
        for task in heartbeats:task.cancel()
        await asyncio.gather(*heartbeats,return_exceptions=True)
        for run in runs:
            with contextlib.suppress(Exception):runtime.store.cancel(run)
            with contextlib.suppress(Exception):await runtime.broker('_internal_agent_image_cleanup',{'run_id':run},user)
        await runtime.close()
        print('SDK_BROKER_RESULT '+json.dumps(evidence),flush=True)


def main():
    from release_pipeline_smoke import api,ROOT
    name=uuid.uuid4().hex[:12];base=(ROOT/'local-projects/sdk-broker-qualification').resolve();source=base/name
    assert source.parent==base and source!=base
    source.mkdir(parents=True);user=project=None
    remote='/tmp/agent_sdk_broker_smoke_'+name+'.py'
    try:
        (source/'README.md').write_text('Disposable SDK broker qualification. No model calls or deployment promotion.\n')
        (source/'sdk-only').write_text('#!/bin/sh\nexec python -c "import os,pathlib; assert os.getenv(\'STACKPILOT_AI_SERVICE_TOKEN\') is None; assert not pathlib.Path(\'/var/run/docker.sock\').exists(); print(6*7)"\n',newline='\n')
        (source/'probe.py').write_text('import os,pathlib\nassert os.getenv("STACKPILOT_AI_SERVICE_TOKEN") is None\nassert not pathlib.Path("/var/run/docker.sock").exists()\nassert not pathlib.Path("/opt/sdk-source/.git").exists()\nprint("SDK inputs isolated")\n')
        (source/'Dockerfile').write_text('FROM python:3.12-slim\nCOPY . /opt/sdk-source\nCOPY sdk-only /usr/local/bin/sdk-only\nRUN chmod +x /usr/local/bin/sdk-only && python /opt/sdk-source/probe.py\n')
        api('POST','/auth/register',{'username':'sdk-'+name,'email':'sdk-'+name+'@example.test','password':'Fixture-'+secrets.token_hex(16)+'!aA1'})
        profile=api('GET','/auth/me');user=(profile.get('user') or profile)['id']
        project=api('POST','/projects',{'name':'SDK broker qualification '+name,'source_type':'local',
            'source_path':'/app/local-projects/sdk-broker-qualification/'+name,'execution_mode':'local','remote_runtime_type':'docker'})['project']['id']
        subprocess.run(['docker','cp',str(Path(__file__)), 'stackpilot-ai-service:'+remote],check=True,capture_output=True)
        result=subprocess.run(['docker','exec','-e','PYTHONPATH=/app','stackpilot-ai-service','python',remote,'inside',user,project,str(uuid.uuid4())],
            capture_output=True,text=True,timeout=360)
        line=next((line for line in result.stdout.splitlines() if line.startswith('SDK_BROKER_RESULT ')),None)
        if not line:raise RuntimeError('Live SDK qualification returned no evidence: '+result.stderr[-3000:])
        evidence=json.loads(line.split(' ',1)[1])
        if evidence.get('foreign_task_id'):
            leaked=subprocess.check_output(['docker','ps','-aq','--filter','label=stackpilot.agent-task='+evidence['foreign_task_id']],text=True).strip()
            assert not leaked,'Foreign-run SDK worker was created'
        if evidence.get('passed'):
            gone=subprocess.run(['docker','image','inspect',evidence['image_id']],capture_output=True,timeout=20)
            assert gone.returncode!=0,'Canceled SDK image remains after successful cleanup'
        (artifact_path('agent-sdk-broker-qualification-2026-10-01.json')).write_text(json.dumps(evidence,indent=2)+'\n')
        print(json.dumps(evidence,indent=2))
        if result.returncode or not evidence['passed']:raise RuntimeError('Live SDK broker qualification failed')
    finally:
        if project:api('DELETE','/projects/'+project,expected=(200,204))
        if user:
            uuid.UUID(user)
            query="SELECT id FROM agent_runs WHERE user_id='"+user+"';"
            rows=subprocess.check_output(['docker','exec','stackpilot-postgres','sh','-c','exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"','probe',query],text=True).splitlines()
            for run in rows:
                uuid.UUID(run)
                code='import os,shutil,sys;from pathlib import Path;root=Path(os.getenv("STACKPILOT_AGENT_WORKSPACE_ROOT","/app/agent-workspaces")).resolve();target=(root/sys.argv[1]).resolve();assert target.parent==root and target!=root;shutil.rmtree(target) if target.exists() else None'
                subprocess.run(['docker','exec','stackpilot-ai-service','python','-c',code,run],check=True,capture_output=True)
            query="DELETE FROM agent_runs WHERE user_id='"+user+"'; DELETE FROM users WHERE id='"+user+"' AND email='sdk-"+name+"@example.test';"
            subprocess.run(['docker','exec','stackpilot-postgres','sh','-c','exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"','cleanup',query],check=True,capture_output=True)
        subprocess.run(['docker','exec','stackpilot-ai-service','python','-c','import pathlib,sys; p=pathlib.Path(sys.argv[1]); assert p.parent==pathlib.Path("/tmp") and p.name.startswith("agent_sdk_broker_smoke_"); p.unlink(missing_ok=True)',remote],capture_output=True)
        if source.exists():shutil.rmtree(source)


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='inside':asyncio.run(inside(*sys.argv[2:5]))
    else:main()
