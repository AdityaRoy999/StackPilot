"""Owned local qualification account/project; no existing user data is modified.

Run inside ai-service with PYTHONPATH=/app. Setup reads an owned Docker GUI
fixture via its deployment metrics API. Cleanup deletes only its saved IDs.
"""
import concurrent.futures
import json
import hashlib
import os
from pathlib import Path
import sys
import time
import uuid
import httpx
from app.tools import get_db_connection

STATE=Path('/tmp/stackpilot-metrics-probe.json')
BASE='http://backend:8090'
CONTAINER=os.getenv('METRICS_FIXTURE_CONTAINER','stackpilot-portable-desktop-qualification')


def setup(url):
    assert not STATE.exists(), 'Existing qualification state: cleanup or reuse it first'
    suffix=uuid.uuid4().hex[:12]
    account={'username':'metrics_'+suffix,'email':'metrics_'+suffix+'@example.invalid',
             'password':'Qualification-'+uuid.uuid4().hex+'!'}
    with httpx.Client(base_url=BASE,headers={'X-stackpilot-CSRF':'1','Origin':'http://localhost:3000'},timeout=25) as client:
        # An isolated test identity avoids changing the platform's closed
        # registration policy or granting access to any existing project.
        salt=os.urandom(16)
        password_hash='pbkdf2_sha256$210000$'+salt.hex()+'$'+hashlib.pbkdf2_hmac('sha256',account['password'].encode(),salt,210000).hex()
        connection=get_db_connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("INSERT INTO users(username,email,password_hash,sign_in_type) VALUES(%s,%s,%s,'local') RETURNING id",(account['username'],account['email'],password_hash))
                user=str(cursor.fetchone()[0])
            connection.commit()
        finally:connection.close()
        state={**account,'user_id':user}
        # Save ownership immediately so a failed setup can always be cleaned up.
        STATE.write_text(json.dumps(state));os.chmod(STATE,0o600)
        response=client.post('/api/v1/auth/login',json={'email':account['email'],'password':account['password']});response.raise_for_status()
        # Local deployment cookies use the public browser domain. Forward only
        # this fixture's returned session as a bearer token to the internal API.
        token=next(iter(response.cookies.values()))
        client.headers['Authorization']='Bearer '+token
        connection=get_db_connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute('SELECT id FROM organizations WHERE created_by=%s AND is_personal=TRUE',(user,))
                organization=str(cursor.fetchone()[0]);state['organization_id']=organization
                cursor.execute("INSERT INTO projects(user_id,organization_id,name,repo_url) VALUES(%s,%s,%s,%s) RETURNING id",(user,organization,'Desktop qualification','https://example.invalid/owned-fixture.git'))
                project=str(cursor.fetchone()[0])
                cursor.execute("INSERT INTO deployments(project_id,status,version,image_name,runtime_provider,remote_container_name,runtime_url,desired_replicas,runtime_snapshot) VALUES(%s,'running','qualification',%s,'local_docker',%s,%s,1,%s::jsonb) RETURNING id",
                    (project,os.getenv('METRICS_FIXTURE_IMAGE','stackpilot-portable-desktop:qualification'),CONTAINER,url,json.dumps({'archetype':'desktop_portable','deployment_plan':{'workload':'desktop'},'runtime_url':url})))
                state.update(project_id=project,deployment_id=str(cursor.fetchone()[0]))
            connection.commit();STATE.write_text(json.dumps(state))
        finally:connection.close()
        path=f"/api/v1/deployments/{state['deployment_id']}/metrics"
        observations=[]
        for _ in range(2):
            response=client.get(path);response.raise_for_status();value=response.json()
            assert value['available'] and value['summary']['memory_bytes']>0,value
            assert value['series'][0]['name']==CONTAINER,value
            observations.append(value)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            polls=[pool.submit(client.get,path) for _ in range(8)]
            time.sleep(.1)
            start=time.monotonic();health=client.get('/healthz');elapsed=(time.monotonic()-start)*1000
            health.raise_for_status()
            assert elapsed<1500, f'Health endpoint stalled behind metrics: {elapsed:.0f}ms'
            for poll in polls:poll.result().raise_for_status()
        result={'available':True,'samples':observations,'health_latency_during_8_metrics_requests_ms':round(elapsed,2)}
        Path('/tmp/stackpilot-metrics-evidence.json').write_text(json.dumps(result,indent=2))
        print(json.dumps({'deployment_id':state['deployment_id'],'email':account['email'],'health_latency_ms':round(elapsed,2)}))


def cleanup():
    state=json.loads(STATE.read_text());connection=get_db_connection()
    try:
        with connection.cursor() as cursor:
            cursor.execute('DELETE FROM projects WHERE user_id=%s',(state['user_id'],))
            cursor.execute('DELETE FROM organizations WHERE created_by=%s AND is_personal=TRUE',(state['user_id'],))
            cursor.execute('DELETE FROM users WHERE id=%s AND email=%s',(state['user_id'],state['email']))
            assert cursor.rowcount==1,'Owned qualification account not found'
        connection.commit();STATE.unlink()
    finally:connection.close()


def observe_stopped():
    state=json.loads(STATE.read_text())
    with httpx.Client(base_url=BASE,headers={'X-stackpilot-CSRF':'1','Origin':'http://localhost:3000'},timeout=25) as client:
        login=client.post('/api/v1/auth/login',json={'email':state['email'],'password':state['password']});login.raise_for_status()
        client.headers['Authorization']='Bearer '+next(iter(login.cookies.values()))
        response=client.get(f"/api/v1/deployments/{state['deployment_id']}/metrics");response.raise_for_status()
        value=response.json()
        assert value['available'] is False,value
        assert value['summary']['ready_pods']==0 and value['summary']['pod_count']==1,value
        assert value['summary']['memory_bytes'] is None and value['summary']['cpu_percent'] is None,value
        assert value['series'][0]['container_status']=='exited',value
        evidence=Path('/tmp/stackpilot-metrics-evidence.json')
        saved=json.loads(evidence.read_text());saved['stopped_container']=value;evidence.write_text(json.dumps(saved,indent=2))
        print('Stopped container correctly unavailable; readiness 0/1; no synthetic zero readings')


if __name__=='__main__':
    cleanup() if sys.argv[1]=='cleanup' else observe_stopped() if sys.argv[1]=='stopped' else setup(sys.argv[1])
