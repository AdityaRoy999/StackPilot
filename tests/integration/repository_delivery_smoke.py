"""Real Docker delivery through the authenticated platform runtime verifier.

Run against a healthy local StackPilot stack. Does not create or alter projects.
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


def command(argv, **kwargs):
    return subprocess.run(argv,check=True,timeout=600,**kwargs)


def verify(url, contract):
    # Use the service's existing token without exposing it to the host or logs.
    code="""import os,json,sys,httpx
payload=json.load(sys.stdin)
r=httpx.post('http://127.0.0.1:8010/runtime/verify',json=payload,headers={'x-stackpilot-service-token':os.getenv('STACKPILOT_AI_SERVICE_TOKEN','')},timeout=60,trust_env=False)
r.raise_for_status();print(json.dumps(r.json()))
"""
    response=command(['docker','exec','-i','stackpilot-ai-service','python','-c',code],
                     input=json.dumps({'url':url,'contract':contract}),text=True,capture_output=True)
    return json.loads(response.stdout)


def run():
    evidence=[]
    for fixture in ('interactive-node','finite-python-job','portable-python-package'):
        identity='stackpilot-delivery-qa-'+uuid.uuid4().hex[:12]
        created=False
        try:
            with tempfile.TemporaryDirectory() as directory:
                source=Path(directory)/'source'
                shutil.copytree(ROOT/'tests'/'fixtures'/fixture,source)
                contract=prepare(source,'standard_web')
                command(['docker','build','-q','-t',identity,str(source)])
                command(['docker','run','-d','--rm','--name',identity,'--read-only','--tmpfs','/tmp:rw,nosuid,size=64m',
                         '--memory','256m','--cpus','1','--pids-limit','128','--cap-drop','ALL',
                         '--security-opt','no-new-privileges:true','-p','127.0.0.1::3000',identity],capture_output=True)
                created=True
                published=command(['docker','port',identity,'3000'],capture_output=True,text=True).stdout.strip()
                time.sleep(.5)
                result=verify('http://'+published,contract)
                if result.get('verified') is not True:
                    raise RuntimeError(fixture+': '+json.dumps(result))
                if contract['workload']=='cli' and result.get('workflow_verified') is not True:
                    raise RuntimeError('CLI business assertions did not execute')
                evidence.append({'fixture':fixture,'contract':contract,'verification':result})
        finally:
            if created: command(['docker','stop',identity],capture_output=True)
            subprocess.run(['docker','image','rm',identity],capture_output=True,timeout=30)
    return evidence


if __name__=='__main__':
    result=run()
    if len(sys.argv)>1: Path(sys.argv[1]).write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))
