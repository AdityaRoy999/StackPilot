"""Real Docker job longer than the former 45-second execution ceiling.

This qualifies the delivery adapter and authenticated production verifier.
It creates no account or project; backend durable release ownership has its
own platform qualification. Restarting this exact fixture must change identity
and fail an observation pinned to the previous execution.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'deployment-runtime'))
from planner import prepare


def command(argv,**kwargs):
    return subprocess.run(argv,check=True,timeout=600,**kwargs)


def verify(url,contract):
    code='''import os,json,sys,time,httpx
payload=json.load(sys.stdin)
started=time.monotonic()
response=httpx.post('http://127.0.0.1:8010/runtime/verify',json=payload,headers={'x-stackpilot-service-token':os.getenv('STACKPILOT_AI_SERVICE_TOKEN','')},timeout=60,trust_env=False)
response.raise_for_status();result=response.json();result['qualification_http_seconds']=time.monotonic()-started;print(json.dumps(result))
'''
    response=command(['docker','exec','-i','stackpilot-ai-service','python','-c',code],
                     input=json.dumps({'url':url,'contract':contract}),text=True,capture_output=True)
    return json.loads(response.stdout)


def run():
    identity='stackpilot-long-job-qa-'+uuid.uuid4().hex[:12]
    created=False;evidence={'scope':'real_long_finite_job_delivery','cases':[]}
    try:
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source';shutil.copytree(ROOT/'tests/fixtures/long-python-job',source)
            contract=prepare(source,'standard_web')
            command(['docker','build','-q','-t',identity,str(source)],capture_output=True)
            command(['docker','run','-d','--name',identity,'--read-only','--tmpfs','/tmp:rw,nosuid,size=64m',
                     '--memory','256m','--cpus','1','--pids-limit','128','--cap-drop','ALL',
                     '--security-opt','no-new-privileges:true','-p','127.0.0.1::3000',identity],capture_output=True)
            created=True
            published=command(['docker','port',identity,'3000'],capture_output=True,text=True).stdout.strip()
            url='http://'+published;time.sleep(.5)
            first=verify(url,contract)
            assert first['qualification_http_seconds']<15,first
            assert first.get('status')=='running' and first.get('verified') is False,first
            pinned={**contract,'job_execution_id':first['job_execution_id']}
            evidence['cases'].append('Running job returns promptly with real process identity and progress, unverified')
            deadline=time.monotonic()+95
            result=first
            while result.get('status')=='running' and time.monotonic()<deadline:
                time.sleep(3);result=verify(url,pinned)
            assert result.get('verified') is True,result
            assert result['job']['finished_at']-result['job']['started_at']>=45,result
            assert result['job']['execution_id']==first['job_execution_id'] and 'result=42' in result['output'],result
            evidence['cases'].append('Actual process ran over45seconds and completed exit0 with declared result checks')
            evidence['completion']=result
            command(['docker','restart',identity],capture_output=True)
            published=command(['docker','port',identity,'3000'],capture_output=True,text=True).stdout.strip()
            url='http://'+published
            ready=time.monotonic()+20
            while True:
                restarted=verify(url,pinned)
                if restarted.get('status')!='unverified' or time.monotonic()>=ready:break
                time.sleep(.5)
            assert restarted.get('status')=='failed' and restarted.get('verified') is False,restarted
            assert restarted.get('job_execution_id')!=first['job_execution_id'],restarted
            evidence['cases'].append('Docker restart creates new execution identity and cannot satisfy original release')
            evidence['restart']=restarted;evidence['passed']=True
    finally:
        if created:command(['docker','rm','-f',identity],capture_output=True)
        subprocess.run(['docker','image','rm',identity],capture_output=True,timeout=30)
    return evidence


if __name__=='__main__':
    result=run()
    if len(sys.argv)>1:Path(sys.argv[1]).write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))
