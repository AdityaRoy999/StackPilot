"""Real user/session ticket and stop boundaries, without any model calls."""
from stackpilot_test_artifacts import artifact_path
import asyncio
import json
import secrets
import subprocess
import uuid
import release_pipeline_smoke as release


def sql(statement):
    process=subprocess.run(['docker','exec','-i','stackpilot-postgres','sh','-c','psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'],input=statement,text=True,capture_output=True,check=True)
    if 'ERROR:' in process.stderr:raise RuntimeError('Authorization fixture SQL failed')
    return process.stdout.strip()


async def sockets(session,ticket):
    import websockets
    origin='ws://127.0.0.1:8010/ws/browser/'
    from websockets.exceptions import InvalidStatus
    for identity,capability in ((session,''),(str(uuid.uuid4()),ticket),(session,ticket+'0')):
        try:
            async with websockets.connect(origin+identity+'?ticket='+capability,proxy=None,open_timeout=5):pass
        except InvalidStatus as exc:assert exc.response.status_code==403
        else:raise AssertionError('Browser accepted an invalid session capability')
    async with websockets.connect(origin+session+'?ticket='+ticket,proxy=None,open_timeout=5) as socket:
        await socket.send(json.dumps({'type':'ping'}))
    return True


def main():
    run=uuid.uuid4().hex[:12];users=[];session=str(uuid.uuid4())
    try:
        owner=release.api('POST','/auth/register',{'username':'ticket-owner-'+run,'email':'ticket-owner-'+run+'@example.test','password':'Fixture-'+secrets.token_hex(16)+'!aA1'})['user']['id'];users.append(owner)
        sql("INSERT INTO ai_sessions(id,user_id,title,session_type) VALUES('"+session+"','"+owner+"','Authorization qualification','agent_chat');")
        issued=release.api('GET','/ai/browser-ticket/'+session);assert issued['control'] is True
        assert asyncio.run(sockets(session,issued['ticket']))
        outsider=release.api('POST','/auth/register',{'username':'ticket-outsider-'+run,'email':'ticket-outsider-'+run+'@example.test','password':'Fixture-'+secrets.token_hex(16)+'!aA1'})['user']['id'];users.append(outsider)
        assert release.api('GET','/ai/browser-ticket/'+session,expected=(404,)).get('error')
        assert release.api('POST','/ai/chat/stop',{'session_id':session},expected=(404,)).get('error')
        assert release.api('POST','/ai/chat/stop',{'session_id':'default'},expected=(404,)).get('error')
        result={'verified':True,'scope':'browser_authorization','signed_owner_ticket_connects':True,'missing_forged_and_wrong_session_tickets_rejected':True,'outsider_ticket_and_stop_rejected':True,'unscoped_stop_rejected':True}
        (artifact_path('browser-authorization-qualification.json')).write_text(json.dumps(result,indent=2));print('BROWSER_AUTHORIZATION_PASS '+json.dumps(result),flush=True)
    finally:
        sql("DELETE FROM ai_sessions WHERE id='"+session+"';")
        for identity in users:sql("DELETE FROM users WHERE id='"+identity+"';")


if __name__=='__main__':main()
