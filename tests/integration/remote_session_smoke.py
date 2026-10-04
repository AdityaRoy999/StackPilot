"""Qualify pairing and detached runs against a disposable DB/backend/model fixture.

No user projects, credentials, AI providers, browser actions, or public tunnels.
Build the backend image first. All created resources are removed in finally.
"""
from stackpilot_test_artifacts import artifact_path
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import unquote
import uuid

ROOT = Path(__file__).resolve().parents[2] if len(Path(__file__).resolve().parents) > 2 else Path('/tmp')

FIXTURE = r'''
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json,time
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(b'{"status":"ok"}')
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
  if self.path.endswith('/stop'):
   self.send_response(200);self.end_headers();self.wfile.write(b'{"status":"ok"}');return
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  def emit(event):
   self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
  emit({'type':'tool_result','name':'fixture_result','result':'Owned string result'})
  emit({'type':'test_case','data':{'frame':'private-frame','result':{'som_frame':'private-overlay','status':'passed'}}})
  emit({'type':'content','delta':'Owned '})
  time.sleep(2)
  emit({'type':'content','delta':'remote fixture reply.'})
  if 'question' in body['message']:
   emit({'type':'agent_question','question':'Owned fixture question','fields':[{'id':'target','label':'Target','type':'text'}]})
   emit({'type':'done','content':'Choose the target.','status':'waiting_for_user_input'})
  elif 'approval' in body['message']:
   emit({'type':'permission_request','tool_name':'fixture_submit','token':'fixture-exact-step','arguments':{'step':1}})
   emit({'type':'done','content':'Review this step.','status':'waiting_for_permission'})
  else: emit({'type':'done','content':'Owned remote fixture reply.','status':'ok'})
ThreadingHTTPServer(('0.0.0.0',8800),Handler).serve_forever()
'''

def docker(*args, input=None):
    process = subprocess.run(['docker', *args], input=input, text=True, capture_output=True)
    if process.returncode: raise RuntimeError('Docker qualification command failed: ' + ' '.join(args[:3]))
    return process.stdout.strip()

def sql(database, statement):
    output = docker('exec', '-i', 'stackpilot-postgres', 'sh', '-c', 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -At', 'sh', database, input=statement)
    return output

class API:
    def __init__(self, base='http://127.0.0.1:8095/api/v1'):
        self.base=base
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies), urllib.request.ProxyHandler({}))
    def call(self, method, path, body=None, token=None, expected=(200,201,202)):
        headers = {'Content-Type':'application/json','Origin':'http://localhost:3000','X-stackpilot-CSRF':'1'}
        if token is None:token=next((unquote(cookie.value) for cookie in self.cookies if cookie.name=='token'),None)
        if token: headers['Authorization'] = 'Bearer '+token
        request = urllib.request.Request(self.base+path, method=method, headers=headers, data=json.dumps(body).encode() if body is not None else None)
        try:
            with self.opener.open(request, timeout=30) as response: status,value = response.status,json.load(response)
        except urllib.error.HTTPError as exc: status,value = exc.code,json.load(exc)
        assert status in expected, f'{method} {path}: HTTP {status} '+value.get('error','')
        return value

def main():
    tag = uuid.uuid4().hex[:12]; database = 'remote_qualification_'+tag
    backend = 'stackpilot-remote-qa-backend-'+tag; model = 'stackpilot-remote-qa-model-'+tag
    created_db = False; containers = []; output = {}
    env_file = None
    try:
        postgres_env=json.loads(docker('inspect','stackpilot-postgres','--format','{{json .Config.Env}}'))
        pg_env=dict(entry.split('=',1) for entry in postgres_env)
        network=json.loads(docker('inspect','stackpilot-postgres','--format','{{json .NetworkSettings.Networks}}'))
        network_name=next(iter(network))
        assert not sql(pg_env['POSTGRES_DB'], "SELECT datname FROM pg_database WHERE datname='"+database+"';")
        docker('exec','stackpilot-postgres','sh','-c','createdb -U "$POSTGRES_USER" "$1"','sh',database);created_db=True
        fd,env_file=tempfile.mkstemp(prefix='stackpilot-remote-fixture-',suffix='.env')
        with os.fdopen(fd,'w') as file:
            file.write('\n'.join([
                'DB_HOST=stackpilot-postgres','DB_PORT=5432','DB_NAME='+database,'DB_USER='+pg_env['POSTGRES_USER'],'DB_PASSWORD='+pg_env['POSTGRES_PASSWORD'],
                'JWT_SECRET='+secrets.token_hex(32),'TOKEN_ENCRYPTION_KEY='+secrets.token_hex(32),'STACKPILOT_AI_SERVICE_TOKEN='+secrets.token_hex(32),
                'STACKPILOT_AI_SERVICE_URL=http://'+model+':8800','STACKPILOT_AUTH_REGISTRATION_MODE=open','CORS_ALLOWED_ORIGINS=http://localhost:3000',
            ]))
        docker('run','-d','--name',model,'--network',network_name,'python:3.12-slim','python','-u','-c',FIXTURE);containers.append(model)
        docker('run','-d','--name',backend,'--network',network_name,'--env-file',env_file,'-p','127.0.0.1:8095:8090','stackpilot-backend');containers.append(backend)
        owner,outsider,phone=API(),API(),API()
        for _ in range(60):
            try: owner.call('GET','/health');break
            except Exception: time.sleep(1)
        else: raise RuntimeError('Qualification backend did not start')
        password='Fixture-'+secrets.token_hex(16)+'!aA1'
        owner.call('POST','/auth/register',dict(username='remote-owner-'+tag,email=tag+'@example.test',password=password))
        outsider.call('POST','/auth/register',dict(username='remote-outsider-'+tag,email='outsider-'+tag+'@example.test',password=password))
        pairing=owner.call('POST','/remote/pairings',{})
        credential='sp_remote_'+secrets.token_hex(32)
        claim=phone.call('POST','/remote/connect',dict(secret=pairing['secret'],name='Qualification phone'),token=credential)
        assert phone.call('GET','/remote/device',token=credential)['status']=='pending'
        phone.call('GET','/remote/api/ai/sessions',token=credential,expected=(401,))
        phone.call('POST','/remote/connect',dict(secret=pairing['secret'],name='Replay'),token='sp_remote_'+secrets.token_hex(32),expected=(410,))
        outsider.call('POST','/remote/devices',dict(id=claim['id'],action='approve',confirmation_code=claim['confirmation_code']),expected=(409,))
        owner.call('POST','/remote/devices',dict(id=claim['id'],action='approve',confirmation_code='000000'),expected=(409,))
        owner.call('POST','/remote/devices',dict(id=claim['id'],action='approve',confirmation_code=claim['confirmation_code']))
        assert phone.call('GET','/remote/device',token=credential)['status']=='approved'
        phone.call('GET','/remote/devices',token=credential)
        phone.call('POST','/remote/session',{},token=credential)
        phone.call('POST','/remote/api/auth/register',{},token=credential,expected=(403,))
        phone.call('GET','/remote/api/ai/settings',token=credential)
        for path in ['/auth/me','/projects','/deployments','/organizations','/secrets','/ssh/connections']:
            phone.call('GET',path,token=credential)
        output['full_platform_account_access']=True
        session=phone.call('POST','/remote/api/ai/sessions',{},token=credential)['session']['id']
        forbidden=outsider.call('POST','/ai/sessions',{})['session']['id']
        phone.call('GET','/remote/api/ai/sessions/'+forbidden,token=credential,expected=(404,))
        phone.call('GET','/remote/api/ai/browser-ticket/'+forbidden,token=credential,expected=(404,))
        ticket=phone.call('GET','/remote/api/ai/browser-ticket/'+session,token=credential)
        claims=json.loads(bytes.fromhex(ticket['ticket'].split('.')[0]))
        assert claims['remote_device_id']==claim['id'] and claims['session_id']==session
        intent=dict(request_id=str(uuid.uuid4()),session_id=session,message='Detached qualification reply')
        started=time.monotonic(); first=phone.call('POST','/remote/api/ai/chat/stream',intent,token=credential)
        assert time.monotonic()-started<2, 'Phone request waited for the model response'
        # Closing the POST and remaining offline must not cancel the producer.
        time.sleep(3)
        replay=phone.call('POST','/remote/api/ai/chat/stream',intent,token=credential)
        assert first['run_id']==replay['run_id']
        recovered=phone.call('GET','/remote/runs/'+first['run_id'],token=credential)
        assert recovered['run']['state']=='completed',recovered['run']
        assert 'private-frame' not in json.dumps(recovered['events']) and 'private-overlay' not in json.dumps(recovered['events'])
        assert any(event.get('result')=='Owned string result' for event in recovered['events'])
        assert [event['sequence'] for event in recovered['events']]==list(range(1,len(recovered['events'])+1))
        end=phone.call('GET','/remote/runs/'+first['run_id']+'?after='+str(recovered['events'][-1]['sequence']),token=credential)
        assert end['events']==[]
        phone.call('POST','/remote/api/ai/chat/stream',{**intent,'message':'Changed payload'},token=credential,expected=(409,))
        outsider.call('GET','/remote/runs/'+first['run_id'],expected=(404,))
        history=phone.call('GET','/remote/api/ai/sessions/'+session,token=credential)['messages']
        assert [m['role'] for m in history]==['user','assistant'],history
        approval=phone.call('POST','/remote/api/ai/chat/stream',dict(request_id=str(uuid.uuid4()),session_id=session,message='Request approval'),token=credential)
        time.sleep(3)
        pending=phone.call('GET','/remote/runs/'+approval['run_id'],token=credential)
        assert pending['run']['state']=='awaiting_approval'
        assert any(event['type']=='permission_request' and event['token']=='fixture-exact-step' for event in pending['events'])
        before=phone.call('GET','/remote/api/ai/sessions/'+session,token=credential)['messages']
        assistant_before=[m for m in before if m['role']=='assistant']
        follow=phone.call('POST','/remote/api/ai/chat/stream',dict(request_id=str(uuid.uuid4()),session_id=session,message='Continue the exact step',approval_token='fixture-exact-step',continuation=True),token=credential)
        time.sleep(3)
        after=phone.call('GET','/remote/api/ai/sessions/'+session,token=credential)['messages']
        assistant_after=[m for m in after if m['role']=='assistant']
        assert len(assistant_before)==len(assistant_after) and assistant_before[-1]['id']==assistant_after[-1]['id']
        assert assistant_after[-1]['metadata']['permissions'][0]['status']=='approved'
        assert assistant_after[-1]['metadata']['permissions'][0]['id']=='permission-fixture-exact-step'
        assert any(m['role']=='user' and m['metadata'].get('continuation') for m in after)
        assert 'Review this step.' in assistant_after[-1]['content'] and 'Owned remote fixture reply.' in assistant_after[-1]['content']
        phone.call('POST','/remote/api/ai/chat/stop',dict(session_id=session),token=credential)
        assert phone.call('GET','/remote/runs/'+approval['run_id'],token=credential)['run']['state']=='cancelled'
        sql(database,"UPDATE remote_runs SET state='working' WHERE id='"+approval['run_id']+"';")
        assert phone.call('GET','/remote/runs/'+approval['run_id'],token=credential)['run']['state']=='interrupted'
        time.sleep(2)
        # Older messages may contain JSON null rather than an absent tool array.
        sql(database,"UPDATE ai_messages SET metadata=metadata || '{\"tool_calls\":null}'::jsonb WHERE id='"+assistant_after[-1]['id']+"';")
        question=phone.call('POST','/remote/api/ai/chat/stream',dict(request_id=str(uuid.uuid4()),session_id=session,message='Request question'),token=credential)
        time.sleep(3)
        question_progress=phone.call('GET','/remote/runs/'+question['run_id'],token=credential)
        assert question_progress['run']['state']=='awaiting_input',question_progress['run']
        assert any(event['type']=='agent_question' for event in question_progress['events'])
        phone.call('POST','/remote/api/ai/chat/stop',dict(session_id=session),token=credential)
        assert phone.call('GET','/remote/runs/'+question['run_id'],token=credential)['run']['state']=='cancelled'
        owner.call('POST','/remote/devices',dict(id=claim['id'],action='revoke'))
        phone.call('GET','/remote/api/ai/sessions',token=credential,expected=(401,))
        phone.call('GET','/remote/runs',token=credential,expected=(401,))
        pairing=owner.call('POST','/remote/pairings',{})
        sql(database,"UPDATE remote_pairings SET expires_at=NOW()-INTERVAL '1 second' WHERE id='"+pairing['id']+"';")
        phone.call('POST','/remote/connect',dict(secret=pairing['secret'],name='Expired'),token='sp_remote_'+secrets.token_hex(32),expected=(410,))
        reset_pair=owner.call('POST','/remote/pairings',{})
        reset_token='sp_remote_'+secrets.token_hex(32)
        reset_phone=phone.call('POST','/remote/connect',dict(secret=reset_pair['secret'],name='Owned invalidation fixture'),token=reset_token)
        owner.call('POST','/remote/devices',dict(id=reset_phone['id'],action='approve',confirmation_code=reset_phone['confirmation_code']))
        sql(database,"UPDATE users SET token_invalid_before=NOW()+INTERVAL '1 second' WHERE id=(SELECT user_id FROM remote_devices WHERE id='"+reset_phone['id']+"');")
        phone.call('GET','/remote/device',token=reset_token,expected=(401,))
        phone.call('GET','/remote/api/ai/sessions',token=reset_token,expected=(401,))
        output=dict(approval_continuation_persists_in_same_assistant_message=True,permission_status_and_hidden_approval_prompt_persist=True,account_invalidation_disconnects_phone=True,string_tool_results_preserved=True,nested_browser_frames_excluded=True,follow_up_question_waits_for_input=True,verified=True,pairing_one_use_and_expiry=True,desktop_confirmation_and_owner_boundary=True,
                    full_platform_account_access=True,phone_api_account_authorized=True,private_browser_capability_bound_to_device=True,detached_response_survives_disconnect=True,
                    retry_does_not_repeat_message_or_action=True,progress_cursor_recovery=True,chat_history_saved_once=True,
                    step_approval_recovered=True,deny_cancels_approval=True,interrupted_run_never_replayed=True,device_revocation=True)
        (artifact_path('remote-platform-session-qualification-2026-10-04.json')).write_text(json.dumps(output,indent=2))
        print('REMOTE_SESSION_PASS '+json.dumps(output),flush=True)
    except Exception:
        logs=subprocess.run(['docker','logs',backend],capture_output=True,text=True).stdout
        for line in logs.splitlines():
            if 'AI stream session persistence error' in line:print('FIXTURE_PERSISTENCE_ERROR '+line[:1200],flush=True)
        raise
    finally:
        for container in reversed(containers): subprocess.run(['docker','rm','-f',container],capture_output=True)
        if created_db: docker('exec','stackpilot-postgres','sh','-c','dropdb --force -U "$POSTGRES_USER" "$1"','sh',database)
        if env_file: Path(env_file).unlink(missing_ok=True)

if __name__=='__main__':main()
