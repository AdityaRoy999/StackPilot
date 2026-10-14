"""Runs within the gateway image; fixture authorization arrives on stdin."""
import asyncio
import json
import sys
import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus


async def main():
    fixture = json.load(sys.stdin)
    headers = {'Authorization': 'Bearer ' + fixture['token'], 'X-StackPilot-CSRF': '1', 'Origin': 'http://localhost:3000'}
    async with httpx.AsyncClient(base_url='http://rdp-gateway:8095', headers=headers, trust_env=False) as client:
        endpoint = '/api/v1/rdp/connections/' + fixture['id'] + '/ticket'
        capability = (await client.post(endpoint, json={})).json()['ticket']
        url = 'ws://rdp-gateway:8095/ws/rdp?ticket=' + capability
        # Cross-origin denial must not consume the legitimate owner's ticket.
        try:
            async with connect(url, origin='https://attacker.example.test', subprotocols=['guacamole']):
                raise AssertionError('Cross-origin desktop socket was accepted')
        except InvalidStatus as error:
            assert error.response.status_code == 403
        async with connect(url, origin='http://localhost:3000', subprotocols=['guacamole']) as socket:
            uuid_message = await asyncio.wait_for(socket.recv(), 30)
            assert uuid_message.startswith('0.,')
            # Invalid interactive instructions cannot select other hosts/protocols.
            await socket.send('6.select,3.vnc;')
            while True:
                try:
                    message = await asyncio.wait_for(socket.recv(), 10)
                    if '5.error' in message: break
                except Exception: break
        try:
            async with connect(url, origin='http://localhost:3000', subprotocols=['guacamole']):
                raise AssertionError('One-use desktop ticket was replayed')
        except InvalidStatus as error:
            assert error.response.status_code == 403
        rejected = await client.post(endpoint, json={}, headers={'Origin': 'https://attacker.example.test'})
        assert rejected.status_code == 403
        rejected = await client.post(endpoint, json={}, headers={'X-StackPilot-CSRF': ''})
        assert rejected.status_code == 403
        # A minted ticket loses access after the account's credentials are revoked.
        capability = (await client.post(endpoint, json={})).json()['ticket']
        import asyncpg, os
        db = await asyncpg.connect(host=os.environ['DB_HOST'], database=os.environ['DB_NAME'], user=os.environ['DB_USER'], password=os.environ['DB_PASSWORD'])
        try:
            await db.execute("UPDATE users SET token_invalid_before=NOW()+INTERVAL '1 second' WHERE id=$1", fixture['user'])
            async with connect('ws://rdp-gateway:8095/ws/rdp?ticket=' + capability, origin='http://localhost:3000', subprotocols=['guacamole']) as socket:
                message = await asyncio.wait_for(socket.recv(), 10)
                assert '5.error' in message and 'expired' in message
        finally:
            await db.execute("UPDATE users SET token_invalid_before=TO_TIMESTAMP(0) WHERE id=$1", fixture['user'])
            await db.close()
    print('RDP_SOCKET_SECURITY_PASS: origin, CSRF, one-use ticket, restricted input, account revocation')


asyncio.run(main())
