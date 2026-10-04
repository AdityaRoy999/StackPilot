"""Opt-in local release qualification. Creates only disposable fixture resources.

Run from the repository root against the local stack. No model/provider calls.
"""
from stackpilot_test_artifacts import artifact_path
import http.cookiejar
import json
from pathlib import Path
import secrets
import subprocess
from urllib.parse import urlsplit, unquote
import time
import urllib.error
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parents[2]
BASE='http://127.0.0.1:8090/api/v1'
cookies=http.cookiejar.CookieJar()
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies),urllib.request.ProxyHandler({}))


def api(method,path,body=None,expected=(200,201,202)):
    headers={'Content-Type':'application/json','Origin':'http://localhost:3000','X-stackpilot-CSRF':'1'}
    # A public HTTPS configuration intentionally issues Secure cookies. The
    # local qualification uses the equivalent returned credential as a bearer.
    token=next((unquote(c.value) for c in cookies if c.name=='token'),None)
    if token:headers['Authorization']='Bearer '+token
    request=urllib.request.Request(BASE+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers=headers)
    try:
        with opener.open(request,timeout=240) as response:
            status=response.status;raw=response.read();value=json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:status=exc.code;value=json.load(exc)
    if status not in expected:raise RuntimeError(f'{method} {path}: HTTP {status}: '+str(value.get('error','request failed')))
    return value


def wait(identity,success=True):
    deadline=time.monotonic()+300;last=''
    while time.monotonic()<deadline:
        result=api('GET','/deployments/'+identity)
        state=result['status']
        if state!=last:print('RELEASE_STATE '+identity[:8]+' '+state,flush=True);last=state
        if state=='failed':
            if success:
                logs=api('GET','/deployments/'+identity+'/logs')['deployment']['logs']
                raise RuntimeError('Release failed: '+logs[-5000:])
            return result
        if state in {'running','ready'}:
            # Job completion follows routed verification; a running candidate is insufficient.
            job=result.get('job',{})
            proof=result.get('runtime_snapshot',{}).get('routed_verification',{})
            if proof.get('verified'):
                if not success:raise AssertionError('Broken candidate was promoted')
                return result
        time.sleep(1)
    raise TimeoutError('Release qualification exceeded its deadline')


def main():
    run=uuid.uuid4().hex[:12];source=ROOT/'local-projects'/'release-qualification'/run;source.mkdir(parents=True)
    project=None;evidence={'run':run,'scope':'local_release_pipeline','cases':[]}
    email='release-'+run+'@example.test'
    api('POST','/auth/register',{'username':'release-'+run,'email':email,'password':'Fixture-'+secrets.token_hex(16)+'!aA1'})
    def configure(version,fail_tests=False,broken=False):
        (source/'index.html').write_text('<h1 id="release">Release '+version+'</h1><input id="name"><button id="submit" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Submit</button><p id="result"></p>'+('<script>console.error("broken fixture")</script>' if broken else ''))
        config={'workload':'web','port':3000,'tests_required':True,'tests':[['python3','-c','raise SystemExit(9)' if fail_tests else 'assert 2+2==4']],
            'browser_checks':[{'kind':'text','selector':'#release','expected':'Release '+version}],
            'scenarios':[{'name':'Submit form','steps':[{'action':'fill','selector':'#name','value':'Alice'},{'action':'click','selector':'#submit'},{'action':'assert','expectations':[{'kind':'text','selector':'#result','expected':'Alice'}]}]}]}
        (source/'stackpilot.json').write_text(json.dumps(config))
        (source/'Dockerfile').write_text('FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN python3 .stackpilot-runtime/repository_tests.py\nEXPOSE 3000\nCMD ["python3","-m","http.server","3000"]\n')
    def deploy(version):
        result=api('POST','/projects/'+project['id']+'/deployments',{'version':version})['deployment'];identity=result['id']
        api('POST','/deployments/'+identity+'/trigger',{});return identity
    def content(url):
        parsed=urlsplit(url)
        # OS DNS need not resolve Chromium's reserved .localhost namespace.
        request=urllib.request.Request('http://127.0.0.1:'+str(parsed.port)+(parsed.path or '/'),headers={'Host':parsed.netloc})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=10) as response:return response.read().decode()
    try:
        configure('one')
        project=api('POST','/projects',{'name':'Release qualification '+run,'source_type':'local','source_path':'/app/local-projects/release-qualification/'+run,'execution_mode':'local','remote_runtime_type':'docker'})['project']
        first=deploy('v1');one=wait(first);url=one['runtime_url'];assert '.preview.localhost:' in url,url
        assert 'Release one' in content(url)
        evidence['cases'].append({'case':'initial_release','passed':True,'url':url,'deployment_id':first,'workflow_verified':one['runtime_snapshot']['runtime_verification']['workflow_verified']})
        configure('two');second=deploy('v2');two=wait(second);assert two['runtime_url']==url and 'Release two' in content(url)
        evidence['cases'].append({'case':'stable_origin_switch','passed':True,'deployment_id':second})
        configure('broken',fail_tests=True);failed=deploy('v3');wait(failed,False);assert 'Release two' in content(url)
        evidence['cases'].append({'case':'required_test_failure_preserves_serving_release','passed':True})
        restored=api('POST','/deployments/'+second+'/rollback',{});assert restored.get('success'),restored
        assert restored['runtime_url']==url and 'Release one' in content(url)
        evidence['cases'].append({'case':'recreate_stopped_checkpoint_and_verify','passed':True,'checkpoint':restored.get('restored_deployment_id')})
        configure('one')
        queued=api('POST','/deployments/'+second+'/docker/deploy',{'container_port':3000});assert queued['status']=='queued' and queued.get('job'),queued
        wait(second);evidence['cases'].append({'case':'manual_redeploy_uses_queued_verification','passed':True})
        private=secrets.token_hex(32)
        api('POST','/projects/'+project['id']+'/secrets',{'key':'QUALIFICATION_TOKEN','value':private})
        configure('secret')
        config=json.loads((source/'stackpilot.json').read_text());config['build_secrets']=['QUALIFICATION_TOKEN']
        (source/'stackpilot.json').write_text(json.dumps(config))
        dockerfile=(source/'Dockerfile').read_text()
        dockerfile=dockerfile.replace('RUN python3 .stackpilot-runtime/repository_tests.py',
            'RUN --mount=type=secret,id=QUALIFICATION_TOKEN,required=true python3 -c "from pathlib import Path; value=Path(\'/run/secrets/QUALIFICATION_TOKEN\').read_text(); assert len(value)==64; print(value)"\nRUN python3 .stackpilot-runtime/repository_tests.py')
        (source/'Dockerfile').write_text(dockerfile)
        secured=deploy('v4');secured_result=wait(secured)
        log_body=str(api('GET','/deployments/'+secured+'/logs'))
        assert private not in log_body and '[REDACTED]' in log_body,'Build credential output was not redacted'
        digest=secured_result['runtime_snapshot']['artifact_digest']
        history=subprocess.run(['docker','history','--no-trunc','--format','{{.CreatedBy}}',digest],capture_output=True,text=True,check=True).stdout
        image=json.loads(subprocess.run(['docker','image','inspect',digest],capture_output=True,text=True,check=True).stdout)[0]
        assert private not in history and private not in json.dumps(image['Config']),'Build credential entered image metadata'
        archive=secured_result['runtime_snapshot']['source_archive']
        check_script='import pathlib,sys; print(str(sys.argv[2].encode() in pathlib.Path(sys.argv[1]).read_bytes()).lower())'
        exported=subprocess.run(['docker','exec','stackpilot-backend','python3','-c',check_script,archive,private],capture_output=True,text=True,check=True).stdout.strip()
        assert exported=='false','Credential entered immutable source archive'
        evidence['cases'].append({'case':'explicit_buildkit_secret_is_redacted_and_excluded_from_source_and_image_metadata','passed':True})
        config['build_secrets']=['MISSING_CREDENTIAL'];(source/'stackpilot.json').write_text(json.dumps(config))
        missing=deploy('v5');wait(missing,False);assert 'Release secret' in content(url)
        evidence['cases'].append({'case':'missing_private_build_input_blocks_release','passed':True})
        query="SELECT DISTINCT c.resource_key FROM deployment_runtime_candidates c JOIN deployments d ON d.id=c.deployment_id WHERE d.project_id='"+str(uuid.UUID(project['id']))+"' AND c.provider='local_docker';"
        journal=subprocess.run(['docker','exec','-i','stackpilot-postgres','sh','-c','psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'],input=query,capture_output=True,text=True,check=True).stdout.splitlines()
        assert journal and any(name.startswith('stackpilot-rollback-') for name in journal),'Rollback runtime was not journaled'
        api('DELETE','/projects/'+project['id'],expected=(200,204));project=None
        remaining=set(subprocess.run(['docker','ps','-a','--format','{{.Names}}'],capture_output=True,text=True,check=True).stdout.splitlines())
        assert not remaining.intersection(journal),'Project deletion left journaled runtimes behind'
        assert not any('release-qualification-'+run+'-' in name for name in remaining),'Project deletion left release fixture containers behind'
        evidence['cases'].append({'case':'project_deletion_removes_previous_attempts_and_rollback_runtimes','passed':True,'journaled_resources':len(journal)})
        evidence['verified']=True
        print('RELEASE_PIPELINE_PASS '+json.dumps(evidence),flush=True)
    finally:
        (artifact_path('release-pipeline-qualification.json')).write_text(json.dumps(evidence,indent=2))
        if evidence.get('verified') and project:api('DELETE','/projects/'+project['id'],expected=(200,204))


if __name__=='__main__':main()
