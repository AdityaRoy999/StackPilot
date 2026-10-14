"""Retry a failed exact QA case after a platform fix, retaining its failure."""
import argparse
import json
from pathlib import Path
import time
import github_category_qualification as github
import release_pipeline_smoke as release
from stackpilot_test_artifacts import artifact_path

def main(category):
    report=json.loads(artifact_path('github-adapter-qualification.json').read_text());github.resume_test_identity(report)
    case=next((c for c in report['cases'] if c['category']==category),None)
    if case is None and category=='package-npm-auto':case=json.loads(artifact_path('github-additional-package-npm-auto.json').read_text())
    if case is None:raise ValueError('Unknown fixture qualification case')
    result=release.api('GET','/deployments/'+case['deployment_id'])
    if result['status'] not in {'failed','failed_ci','canceled'}:raise ValueError('Only failed fixture builds can retry')
    item={**case,'previous_deployment_id':case['deployment_id'],'started_at':time.time(),'outcome':'queued'}
    deployment=release.api('POST','/projects/'+case['project_id']+'/deployments',{'version':'adapter-retry-'+case['commit'][:10],'branch':case['branch'],'commit_sha':case['commit']})['deployment']
    item['deployment_id']=deployment['id'];release.api('POST','/deployments/'+deployment['id']+'/trigger',{})
    output=artifact_path('github-adapter-retry-'+category+'.json');deadline=time.monotonic()+4000;last=''
    while time.monotonic()<deadline:
        result=release.api('GET','/deployments/'+item['deployment_id']);item['platform_status']=result['status']
        if last!=result['status']:print('ADAPTER_RETRY_STATE '+category+' '+result['status'],flush=True);last=result['status']
        if result['status'] in {'failed','failed_ci','canceled','superseded'} or (result.get('runtime_snapshot') or {}).get('routed_verification',{}).get('verified'):
            github.finish_case(item,result);break
        output.write_text(json.dumps(item,indent=2));time.sleep(5)
    else:
        item['outcome']='timed_out';release.api('POST','/deployments/'+item['deployment_id']+'/cancel',{},expected=(200,202,409))
    output.write_text(json.dumps(item,indent=2));print('ADAPTER_RETRY_RESULT '+category+' '+item['outcome'],flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('category');main(parser.parse_args().category)
