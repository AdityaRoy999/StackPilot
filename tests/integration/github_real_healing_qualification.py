"""Real provider recovery on a pinned repo with one injected delivery fault."""
import json
import os
import secrets
import shutil
import subprocess
import time
import uuid
import github_category_qualification as github
import release_pipeline_smoke as release
from stackpilot_test_artifacts import artifact_path


def main():
    run=uuid.uuid4().hex[:10];name='github-qa-'+run;repo='cyb3rr31a/python-calculator';sha,branch=github.revision(repo)
    release.api('POST','/auth/register',{'username':name,'email':name+'@example.test','password':'Fixture-'+secrets.token_hex(16)+'!aA1'})
    user=release.api('GET','/auth/me')['user']['id']
    settings={'enabled':True,'agent_access_mode':'full_access'}
    if os.getenv('STACKPILOT_HEALING_MODEL'):settings['model']=os.environ['STACKPILOT_HEALING_MODEL']
    prefs=release.api('PUT','/ai/settings',settings)
    source=release.ROOT/'local-projects/github-healing'/run
    shutil.copytree(github.SOURCE/repo.replace('/','--'),source,ignore=shutil.ignore_patterns('.git'))
    contract={'workload':'desktop','desktop_framework':'python-gui','entrypoint':['python','-u','missing.py']}
    (source/'stackpilot.json').write_text(json.dumps(contract))
    project=release.api('POST','/projects',{'name':'Real provider delivery recovery '+run,'source_type':'local','source_path':'/app/local-projects/github-healing/'+run,'execution_mode':'local','environments':[{'name':'production','branch':branch,'auto_deploy':False,'require_ci':False}]})['project']
    private='qa-private-'+secrets.token_hex(16)
    release.api('POST','/projects/'+project['id']+'/secrets',{'key':'QA_PRIVATE_CONTEXT','value':private})
    deployment=release.api('POST','/projects/'+project['id']+'/deployments',{'version':'healing-'+sha[:10],'branch':branch,'commit_sha':sha})['deployment']
    item={'run':run,'identity_prefix':'github-qa-','user_id':user,'category':'real-ai-healing','repository':'https://github.com/'+repo,'commit':sha,'branch':branch,'project_id':project['id'],'deployment_id':deployment['id'],'ai_enabled':True,'fault':'Only stackpilot.json entrypoint points to missing.py; application source unchanged','started_at':time.time(),'outcome':'queued'}
    output=artifact_path('github-real-healing.json');
    if output.exists():
        old=json.loads(output.read_text());artifact_path('github-real-healing-'+old['run']+'.json').write_text(json.dumps(old,indent=2))
    duration=max(60,min(2700,int(os.getenv('STACKPILOT_HEALING_TIMEOUT_SECONDS','2700'))))
    release.api('POST','/deployments/'+deployment['id']+'/trigger',{});last='';deadline=time.monotonic()+duration
    while time.monotonic()<deadline:
        result=release.api('GET','/deployments/'+deployment['id'])
        query="SELECT COALESCE(json_agg(json_build_object('status',status,'attempts',attempts,'session_id',session_id,'last_error',last_error)),'[]') FROM deployment_incidents WHERE deployment_id='"+str(uuid.UUID(deployment['id']))+"';"
        rows=subprocess.run(['docker','exec','-i','stackpilot-postgres','sh','-c','psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'],input=query,capture_output=True,text=True,encoding='utf-8',check=True,timeout=15).stdout
        item['incidents']=json.loads(rows);item['platform_status']=result['status']
        state=result['status']+' / '+','.join(i['status'] for i in item['incidents'])
        if state!=last:print('REAL_HEAL_STATE '+state,flush=True);last=state
        if (result.get('runtime_snapshot') or {}).get('routed_verification',{}).get('verified') and any(i['status']=='healed' for i in item['incidents']):
            github.finish_case(item,result);item['outcome']='healed';break
        if item['incidents'] and all(i['status'] in {'failed','blocked','canceled'} for i in item['incidents']):item['outcome']='recovery_failed';break
        output.write_text(json.dumps(item,indent=2));time.sleep(5)
    else:item['outcome']='timed_out'
    # Inspect fixture-only message storage. Never print/export prompts containing
    # credentials; record only whether the private marker stayed out of context.
    query="SELECT COALESCE(string_agg(m.content||m.metadata::text,' '),'') FROM ai_messages m JOIN ai_sessions s ON s.id=m.session_id WHERE s.user_id='"+str(uuid.UUID(user))+"';"
    messages=subprocess.run(['docker','exec','-i','stackpilot-postgres','sh','-c','psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'],input=query,capture_output=True,text=True,encoding='utf-8',check=True,timeout=15).stdout
    assert private not in messages,'Private environment value appeared in model conversation'
    item['private_value_absent_from_conversation']=True
    output.write_text(json.dumps(item,indent=2));print('REAL_HEAL_RESULT '+item['outcome'],flush=True)

if __name__=='__main__':main()
