"""Opt-in database lease qualification; creates and removes an owned fixture.

Run inside ai-service with PYTHONPATH=/app. No model calls or builds are made.
Run before starting incident workers: admission refuses if real incidents exist.
"""
import json
from app.tools import get_db_connection
from app.deployment_incidents import claim,finish


def main():
    connection=get_db_connection();deployment=None;sessions=[]
    def sql(query,args=(),fetch=False):
        with connection:
            with connection.cursor() as cursor:
                cursor.execute(query,args)
                return cursor.fetchone() if fetch else None
    try:
        assert sql("SELECT count(*) FROM deployment_incidents WHERE status IN ('queued','running','retrying')",fetch=True)[0]==0,'Real incidents are active; qualification refused'
        project,user=sql('SELECT id,user_id FROM projects ORDER BY created_at LIMIT 1',fetch=True)
        deployment=sql("INSERT INTO deployments(project_id,version,status) VALUES(%s,'incident-qualification','failed') RETURNING id::text",(project,),True)[0]
        incident=sql("INSERT INTO deployment_incidents(deployment_id,user_id,source_job_id,kind,last_error) VALUES(%s,%s,'qualification','build','isolated lease fixture') RETURNING id::text",(deployment,user),True)[0]
        session=sql("INSERT INTO ai_sessions(user_id,project_id,deployment_id,title,session_type,status) VALUES(%s,%s,%s,'Lease qualification','sre_incident','healing') RETURNING id::text",(user,project,deployment),True)[0]
        sessions.append(session)
        sql("UPDATE deployment_incidents SET session_id=%s WHERE id=%s",(session,incident))
        first=claim('fixture-worker-one');assert first['id']==incident and first['attempt']==1
        assert claim('fixture-worker-two') is None,'A healthy lease was stolen'
        assert finish(first,'wrong-owner','healed',{}) is False
        sql("UPDATE deployment_incidents SET locked_at=NOW()-INTERVAL '4 minutes' WHERE id=%s",(incident,))
        second=claim('fixture-worker-two');assert second['id']==incident and second['attempt']==2
        assert finish(first,'fixture-worker-one','healed',{}) is False,'A stale worker published success'
        assert finish(second,'fixture-worker-two','retrying',{'fixture':True}) is True
        sql("UPDATE deployment_incidents SET attempts=3,next_run_at=NOW() WHERE id=%s",(incident,))
        assert claim('fixture-worker-three') is None
        assert sql('SELECT status FROM deployment_incidents WHERE id=%s',(incident,),True)[0]=='failed'
        assert sql('SELECT status FROM ai_sessions WHERE id=%s',(session,),True)[0]=='failed'
        assert sql('SELECT count(*) FROM ai_messages WHERE session_id=%s AND LENGTH(TRIM(content))>0',(session,),True)[0]>=1
        terminal=sql("INSERT INTO deployment_incidents(deployment_id,user_id,source_job_id,kind,last_error) VALUES(%s,%s,'terminal-fixture','build','isolated provider failure') RETURNING id::text",(deployment,user),True)[0]
        terminal_session=sql("INSERT INTO ai_sessions(user_id,project_id,deployment_id,title,session_type,status) VALUES(%s,%s,%s,'Terminal qualification','sre_incident','healing') RETURNING id::text",(user,project,deployment),True)[0]
        sessions.append(terminal_session)
        sql('UPDATE deployment_incidents SET session_id=%s WHERE id=%s',(terminal_session,terminal))
        terminal_claim=claim('fixture-worker-terminal');assert terminal_claim['id']==terminal
        assert finish(terminal_claim,'fixture-worker-terminal','blocked',{},'Provider request failed (HTTP 410)') is True
        assert sql('SELECT status FROM ai_sessions WHERE id=%s',(terminal_session,),True)[0]=='blocked'
        assert sql('SELECT count(*) FROM ai_messages WHERE session_id=%s AND content LIKE %s',(terminal_session,'%HTTP 410%'),True)[0]==1
        own=sql("INSERT INTO deployment_incidents(deployment_id,user_id,source_job_id,kind) VALUES(%s,%s,'original-build','build') RETURNING id::text",(deployment,user),True)[0]
        own_session=sql("INSERT INTO ai_sessions(user_id,project_id,deployment_id,title,session_type,status) VALUES(%s,%s,%s,'Own rebuild qualification','sre_incident','healing') RETURNING id::text",(user,project,deployment),True)[0]
        sessions.append(own_session)
        sql('UPDATE deployment_incidents SET session_id=%s WHERE id=%s',(own_session,own))
        own_job=sql("INSERT INTO deployment_jobs(deployment_id,user_id,status,metadata) VALUES(%s,%s,'failed',%s::jsonb) RETURNING id::text",(deployment,user,json.dumps({'ai_repair':True,'ai_session_id':own_session})),True)[0]
        sql('UPDATE deployments SET job_id=%s WHERE id=%s',(own_job,deployment))
        own_claim=claim('fixture-worker-own-rebuild')
        assert own_claim and own_claim['id']==own,'An incident was canceled by its own AI rebuild'
        assert finish(own_claim,'fixture-worker-own-rebuild','healed',{'fixture':True}) is True
        canceled=sql("INSERT INTO deployment_incidents(deployment_id,user_id,source_job_id,kind) VALUES(%s,%s,'cancel-fixture','build') RETURNING id::text",(deployment,user),True)[0]
        sql("UPDATE deployments SET status='canceled' WHERE id=%s",(deployment,))
        assert claim('fixture-worker-three') is None
        assert sql('SELECT status FROM deployment_incidents WHERE id=%s',(canceled,),True)[0]=='canceled'
        print(json.dumps({'passed':True,'healthy_lease_not_stolen':True,'stale_lease_recovered':True,'stale_completion_rejected':True,'retry_budget_terminal':True,'visible_terminal_recovery':True,'own_rebuild_preserved':True,'cancellation_preserved':True}))
    finally:
        for session in sessions:sql('DELETE FROM ai_sessions WHERE id=%s',(session,))
        if deployment:sql('DELETE FROM deployments WHERE id=%s',(deployment,))
        connection.close()


if __name__=='__main__':main()
