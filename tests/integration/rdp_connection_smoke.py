"""Real RDP desktop and account isolation. Cleans up only exact owned fixtures."""
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).parent))
import release_pipeline_smoke as release

ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get('STACKPILOT_NODE', 'C:/Users/adiro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')


def sql(command):
    return subprocess.run(['docker', 'exec', '-i', 'stackpilot-postgres', 'sh', '-c', 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], input=command, capture_output=True, text=True, check=True).stdout.strip()


def main():
    identities, container = [], None
    evidence = {'passed': False, 'scope': 'live_stackpilot_api_and_isolated_xrdp_fixture'}
    release.BASE = 'http://localhost:3000/api/v1'
    try:
        fixture = 'rdp-' + secrets.token_hex(5)
        container = 'stackpilot-test-' + fixture
        host = container
        password = 'Rdp-' + secrets.token_hex(8) + '!aA1'
        subprocess.run(['docker', 'run', '-d', '--name', container, '--network', 'stackpilot_rdp', '--tmpfs', '/run', '--shm-size', '128m', '--memory', '256m', 'stackpilot-rdp-test-fixture:local'], capture_output=True, check=True)
        subprocess.run(['docker', 'exec', '-i', container, 'sh', '-c', 'umask 077; cat > /run/fixture-password'], input=(password + '\n').encode(), capture_output=True, check=True)
        for _ in range(40):
            state = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]['State']
            if state['Status'] != 'running':
                raise RuntimeError('RDP fixture exited: ' + subprocess.check_output(['docker', 'logs', container], stderr=subprocess.STDOUT, text=True)[-2000:])
            probe = subprocess.run(['docker', 'exec', container, 'bash', '-c', 'exec 3<>/dev/tcp/127.0.0.1/3389'], capture_output=True)
            if probe.returncode == 0: break
            time.sleep(0.1)
        else: raise RuntimeError('RDP fixture did not become ready')
        verify_password = r'''$p=<STDIN>; chomp $p; open(F,"/etc/shadow") or die; while(<F>){ @v=split(/:/); if($v[0] eq "rdpfixture"){die "Fixture password mismatch" unless crypt($p,$v[1]) eq $v[1]; print "FIXTURE_PASSWORD_VERIFIED\n";exit;}}die;'''
        check = subprocess.run(['docker','exec','-i',container,'perl','-e',verify_password],input=(password+'\n').encode(),capture_output=True,check=True)
        print(check.stdout.decode(), flush=True)
        pam = subprocess.run(['docker','exec','-i',container,'pamtester','xrdp-sesman','rdpfixture','authenticate'],input=(password+'\n').encode(),capture_output=True)
        if pam.returncode: raise RuntimeError('Fixture PAM authentication failed: '+pam.stdout.decode()+pam.stderr.decode())
        release.api('POST', '/auth/register', {'username': fixture, 'email': fixture + '@example.test', 'password': password})
        owner = release.api('GET', '/auth/me')['user']['id']; identities.append(owner)
        token = next(cookie.value for cookie in release.cookies if cookie.name == 'token')
        owner_cookies = list(release.cookies)
        print('RDP fixture ready; testing transport', flush=True)
        if '--transport-only' in sys.argv:
            saved = release.api('POST', '/rdp/connections', {'name': 'Transport fixture', 'host': host, 'port': 3389, 'username': 'rdpfixture', 'password': password, 'security': 'tls', 'ignore_certificate': True})['connection']
            socket_script = (ROOT/'tests/integration/rdp_socket_security.py').read_text()
            command = 'import sys,json; fixture=json.load(sys.stdin); sys.stdin=__import__("io").StringIO(json.dumps(fixture)); exec(' + repr(socket_script) + ')'
            result = subprocess.run(['docker', 'exec', '-i', 'stackpilot-rdp-gateway', 'python', '-c', command], input=json.dumps({'token': token, 'id': saved['id'], 'user': owner}), text=True, capture_output=True, timeout=100)
            print(result.stdout, flush=True)
            if result.returncode: raise RuntimeError(result.stderr)
            evidence['passed'] = True; return
        # UI imports, reviews, saves, and exercises an actual RDP desktop.
        process = subprocess.run([NODE, str(ROOT/'tests/integration/rdp_desktop_ui.mjs')], input=json.dumps({'host': host, 'container': container, 'password': password, 'token': token}), text=True, cwd=ROOT, capture_output=True, timeout=180)
        print(process.stdout)
        if process.returncode:
            print(process.stderr)
            verify = '''import sys,json,asyncio,asyncpg,os,app
data=json.load(sys.stdin)
async def check():
 db=await asyncpg.connect(host=os.environ['DB_HOST'],database=os.environ['DB_NAME'],user=os.environ['DB_USER'],password=os.environ['DB_PASSWORD'])
 rows=await db.fetch('SELECT password_encrypted FROM rdp_connections WHERE user_id=$1',data['user'])
 print('SAVED_CREDENTIAL_MATCHES_FIXTURE', bool(rows) and all(app.decrypt(row['password_encrypted'])==data['password'] for row in rows))
 await db.close()
asyncio.run(check())'''
            comparison = subprocess.run(['docker','exec','-i','stackpilot-rdp-gateway','python','-c',verify],input=json.dumps({'user':owner,'password':password}),capture_output=True,text=True)
            print(comparison.stdout)
            print(subprocess.run(['docker', 'exec', container, 'tail', '-n', '25', '/var/log/xrdp-sesman.log'], capture_output=True, text=True).stdout)
            raise RuntimeError('RDP UI qualification failed; see the saved report')
        records = release.api('GET', '/rdp/connections')['connections']
        assert len(records) == 1 and password not in json.dumps(records)
        identifier = str(uuid.UUID(records[0]['id']))
        encrypted = sql("SELECT password_encrypted FROM rdp_connections WHERE id='" + identifier + "';")
        assert encrypted.startswith('enc:v1:') and password not in encrypted
        evidence['encryptedCredentials'] = True
        # Run WebSocket security with the real gateway/backend/bridge, not mocks.
        socket_script = (ROOT/'tests/integration/rdp_socket_security.py').read_text()
        command = 'import sys,json; fixture=json.load(sys.stdin); sys.stdin=__import__("io").StringIO(json.dumps(fixture)); exec(' + repr(socket_script) + ')'
        result = subprocess.run(['docker', 'exec', '-i', 'stackpilot-rdp-gateway', 'python', '-c', command], input=json.dumps({'token': token, 'id': identifier, 'user': owner}), text=True, capture_output=True, timeout=100)
        print(result.stdout)
        if result.returncode: raise RuntimeError('Socket security failed: ' + result.stderr)
        evidence['socketSecurity'] = True
        # Cross-user operations must fail even when the connection UUID is known.
        release.cookies.clear()
        other = fixture + '-other'
        release.api('POST', '/auth/register', {'username': other, 'email': other + '@example.test', 'password': password})
        identities.append(release.api('GET', '/auth/me')['user']['id'])
        assert release.api('GET', '/rdp/connections')['connections'] == []
        release.api('POST', '/rdp/connections/' + identifier + '/ticket', {}, expected=(404,))
        release.api('DELETE', '/rdp/connections/' + identifier, expected=(404,))
        evidence['accountIsolation'] = True
        release.cookies.clear()
        for cookie in owner_cookies: release.cookies.set_cookie(cookie)
        # Import rejects ambiguous input and reports unsupported features explicitly.
        source = b'full address:s:host.test\ngatewayhostname:s:gateway.test\nremoteapplicationmode:i:1\npassword 51:b:opaque-secret'
        imported = release.api('POST', '/rdp/import', {'filename': 'fixture.rdp', 'content': base64.b64encode(source).decode()})
        assert imported['unsupported'] == ['RD Gateway', 'RemoteApp'] and 'opaque-secret' not in json.dumps(imported)
        release.api('POST', '/rdp/import', {'filename': 'fixture.rdp', 'content': base64.b64encode(b'full address:s:one\nfull address:s:two').decode()}, expected=(400,))
        evidence['safeImport'] = True
        request = urllib.request.Request(release.BASE + '/rdp/connections', headers={'Origin': 'http://localhost:3000'})
        try:
            urllib.request.urlopen(request, timeout=10)
            raise AssertionError('Unauthenticated RDP request succeeded')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        evidence['requiresAuthentication'] = True
        # Password retention on edit; no credential comes back in JSON.
        edit = {key: records[0][key] for key in ('name', 'host', 'port', 'username', 'domain', 'security', 'ignore_certificate', 'keyboard_layout')}
        edit['name'] += ' edited'; edit['password'] = None
        updated = release.api('PUT', '/rdp/connections/' + identifier, edit)
        assert updated['connection']['revision'] == 2
        assert sql("SELECT password_encrypted FROM rdp_connections WHERE id='" + identifier + "';") == encrypted
        release.api('DELETE', '/rdp/connections/' + identifier)
        assert release.api('GET', '/rdp/connections')['connections'] == []
        audit = release.api('GET', '/auth/audit-logs')
        assert 'rdp.session.start' in json.dumps(audit) and password not in json.dumps(audit)
        evidence['auditAndCleanup'] = True; evidence['passed'] = True
        print('RDP_CONNECTION_LIVE_PASS')
    finally:
        report_name = 'rdp-transport-security.json' if '--transport-only' in sys.argv else 'rdp-connection-live.json'
        (ROOT/'tests/artifacts'/report_name).write_text(json.dumps(evidence, indent=2))
        if container:
            subprocess.run(['docker', 'rm', '-f', container], check=True, capture_output=True)
        for identity in identities:
            identity = str(uuid.UUID(identity))
            sql("DELETE FROM organizations WHERE is_personal AND id IN (SELECT organization_id FROM organization_members WHERE user_id='" + identity + "' AND role='owner'); DELETE FROM users WHERE id='" + identity + "';")


if __name__ == '__main__':
    main()
