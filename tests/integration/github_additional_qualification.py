"""Additional package and lab signing checks through StackPilot's APIs."""
import argparse
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import time
import github_category_qualification as github
import release_pipeline_smoke as release
from stackpilot_test_artifacts import artifact_path


def main(kind):
    report=json.loads(artifact_path('github-adapter-qualification.json').read_text());github.resume_test_identity(report)
    if kind in {'npm','npm-simple'}:repo='npm/init-package-json' if kind=='npm' else 'jonschlinkert/is-number';contract=None
    else:
        repo='alexbond008/calculator-android'
        signing={'keystore':'QA_ANDROID_KEYSTORE','store_password':'QA_ANDROID_STORE_PASS','key_password':'QA_ANDROID_KEY_PASS','alias':'QA_ANDROID_ALIAS'}
        contract={'workload':'android','build_secrets':list(signing.values()),'android':{'format':kind,'variant':'Release','module':'app','signing':signing}}
    sha,branch=github.revision(repo);category='package-npm-auto' if kind=='npm' else 'package-npm-consumer' if kind=='npm-simple' else 'android-signed-'+kind
    item={'category':category,'repository':'https://github.com/'+repo,'commit':sha,'branch':branch,'started_at':time.time(),'outcome':'creating','signing_identity':'temporary test-only identity; not a production distribution key' if contract else None}
    if contract:
        source=release.ROOT/'local-projects/github-adapters'/report['run']/category
        shutil.copytree(github.SOURCE/repo.replace('/','--'),source,ignore=shutil.ignore_patterns('.git'),dirs_exist_ok=True)
        (source/'stackpilot.json').write_text(json.dumps(contract))
        item['delivery_contract']=contract;spec={'source_type':'local','source_path':'/app/local-projects/github-adapters/'+report['run']+'/'+category}
    else:spec={'source_type':'github','repo_url':item['repository']}
    project=release.api('POST','/projects',{'name':'Additional adapter QA '+category+' '+report['run']+' '+secrets.token_hex(3),'execution_mode':'local','environments':[{'name':'production','branch':branch,'auto_deploy':False,'require_ci':False}],**spec})['project']
    item['project_id']=project['id']
    output=artifact_path('github-additional-'+category+'.json');output.write_text(json.dumps(item,indent=2))
    if contract:
        password=secrets.token_urlsafe(24)
        script='IFS= read -r SP_PASS; export SP_PASS; keytool -genkeypair -alias stackpilot-qa -keystore /tmp/qa.p12 -storepass:env SP_PASS -keypass:env SP_PASS -dname "CN=StackPilot Test Fixture" -keyalg RSA -validity 30 >/dev/null 2>&1; base64 -w0 /tmp/qa.p12'
        identity=subprocess.run(['docker','run','--rm','-i','eclipse-temurin:21-jdk','sh','-ec',script],input=(password+'\n').encode(),check=True,capture_output=True,timeout=60).stdout.decode('ascii')
        values={'QA_ANDROID_KEYSTORE':identity,'QA_ANDROID_STORE_PASS':password,'QA_ANDROID_KEY_PASS':password,'QA_ANDROID_ALIAS':'stackpilot-qa'}
        for key,value in values.items():release.api('POST','/projects/'+project['id']+'/secrets',{'key':key,'value':value,'description':'Disposable qualification signing input'})
        # Never record private values, even in fixture evidence or log excerpts.
        item['private_input_keys']=list(values)
    output=artifact_path('github-additional-'+category+'.json')
    deployment=release.api('POST','/projects/'+project['id']+'/deployments',{'version':'additional-'+sha[:10],'branch':branch,'commit_sha':sha})['deployment'];item['deployment_id']=deployment['id']
    release.api('POST','/deployments/'+deployment['id']+'/trigger',{});item['outcome']='queued';last='';deadline=time.monotonic()+4000
    while time.monotonic()<deadline:
        result=release.api('GET','/deployments/'+item['deployment_id']);item['platform_status']=result['status']
        if last!=result['status']:print('ADDITIONAL_STATE '+category+' '+result['status'],flush=True);last=result['status']
        if result['status'] in {'failed','failed_ci','canceled','superseded'} or (result.get('runtime_snapshot') or {}).get('routed_verification',{}).get('verified'):
            github.finish_case(item,result)
            if contract:
                logs=release.api('GET','/deployments/'+item['deployment_id']+'/logs').get('deployment',{}).get('logs','')
                assert all(v not in logs for v in (identity,password)), 'Signing material appeared in deployment logs'
                item['secret_values_absent_from_logs']=True
                if item['outcome']=='delivered':
                    name=result['remote_container_name'];runtime=subprocess.run(['docker','inspect','--format','{{json .Config.Env}}',name],check=True,capture_output=True,text=True,timeout=15).stdout
                    assert not any(key+'=' in runtime for key in values),'Build signing inputs entered artifact runtime'
                    item['secret_keys_absent_from_runtime']=True
            break
        output.write_text(json.dumps(item,indent=2));time.sleep(5)
    else:item['outcome']='timed_out'
    output.write_text(json.dumps(item,indent=2));print('ADDITIONAL_RESULT '+category+' '+item['outcome'],flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('kind',choices=['npm','npm-simple','apk','aab']);main(parser.parse_args().kind)
