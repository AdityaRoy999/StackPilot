"""Qualify asynchronous public exposure against a disposable HTTP runtime.

Run from the repository host with Docker available. Uses temporary accounts, DB rows and a runtime container;
never uses user projects, credentials or AI providers. Set
EXPOSURE_RESTART_BACKEND=1 to also verify recovery over a backend restart.
"""
import http.cookiejar
import json
import os
import secrets
import subprocess
import time
import urllib.error
import urllib.request
from urllib.parse import unquote
import uuid

FIXTURE = '''
from http.server import BaseHTTPRequestHandler,HTTPServer
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_HEAD(self):self.send_response(200);self.end_headers()
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"project_exposure_fixture":true}')
HTTPServer(('0.0.0.0',8000),Handler).serve_forever()
'''

def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, 'Docker fixture operation failed: ' + args[0]
    return result.stdout.strip()

def database(statements):
    # Database credentials remain inside the existing service container.
    script = '''import os,json,sys,psycopg2
c=psycopg2.connect(host=os.getenv('DB_HOST','postgres'),dbname=os.getenv('DB_NAME','stackpilot'),user=os.getenv('DB_USER','stackpilot_admin'),password=os.getenv('DB_PASSWORD',''))
out=[]
with c.cursor() as q:
 for sql,args in json.load(sys.stdin):
  q.execute(sql,args);out.append(q.fetchall() if q.description else [])
c.commit();c.close();print(json.dumps(out,default=str))'''
    result=subprocess.run(['docker','exec','-i','stackpilot-ai-service','python','-c',script],input=json.dumps(statements),capture_output=True,text=True,timeout=20)
    assert result.returncode==0, 'Fixture database operation failed'
    return json.loads(result.stdout)

class API:
    def __init__(self):
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.cookies))
    def call(self, method, path, body=None, expected=(200,201,202), through_frontend=False):
        headers = {'Content-Type':'application/json', 'Origin':'http://localhost:3000', 'X-stackpilot-CSRF':'1'}
        token = next((unquote(c.value) for c in self.cookies if c.name=='token'),None)
        if token:headers['Authorization']='Bearer '+token
        base='http://127.0.0.1:3000/api' if through_frontend else 'http://127.0.0.1:8090/api/v1'
        request=urllib.request.Request(base+path,method=method,headers=headers,data=json.dumps(body).encode() if body is not None else None)
        try:
            with self.opener.open(request,timeout=20) as response:status,data=response.status,json.load(response)
        except urllib.error.HTTPError as error:status,data=error.code,json.load(error)
        assert status in expected, f'{method} {path}: HTTP {status} '+data.get('error','')
        return data

def await_ready(api, path):
    deadline=time.monotonic()+190
    while time.monotonic()<deadline:
        try:state=api.call('GET',path)
        except (urllib.error.URLError,ConnectionError):time.sleep(.5);continue
        assert state['state']!='failed', state.get('error','Exposure failed')
        assert 'configuration_encrypted' not in state and 'requested_by' not in state
        if state['state']=='ready':return state
        time.sleep(.5)
    raise AssertionError('Project tunnel did not become ready')

def verify_observation_race(api, deployment, public_url):
    # Hold an uncommitted ingress update while the real runtime-status request
    # reads the old URL. Release it only after that request waits on our row.
    # The observer must preserve and return the newly committed URL.
    script='''import os,sys,json,threading,time,urllib.request,psycopg2
args=json.load(sys.stdin)
def connect():return psycopg2.connect(host=os.getenv('DB_HOST','postgres'),dbname=os.getenv('DB_NAME','stackpilot'),user=os.getenv('DB_USER','stackpilot_admin'),password=os.getenv('DB_PASSWORD',''))
c,monitor=connect(),connect();done=threading.Event();result={}
try:
 with c.cursor() as q:
  q.execute("UPDATE deployments SET runtime_url=%s,runtime_snapshot=jsonb_set(runtime_snapshot,'{runtime_url}',to_jsonb(%s::text),true) WHERE id=%s",(args['url'],args['url'],args['id']))
 def observe():
  try:
   opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
   request=urllib.request.Request('http://backend:8090/api/v1/deployments/'+args['id']+'/kubernetes/status',headers={'Authorization':'Bearer '+args['token']})
   with opener.open(request,timeout=15) as response:result.update(json.load(response))
  except Exception as error:result['error']=type(error).__name__
  finally:done.set()
 worker=threading.Thread(target=observe,daemon=True);worker.start();blocked=False;deadline=time.monotonic()+8
 while time.monotonic()<deadline:
  with monitor.cursor() as q:
   q.execute('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE %s=ANY(pg_blocking_pids(pid)))',(c.get_backend_pid(),));blocked=q.fetchone()[0]
  monitor.rollback()
  if blocked or done.is_set():break
  time.sleep(.05)
 assert blocked,'Runtime observation did not reach the controlled concurrency point'
 c.commit();assert done.wait(8),'Runtime observation did not complete'
 assert result.get('runtime',{}).get('runtime_url')==args['url'],'Observation returned an obsolete runtime address'
 with monitor.cursor() as q:
  q.execute('SELECT runtime_url FROM deployments WHERE id=%s',(args['id'],));assert q.fetchone()[0]==args['url'],'Observation overwrote the confirmed public address'
 print(json.dumps({'observation_race':'passed'}))
finally:c.rollback();c.close();monitor.close()
'''
    token=next(unquote(cookie.value) for cookie in api.cookies if cookie.name=='token')
    result=subprocess.run(['docker','exec','-i','stackpilot-ai-service','python','-c',script],input=json.dumps({'id':deployment,'url':public_url+'/verified','token':token}),capture_output=True,text=True,timeout=25)
    assert result.returncode==0, 'Runtime observation concurrency regression: '+result.stderr
    assert json.loads(result.stdout)['observation_race']=='passed'

def main():
    tag=uuid.uuid4().hex[:12]; name='stackpilot-exposure-qa-'+tag
    owner,outsider=API(),API(); users=[]; deployment=None; created=False
    try:
        for api,prefix in [(owner,'owner'),(outsider,'outsider')]:
            account=api.call('POST','/auth/register',dict(username='exposure-'+prefix+'-'+tag,email=prefix+'-'+tag+'@example.test',password='Fixture-'+secrets.token_hex(20)+'!aA1'))
            users.append(account['user']['id'])
        docker('run','-d','--rm','--name',name,'--network','stackpilot-runtime','--memory','64m','-p','127.0.0.1::3000','-p','127.0.0.1::8000','python:3.12-slim','python','-u','-c',FIXTURE);created=True
        info=json.loads(docker('inspect',name))[0]
        host_port=info['NetworkSettings']['Ports']['8000/tcp'][0]['HostPort']; local='http://localhost:'+host_port
        organization=owner.call('GET','/organizations')['organizations'][0]['id']
        project=database([('INSERT INTO projects(user_id,name,organization_id) VALUES(%s,%s,%s) RETURNING id',(users[0],'Exposure QA '+tag,organization))])[0][0][0]
        deployment=database([("INSERT INTO deployments(project_id,status,runtime_provider,runtime_exposure,runtime_url,remote_container_name,image_name,runtime_snapshot) VALUES(%s,'running','local_docker','local_docker',%s,%s,'python:3.12-slim',%s::jsonb) RETURNING id",(project,local,name,json.dumps({'container_port':3000,'provider':'local_docker'})))])[0][0][0]
        path='/deployments/'+deployment+'/exposure'
        outsider.call('GET',path,expected=(404,));outsider.call('POST',path,{'exposure_mode':'cloudflare_tunnel'},expected=(404,))
        owner.call('POST',path,{'exposure_mode':'unknown'},expected=(400,))
        owner.call('POST',path,{'exposure_mode':'cloudflare_tunnel','tunnel_token':'fixture-token'},expected=(400,))
        before=time.monotonic()
        queued=owner.call('POST',path,{'exposure_mode':'cloudflare_tunnel','port':3000},expected=(202,),through_frontend=True)
        response_ms=round((time.monotonic()-before)*1000)
        assert response_ms<2500 and queued['runtime_exposure']=='local_docker' and queued['runtime_url']==local
        assert owner.call('GET',path,through_frontend=True)['request_id']==queued['request_id']
        if os.getenv('EXPOSURE_RESTART_BACKEND')=='1':
            docker('restart', 'stackpilot-backend')
        ready=await_ready(owner,path);ready_ms=round((time.monotonic()-before)*1000)
        assert ready['runtime_url'].startswith('https://') and ready['runtime_exposure']=='cloudflare_tunnel'
        saved=database([("SELECT runtime_snapshot->>'container_port',runtime_snapshot->>'exposure_mode' FROM deployments WHERE id=%s",(deployment,))])[0][0]
        assert saved==['8000','cloudflare_tunnel'], 'Confirmed runtime metadata must survive refresh and repeated requests'
        public=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        used_doh=False
        try:
            with public.open(ready['runtime_url'],timeout=15) as response:assert json.load(response)['project_exposure_fixture']
        except urllib.error.URLError:
            # A freshly allocated quick hostname can still be negatively cached
            # by the Windows resolver. Verify real TLS/GET through public DoH,
            # preserving hostname validation and reporting the fallback explicitly.
            used_doh=True
            probe=subprocess.run(['docker','exec','stackpilot-backend','curl','--noproxy','*','--doh-url','https://cloudflare-dns.com/dns-query','--max-time','15','-fsS',ready['runtime_url']],capture_output=True,text=True,timeout=20)
            assert probe.returncode==0, 'Public HTTPS GET did not succeed through the DNS fallback'
            assert json.loads(probe.stdout)['project_exposure_fixture']
        verify_observation_race(owner,deployment,ready['runtime_url'])
        tunnel='stackpilot-tunnel-'+deployment
        initial=json.loads(docker('inspect',tunnel))[0]
        owner.call('POST',path,{'exposure_mode':'cloudflare_tunnel'},expected=(202,))
        reused=await_ready(owner,path)
        assert reused['runtime_url']==ready['runtime_url']
        assert json.loads(docker('inspect',tunnel))[0]['Id']==initial['Id']
        direct=owner.call('POST',path,{'exposure_mode':'direct'},expected=(200,))
        assert direct['runtime_url']==local and direct['runtime_exposure']=='local_docker'
        owner.call('POST',path,{'exposure_mode':'cloudflare_tunnel'},expected=(202,))
        owner.call('POST',path,{'exposure_mode':'direct'},expected=(200,))
        time.sleep(2)
        assert owner.call('GET',path)['runtime_exposure']=='local_docker'
        remaining=docker('ps','-a','--filter','name=^/'+tunnel+'$','--format','{{.Names}}')
        assert not remaining, 'A cancelled request must not recreate its tunnel'
        assert json.loads(docker('inspect',name))[0]['State']['Running']
        owner.call('POST',path,{'exposure_mode':'cloudflare_tunnel'},expected=(202,))
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            if docker('ps','-a','--filter','name=^/'+tunnel+'$','--format','{{.Names}}'):break
            time.sleep(.2)
        else:raise AssertionError('Expected a connector before checking deployment deletion')
        owner.call('DELETE','/deployments/'+deployment,{'delete_image':False},expected=(200,))
        time.sleep(1)
        assert not docker('ps','-a','--filter','name=^/'+tunnel+'$','--format','{{.Names}}')
        assert not docker('ps','-a','--filter','name=^/'+name+'$','--format','{{.Names}}')
        deployment=None;created=False
        print(json.dumps({'result':'passed','start_response_ms':response_ms,'public_ready_ms':ready_ms,'correct_internal_port':8000,
                          'ownership_checks':True,'named_hostname_validation':True,'idempotent_reuse':True,'cancellation':True,
                          'deployment_deletion_cleanup':True,
                          'frontend_proxy_status':True,
                          'runtime_observation_race':True,
                          'public_probe_used_doh':used_doh,
                          'backend_restart_recovery':os.getenv('EXPOSURE_RESTART_BACKEND')=='1'}),flush=True)
    finally:
        if deployment:
            try:owner.call('POST','/deployments/'+deployment+'/exposure',{'exposure_mode':'direct'})
            except Exception:pass
            subprocess.run(['docker','rm','-f','stackpilot-tunnel-'+deployment],capture_output=True)
        if created:subprocess.run(['docker','stop','-t','1',name],capture_output=True)
        if users:
            cleanup=[]
            for user in users:
                cleanup.extend([('DELETE FROM projects WHERE user_id=%s',(user,)),
                                ('DELETE FROM organizations WHERE created_by=%s AND is_personal=TRUE',(user,)),
                                ('DELETE FROM users WHERE id=%s',(user,))])
            database(cleanup)

if __name__=='__main__':main()
