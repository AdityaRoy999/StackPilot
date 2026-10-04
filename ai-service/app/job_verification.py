"""Short observations of an asynchronous repository job, never synthetic success.

The release broker stores the first execution_id and supplies job_execution_id
on subsequent observations. A restarted process cannot satisfy that release.
The job deadline is enforced in its deployment container, not by a long-lived
HTTP request or an AI service task.
"""
import math
import re
import time
from urllib.parse import urlsplit

import httpx


def observe(value, contract, *, now=None):
    """Validate actual adapter state and preserve pending/terminal semantics."""
    scope = 'job_completion'
    base = {'verified':False,'scope':scope,'workflow_verified':False}
    try:
        if not isinstance(value,dict) or value.get('workload')!='job':
            raise ValueError('Repository job observation is missing')
        identity=value.get('execution_id')
        if not isinstance(identity,str) or not re.fullmatch(r'[0-9a-f]{32}',identity):
            raise ValueError('Job execution identity is missing or invalid')
        expected=contract.get('job_execution_id')
        if expected is not None and (not isinstance(expected,str) or not re.fullmatch(r'[0-9a-f]{32}',expected)):
            raise ValueError('Expected job execution identity is invalid')
        if expected is not None and identity!=expected:
            return {**base,'status':'failed','reason':'Job execution changed; a restarted/replayed command cannot satisfy the original release',
                    'job_execution_id':identity,'expected_job_execution_id':expected}
        state=value.get('state')
        if state not in {'running','completed','failed','timed_out','cancelled'}:
            raise ValueError('Job lifecycle state is missing or invalid')
        timeout=value.get('timeout_seconds')
        if type(timeout) is not int or not 1<=timeout<=86400:
            raise ValueError('Job execution deadline is invalid')
        declared=contract.get('job_timeout_seconds')
        if declared is not None and declared!=timeout:
            raise ValueError('Observed job deadline differs from the accepted repository contract')
        def timestamp(key,optional=False):
            number=value.get(key)
            if number is None and optional:return None
            if isinstance(number,bool) or not isinstance(number,(int,float)) or not math.isfinite(number) or number<=0:
                raise ValueError('Job '+key+' is invalid')
            return number
        started=timestamp('started_at');deadline=timestamp('deadline_at');finished=timestamp('finished_at',True)
        if abs(deadline-started-timeout)>.01 or finished is not None and finished<started:
            raise ValueError('Job timestamps contradict its execution deadline')
        observed_at=time.time() if now is None else now
        if started>observed_at+10 or finished is not None and finished>observed_at+10:
            raise ValueError('Job timestamps are ahead of the observation clock')
        digest=value.get('command_sha256')
        if not isinstance(digest,str) or not re.fullmatch(r'[0-9a-f]{64}',digest):
            raise ValueError('Job command identity is missing or invalid')
        exit_code=value.get('exit_code')
        if exit_code is not None and (type(exit_code) is not int or not -255<=exit_code<=255):
            raise ValueError('Observed job exit status is invalid')
        if type(value.get('timed_out')) is not bool or type(value.get('truncated')) is not bool:
            raise ValueError('Job observation requires timeout/output retention flags')
        output=value.get('output')
        if not isinstance(output,str) or len(output.encode('utf-8'))>512*1024:
            raise ValueError('Job output is missing or exceeds observation bounds')
        job={key:value.get(key) for key in ('execution_id','state','started_at','finished_at','deadline_at',
             'timeout_seconds','command_sha256','exit_code','timed_out','elapsed_seconds','offset','truncated')}
        job['output']=output[-8000:]
        base.update({'job':job,'job_execution_id':identity,'output':output[-8000:]})
        if state=='running':
            if exit_code is not None or finished is not None or value['timed_out']:
                raise ValueError('Running job has contradictory terminal evidence')
            if observed_at>deadline+5:
                return {**base,'status':'failed','reason':'Job remained running after its execution deadline'}
            return {**base,'status':'running','pending':True,'reason':'Repository command is still running; completion has not been verified'}
        if state=='completed':
            if exit_code!=0 or finished is None or value['timed_out'] or finished>deadline+5:
                raise ValueError('Completed job does not have a successful in-deadline process exit')
            return {**base,'status':'passed','verified':True,'pending':False,'reason':'Finite repository command exited successfully'}
        if state in {'failed','timed_out','cancelled'}:
            return {**base,'status':'failed','pending':False,'reason':{'failed':'Repository command exited unsuccessfully',
                    'timed_out':'Repository command exceeded its execution deadline','cancelled':'Repository command was cancelled'}[state]}
    except ValueError as error:
        return {**base,'status':'unverified','reason':str(error)}


async def verify_job(url, contract, *, request_url):
    """Return promptly; the durable release broker schedules later observations."""
    checks=[]
    try:
        async with httpx.AsyncClient(timeout=10,follow_redirects=False,trust_env=False) as client:
            headers={'Host':urlsplit(url).netloc}
            response=await client.get(request_url(url,'/job/status'),headers=headers)
            response.raise_for_status()
            if len(response.content)>512*1024:
                raise ValueError('Job observation exceeds retention bounds')
            result=observe(response.json(),contract)
            checks.append({'path':'/job/status','status':response.status_code,'passed':result['verified']})
            if not result['verified']:
                return {**result,'checks':checks}
            # Additional outcome checks run only once real completion exists.
            declared=[{'path':contract.get('health_path','/healthz'),'statuses':contract.get('accepted_statuses',[200])},
                      *contract.get('checks',[])]
            if len(declared)>51:raise ValueError('Too many job outcome checks')
            for check in declared:
                response=await client.get(request_url(url,check.get('path','/healthz')),headers=headers)
                passed=response.status_code in check.get('statuses',[200])
                if 'json_contains' in check:
                    value=response.json()
                    passed=passed and isinstance(value,dict) and all(value.get(key)==expected for key,expected in check['json_contains'].items())
                if 'text_contains' in check:passed=passed and str(check['text_contains']) in response.text
                checks.append({'path':check.get('path','/healthz'),'status':response.status_code,'passed':passed})
                if not passed:
                    return {**result,'verified':False,'status':'failed','checks':checks,'reason':'Declared job outcome check failed'}
            # Pin the final observation too: a server/container restart between
            # the completion response and an outcome check must not pass.
            response=await client.get(request_url(url,'/job/status'),headers=headers)
            response.raise_for_status()
            final=observe(response.json(),{**contract,'job_execution_id':result['job_execution_id']})
            checks.append({'path':'/job/status','status':response.status_code,'passed':final['verified']})
            return {**final,'checks':checks,'workflow_verified':bool(contract.get('checks')) and final['verified']}
    except Exception as error:
        return {'status':'unverified','verified':False,'scope':'job_completion','checks':checks,
                'reason':'Job observation unavailable: '+(str(error) or type(error).__name__),'workflow_verified':False}
