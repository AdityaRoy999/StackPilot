"""Read immutable build evidence without executing the submitted image."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def inspect(image):
    digest=subprocess.run(['docker','image','inspect','--format','{{.Id}}',image],check=True,capture_output=True,text=True,timeout=15).stdout.strip()
    if not digest.startswith('sha256:') or len(digest)!=71:raise ValueError('Immutable image identity unavailable')
    container=subprocess.run(['docker','create','--entrypoint','/bin/true',digest],check=True,capture_output=True,text=True,timeout=15).stdout.strip()
    try:
        with tempfile.TemporaryDirectory() as directory:
            for source in ('/stackpilot-evidence/tests.json','/app/.stackpilot-tests.json','/app/out/.stackpilot-tests.json','/artifacts/manifest.json'):
                output=Path(directory)/'evidence.json'
                result=subprocess.run(['docker','cp',f'{container}:{source}',str(output)],capture_output=True,timeout=20)
                if result.returncode==0:
                    evidence=json.loads(output.read_text())
                    if not isinstance(evidence,dict):raise ValueError('Build evidence must be an object')
                    return {**evidence,'image_digest':digest,'evidence_origin':'repository_image'}
        return {'status':'unrecorded','image_digest':digest,'scope':'repository_tests','reason':'Image has no test evidence; runtime health does not certify repository tests'}
    finally:
        subprocess.run(['docker','rm',container],check=True,capture_output=True,timeout=15)


def require(evidence, required):
    if required and evidence.get('status',evidence.get('tests'))!='passed':
        raise RuntimeError('Required repository test evidence is missing or not passed')


if __name__=='__main__':
    evidence=inspect(sys.argv[1]);Path(sys.argv[2]).write_text(json.dumps(evidence))
    if len(sys.argv)>3:require(evidence,json.loads(Path(sys.argv[3]).read_text()).get('tests_required',False))
