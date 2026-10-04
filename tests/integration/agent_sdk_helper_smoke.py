"""Real Docker SDK build, labels and execution without control-plane inputs.

Run in a disposable trusted backend-image container with the Docker socket and
this repository mounted read-only. Lease authorization is a fixture callback;
focused tests cover revocation. This is not a live broker/DB lease qualification
and creates no account or project.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'deployment-runtime'))
import agent_image


def run():
    run_id=str(uuid.uuid4());image=None;image_removed=False;reference=None
    with tempfile.TemporaryDirectory(prefix='sdk-real-qa-') as temporary:
        source=Path(temporary)/'source';source.mkdir()
        (source/'.git').mkdir();(source/'.git'/'config').write_text('fixture credential excluded')
        (source/'probe.py').write_text('''import os,pathlib
assert os.getenv('STACKPILOT_FIXTURE_CREDENTIAL') is None
assert os.getenv('STACKPILOT_AI_SERVICE_TOKEN') is None
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not pathlib.Path('/opt/sdk-source/.git').exists()
assert os.access('/opt/sdk-source/sdk-only',os.X_OK)
print('SDK build inputs isolated')
''')
        (source/'sdk-only').write_text('#!/bin/sh\nexec python -c "print(6*7)"\n')
        (source/'sdk-only').chmod(0o755)
        (source/'Dockerfile').write_text('FROM python:3.12-slim\nCOPY . /opt/sdk-source\nRUN python /opt/sdk-source/probe.py\nENV PATH="/opt/sdk-source:${PATH}"\n')
        spec={'run_id':run_id,'user_id':str(uuid.uuid4()),'task_id':str(uuid.uuid4()),'lease_owner':'fixture-owner',
              'attempt':1,'timeout_seconds':120,'network':False}
        try:
            with patch('agent_image.lease_valid',return_value=True):result=agent_image.execute(source,spec)
            assert result.get('status')=='completed' and result.get('verified') is False,result
            image=result['image_id']
            actual=json.loads(subprocess.check_output(['docker','image','inspect',image],text=True))[0]
            assert actual['Id']==image and actual['Config']['Labels']['stackpilot.agent-run']==run_id,actual
            command=subprocess.run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL',
                '--security-opt','no-new-privileges:true','--memory','128m','--cpus','1','--pids-limit','64',
                '--entrypoint','sdk-only',image],check=True,capture_output=True,text=True,timeout=30)
            assert command.stdout.strip()=='42',command.stdout
            reference='stackpilot-sdk-qa-ref-'+uuid.uuid4().hex[:12]
            subprocess.run(['docker','create','--name',reference,'--entrypoint','sdk-only',image],check=True,capture_output=True,timeout=20)
            retained=agent_image.cleanup(run_id)
            assert retained['removed']==[] and any(entry['image_id']==image for entry in retained['retained']),retained
            subprocess.run(['docker','rm',reference],check=True,capture_output=True,timeout=20);reference=None
            cleaned=agent_image.cleanup(run_id)
            assert image in cleaned['removed'] and not cleaned['retained'],cleaned
            image_removed=True
            evidence={'passed':True,'scope':'real_local_docker_sdk_fixture','lease_authorization':'fixture_callback',
                      'image_id':image,'labels':result['labels'],'sdk_image_verified':False,
                      'actual_command_exit_code':command.returncode,'actual_command_output':command.stdout.strip(),
                      'cases':['Source Git metadata excluded; executable bits preserved',
                               'Guest has no control-plane credentials or Docker socket',
                               'Actual Docker build produced a task-owned observed image digest',
                               'Custom SDK command executed in a disposable resource-limited container',
                               'Cleanup retained a container-referenced SDK and removed it only after the reference was released']}
            return evidence
        finally:
            if reference:subprocess.run(['docker','rm','-f',reference],capture_output=True,check=True,timeout=20)
            if image and not image_removed:
                labels=json.loads(subprocess.check_output(['docker','image','inspect',image],text=True))[0]['Config']['Labels']
                assert labels['stackpilot.agent-run']==run_id and labels['stackpilot.agent-sdk']=='true'
                subprocess.run(['docker','image','rm','-f',image],capture_output=True,check=True,timeout=30)


if __name__=='__main__':print(json.dumps(run(),indent=2))
