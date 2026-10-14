"""Retry the exact pinned Android GitHub case, retaining unsuccessful attempts."""
import json
import time
import github_category_qualification as github
import release_pipeline_smoke as release
from stackpilot_test_artifacts import artifact_path


def main():
    path=artifact_path('github-android-final.json')
    report=json.loads(path.read_text())
    if not report.get('complete'):raise ValueError('Android observer is still active')
    github.resume_test_identity(report)
    previous=report['cases'][0]
    report.setdefault('previous_attempts',[]).append(previous)
    case={key:previous[key] for key in ('category','repository','commit','branch','source_changes','project_id')}
    case.update(started_at=time.time(),outcome='creating')
    report['cases']=[case];report['complete']=False
    def save():path.write_text(json.dumps(report,indent=2))
    save()
    deployment=release.api('POST','/projects/'+case['project_id']+'/deployments',
                           {'version':'native-worker-ready-'+case['commit'][:10],
                            'branch':case['branch'],'commit_sha':case['commit']})['deployment']
    case['deployment_id']=deployment['id'];save()
    release.api('POST','/deployments/'+deployment['id']+'/trigger',{})
    deadline=time.monotonic()+2400;last=None
    while time.monotonic()<deadline:
        result=release.api('GET','/deployments/'+deployment['id'])
        if result['status']!=last:
            print('ANDROID_FINAL_STATE '+result['status'],flush=True);last=result['status']
        routed=(result.get('runtime_snapshot') or {}).get('routed_verification') or {}
        if result['status'] in {'failed','failed_ci','canceled'} or result['status'] in {'running','ready'} and routed.get('verified'):
            github.finish_case(case,result);report['complete']=True;save()
            print('ANDROID_FINAL_RESULT '+case['outcome'],flush=True)
            return
        save();time.sleep(5)
    release.api('POST','/deployments/'+deployment['id']+'/cancel',{},expected=(200,202,409))
    case['outcome']='timed_out';report['complete']=True;save()
    raise TimeoutError('Android qualification deadline exceeded')


if __name__=='__main__':main()
