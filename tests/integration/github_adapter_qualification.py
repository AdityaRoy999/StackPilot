"""Qualify real pinned sources through public APIs, with fixture-only accounts."""
import json
import secrets
import shutil
import time
import uuid
import github_category_qualification as github
import release_pipeline_smoke as release
from stackpilot_test_artifacts import artifact_path

REPORT=artifact_path('github-adapter-qualification.json')


def main():
    run=uuid.uuid4().hex[:10];report={'run':run,'identity_prefix':'github-retry-','route':'StackPilot public APIs','ai_enabled':False,'cases':[],'complete':False}
    def save():
        pending=REPORT.with_suffix('.pending.json');pending.write_text(json.dumps(report,indent=2))
        for attempt in range(8):
            try:pending.replace(REPORT);return
            except PermissionError:time.sleep(min(.1*2**attempt,2))
        raise RuntimeError('Qualification report locked')
    name=report['identity_prefix']+run
    release.api('POST','/auth/register',{'username':name,'email':name+'@example.test','password':'Fixture-'+secrets.token_hex(16)+'!aA1'})
    report['user_id']=release.api('GET','/auth/me')['user']['id'];release.api('PUT','/ai/settings',{'enabled':False});save()
    cases=[('desktop-compose','JetBrains/compose-multiplatform-desktop-template',None,None),
           ('desktop-python-auto','cyb3rr31a/python-calculator',None,None),
           ('package-python-auto','pypa/sampleproject',None,None),
           ('cli-go-prebuild','charmbracelet/glow',None,{'workload':'cli','entrypoint':['/usr/local/bin/glow','--version'],'console_scenarios':[{'name':'Version command','steps':[{'output_contains':'glow'},{'exit_code':0}]}]}),
           ('windows-exe-download','microsoft/WPF-Samples','Sample Applications/CalculatorDemo',{'delivery':'artifact','workload':'windows'}),
           ('android-aab','alexbond008/calculator-android',None,{'workload':'android','android':{'format':'aab','variant':'Release','module':'app'}})]
    for category,repo,component,contract in cases:
        sha,branch=github.revision(repo)
        item={'category':category,'repository':'https://github.com/'+repo,'commit':sha,'branch':branch,'component':component,'started_at':time.time(),'outcome':'creating','source_changes':'none' if not contract else 'Only StackPilot delivery metadata'}
        report['cases'].append(item);save()
        if contract:
            directory=release.ROOT/'local-projects/github-adapters'/run/category
            shutil.copytree(github.SOURCE/repo.replace('/','--')/(component or ''),directory,ignore=shutil.ignore_patterns('.git'))
            (directory/'stackpilot.json').write_text(json.dumps(contract,indent=2))
            item['delivery_contract']=contract
            spec={'source_type':'local','source_path':'/app/local-projects/github-adapters/'+run+'/'+category}
        else:spec={'source_type':'github','repo_url':item['repository']}
        project=release.api('POST','/projects',{'name':'Adapter QA '+category+' '+run,'execution_mode':'local','environments':[{'name':'production','branch':branch,'require_ci':False,'auto_deploy':False}],**spec})['project']
        item['project_id']=project['id']
        deployment=release.api('POST','/projects/'+project['id']+'/deployments',{'version':'adapter-'+sha[:10],'branch':branch,'commit_sha':sha})['deployment']
        item['deployment_id']=deployment['id'];release.api('POST','/deployments/'+deployment['id']+'/trigger',{})
        item['outcome']='queued';print('ADAPTER_QUEUED '+category,flush=True);save()
    pending=report['cases'][:];states={};deadline=time.monotonic()+4000
    while pending and time.monotonic()<deadline:
        for item in pending[:]:
            result=release.api('GET','/deployments/'+item['deployment_id']);item['platform_status']=result['status']
            if states.get(item['category'])!=result['status']:print('ADAPTER_STATE '+item['category']+' '+result['status'],flush=True);states[item['category']]=result['status']
            routed=(result.get('runtime_snapshot') or {}).get('routed_verification') or {}
            if result['status'] in {'failed','failed_ci','canceled','superseded'} or result['status'] in {'running','ready'} and routed.get('verified'):
                try:github.finish_case(item,result)
                except Exception as exc:item.update(outcome='verification_failed',error=str(exc))
                pending.remove(item);print('ADAPTER_RESULT '+item['category']+' '+item['outcome'],flush=True)
            save()
        if pending:time.sleep(5)
    for item in pending:
        item['outcome']='timed_out';release.api('POST','/deployments/'+item['deployment_id']+'/cancel',{},expected=(200,202,409))
    report['complete']=True;save();print('ADAPTER_COMPLETE '+json.dumps({c['category']:c['outcome'] for c in report['cases']}),flush=True)

if __name__=='__main__':main()
