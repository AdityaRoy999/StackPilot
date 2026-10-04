"""Live JWT/run ownership, event replay and cancellation. No model calls."""
from stackpilot_test_artifacts import artifact_path
import json
import secrets
import subprocess
import uuid

from release_pipeline_smoke import api, ROOT, cookies


def main():
    name=uuid.uuid4().hex[:12]
    source=ROOT/'local-projects/agent-access-qualification'/name
    source.mkdir(parents=True)
    (source/'index.html').write_text('<h1>Disposable access fixture</h1>')
    api('POST','/auth/register',{'username':'agent-access-'+name,'email':'agent-access-'+name+'@example.test',
        'password':'Fixture-'+secrets.token_hex(16)+'!aA1'})
    profile=api('GET','/auth/me');owner=(profile.get('user') or profile)['id']
    project=api('POST','/projects',{'name':'Agent access qualification '+name,'source_type':'local',
        'source_path':'/app/local-projects/agent-access-qualification/'+name,'execution_mode':'local','remote_runtime_type':'docker'})['project']
    run=None
    saved=list(cookies)
    try:
        script='''import asyncio,sys,json
from app.agent_runtime.runtime import TeamRuntime
from app.main import AgentRequest
async def execute():
 r=TeamRuntime()
 a=await r.attach(AgentRequest(message="Inspect repository",user_id=sys.argv[1],project_id=sys.argv[2],session_id=sys.argv[3]))
 await r.emit(a,{"type":"agent_run","state":"working"})
 await asyncio.to_thread(r.store.release_lead,a.run_id,a.owner)
 print(json.dumps({"run_id":a.run_id}))
 await r.close()
asyncio.run(execute())'''
        response=subprocess.run(['docker','exec','-e','PYTHONPATH=/app','stackpilot-ai-service','python','-c',script,owner,project['id'],name],capture_output=True,text=True,check=True)
        run=json.loads(response.stdout)['run_id']
        observed=api('POST','/ai/tools/execute',{'tool_name':'agent_run_status','arguments':{'run_id':run}})
        assert observed['run_id']==run and observed['events'][0]['sequence']==1,observed
        internal=api('POST','/ai/tools/execute',{'tool_name':'_internal_agent_workspace','arguments':{'project_id':project['id']}},expected=(200,403))
        assert internal.get('error') and not internal.get('source_root'),internal
        api('POST','/auth/register',{'username':'agent-outsider-'+name,'email':'agent-outsider-'+name+'@example.test',
            'password':'Fixture-'+secrets.token_hex(16)+'!aA1'})
        denied=api('POST','/ai/tools/execute',{'tool_name':'agent_run_status','arguments':{'run_id':run}},expected=(200,403))
        assert denied.get('error') and not denied.get('events'),denied
        forged=api('POST','/ai/tools/execute',{'tool_name':'agent_cancel_run','user_id':owner,'arguments':{'run_id':run}},expected=(200,403))
        assert forged.get('error') and forged.get('state')!='canceled',forged
        cookies.clear()
        for cookie in saved:cookies.set_cookie(cookie)
        canceled=api('POST','/ai/tools/execute',{'tool_name':'agent_cancel_run','arguments':{'run_id':run}})
        assert canceled['state']=='canceled',canceled
        evidence={'scope':'local_jwt_agent_access','passed':True,'cases':[
            'Owner reads persisted ordered events','Public JWT cannot call internal source broker',
            'Other tenant cannot read events','Body user_id cannot authorize another tenant cancellation','Owner can cancel run']}
        (artifact_path('agent-team-access-qualification.json')).write_text(json.dumps(evidence,indent=2))
        print(json.dumps(evidence))
    finally:
        cookies.clear()
        for cookie in saved:cookies.set_cookie(cookie)
        if run:api('POST','/ai/tools/execute',{'tool_name':'agent_cancel_run','arguments':{'run_id':run}})
        api('DELETE','/projects/'+project['id'],expected=(200,204))


if __name__=='__main__':main()
