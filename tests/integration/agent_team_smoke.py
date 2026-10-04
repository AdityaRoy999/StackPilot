"""Real model teammates -> scoped patches -> independent tests -> routed release.

Creates a disposable local project. It never edits an existing user's project.
Model accuracy is a measured result, not assumed by the deterministic unit tests.
"""
from stackpilot_test_artifacts import artifact_path
import asyncio
import json
from pathlib import Path
import sys
import time
import uuid


async def inside(user,project,session,model=''):
    from app.agent_runtime.runtime import TeamRuntime,public_task
    from app.agent_runtime.context import actor_context
    from app.main import AgentRequest
    from app.tools import execute_tool_call
    runtime=TeamRuntime()
    await runtime.initialize()
    actor=await runtime.attach(AgentRequest(message='Deploy the repaired fixture',user_id=user,project_id=project,
        session_id=session,model=model or None,agent_access_mode='full_access'))
    token=actor_context.set(actor)
    started=time.monotonic()
    evidence={'scope':'local_model_team_delivery','run_id':actor.run_id,'model':model or 'configured_default','cases':[]}
    async def wait_task(identity,deadline=480):
        end=time.monotonic()+deadline
        while time.monotonic()<end:
            task=await asyncio.to_thread(runtime.store.task,identity,actor.run_id)
            if task['state'] in {'failed','canceled','blocked'}:raise RuntimeError('Task could not complete: '+json.dumps(public_task(task)))
            if task['state'] not in {'queued','running'}:return task
            await asyncio.to_thread(runtime.store.fence_lead,actor.run_id,actor.owner,True)
            await asyncio.sleep(1)
        raise TimeoutError('Task did not finish: '+identity)
    try:
        first=await runtime.handle(actor,'spawn_agent',{'role':'Arithmetic defect','goal':'Repair square in a.py using the original tests/test_math.py. Change only a.py and submit your patch.',
            'completion_contract':'Run python -m unittest tests.test_math.MathTests.test_square -v. When that original regression passes, submit_agent_patch. The lead handles the combined suite.','write_scope':['a.py']})
        second=await runtime.handle(actor,'spawn_agent',{'role':'Arithmetic defect','goal':'Repair cube in b.py using the original tests/test_math.py. Change only b.py and submit your patch.',
            'completion_contract':'Run python -m unittest tests.test_math.MathTests.test_cube -v. When that original regression passes, submit_agent_patch. The lead handles the combined suite.','write_scope':['b.py']})
        tasks=await asyncio.gather(wait_task(first['agent_id']),wait_task(second['agent_id']))
        for task in tasks:
            assert task['state']=='submitted',public_task(task)
            proposal=json.loads(task['result'])['patch_id']
            integrated=await runtime.handle(actor,'integrate_agent_patch',{'patch_id':proposal})
            assert integrated['status']=='integrated',integrated
        evidence['cases'].append({'case':'real_models_repaired_distinct_files','passed':True,'agents':[task['id'] for task in tasks]})
        blocked=await execute_tool_call('workspace_trigger_rebuild',{'deployment_id':''},user)
        assert blocked.get('status')=='blocked' and not blocked.get('job_id'),blocked
        evidence['cases'].append({'case':'release_requires_independent_current_revision_tests','passed':True})
        verified=await runtime.handle(actor,'verify_agent_source',{'image':'python:3.12-slim','timeout_seconds':30})
        tested=await wait_task(verified['agent_id'])
        assert tested['state']=='completed',public_task(tested)
        report=json.loads(tested['result'])
        assert report['status']=='passed' and report['verified'] and report['commands'][0]['exit_code']==0,report
        evidence['cases'].append({'case':'independent_original_tests_passed_in_real_worker','passed':True,'revision':report['revision']})
        queued=await execute_tool_call('workspace_trigger_rebuild',{'deployment_id':''},user)
        assert queued.get('status')=='rebuild_queued' and queued.get('job_id'),queued
        result=await execute_tool_call('wait_for_deployment',{'deployment_id':queued['deployment_id'],'job_id':queued['job_id'],'timeout_seconds':300},user)
        assert result.get('verified') is True and result.get('job_status')=='completed',result
        evidence['cases'].append({'case':'first_deployment_built_accepted_revision_and_verified_routed_application','passed':True,
            'job_id':queued['job_id'],'deployment_id':queued['deployment_id'],'url':result.get('runtime_url'),'revision':report['revision']})
        events=runtime.store.events(actor.run_id,limit=500)
        assert any(event['type']=='tool_call' and event['agent_id']==first['agent_id'] for event in events)
        assert any(event['type']=='tool_result' and event['agent_id']==second['agent_id'] for event in events)
        evidence['cases'].append({'case':'individual_events_persisted_by_worker_id','passed':True,'events':len(events)})
        print('AGENT_TEAM_SMOKE_PASS '+json.dumps(evidence),flush=True)
    except BaseException as exc:
        evidence['error']=type(exc).__name__+': '+str(exc)[:2000]
        raise
    finally:
        evidence['elapsed_seconds']=round(time.monotonic()-started,2)
        events=await asyncio.to_thread(runtime.store.events,actor.run_id,0,500)
        timings=[event['elapsed_ms'] for event in events if event.get('type')=='model_timing']
        evidence['model_calls']=len(timings)
        evidence['model_latency_ms']=timings
        evidence['provider_events']=[{key:event[key] for key in ('type','agent_id','status_code','message','retry','reason') if key in event}
            for event in events if event.get('type') in {'provider_error','provider_retry'}]
        print('AGENT_TEAM_SMOKE_RESULT '+json.dumps(evidence),flush=True)
        actor_context.reset(token)
        await asyncio.to_thread(runtime.store.cancel,actor.run_id)
        await runtime.close()
    return evidence


async def inside_lead(user, project, session, model=''):
    """The real production lead chooses actions from a single user request."""
    from app.main import AgentRequest, stream_agent_reply
    from app.agent_runtime.runtime import get_runtime
    runtime = get_runtime()
    started = time.monotonic()
    evidence = {'scope':'local_single_prompt_delivery','model':model or 'configured_default',
                'prompt':'Deploy this repository.','cases':[],'trace':[]}
    run_id = None
    release = None
    error = None
    stream = stream_agent_reply(AgentRequest(message=evidence['prompt'], user_id=user,
        project_id=project, session_id=session, model=model or None, agent_access_mode='full_access'))
    try:
        async with asyncio.timeout(900):
            async for raw in stream:
                if not raw.startswith('data: '): continue
                event = json.loads(raw[6:])
                if event.get('type')=='agent_run' and event.get('run_id'):
                    run_id = event['run_id']
                    evidence['run_id'] = run_id
                if event.get('type')=='tool_call':
                    name = event.get('name')
                    evidence['trace'].append({'agent_id':event.get('agent_id','lead'),'tool':name})
                    print('LEAD_TOOL '+str(event.get('agent_id','lead'))+' '+str(name),flush=True)
                elif event.get('type')=='tool_result':
                    value=event.get('result') or {}
                    if isinstance(value,str):
                        try:value=json.loads(value)
                        except json.JSONDecodeError:value={}
                    if not isinstance(value,dict):value={}
                    evidence['trace'].append({'agent_id':event.get('agent_id','lead'),
                        'tool_result':event.get('name'),'status':value.get('status'),
                        'error':str(value.get('error',''))[:500],'verified':value.get('verified'),
                        'job_status':value.get('job_status')})
                    if event.get('name')=='wait_for_deployment' and value.get('verified') is True and value.get('job_status')=='completed':
                        release=value
                elif event.get('type') in {'error','ask_user','approval_required','agent_question','permission_request'}:
                    error=str(event.get('error') or event.get('message') or event.get('question') or event.get('type'))[:1000]
                    evidence['trace'].append({'event':event['type'],'tool':event.get('tool_name'),'error':error})
                elif event.get('type')=='done':
                    evidence['final_status']=event.get('status')
                    evidence['final_content']=str(event.get('content') or '')[:3000]
                elif event.get('type') in {'provider_error','provider_retry'}:
                    evidence['trace'].append({key:event[key] for key in ('type','status_code','message','retry','reason') if key in event})
        if not run_id:raise AssertionError('Lead did not attach an authorized repository run')
        run=await asyncio.to_thread(runtime.store.run,run_id,user)
        tasks=await asyncio.to_thread(runtime.store.tasks,run_id)
        evidence['tasks']=[{'id':task['id'],'role':task['role'],'state':task['state']} for task in tasks]
        if not release:raise AssertionError('Lead did not verify the exact deployed job: '+str(error))
        evidence['cases'].append({'case':'single_request_repaired_tested_and_released_repository','passed':True,
            'revision':run['effective_revision'],'deployment_id':release.get('deployment_id'),
            'job_id':release.get('job_id'),'url':release.get('runtime_url')})
        evidence['passed']=True
        print('AGENT_TEAM_SMOKE_PASS '+json.dumps(evidence),flush=True)
    except BaseException as exc:
        evidence['passed']=False
        evidence['error']=type(exc).__name__+': '+str(exc)[:1500]
        raise
    finally:
        await stream.aclose()
        evidence['elapsed_seconds']=round(time.monotonic()-started,2)
        if run_id:
            events=await asyncio.to_thread(runtime.store.events,run_id,0,1000)
            evidence['events']=len(events)
            evidence['lead_model_turns']=sum(event.get('type')=='model_turn' and event.get('agent_id')=='lead' for event in events)
            evidence['lead_model_latency_ms']=[event['elapsed_ms'] for event in events if event.get('type')=='model_timing' and event.get('agent_id')=='lead']
            evidence['worker_model_latency_ms']=[event['elapsed_ms'] for event in events if event.get('type')=='model_timing' and event.get('agent_id')!='lead']
            await asyncio.to_thread(runtime.store.cancel,run_id)
        await runtime.close()
        print('AGENT_TEAM_SMOKE_RESULT '+json.dumps(evidence),flush=True)
    return evidence


def host():
    import secrets
    import subprocess
    from release_pipeline_smoke import api,ROOT,cookies
    deadline=time.monotonic()+90
    while True:
        try:
            api('GET','/health');break
        except Exception:
            if time.monotonic()>=deadline:raise
            time.sleep(1)
    name=uuid.uuid4().hex[:12]
    source=ROOT/'local-projects/agent-team-qualification'/name
    source.mkdir(parents=True)
    (source/'tests').mkdir()
    (source/'a.py').write_text('def square(n):\n    return n + n\n')
    (source/'b.py').write_text('def cube(n):\n    return n ** 2\n')
    (source/'tests/test_math.py').write_text('import unittest\nfrom a import square\nfrom b import cube\nclass MathTests(unittest.TestCase):\n    def test_square(self):\n        for n in [0, 1, 3, -4]: self.assertEqual(square(n), n*n)\n    def test_cube(self):\n        for n in [0, 1, 3, -4]: self.assertEqual(cube(n), n*n*n)\n')
    (source/'server.py').write_text('from http.server import HTTPServer,BaseHTTPRequestHandler\nfrom a import square\nfrom b import cube\nclass Handler(BaseHTTPRequestHandler):\n    def do_GET(self):\n        body=f"<html><title>Agent Team Qualification</title><main id=\'result\'>square(3)={square(3)} cube(3)={cube(3)}</main></html>".encode()\n        self.send_response(200)\n        self.send_header("Content-Type","text/html")\n        self.end_headers()\n        self.wfile.write(body)\nHTTPServer(("0.0.0.0",3000),Handler).serve_forever()\n')
    (source/'stackpilot.json').write_text(json.dumps({'version':1,'workload':'web','port':3000,'tests_required':True,
        'tests':[['python','-m','unittest','discover','-s','tests','-v']],
        'browser_checks':[{'kind':'text','selector':'#result','expected':'square(3)=9 cube(3)=27'}]}))
    (source/'Dockerfile').write_text('FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN python .stackpilot-runtime/repository_tests.py\nEXPOSE 3000\nUSER 65534:65534\nCMD ["python","server.py"]\n')
    (source/'stackpilot.completion.json').write_text(json.dumps({'version':1,'summary':'Repair square and cube without replacing the web application','workload':'web','features':[
        {'id':'square','description':'Square signed integers','checks':[{'argv':['python','-c','from a import square; assert all(square(n)==n*n for n in [0,1,3,-4])']}]},
        {'id':'cube','description':'Cube signed integers','checks':[{'argv':['python','-c','from b import cube; assert all(cube(n)==n*n*n for n in [0,1,3,-4])']}]}]}))
    user=api('POST','/auth/register',{'username':'agent-'+name,'email':'agent-'+name+'@example.test','password':'Fixture-'+secrets.token_hex(16)+'!aA1'})
    # The authenticated profile is the authoritative identity (registration
    # response shapes differ across frontend/backends).
    profile=api('GET','/auth/me')
    identity=(profile.get('user') or profile)['id']
    project=api('POST','/projects',{'name':'Agent team qualification '+name,'source_type':'local',
        'source_path':'/app/local-projects/agent-team-qualification/'+name,'execution_mode':'local','remote_runtime_type':'docker'})['project']
    try:
        subprocess.run(['docker','cp',str(Path(__file__)), 'stackpilot-ai-service:/tmp/agent_team_smoke.py'],check=True)
        lead='--lead' in sys.argv[1:]
        models=[arg for arg in sys.argv[1:] if arg!='--lead']
        command=['docker','exec','-e','PYTHONPATH=/app','stackpilot-ai-service','python','/tmp/agent_team_smoke.py',
            'inside-lead' if lead else 'inside',identity,project['id'],name]
        if models:command.append(models[0])
        result=subprocess.run(command,capture_output=True,text=True,timeout=1500)
        print(result.stdout,flush=True)
        line=next((line for line in result.stdout.splitlines() if line.startswith('AGENT_TEAM_SMOKE_RESULT ')),None)
        if line:
            evidence=json.loads(line.split(' ',1)[1]);evidence['passed']=result.returncode==0
            label=(models[0] if models else 'default').replace('/','-')
            (artifact_path('agent-' + ('lead' if lead else 'team') + '-model-' + label + '-qualification.json')).write_text(json.dumps(evidence,indent=2))
        if result.returncode:
            print(result.stderr,flush=True)
            raise RuntimeError('Real model team qualification failed')
        observed=api('POST','/ai/tools/execute',{'tool_name':'agent_run_status','arguments':{'run_id':evidence['run_id']}})
        assert observed.get('run_id')==evidence['run_id'] and len(observed.get('events',[]))>2,observed
        sequences=[event['sequence'] for event in observed['events']]
        assert sequences==sorted(set(sequences))
        evidence['cases'].append({'case':'authenticated_owner_can_replay_ordered_run_events','passed':True})
        saved_cookies=list(cookies)
        try:
            api('POST','/auth/register',{'username':'outsider-'+name,'email':'outsider-'+name+'@example.test','password':'Fixture-'+secrets.token_hex(16)+'!aA1'})
            denied=api('POST','/ai/tools/execute',{'tool_name':'agent_run_status','arguments':{'run_id':evidence['run_id']}},expected=(200,403))
            assert denied.get('error') and not denied.get('tasks'),denied
            evidence['cases'].append({'case':'other_tenant_cannot_read_agent_run','passed':True})
        finally:
            cookies.clear()
            for cookie in saved_cookies:cookies.set_cookie(cookie)
        (artifact_path('agent-' + ('lead' if lead else 'team') + '-model-qualification.json')).write_text(json.dumps(evidence,indent=2))
        (artifact_path('agent-' + ('lead' if lead else 'team') + '-model-' + label + '-qualification.json')).write_text(json.dumps(evidence,indent=2))
    finally:
        api('DELETE','/projects/'+project['id'],expected=(200,204))


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='inside-lead':asyncio.run(inside_lead(*sys.argv[2:]))
    elif len(sys.argv)>1 and sys.argv[1]=='inside':asyncio.run(inside(*sys.argv[2:]))
    else:host()
