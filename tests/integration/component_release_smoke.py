"""Authenticated broker qualification: pending job + mixed Linux release.

Run after the new backend and AI service are active. This creates/deletes one
disposable account/project and never rebuilds an existing user project.
"""
from stackpilot_test_artifacts import artifact_path
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import time
import uuid
import argparse

from release_pipeline_smoke import api,ROOT


def sql(query):
    return subprocess.check_output(['docker','exec','stackpilot-postgres','sh','-c',
        'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"','qualification',query],text=True)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--restart-backend',action='store_true');args=parser.parse_args()
    run=uuid.uuid4().hex[:12];base=(ROOT/'local-projects/component-release-qualification').resolve()
    source=base/run;source.mkdir(parents=True)
    project=user=None;final=None;evidence={'run':run,'scope':'authenticated mixed Linux broker release','cases':[],'passed':False}
    try:
        for name in ('api','worker','job'):(source/name).mkdir()
        (source/'api/api.py').write_text('from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer\n'
            'class Handler(BaseHTTPRequestHandler):\n'
            ' def do_GET(self):\n'
            '  self.send_response(200);self.send_header("Content-Type","application/json");self.end_headers();self.wfile.write(b\'{"ready":true}\')\n'
            'ThreadingHTTPServer(("0.0.0.0",3000),Handler).serve_forever()\n')
        (source/'worker/worker.py').write_text('from pathlib import Path\nimport time\nPath("/tmp/worker-ready").write_text("ready")\nwhile True:time.sleep(1)\n')
        (source/'job/batch.py').write_text('import time\ndef total():return sum(range(100))\nif __name__=="__main__":\n time.sleep(85)\n print("job-result:",total(),flush=True)\n')
        docker='FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN python .stackpilot-runtime/repository_tests.py\nUSER 65534:65534\n'
        (source/'api/Dockerfile').write_text(docker+'EXPOSE 3000\nCMD ["python","api.py"]\n')
        (source/'worker/Dockerfile').write_text(docker+'CMD ["python","worker.py"]\n')
        config={'version':2,'primary_component':'api','tests_required':True,'components':[
            {'id':'api','root':'api','workload':'api','port':3000,'health':{'path':'/ready'},
             'checks':[{'path':'/ready','json_contains':{'ready':True}}],
             'tests':[['python','-c','import ast;from pathlib import Path;ast.parse(Path("api.py").read_text())']], 'tests_required':True},
            {'id':'worker','root':'worker','workload':'worker','capabilities':['linux','process'],
             'tests':[['python','-c','import ast;from pathlib import Path;ast.parse(Path("worker.py").read_text())']], 'tests_required':True,
             'process_checks':[{'argv':['python','-c','from pathlib import Path;assert Path("/tmp/worker-ready").read_text()=="ready"'],'timeout_seconds':10}]},
            {'id':'job','root':'job','workload':'job','entrypoint':['python','-u','batch.py'],'job_timeout_seconds':180,
             'tests':[['python','-c','from batch import total;assert total()==4950']],'tests_required':True,
             'checks':[{'path':'/healthz','text_contains':'job-result: 4950'}]}]}
        (source/'stackpilot.json').write_text(json.dumps(config))
        api('POST','/auth/register',{'username':'component-'+run,'email':'component-'+run+'@example.test','password':'Fixture-'+secrets.token_hex(16)+'!aA1'})
        profile=api('GET','/auth/me');user=(profile.get('user') or profile)['id']
        project=api('POST','/projects',{'name':'Component release qualification '+run,'source_type':'local',
            'source_path':'/app/local-projects/component-release-qualification/'+run,'execution_mode':'local','remote_runtime_type':'docker'})['project']['id']
        def deploy(version):
            identity=api('POST','/projects/'+project+'/deployments',{'version':version})['deployment']['id']
            api('POST','/deployments/'+identity+'/trigger',{});return identity
        first=deploy('v1');pending=None;started=time.monotonic();deadline=started+450
        while time.monotonic()<deadline:
            result=api('GET','/deployments/'+first);state=result['status']
            proof=result.get('runtime_snapshot',{}).get('runtime_verification',{})
            if proof.get('status')=='running' and proof.get('pending'):
                if pending is None:
                    pending=proof
                    assert proof.get('verified') is False and proof.get('job_execution_ids',{}).get('job'),proof
                    assert state not in {'failed','running','ready'},result
                    evidence['cases'].append({'case':'85 second job remains deploying with original execution ID','passed':True})
                    if args.restart_backend:
                        observation_deadline=time.monotonic()+20
                        while time.monotonic()<observation_deadline:
                            record=json.loads(sql("SELECT json_build_object('status',status,'attempt',attempts) FROM deployment_jobs WHERE deployment_id='"+str(uuid.UUID(first))+"' ORDER BY created_at DESC LIMIT 1;"))
                            if record['status']=='retrying':break
                            assert record['status']=='running',record
                            time.sleep(.2)
                        else:raise TimeoutError('Pending observation did not release its queue worker')
                        pending_attempt=record['attempt']
                        subprocess.run(['docker','restart','stackpilot-backend'],check=True,capture_output=True,timeout=40)
                        ready=time.monotonic()+45
                        while time.monotonic()<ready:
                            try:api('GET','/health');break
                            except Exception:time.sleep(1)
                        else:raise TimeoutError('Backend did not recover after pending fixture restart')
                        evidence['cases'].append({'case':'pending candidate survives actual backend restart','passed':True})
            if state=='failed':
                detail=api('GET','/deployments/'+first+'/logs')
                jobs=sql("SELECT json_build_object('status',status,'error',last_error) FROM deployment_jobs WHERE deployment_id='"+str(uuid.UUID(first))+"' ORDER BY created_at DESC LIMIT 1;").strip()
                raise RuntimeError(json.dumps({'deployment':result,'logs':detail,'job':jobs})[-7000:])
            if state in {'running','ready'} and result.get('runtime_snapshot',{}).get('routed_verification',{}).get('verified'):
                break
            time.sleep(1)
        else:raise TimeoutError('Mixed component broker release did not complete')
        assert pending,'No durable pending component observation was recorded'
        final=result['runtime_snapshot']['runtime_verification'];assert final.get('verified') is True,final
        assert final['job_execution_ids']==pending['job_execution_ids'],final
        assert final['identities']==pending['identities'],'Broker replaced/rebuilt pending candidates'
        if args.restart_backend:
            actual_attempt=int(sql("SELECT attempts FROM deployment_jobs WHERE deployment_id='"+first+"' ORDER BY created_at DESC LIMIT 1;").strip())
            assert actual_attempt==pending_attempt,'Observation polling consumed a build retry'
        evidence['cases'].append({'case':'all components pass and same candidate/execution is promoted','passed':True,
                                  'elapsed_seconds':round(time.monotonic()-started,2)})
        # A saved release snapshot is deliberately stale: monitoring must get
        # fresh daemon observations instead of inheriting an old success flag.
        first=str(uuid.UUID(first))
        sql("UPDATE deployments SET runtime_snapshot=jsonb_set(runtime_snapshot,'{deployment_plan,component_runtime,generated_at}','0'::jsonb) WHERE id='"+first+"';")
        health=api('GET','/deployments/'+first+'/runtime/health')
        assert health.get('healthy') is True and health.get('verification_scope')=='component_contracts',health
        evidence['cases'].append({'case':'monitoring rechecks every component despite stale saved proof','passed':True})
        # A secondary worker is restarted, then independent health checks must
        # bind their result to the newly observed start, not the old snapshot.
        before=health['verification']['identities']['worker']['started_at']
        subprocess.run(['docker','restart',health['verification']['identities']['worker']['container_id']],check=True,capture_output=True,timeout=30)
        health=api('GET','/deployments/'+first+'/runtime/health')
        assert health.get('healthy') is True and health['verification']['identities']['worker']['started_at']!=before,health
        evidence['cases'].append({'case':'worker restart receives fresh component evidence','passed':True})
        config['components'][0]['checks'][0]['json_contains']['ready']=False
        (source/'stackpilot.json').write_text(json.dumps(config));second=deploy('v2')
        deadline=time.monotonic()+300
        while time.monotonic()<deadline:
            result=api('GET','/deployments/'+second)
            if result['status']=='failed':break
            if result['status'] in {'running','ready'}:raise AssertionError('Failing component graph was promoted')
            time.sleep(1)
        else:raise TimeoutError('Failing component graph did not terminate')
        assert api('GET','/deployments/'+first+'/runtime/health').get('healthy') is True
        evidence['cases'].append({'case':'actual component assertion failure retains previous healthy release','passed':True})
        evidence['passed']=True
    except Exception as error:
        evidence['error']=type(error).__name__+': '+str(error)
        raise
    finally:
        # Preserve the actual release checks even if fixture cleanup fails.
        (artifact_path('component-broker-qualification-2026-10-01.json')).write_text(json.dumps(evidence,indent=2))
        try:
            if project:api('DELETE','/projects/'+project,expected=(200,204))
            if final:
                for component in final['identities'].values():
                    remaining=subprocess.run(['docker','inspect',component['container_id']],capture_output=True,timeout=15)
                    assert remaining.returncode!=0,'Project deletion left a verified fixture container behind'
            if user:
                user=str(uuid.UUID(user));sql("DELETE FROM users WHERE id='"+user+"' AND email='component-"+run+"@example.test';")
            assert source.resolve().parent==base and source.resolve()!=base
            if source.exists():shutil.rmtree(source)
            evidence['cases'].append({'case':'safe project cleanup removes all fixture releases','passed':True})
        except Exception as error:
            evidence['cleanup_error']=type(error).__name__+': '+str(error);evidence['passed']=False
            raise
        finally:
            (artifact_path('component-broker-qualification-2026-10-01.json')).write_text(json.dumps(evidence,indent=2))
    print(json.dumps(evidence,indent=2))


if __name__=='__main__':main()
