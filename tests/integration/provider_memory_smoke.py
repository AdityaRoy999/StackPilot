"""Qualify provider isolation and streamed memory on an isolated local database.

Uses a deterministic HTTP fixture instead of a paid model. It never changes the
running backend's provider, credentials, conversations, or deployment workers.
Run: python tests/integration/provider_memory_smoke.py
"""
from stackpilot_test_artifacts import artifact_path
import http.cookiejar
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path('/tmp') if '--stub' in sys.argv else Path(__file__).resolve().parents[2]
MODEL = 'nvidia/nemotron-3-super-120b-a12b'


def fixture_server():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass

        def do_GET(self):
            records = Path('/tmp/provider-requests.json')
            body = records.read_bytes() if self.path == '/observed' and records.exists() else b'{}'
            self.send_response(200); self.end_headers(); self.wfile.write(body)

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            records = Path('/tmp/provider-requests.json')
            previous = json.loads(records.read_text()) if records.exists() else []
            previous.append({'path': self.path, **request})
            records.write_text(json.dumps(previous))
            self.send_response(200)
            if self.path == '/chat/agent/stream':
                self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                if request.get('message') == 'interrupt-fixture':
                    events = [{'type': 'content', 'delta': 'Partial unverified result'}, {'type': 'error', 'error': 'Fixture provider interrupted'}]
                else:
                    events = [{'type': 'content', 'delta': 'Saved project context.'}, {'type': 'done', 'content': 'Saved project context.', 'model': MODEL}]
                for event in events:
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode()); self.wfile.flush()
            else:
                self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(json.dumps({'models': [{'id': MODEL, 'mode': 'fast'}], 'selected_model': MODEL}).encode())
    ThreadingHTTPServer(('0.0.0.0', 18791), Handler).serve_forever()


def docker(*args, check=True):
    result = subprocess.run(['docker', *args], capture_output=True, text=True)
    if check and result.returncode:
        # Docker environment output may contain credentials: never echo it.
        raise RuntimeError('Docker qualification command failed: ' + args[0])
    return result.stdout


def main():
    suffix = uuid.uuid4().hex[:10]
    db_name = 'sp_ui_test_' + suffix
    backend = 'sp-ui-backend-' + suffix
    service = 'sp-ui-ai-' + suffix
    inspect = json.loads(docker('inspect', 'stackpilot-backend'))[0]
    environment = dict(item.split('=', 1) for item in inspect['Config']['Env'])
    network = next(iter(inspect['NetworkSettings']['Networks']))
    db_user = environment.get('DB_USER', 'stackpilot_admin')
    db_source = environment.get('DB_NAME', 'stackpilot_platform')
    psql = ['exec', 'stackpilot-postgres', 'psql', '-U', db_user, '-d', db_source, '-v', 'ON_ERROR_STOP=1', '-At', '-c']
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies), urllib.request.ProxyHandler({}))
    base = 'http://127.0.0.1:18090/api/v1'

    def api(method, path, value=None, expected=(200, 201)):
        token = next((cookie.value for cookie in cookies if cookie.name == 'token'), '')
        headers = {'Content-Type': 'application/json', 'Origin': 'http://localhost:3000', 'X-stackpilot-CSRF': '1', 'Connection': 'keep-alive'}
        if token: headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(base + path, data=json.dumps(value).encode() if value is not None else None, method=method, headers=headers)
        if path.endswith('/stream'):
            # Drogon's async response requires persistent HTTP/1.1. urllib
            # unconditionally sends Connection: close, skipping the stream.
            connection = http.client.HTTPConnection('127.0.0.1', 18090, timeout=60)
            try:
                connection.request(method, '/api/v1' + path, body=json.dumps(value), headers=headers)
                response = connection.getresponse()
                assert response.status in expected, response.status
                return response.read().decode()
            finally:
                connection.close()
        try:
            with opener.open(request, timeout=60) as response:
                status = response.status
                raw = response.read().decode()
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read().decode()
        if status not in expected: raise AssertionError(f'{method} {path}: unexpected HTTP {status}')
        return raw if path.endswith('/stream') else json.loads(raw or '{}')

    def stream(message, session_id=''):
        raw = api('POST', '/ai/chat/stream', {'message': message, 'model': MODEL, 'provider': 'openai_compatible', 'session_id': session_id})
        frames = [json.loads(line[6:]) for line in raw.splitlines() if line.startswith('data: ')]
        started = next((frame['session_id'] for frame in frames if frame.get('type') == 'start'), None)
        if not started:
            raise AssertionError('Stream did not start: ' + repr(raw[:500]))
        return started

    def wait_saved(session_id, count):
        for _ in range(40):
            result = api('GET', '/ai/sessions/' + session_id)
            if len(result.get('messages', [])) >= count: return result
            time.sleep(.1)
        raise AssertionError('Stream completion was not persisted')

    try:
        docker(*psql, 'CREATE DATABASE ' + db_name)
        with tempfile.TemporaryDirectory(prefix='stackpilot-provider-qualification-') as directory:
            values = {key: value for key, value in environment.items() if key.startswith('DB_')}
            values.update({'DB_NAME': db_name, 'JWT_SECRET': secrets.token_hex(32), 'TOKEN_ENCRYPTION_KEY': secrets.token_hex(32),
                           'STACKPILOT_AI_SERVICE_URL': 'http://' + service + ':18791', 'STACKPILOT_AUTH_REGISTRATION_MODE': 'open',
                           'STACKPILOT_JOB_WORKERS': '1', 'STACKPILOT_API_RATE_LIMIT_PER_MINUTE': '0', 'STACKPILOT_REQUIRE_HTTPS': 'false',
                           'BACKEND_PUBLIC_URL': 'http://localhost:18090', 'CORS_ALLOWED_ORIGIN': 'http://localhost:3000', 'NVIDIA_API_KEY': 'fixture-only-default'})
            env_path = Path(directory) / 'backend.env'
            env_path.write_text('\n'.join(key + '=' + value for key, value in values.items()), encoding='utf-8')
            docker('run', '-d', '--name', service, '--network', network, '-v', str(Path(__file__).resolve()) + ':/fixture.py:ro', '--entrypoint', 'python', 'stackpilot-ai-service', '/fixture.py', '--stub')
            docker('run', '-d', '--name', backend, '--network', network, '--env-file', str(env_path), '-p', '127.0.0.1:18090:8090', 'stackpilot-backend')
            for _ in range(60):
                try: api('GET', '/health'); break
                except Exception: time.sleep(.5)
            else: raise AssertionError('Isolated backend did not become healthy')
            api('POST', '/auth/register', {'username': 'qualification-' + suffix, 'email': suffix + '@example.test', 'password': 'Fixture-' + secrets.token_hex(16) + '!aA1'})
            api('PUT', '/ai/settings', {'provider': 'nvidia_nim', 'model': MODEL, 'agent_access_mode': 'full_access', 'confidence_threshold': .8})
            first = api('PUT', '/ai/settings', {'provider_connection': {'name': 'Primary fixture', 'vendor': 'openai', 'provider': 'openai_compatible', 'base_url': 'https://api.openai.com/v1', 'api_key': 'fixture-alpha', 'active': True}})['provider_connections'][0]
            second = api('PUT', '/ai/settings', {'provider_connection': {'name': 'Second fixture', 'vendor': 'nvidia', 'provider': 'nvidia_nim', 'api_key': 'fixture-beta'}})['provider_connections'][1]
            settings = api('GET', '/ai/settings')
            assert settings['agent_access_mode'] == 'full_access' and settings['model'] == MODEL
            assert len(settings['provider_connections']) == 2 and sum(c['active'] for c in settings['provider_connections']) == 1
            assert 'fixture-alpha' not in json.dumps(settings) and first['has_key']
            api('GET', '/ai/models')
            session = stream('Remember my project is Atlas')
            saved = wait_saved(session, 2)
            memory = saved['session']
            assert 'Atlas' in memory['memory_summary'] and 'Atlas' in memory['memory_graph']['preferences'][0]
            stream('Inspect deployment', session)
            wait_saved(session, 4)
            prior = api('GET', '/ai/sessions/' + session)['session']['memory_summary']
            stream('interrupt-fixture', session)
            failed = wait_saved(session, 6)
            assert failed['session']['memory_summary'] == prior
            assert failed['messages'][-1]['metadata'].get('interrupted_reason')
            history = api('GET', '/ai/sessions')['sessions'][0]
            assert history['last_provider'] == 'openai_compatible' and history['provider_connection_name'] == 'Primary fixture'
            api('PUT', '/ai/settings', {'model': MODEL})
            assert api('GET', '/ai/settings')['agent_access_mode'] == 'full_access'
            api('PUT', '/ai/settings', {'provider_connection': {'id': first['id'], 'active': False}})
            assert api('GET', '/ai/settings')['provider'] == 'nvidia_nim'
            api('GET', '/ai/models')
            defaults = json.loads(docker('exec', service, 'python', '-c', "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:18791/observed').read().decode())"))
            assert defaults[-1]['provider_overrides']['api_key'] == 'fixture-only-default'
            api('PUT', '/ai/settings', {'provider_connection': {'id': first['id'], 'active': True}})
            api('PUT', '/ai/settings', {'provider_connection': {**first, 'api_key': ''}})
            api('GET', '/ai/models')
            api('PUT', '/ai/settings', {'provider_connection': {'id': second['id'], 'active': True}})
            assert api('GET', '/ai/settings')['provider'] == 'nvidia_nim'
            api('GET', '/ai/models')
            api('PUT', '/ai/settings', {'provider_connection': {'name': 'Blocked fixture', 'provider': 'openai_compatible', 'base_url': 'http://127.0.0.1/v1'}}, expected=(400,))
            observed = json.loads(docker('exec', service, 'python', '-c', "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:18791/observed').read().decode())"))
            turns = [r for r in observed if r['path'].endswith('/stream')]
            assert turns[0]['provider_overrides']['api_key'] == 'fixture-alpha'
            assert 'Atlas' in turns[1]['memory']['summary']
            assert turns[1]['memory']['graph']['preferences'][0] == 'Remember my project is Atlas'
            assert not any(m.get('content') == 'Inspect deployment' for m in turns[1]['history'])
            assert observed[-1]['provider_overrides']['api_key'] == 'fixture-beta'
            encrypted = docker('exec', 'stackpilot-postgres', 'psql', '-U', db_user, '-d', db_name, '-At', '-c', 'SELECT api_key_encrypted FROM ai_provider_connections')
            assert 'fixture-alpha' not in encrypted and 'fixture-beta' not in encrypted
            # Metadata fixtures qualify cluster preflight without installing
            # anything on a user's saved servers or contacting a real host.
            owner = api('GET', '/auth/me')['user']['id']
            cp, alternate, worker = (str(uuid.uuid4()) for _ in range(3))
            cluster, other_cluster = str(uuid.uuid4()), str(uuid.uuid4())
            sql = f"""
              INSERT INTO ssh_connections(id,user_id,name,host,port,username,auth_type)
              VALUES('{cp}','{owner}','Control plane fixture','127.0.0.1',65534,'fixture','password'),
                    ('{alternate}','{owner}','Other control plane fixture','127.0.0.2',65534,'fixture','password'),
                    ('{worker}','{owner}','Worker fixture','127.0.0.3',65534,'fixture','password');
              INSERT INTO kubernetes_clusters(id,user_id,name,control_plane_connection_id,status)
              VALUES('{cluster}','{owner}','primary-fixture','{cp}','ready'),
                    ('{other_cluster}','{owner}','other-fixture','{alternate}','ready');
              INSERT INTO kubernetes_cluster_nodes(cluster_id,connection_id,role,status)
              VALUES('{cluster}','{cp}','server','ready'),('{other_cluster}','{worker}','agent','ready');
            """
            docker('exec', 'stackpilot-postgres', 'psql', '-U', db_user, '-d', db_name, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql)
            assert len(api('GET', '/ssh/connections')['connections']) == 3
            assert len(api('GET', '/ssh/clusters')['clusters']) == 2
            api('POST', f'/ssh/connections/{worker}/provision/kubernetes', {}, expected=(409,))
            api('POST', f'/ssh/connections/{worker}/cluster/init', {}, expected=(409,))
            api('POST', f'/ssh/connections/{cp}/cluster/join', {'worker_connection_id': worker}, expected=(409,))
            api('POST', f'/ssh/connections/{cp}/cluster/join', {'worker_connection_id': cp}, expected=(400,))
            api('POST', f'/ssh/connections/{worker}/probe', {}, expected=(400,))
            observation = next(c for c in api('GET', '/ssh/connections')['connections'] if c['id'] == worker)
            assert observation['last_probed_at'] and observation['last_probe_error']
            # A new account cannot update or activate another tenant's connection.
            cookies.clear()
            api('POST', '/auth/register', {'username': 'outsider-' + suffix, 'email': 'outsider-' + suffix + '@example.test', 'password': 'Fixture-' + secrets.token_hex(16) + '!aA1'})
            api('PUT', '/ai/settings', {'provider_connection': {'id': first['id'], 'active': True}}, expected=(404,))
            report = {'passed': True, 'model': MODEL, 'transport': 'deterministic fixture; not a model capability benchmark', 'cases': [
                'multiple encrypted provider connections', 'single active connection', 'no secrets in settings responses', 'saved-key decryption for model and stream requests',
                'blank key preserves credential', 'provider activation changes route', 'tenant isolation', 'private endpoint rejection', 'partial settings preserve permissions',
                'stream saves and reloads memory', 'preferences survive recent history window', 'current message is not duplicated', 'interrupted turn does not become successful memory',
                'history records the serving connection', 'model edits preserve the fallback provider configuration', 'saved servers and clusters exposed to builder',
                'managed worker cannot be prepared as a standalone control plane', 'worker cannot join two clusters',
                'control plane cannot join itself', 'failed host probe remains visible after reload']}
            (artifact_path('provider-memory-qualification.json')).write_text(json.dumps(report, indent=2), encoding='utf-8')
            print(json.dumps(report))
    except Exception:
        logs = subprocess.run(['docker', 'logs', backend], capture_output=True, text=True)
        for line in (logs.stdout + logs.stderr).splitlines():
            if 'AI stream' in line: print(line)
        raise
    finally:
        docker('rm', '-f', backend, check=False)
        docker('rm', '-f', service, check=False)
        docker(*psql, 'DROP DATABASE IF EXISTS ' + db_name + ' WITH (FORCE)', check=False)


if __name__ == '__main__':
    fixture_server() if '--stub' in sys.argv else main()
