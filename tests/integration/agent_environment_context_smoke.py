"""Disposable local qualification; no deployments or model calls are started."""
import json
import secrets
import subprocess
import uuid

import release_pipeline_smoke as release


def sql(statement):
    return subprocess.run(['docker','exec','-i','stackpilot-postgres','sh','-c',
        'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'],
        input=statement,check=True,capture_output=True,text=True).stdout.strip()


def tool(name,arguments,user):
    code='''import json,os,sys,urllib.request
body=json.load(sys.stdin)
request=urllib.request.Request('http://backend:8090/api/v1/ai/tools/execute',
 data=json.dumps(body).encode(),headers={'Content-Type':'application/json',
 'X-StackPilot-Service-Token':os.environ['STACKPILOT_AI_SERVICE_TOKEN']})
with urllib.request.urlopen(request,timeout=45) as response:print(response.read().decode())
'''
    response=subprocess.run(['docker','exec','-i','stackpilot-ai-service','python','-c',code],
        input=json.dumps({'tool_name':name,'arguments':arguments,'user_id':user}),
        check=True,capture_output=True,text=True)
    return json.loads(response.stdout)


def main():
    identity=None;project_id=None
    deployments={}
    fixture='environment-context-'+uuid.uuid4().hex[:12]
    private='private-fixture-'+secrets.token_hex(16)
    try:
        release.api('POST','/auth/register',{'username':fixture,'email':fixture+'@example.test',
            'password':'Fixture-'+secrets.token_hex(16)+'!aA1'})
        identity=str(uuid.UUID(release.api('GET','/auth/me')['user']['id']))
        project=release.api('POST','/projects',{'name':fixture,'source_type':'application',
            'application_template_id':'postgres','application_config':{'password':private,'database':'fixture','username':'postgres'},
            'env_vars':[{'key':'CONNECTION_URL','value':'project-'+private}],
            'environments':[
                {'name':'development','branch':'develop','require_ci':False,'auto_deploy':False,
                 'env_vars':[{'key':'CONNECTION_URL','value':'postgresql://user:'+private+'@postgres:5432/fixture'}]},
                {'name':'production','branch':'main','require_ci':False,'auto_deploy':False,
                 'env_vars':[{'key':'CONNECTION_URL','value':'production-'+private}]}]})['project']
        project_id=str(uuid.UUID(project['id']))
        environments=json.loads(sql("SELECT json_agg(json_build_object('id',id,'name',name)) FROM project_environments WHERE project_id='"+project_id+"';"))
        env={item['name']:str(uuid.UUID(item['id'])) for item in environments}
        release.api('POST','/projects/'+project_id+'/secrets',{'key':'CREDENTIAL_URL','value':'http://localhost:8090/private-'+private})
        release.api('POST','/projects/'+project_id+'/secrets',{'key':'CREDENTIAL_URL','value':'scoped-'+private,'environment_id':env['production']})
        deployments={name:str(uuid.uuid4()) for name in env}
        for name,dep in deployments.items():
            branch='main' if name=='production' else 'develop'
            sql("INSERT INTO deployments(id,project_id,environment_id,branch,commit_sha,status) VALUES('"+dep+"','"+project_id+"','"+env[name]+"','"+branch+"','"+'a'*40+"','pending');")
            # The source broker requires an existing source snapshot. This is an
            # inert test-owned file tree, not a build or running deployment.
            code='''import os,sys,uuid
from pathlib import Path
root=Path(os.getenv('BUILD_WORKSPACE_DIR','uploads/builds')).resolve()
target=root/str(uuid.UUID(sys.argv[1]))/'source'
assert target.resolve().is_relative_to(root)
target.mkdir(parents=True,exist_ok=True)
(target/'fixture.txt').write_text('inert environment-context fixture')
'''
            subprocess.run(['docker','exec','stackpilot-backend','python3','-c',code,dep],check=True,capture_output=True)
            arguments={'project_id':project_id,'deployment_id':dep}
            context=tool('_internal_agent_workspace',arguments,identity)
            assert 'error' not in context,context.get('error')
            context=context['project_context']
            assert private not in json.dumps(context),'Private values entered broker context'
            assert context['deployment']['branch']==branch
            assert context['deployment']['environment_id']==env[name]
            assert set(context['configured_branches'])=={'main','develop'}
            keys={item['key']:item for item in context['effective_env_keys']}
            assert keys['CONNECTION_URL']['scope']=='environment'
            assert keys['CONNECTION_URL']['environment_id']==env[name]
            assert keys['CREDENTIAL_URL']['scope']=='credential'
            assert keys['CREDENTIAL_URL']['environment_id']==(env[name] if name=='production' else '')
            for key,expected in [('CONNECTION_URL','unsupported_connection_format' if name=='production' else 'requires_runtime_probe'),
                                 ('CREDENTIAL_URL','unsupported_connection_format' if name=='production' else 'requires_runtime_probe')]:
                result=tool('_internal_agent_service_check',{**arguments,'key':key},identity)
                assert private not in json.dumps(result),'Private values entered connection result'
                assert result.get('status')==expected,(name,key,result)
                assert result['values_visible'] is False and result['verified'] is False
        # Exact IDs test cross-project and cross-user access without another account.
        other_user=sql("SELECT id FROM users WHERE id<>'"+identity+"' LIMIT 1;")
        if other_user:
            result=tool('_internal_agent_service_check',{'project_id':project_id,'deployment_id':deployments['production'],'key':'CONNECTION_URL'},str(uuid.UUID(other_user)))
            assert 'error' in result and private not in json.dumps(result)
        result=tool('_internal_agent_service_check',{'project_id':project_id,'deployment_id':str(uuid.uuid4()),'key':'CONNECTION_URL'},identity)
        assert 'error' in result and private not in json.dumps(result)
        print('AGENT_ENVIRONMENT_CONTEXT_PASS: key-only metadata, exact environment/branch, variable and credential precedence, private probe results, access controls')
    finally:
        if project_id:release.api('DELETE','/projects/'+project_id,expected=(200,204,404))
        for dep in deployments.values():
            code='''import os,sys,uuid,shutil
from pathlib import Path
root=Path(os.getenv('BUILD_WORKSPACE_DIR','uploads/builds')).resolve()
target=root/str(uuid.UUID(sys.argv[1]))
assert target.resolve().is_relative_to(root) and target!=root
if target.exists():shutil.rmtree(target)
'''
            subprocess.run(['docker','exec','stackpilot-backend','python3','-c',code,dep],check=True,capture_output=True)
        if identity:
            sql("DELETE FROM organizations WHERE is_personal AND id IN (SELECT organization_id FROM organization_members WHERE user_id='"+identity+"' AND role='owner'); DELETE FROM users WHERE id='"+identity+"';")


if __name__=='__main__':main()
