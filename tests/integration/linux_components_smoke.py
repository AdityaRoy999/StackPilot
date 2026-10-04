"""Exercise six real Docker workload adapters on a disposable component graph.

This qualifies daemon observations + AI-service verifier code, not autonomous
repository repair or the backend's release transaction. No user projects change.
"""
import copy
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
from compose_policy import sanitize
from compose_runtime_evidence import collect,identity


def run(argv,**kwargs):
    return subprocess.run(argv,check=True,capture_output=True,text=True,timeout=kwargs.pop('timeout',120),**kwargs)


def qualify():
    project='stackpilot-linux-components-'+uuid.uuid4().hex[:12]
    image='stackpilot-component-qualification:'+project
    evidence={'qualification':'actual Docker adapters, daemon identities, and component runtime gate','project':project,'cases':[]}
    with tempfile.TemporaryDirectory(prefix='stackpilot-component-qualification-') as directory:
        root=Path(directory);model_path=root/'compose.json';plan_path=root/'plan.json'
        for name in ('console_server.py','artifact_server.py'):
            shutil.copyfile(ROOT/'deployment-runtime'/name,root/name)
        (root/'api.py').write_text('from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer\n'
            'class Handler(BaseHTTPRequestHandler):\n'
            ' def do_GET(self):\n'
            '  self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(b\'{"ready":true}\')\n'
            'ThreadingHTTPServer(("0.0.0.0",3000),Handler).serve_forever()\n')
        (root/'worker.py').write_text('from pathlib import Path\nimport time\nPath("/tmp/ready").write_text("worker-ready")\nwhile True: time.sleep(1)\n')
        (root/'cli.py').write_text('while True:\n value=input("Number: ")\n if value=="quit": break\n print("Square:",int(value)**2,flush=True)\n')
        (root/'job.py').write_text('import time\ntime.sleep(8)\nprint("job-completed",flush=True)\n')
        (root/'tcp.py').write_text('import socket\nserver=socket.socket();server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);server.bind(("0.0.0.0",3000));server.listen()\n'
                                  'while True:\n client,_=server.accept();client.sendall(b"ready");client.close()\n')
        artifacts=root/'artifacts';artifacts.mkdir();(artifacts/'fixture.whl').write_bytes(b'independently hashed disposable artifact fixture')
        (root/'Dockerfile').write_text('FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nUSER 65534:65534\nEXPOSE 3000\n')
        commands={'api':['python','api.py'],'worker':['python','worker.py'],
                  'cli':['python','-c','from console_server import serve;serve(["python","-u","cli.py"],"cli",3000)'],
                  'job':['python','-c','from console_server import serve;serve(["python","-u","job.py"],"job",3000,60)'],
                  'package':['python','artifact_server.py'],'tcp':['python','tcp.py']}
        model={'services':{name:{'image':image,'command':argv,**({'ports':[{'target':3000,'published':'0','host_ip':'127.0.0.1','protocol':'tcp'}]} if name!='worker' else {})}
                           for name,argv in commands.items()}}
        model['services']['package']['environment']={'ARTIFACT_ROOT':'/app/artifacts','PORT':'3000'}
        model=sanitize(model,root);model_path.write_text(json.dumps(model))
        common={'protocol':'http','port':3000,'accepted_statuses':[200]}
        contracts={'api':{**common,'workload':'api','verification_scope':'http_contract','health_path':'/ready','checks':[{'path':'/ready','json_contains':{'ready':True}}]},
            'worker':{'protocol':'process','workload':'worker','verification_scope':'process','process_checks':[
                {'argv':['python','-c','from pathlib import Path;print(Path("/tmp/ready").read_text())'],'timeout_seconds':10,'output_contains':'worker-ready'}]},
            'cli':{**common,'workload':'cli','verification_scope':'console_workflow','health_path':'/healthz','console_scenarios':[
                {'name':'Actual CLI square and exit','steps':[{'input':'12\n','output_contains':'Square: 144'},{'input':'quit\n','exit_code':0}]}]},
            'job':{**common,'workload':'job','verification_scope':'job_completion','health_path':'/healthz','job_timeout_seconds':60,'checks':[{'path':'/healthz','text_contains':'job-completed'}]},
            'package':{**common,'workload':'package','verification_scope':'artifact_delivery','health_path':'/healthz'},
            'tcp':{'protocol':'tcp','port':3000,'workload':'tcp','verification_scope':'tcp_connect'}}
        plan={'repository_plan':{'version':2,'primary_component':'api','execution_order':list(contracts)},'component_contracts':contracts}
        plan_path.write_text(json.dumps(plan))
        def verify(contract):
            file=root/'verification-input.json';file.write_text(json.dumps(contract))
            script='import asyncio,json;from app.runtime_verification import verify_runtime;c=json.load(open("/qualification.json"));print(json.dumps(asyncio.run(verify_runtime(c["component_runtime"]["components"]["api"]["url"],c))))'
            result=run(['docker','run','--rm','--network','bridge','--add-host','host.docker.internal:host-gateway','--memory','1g','--cpus','2',
                '--mount',f'type=bind,source={ROOT / "ai-service/app"},target=/app/app,readonly',
                '--mount',f'type=bind,source={file},target=/qualification.json,readonly',
                'stackpilot-ai-service:latest','python','-c',script],timeout=240)
            return json.loads(result.stdout.strip().splitlines()[-1])
        try:
            run(['docker','build','-t',image,str(root)],timeout=180)
            run(['docker','compose','-p',project,'-f',str(model_path),'up','-d'],timeout=90)
            # Let actual worker state/ports initialize; retries are bounded and
            # apply only to these newly created fixture containers.
            for attempt in range(30):
                try:observation=collect(project,model,plan);break
                except RuntimeError:
                    if attempt==29:raise
                    time.sleep(.2)
            contract={**plan,'component_runtime':observation}
            first=verify(contract)
            if first.get('status')=='running':
                assert first.get('pending') and first.get('job_execution_ids',{}).get('job'),first
                evidence['cases'].append({'case':'finite component remains pending with original execution identity','passed':True})
                plan['component_contracts']['job']['job_execution_id']=first['job_execution_ids']['job']
                plan_path.write_text(json.dumps(plan));time.sleep(8)
                contract={**plan,'component_runtime':collect(project,model,plan)}
                passed=verify(contract)
            else:passed=first
            assert passed.get('verified') is True,passed
            assert set(passed.get('components',{}))==set(contracts),passed
            fresh=collect(project,model,plan,execute_checks=False)
            assert passed['identities']==identity(fresh),passed
            evidence['cases'].append({'case':'all six real workload adapters pass on exact candidate identities','passed':True,
                                      'scopes':{name:value['scope'] for name,value in passed['components'].items()}})
            broken=copy.deepcopy(plan);broken['component_contracts']['api']['checks'][0]['json_contains']['ready']=False
            failed=verify({**broken,'component_runtime':collect(project,model,broken)})
            assert failed.get('verified') is False and failed.get('status')=='failed',failed
            evidence['cases'].append({'case':'actual secondary/API assertion failure rejects entire release','passed':True})
            before=identity(fresh)
            run(['docker','restart',fresh['components']['worker']['container_id']],timeout=30)
            after=collect(project,model,plan,execute_checks=False)
            assert identity(after)!=before
            evidence['cases'].append({'case':'worker restart changes bound release identity','passed':True})
            evidence['passed']=True
        finally:
            subprocess.run(['docker','compose','-p',project,'-f',str(model_path),'down','--remove-orphans'],capture_output=True,timeout=90)
            subprocess.run(['docker','image','rm',image],capture_output=True,timeout=30)
    return evidence


if __name__=='__main__':
    result=qualify()
    path=ROOT/'docs/linux-component-qualification-2026-10-01.json';path.write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))
