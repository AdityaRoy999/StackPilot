"""Revocation against the real, private AI WebSocket through the Remote gateway.

Uses one disposable user and an empty chat. Does not attach/navigate a browser.
"""
import asyncio
import json
import secrets
import uuid
from pathlib import Path
import websockets
from remote_session_smoke import API, docker, sql

async def verify(owner,phone,credential,session,device,ticket):
    from websockets.exceptions import ConnectionClosed, InvalidStatus
    address='ws://127.0.0.1:8094/ws/browser/'+session+'?ticket='+ticket
    async with websockets.connect(address,proxy=None,open_timeout=10) as socket:
        # The successful upgrade proves the device capability was accepted.
        # No attach message is sent, so the fixture never creates a browser tab.
        await asyncio.sleep(.2)
        owner.call('POST','/remote/devices',dict(id=device,action='revoke'))
        try:
            while True:await asyncio.wait_for(socket.recv(),4)
        except ConnectionClosed as exc:assert exc.code==1008
    phone.call('GET','/remote/api/ai/browser-ticket/'+session,token=credential,expected=(401,))
    try:
        async with websockets.connect(address,proxy=None,open_timeout=5):pass
    except InvalidStatus as exc:assert exc.response.status_code==403
    else:raise AssertionError('Revoked browser ticket was accepted again')

def main():
    tag=uuid.uuid4().hex[:12];owner=API('http://127.0.0.1:8090/api/v1');phone=API('http://127.0.0.1:8094/api/v1');uid=None
    try:
        account=owner.call('POST','/auth/register',dict(username='remote-browser-qa-'+tag,email='remote-browser-qa-'+tag+'@example.test',password='Fixture-'+secrets.token_hex(20)+'!aA1'))
        uid=account['user']['id'];pair=owner.call('POST','/remote/pairings',{});credential='sp_remote_'+secrets.token_hex(32)
        claim=phone.call('POST','/remote/connect',dict(secret=pair['secret'],name='Owned revocation fixture'),token=credential)
        owner.call('POST','/remote/devices',dict(id=claim['id'],action='approve',confirmation_code=claim['confirmation_code']))
        session=phone.call('POST','/remote/api/ai/sessions',{},token=credential)['session']['id']
        capability=phone.call('GET','/remote/api/ai/browser-ticket/'+session,token=credential)
        asyncio.run(verify(owner,phone,credential,session,claim['id'],capability['ticket']))
        result=dict(verified=True,scoped_gateway_browser_connects=True,revocation_closes_existing_viewer=True,revocation_blocks_reconnect_with_old_ticket=True,no_browser_navigation_or_model_calls=True)
        (Path(__file__).resolve().parents[2]/'docs'/'remote-browser-revocation-2026-10-03.json').write_text(json.dumps(result,indent=2))
        print('REMOTE_BROWSER_REVOCATION_PASS '+json.dumps(result))
    finally:
        if uid:
            assert str(uuid.UUID(uid))==uid
            env=dict(entry.split('=',1) for entry in json.loads(docker('inspect','stackpilot-postgres','--format','{{json .Config.Env}}')))
            sql(env['POSTGRES_DB'],"DELETE FROM users WHERE id='"+uid+"';")

if __name__=='__main__':main()
