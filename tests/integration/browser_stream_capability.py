"""Issue one short-lived capability for the disposable local stream fixture.

Run inside ai-service; no service token or capability is printed. This is a test
helper, never an HTTP endpoint or an authorization bypass in the application.
"""
import hashlib
import hmac
import json
import os
import time
import uuid
from pathlib import Path

from app.browser_ticket import verify


def main():
    key = os.environ['STACKPILOT_AI_SERVICE_TOKEN']
    session = 'stream-qa-' + uuid.uuid4().hex
    claims = {'kind': 'browser', 'session_id': session, 'user_id': 'stream-qa-owned-fixture',
              'control': True, 'expires': int(time.time()) + 300}
    payload = json.dumps(claims, sort_keys=True, separators=(',', ':')).encode()
    ticket = payload.hex() + '.' + hmac.new(key.encode(), payload, hashlib.sha256).hexdigest()
    verify(ticket, session, key)
    path = Path('/tmp/browser-stream-capability.json')
    path.write_text(json.dumps({'session': session, 'ticket': ticket}))
    path.chmod(0o600)
    print('Issued owned fixture capability for ' + session)


if __name__ == '__main__':
    main()
