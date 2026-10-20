"""Real phone tunnel lifecycle and pairing with a disposable account.

Run inside ai-service after deploying backend/frontend. Briefly restarts the
managed tunnel, restores its enabled state, and prints timings without URLs,
pairing secrets, passwords or tokens. No AI calls or user projects are used.
"""
import http.cookiejar
import json
import os
import secrets
import time
import urllib.error
import urllib.request
from urllib.parse import unquote
import uuid
import psycopg2


class API:
    def __init__(self, origin):
        self.origin = origin
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies), urllib.request.ProxyHandler({}))

    def call(self, method, path, body=None, token=None, expected=(200, 201)):
        headers = {'Content-Type': 'application/json', 'X-stackpilot-CSRF': '1', 'Origin': 'http://localhost:3000'}
        credential = token or next((unquote(c.value) for c in self.cookies if c.name == 'token'), None)
        if credential:
            headers['Authorization'] = 'Bearer ' + credential
        request = urllib.request.Request(self.origin + '/api/v1' + path, method=method, headers=headers,
                                         data=json.dumps(body).encode() if body is not None else None)
        try:
            with self.opener.open(request, timeout=20) as response:
                status, value = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            status, value = error.code, json.load(error)
        assert status in expected, f'{method} {path}: HTTP {status}'
        return value


def main():
    owner = API('http://backend:8090')
    uid = None
    initially_running = None
    try:
        owner.call('GET', '/remote/access', expected=(401,))
        tag = uuid.uuid4().hex[:12]
        account = owner.call('POST', '/auth/register', dict(username='tunnel-qa-' + tag,
                             email='tunnel-qa-' + tag + '@example.test', password='Fixture-' + secrets.token_hex(20) + '!aA1'))
        uid = account['user']['id']
        initial = owner.call('GET', '/remote/access')
        assert initial['available']
        initially_running = initial['running']
        stopped = owner.call('POST', '/remote/access', {'action': 'stop'})
        assert not stopped['running'] and not stopped['ready'] and not stopped['url']
        started = time.monotonic()
        owner.call('POST', '/remote/access', {'action': 'start'})
        start_response_ms = round((time.monotonic() - started) * 1000)
        deadline = started + 60
        while time.monotonic() < deadline:
            access = owner.call('GET', '/remote/access')
            if access['ready']:
                break
            time.sleep(0.5)
        else:
            raise AssertionError('Public phone gateway did not become ready within 60 seconds')
        ready_ms = round((time.monotonic() - started) * 1000)
        origin = access['url']
        warm = []
        for _ in range(5):
            before = time.monotonic()
            assert owner.call('GET', '/remote/access')['ready']
            warm.append(round((time.monotonic() - before) * 1000))
            time.sleep(0.3)
        assert owner.call('POST', '/remote/access', {'action': 'start'})['url'] == origin

        reconnected = time.monotonic()
        owner.call('POST', '/remote/access', {'action': 'restart'})
        deadline = reconnected + 60
        while time.monotonic() < deadline:
            fresh = owner.call('GET', '/remote/access')
            if fresh['ready']:
                assert fresh['url'] != origin, 'Reconnect must discard the old quick-tunnel hostname'
                origin = fresh['url']
                break
            time.sleep(0.5)
        else:
            raise AssertionError('Reconnected phone gateway did not become ready')
        reconnect_ms = round((time.monotonic() - reconnected) * 1000)

        phone = API(origin)
        pair = owner.call('POST', '/remote/pairings', {})
        credential = 'sp_remote_' + secrets.token_hex(32)
        claim = phone.call('POST', '/remote/connect', {'secret': pair['secret'], 'name': 'Tunnel startup QA'}, token=credential)
        owner.call('POST', '/remote/devices', {'id': claim['id'], 'action': 'approve', 'confirmation_code': claim['confirmation_code']})
        assert phone.call('GET', '/remote/device', token=credential)['status'] == 'approved'
        print(json.dumps({'result': 'passed', 'start_response_ms': start_response_ms, 'cold_public_ready_ms': ready_ms,
                          'reconnect_public_ready_ms': reconnect_ms,
                          'warm_status_ms': warm, 'idempotent_start': True, 'public_pairing_approval': True,
                          'unauthenticated_management_blocked': True}), flush=True)
    finally:
        if initially_running is not None:
            owner.call('POST', '/remote/access', {'action': 'start' if initially_running else 'stop'})
        if uid:
            connection = psycopg2.connect(host=os.getenv('DB_HOST', 'postgres'), dbname=os.getenv('DB_NAME', 'stackpilot'),
                                          user=os.getenv('DB_USER', 'stackpilot_admin'), password=os.getenv('DB_PASSWORD', ''))
            try:
                with connection.cursor() as cursor:
                    cursor.execute('DELETE FROM users WHERE id=%s', (uid,))
                connection.commit()
            finally:
                connection.close()


if __name__ == '__main__':
    main()
