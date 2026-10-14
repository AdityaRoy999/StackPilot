"""Durable, bounded repair and monitoring workers. PostgreSQL owns lifecycle state."""
import asyncio
import contextlib
import json
import logging
import os
import time
import uuid
from pathlib import Path
import httpx

log=logging.getLogger(__name__)


def monitoring_contract(plan):
    """Recurring probes may run only explicitly opted-in monitoring workflows."""
    return {**plan,'scenarios':plan.get('monitor_scenarios',[]),'console_scenarios':[]}

class RepairBlocked(RuntimeError):
    """A prerequisite requires intervention, not repeated source mutations."""


def database(operation):
    from .tools import get_db_connection
    connection=get_db_connection()
    try:
        with connection:
            with connection.cursor() as cursor:
                return operation(cursor)
    finally:
        connection.close()


def close_terminal_runs(cursor):
    """Fence detached repair workers in the incident transaction, including
    terminal transitions made by stale-lock reconciliation after a restart.
    Retryable incidents keep their checkpoints and existing run.
    """
    cursor.execute("""UPDATE agent_runs r SET state='canceled',lead_until=0,updated_at=%s
      FROM deployment_incidents i WHERE r.session_id=i.session_id::text
      AND r.deployment_id=i.deployment_id::text AND r.state='working'
      AND r.settings::jsonb->>'deployment_repair'='true'
      AND i.status IN ('failed','blocked','canceled','healed')
      AND NOT EXISTS(SELECT 1 FROM deployment_incidents active WHERE active.session_id=i.session_id
        AND active.status IN ('queued','running','retrying')) RETURNING r.id""", (time.time(),))
    for row in cursor.fetchall():
        cursor.execute("UPDATE agent_tasks SET state='canceled',lease_owner='',lease_until=0,updated_at=%s WHERE run_id=%s AND state IN ('queued','running','blocked','submitted')", (time.time(), row[0]))


def claim(owner):
    def work(cursor):
        cursor.execute("UPDATE deployment_incidents SET status='retrying',locked_by=NULL,locked_at=NULL,next_run_at=NOW() WHERE status='running' AND locked_at<NOW()-INTERVAL '3 minutes'")
        cursor.execute("UPDATE deployment_incidents SET status='failed',locked_by=NULL,locked_at=NULL,updated_at=NOW(),last_error='Repair retry budget exhausted' WHERE status IN ('queued','retrying') AND attempts>=3")
        cursor.execute("UPDATE deployment_incidents i SET status='canceled',locked_by=NULL,locked_at=NULL,updated_at=NOW() FROM deployments d WHERE d.id=i.deployment_id AND d.status IN ('canceled','cancelled','retired','superseded') AND i.status IN ('queued','retrying','running')")
        cursor.execute("""UPDATE deployment_incidents i SET status='canceled',locked_by=NULL,locked_at=NULL,updated_at=NOW(),last_error='Superseded by a newer deployment job'
          FROM deployments d WHERE d.id=i.deployment_id AND i.status IN ('queued','retrying')
          AND i.source_job_id<>'' AND i.source_job_id NOT LIKE 'manual:%%'
          AND d.job_id IS NOT NULL AND i.source_job_id<>d.job_id::text
          AND NOT EXISTS(SELECT 1 FROM deployment_jobs j WHERE j.id=d.job_id
            AND j.metadata->>'ai_session_id'=i.session_id::text
            AND j.metadata->>'ai_repair'='true')""")
        close_terminal_runs(cursor)
        cursor.execute("""UPDATE ai_sessions s SET status=CASE i.status
          WHEN 'healed' THEN 'healed' WHEN 'blocked' THEN 'blocked'
          WHEN 'canceled' THEN 'canceled' WHEN 'failed' THEN 'failed' ELSE 'healing' END,
          updated_at=NOW()
          FROM deployment_incidents i WHERE i.session_id=s.id
          AND i.status IN ('blocked','canceled','failed') AND s.status='healing'""")
        # Reconcile older runs which left only empty progress rows. This also
        # covers a worker crash between exhausting the lease budget and a chat
        # publish; it is idempotent because a visible message suppresses it.
        cursor.execute("""INSERT INTO ai_messages(session_id,role,content,metadata)
          SELECT i.session_id,'assistant',
            CASE WHEN i.last_error LIKE '%HTTP 410%' THEN
              'The configured AI model is no longer available (HTTP 410). Choose an active model and retry recovery.'
            ELSE 'Deployment recovery ended without a verified live deployment. Review the deployment logs and retry after addressing the reported blocker.' END,
            jsonb_build_object('healing_event',i.status,'attempt',i.attempts)
          FROM deployment_incidents i WHERE i.status IN ('failed','blocked') AND i.session_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM ai_messages m WHERE m.session_id=i.session_id AND LENGTH(TRIM(m.content))>0)""")
        cursor.execute("""WITH candidate AS (
          SELECT i.id FROM deployment_incidents i JOIN deployments d ON d.id=i.deployment_id
          WHERE i.status IN ('queued','retrying') AND i.next_run_at<=NOW() AND i.attempts<3
          AND d.status NOT IN ('canceled','cancelled','retired','superseded')
          AND NOT EXISTS(SELECT 1 FROM deployment_jobs j WHERE j.deployment_id=d.id AND j.status IN ('queued','running','retrying'))
          ORDER BY i.created_at FOR UPDATE OF i SKIP LOCKED LIMIT 1)
          UPDATE deployment_incidents i SET status='running',attempts=attempts+1,locked_by=%s,locked_at=NOW(),updated_at=NOW()
          FROM candidate WHERE i.id=candidate.id RETURNING i.id::text,i.deployment_id::text,i.user_id::text,i.attempts,i.last_error,i.session_id::text""",(owner,))
        row=cursor.fetchone()
        return dict(zip(('id','deployment_id','user_id','attempt','error','session_id'),row)) if row else None
    return database(work)


def finish(incident, owner, status, evidence, error=''):
    def work(cursor):
        cursor.execute("UPDATE deployment_incidents SET status=%s,evidence=%s::jsonb,last_error=%s,locked_by=NULL,locked_at=NULL,next_run_at=NOW()+INTERVAL '60 seconds',updated_at=NOW() WHERE id=%s AND status='running' AND locked_by=%s AND attempts=%s",(status,json.dumps(evidence),error[:4000],incident['id'],owner,incident['attempt']))
        if cursor.rowcount != 1:
            return False
        # Keep the visible chat state in the same transaction as the incident.
        # A separate status publish can fail or the worker can restart between
        # commits, leaving the badge stuck at "healing" forever.
        cursor.execute("UPDATE ai_sessions s SET status=%s,updated_at=NOW() FROM deployment_incidents i WHERE i.id=%s AND s.id=i.session_id",(session_status_for_incident(status),incident['id']))
        if status in {'failed','blocked','canceled','healed'}:
            close_terminal_runs(cursor)
        if status in {'failed','blocked'}:
            reason = ('The selected AI model is unavailable (provider HTTP 410). Choose an active model and retry recovery.'
                      if 'HTTP 410' in error else
                      'Recovery stopped before a verified deployment was produced. '+error[:1000])
            cursor.execute("INSERT INTO ai_messages(session_id,role,content,metadata) SELECT session_id,'assistant',%s,%s::jsonb FROM deployment_incidents WHERE id=%s AND session_id IS NOT NULL",(reason,json.dumps({'healing_event':status,'attempt':incident['attempt']}),incident['id']))
        return True
    return database(work)


def session_status_for_incident(status):
    """Map durable incident states to the status presented by the chat UI."""
    if status in {'queued', 'running', 'retrying'}:
        return 'healing'
    if status == 'healed':
        return 'healed'
    if status == 'blocked':
        return 'blocked'
    if status == 'canceled':
        return 'canceled'
    return 'failed'


def publish_session_update(incident, status, content='', metadata=None):
    """Synchronize an incident transition with its durable chat session."""
    def work(cursor):
        session_id = incident.get('session_id')
        if not session_id:
            cursor.execute("SELECT session_id::text FROM deployment_incidents WHERE id=%s", (incident['id'],))
            row = cursor.fetchone()
            session_id = row[0] if row and row[0] else None
        if not session_id:
            return False
        cursor.execute(
            "UPDATE ai_sessions SET status=%s,updated_at=NOW() WHERE id=%s",
            (session_status_for_incident(status), session_id),
        )
        if content:
            event = {'healing_event': status, 'attempt': incident.get('attempt')}
            event.update(metadata or {})
            cursor.execute(
                "INSERT INTO ai_messages(session_id,role,content,metadata) VALUES(%s,'assistant',%s,%s::jsonb)",
                (session_id, content, json.dumps(event)),
            )
        return True
    return database(work)


async def heartbeat(incident, owner):
    while True:
        await asyncio.sleep(20)
        def renew(cursor):
            cursor.execute("UPDATE deployment_incidents i SET locked_at=NOW() FROM deployments d WHERE i.id=%s AND i.status='running' AND i.locked_by=%s AND i.attempts=%s AND d.id=i.deployment_id AND d.status NOT IN ('canceled','cancelled') RETURNING i.id",(incident['id'],owner,incident['attempt']))
            return bool(cursor.fetchone())
        if not await asyncio.to_thread(database,renew):
            raise RuntimeError('Repair incident ownership or deployment authorization was revoked')


def session(incident, owner):
    def work(cursor):
        cursor.execute("SELECT d.project_id::text,p.name,d.status,d.runtime_snapshot FROM deployments d JOIN projects p ON p.id=d.project_id WHERE d.id=%s AND has_project_access(p.id,%s,'admin')",(incident['deployment_id'],incident['user_id']))
        row=cursor.fetchone()
        if not row: raise RepairBlocked('Repair requires current project administration access')
        project_id,name,status,snapshot=row
        snapshot=snapshot or {}
        sid=incident['session_id']
        if not sid:
            cursor.execute("INSERT INTO ai_sessions(user_id,project_id,deployment_id,title,session_type,status) VALUES(%s,%s,%s,%s,'sre_incident','healing') RETURNING id::text",(incident['user_id'],project_id,incident['deployment_id'],'Deployment recovery: '+name))
            sid=cursor.fetchone()[0]
            cursor.execute("UPDATE deployment_incidents SET session_id=%s WHERE id=%s AND locked_by=%s",(sid,incident['id'],owner))
        else:
            cursor.execute("UPDATE ai_sessions SET status='healing',updated_at=NOW() WHERE id=%s",(sid,))
        progress = 'Inspecting deployment evidence' if incident['attempt'] == 1 else 'Retrying recovery attempt '+str(incident['attempt'])+' of 3'
        cursor.execute(
            "INSERT INTO ai_messages(session_id,role,content,metadata) VALUES(%s,'assistant',%s,%s::jsonb) RETURNING id::text",
            (sid, progress, json.dumps({'healing_event':'running','attempt':incident['attempt']})),
        )
        message_id=cursor.fetchone()[0]
        plan = snapshot.get('deployment_plan') or {}
        requires_worker = plan.get('requires_worker') if isinstance(plan, dict) else None
        return sid,message_id,project_id,name,requires_worker
    return database(work)


async def repair(incident, owner):
    from .tools import execute_tool_call

    sid,message_id,project_id,name,requires_worker=await asyncio.to_thread(session,incident,owner)
    incident['session_id']=sid
    backend=(os.getenv('BACKEND_INTERNAL_URL') or 'http://backend:8090').rstrip('/')
    async with httpx.AsyncClient(timeout=10,trust_env=False) as client:
        response=await client.post(backend+'/api/v1/ai/tools/execute',headers={'X-StackPilot-Service-Token':os.getenv('STACKPILOT_AI_SERVICE_TOKEN','')},json={'tool_name':'_internal_repair_settings','arguments':{},'user_id':incident['user_id']})
        response.raise_for_status();settings=response.json()
    if settings.get('error'):raise RuntimeError('Repair owner settings unavailable')
    if not settings.get('enabled'):
        await asyncio.to_thread(finish,incident,owner,'blocked',{},'AI repair is disabled for the owner')
        return
    if requires_worker:
        raise RepairBlocked('The required '+str(requires_worker)+' worker is unavailable; source changes cannot replace that capability')
    # Provider catalogs change independently of stored preferences. Resolve a
    # retired model before spending the recovery budget on identical 410s.
    from .main import provider_config, model_catalog, model_mode_for, redact_text
    selected_model=settings.get('model') or ''
    provider,base_url,api_key,selected_model=provider_config(
        settings.get('provider'),selected_model,None,settings.get('provider_overrides') or {})
    catalog=await model_catalog(provider,base_url,api_key,selected_model)
    from .agent_runtime.models import select_repository_planner
    available={item['id'] for item in catalog.get('models',[])}
    candidates=[os.getenv('NVIDIA_NIM_AGENT_PLANNER_MODEL',''),os.getenv('NVIDIA_NIM_BROWSER_PLANNER_MODEL','')]
    if catalog.get('source')=='provider':candidates=[m for m in candidates if m in available]
    selected_model,notice=select_repository_planner(provider,selected_model,{},candidates)
    if notice:
        await asyncio.to_thread(database,lambda cursor:cursor.execute(
            "INSERT INTO ai_messages(session_id,role,content,metadata) VALUES(%s,'assistant',%s,%s::jsonb)",
            (sid,notice,json.dumps({'healing_event':'model_fallback','reason':'required_native_tools','attempt':incident['attempt']}))))
    if catalog.get('source')=='provider':
        available=[item['id'] for item in catalog['models']]
        if selected_model and selected_model not in available:
            family=selected_model.split('/',1)[0]+'/' if '/' in selected_model else ''
            matching_family=[model for model in available if family and model.startswith(family)]
            same_mode=[model for model in available if model_mode_for(model)==model_mode_for(selected_model)]
            replacement=([model for model in matching_family if model in same_mode] or
                         same_mode or matching_family or available)[0]
            await asyncio.to_thread(database,lambda cursor:cursor.execute(
                "INSERT INTO ai_messages(session_id,role,content,metadata) VALUES(%s,'assistant',%s,%s::jsonb)",
                (sid,'The configured model is no longer listed by the provider. Switching recovery to '+replacement+'.',json.dumps({'healing_event':'model_fallback','attempt':incident['attempt']}))))
            selected_model=replacement
    def latest_failure(cursor):
        cursor.execute("""SELECT RIGHT(COALESCE(d.logs,''),4000),COALESCE(j.last_error,'')
          FROM deployments d LEFT JOIN deployment_jobs j ON j.id=d.job_id WHERE d.id=%s""",(incident['deployment_id'],))
        row=cursor.fetchone()
        return '\n'.join(part for part in row if part) if row else ''
    def build_failure_log():
        # The detailed Docker failure is written to the deployment's owned
        # build log; deployment summary rows may contain only a plan header.
        path=Path('/app/uploads/builds')/str(uuid.UUID(incident['deployment_id']))/'build.log'
        if not path.is_file() or path.is_symlink():
            return ''
        with path.open('rb') as source:
            source.seek(0,os.SEEK_END)
            source.seek(max(0,source.tell()-8192))
            return source.read().decode('utf-8',errors='replace')
    try:
        detailed_failure=await asyncio.to_thread(build_failure_log)
    except OSError:
        detailed_failure=''
    failure_evidence=redact_text((detailed_failure or await asyncio.to_thread(database,latest_failure) or incident['error'] or '')[-4000:])
    # Resume an already queued rebuild after a worker restart. Do not edit its
    # immutable source or spend another provider turn on the same running job.
    def existing_job(cursor):
        cursor.execute("SELECT j.id::text,j.status,j.metadata->'runtime_verification',d.status FROM deployments d JOIN deployment_jobs j ON j.id=d.job_id WHERE d.id=%s AND j.metadata->>'ai_session_id'=%s",(incident['deployment_id'],sid))
        return cursor.fetchone()
    previous=await asyncio.to_thread(database,existing_job)
    if previous and previous[1]=='completed' and (previous[2] or {}).get('verified') is True and previous[3] in {'running','ready'}:
        await asyncio.to_thread(finish,incident,owner,'healed',{'job_id':previous[0],'runtime_verification':previous[2]})
        return
    if previous and previous[1] in {'queued','running','retrying'}:
        awaited=await execute_tool_call('wait_for_deployment',{'deployment_id':incident['deployment_id'],'job_id':previous[0],'timeout_seconds':480},incident['user_id'])
        if awaited.get('verified') is True and awaited.get('job_status')=='completed':
            if await asyncio.to_thread(finish,incident,owner,'healed',awaited):
                await asyncio.to_thread(database,lambda cursor:cursor.execute("UPDATE ai_sessions SET status='healed',updated_at=NOW() WHERE id=%s",(sid,)))
            return
        if awaited.get('job_status') in {'queued','running','retrying'}:
            raise RuntimeError('Previous repair rebuild is still running; a second repair was not started')
    payload={'user_id':incident['user_id'],'project_id':project_id,'deployment_id':incident['deployment_id'],
             'session_id':sid,'provider':settings.get('provider'),'model':selected_model,
             'workflow_type':'sre_incident','model_mode':'thinking','agent_access_mode':'full_access',
             'provider_overrides':settings.get('provider_overrides') or {},'allow_agent_questions':False,
             'project':{'id':project_id,'name':name},'deployment':{'id':incident['deployment_id']},
             'runtime':{'incident_id':incident['id']},'message':
             'Diagnose and repair this deployment using observed logs and source. Analyze the repository first. '
             'Read get_project_context for the selected branch, commit, environment, runtime placement, dotenv keys, and configured variable scopes. Values remain private to the executor, which overlays project variables, selected-environment variables, project credentials, then environment credentials. Preserve the exact environment and branch on every rebuild. Development may use local dependencies while production uses hosted services; local runtime placement does not imply local databases. Use check_service_connection with variable names and credential-key references to diagnose external linking. Fix or create source/configuration files as needed; never fabricate values or silently replace persistent production services with empty local databases. '
             'Distinguish a build failure from endpoint selection or verification failure; inspect the configured primary_service, health.path, workload, and actual routes before unrelated package changes. In stackpilot.json HTTP health is {"health":{"path":"/actual-route","statuses":[200]}}. Use workload api for a Compose API endpoint; web requires a real rendered application. '
             'Call get_completion_status first: a repair plan may already preserve the declared production build or original deployed service tests with an admitted SDK. Use that plan instead of inventing replacement checks. Inspect vercel.json, render.yaml and existing hosted-service URLs. A production frontend with external API/database dependencies must retain those connections and API rewrites; do not deploy its development Compose API/database or run acceptance for externally hosted source. Respect deployment_mode=dockerfile and static_frontend when selected by the runtime. Repair deployment readiness first, then unrelated quality improvements in a separate task. A failed declared acceptance check still needs a real fix. '
             'For worker tests select the component root (for example apps/api), use argv arrays, and prepare declared dependencies in the SAME disposable worker with setup or automatic test preparation. Separate calls lose installed dependencies. Inspect get_execution_capabilities before requesting network or instance resources; available network is a tool option, not a missing prerequisite. '
             'Acceptance workers start from clean source, without build directories or prior installed dependencies. Inspect the original Dockerfile for required native compilers and SDKs. Create/build native dependencies in setup before testing. If an independent check failed because its frozen SDK/setup was wrong, call verify_agent_source with repair_environment=true, an admitted SDK image, setup argv arrays and the required network flag; this changes only execution prerequisites, never the frozen test commands or expected outputs. Do not keep replaying a missing directory or quote a whole script as a command name. '
             'Preserve the original application behavior and deployment target. A detected CLI must use workload cli with its real argv entrypoint, '
             'not an invented web server. Finite jobs require workload job and an explicit command; packages require a tested build_recipe and explicit outputs. '
             'If the previous inferred workload is wrong, correct the delivery contract rather than rewriting application behavior. '
             'Run the existing independent source verification before rebuilding; add console_scenarios for interactive input/output. Avoid adding unrelated requirements or tests to a narrowly scoped deployment configuration repair. '
             'Do not disable tests, replace the app with a placeholder, suppress build failures or change unrelated files. '
             'Apply the smallest justified fix, call workspace_trigger_rebuild and wait for that exact job. '
             'For desktop Python, the existing desktop runtime provides Xvfb, a window manager and a noVNC viewer. Keep the original Python argv entrypoint; do not nest xvfb-run, replace the runtime CMD, add tail loops or invent an HTTP server. Lead file edits are already integrated; integrate_agent_patch only accepts IDs from actual submitted worker patches. '
             'Missing infrastructure, signing keys or credentials must be reported as blocked. '
             'Recovery context: '+redact_text(str(incident.get('error') or '')[:2000])+'\nObserved failure evidence: '+failure_evidence}
    token=os.getenv('STACKPILOT_AI_SERVICE_TOKEN','')
    metadata={'reasoning':'','tool_calls':[],'tool_steps':[],'healing_event':'running',
              'healing':{'state':'running','attempt':incident['attempt']}}
    content='';last_flush=0
    def persist(cursor):
        visible_content=content if content.strip() else ''
        cursor.execute("UPDATE ai_messages SET content=CASE WHEN %s<>'' THEN %s ELSE COALESCE(NULLIF(content,''),'Inspecting deployment evidence') END,metadata=%s::jsonb WHERE id=%s AND EXISTS(SELECT 1 FROM deployment_incidents WHERE id=%s AND locked_by=%s AND status='running')",(visible_content,visible_content,json.dumps(metadata),message_id,incident['id'],owner))
    async with httpx.AsyncClient(timeout=httpx.Timeout(40,connect=5,read=None),trust_env=False) as client:
        async with client.stream('POST','http://127.0.0.1:8010/chat/agent/stream',headers={'X-StackPilot-Service-Token':token},json=payload) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith('data: '): continue
                data=line[6:]
                if data=='[DONE]': break
                event=json.loads(data);kind=event.get('type')
                if kind=='content':content+=event.get('delta','')
                elif kind=='reasoning':metadata['reasoning']+=event.get('delta','')
                elif kind=='tool_call':metadata['tool_calls'].append(event)
                elif kind=='tool_step':metadata['tool_steps'].append(event)
                elif kind=='tool_result':
                    for call in reversed(metadata['tool_calls']):
                        if (event.get('id') and call.get('id')==event.get('id')) or (not event.get('id') and call.get('name')==event.get('name')):
                            call['result']=event.get('result');break
                elif kind=='error':raise RuntimeError(event.get('message') or event.get('error') or 'Agent stream failed')
                elif kind=='done':content=event.get('content') or content
                if len(metadata['tool_steps'])>200:metadata['tool_steps']=metadata['tool_steps'][-200:]
                content=content[-100000:]
                metadata['reasoning']=metadata['reasoning'][-100000:]
                metadata['tool_calls']=metadata['tool_calls'][-100:]
                if time.monotonic()-last_flush>2 or kind in {'tool_result','tool_step','done'}:
                    await asyncio.to_thread(database,persist);last_flush=time.monotonic()
    await asyncio.to_thread(database,persist)
    def evidence(cursor):
        cursor.execute("SELECT j.id::text,j.status,j.metadata->'runtime_verification',d.status FROM deployments d JOIN deployment_jobs j ON j.id=d.job_id WHERE d.id=%s AND j.metadata->>'ai_session_id'=%s",(incident['deployment_id'],sid))
        return cursor.fetchone()
    row=await asyncio.to_thread(database,evidence)
    verified=bool(row and row[1]=='completed' and (row[2] or {}).get('verified') is True and row[3] in {'running','ready'})
    outcome={'job_id':row[0] if row else None,'runtime_verification':row[2] if row else None,'verified':verified}
    from .agent_runtime.command_failures import failure_summary
    last_failure = next((call for call in reversed(metadata['tool_calls']) if isinstance(call.get('result'),dict) and
        (call['result'].get('error') or call['result'].get('status') in {'failed','blocked','denied'} or
         (call['result'].get('exit_code') is not None and call['result']['exit_code'] != 0))), None)
    reason = 'Repair has no completed, verified job for this session'
    if last_failure:
        result = last_failure['result']
        detail = {'name':last_failure.get('name'), 'status':result.get('status'),
                  'exit_code':result.get('exit_code'), 'reason':redact_text(failure_summary(result))}
        outcome['last_tool_failure'] = detail
        reason += '; '+str(detail['name'])+': '+detail['reason']
    state='healed' if verified else 'retrying' if incident['attempt']<3 else 'failed'
    changed=await asyncio.to_thread(finish,incident,owner,state,outcome,'' if verified else reason)
    if changed:
        if verified:
            await asyncio.to_thread(publish_session_update,incident,'healed')
        elif state == 'retrying':
            await asyncio.to_thread(
                publish_session_update,
                incident,
                'retrying',
                'Verification has not passed yet. StackPilot will retry recovery automatically.',
                {'verified':False},
            )
        else:
            await asyncio.to_thread(
                publish_session_update,
                incident,
                'failed',
                'Auto-healing stopped because no completed, verified deployment was produced.',
                {'verified':False},
            )


async def repair_worker():
    owner='ai-'+uuid.uuid4().hex
    while True:
        try:
            incident=await asyncio.to_thread(claim,owner)
            if not incident:
                await asyncio.sleep(5);continue
            work=asyncio.create_task(repair(incident,owner));lease=asyncio.create_task(heartbeat(incident,owner))
            try:
                done,_=await asyncio.wait({work,lease},timeout=600,return_when=asyncio.FIRST_COMPLETED)
                if not done:raise TimeoutError('Repair attempt deadline exceeded')
                for task in done:task.result()
            except asyncio.CancelledError:
                raise
            except RepairBlocked as exc:
                changed=await asyncio.to_thread(finish,incident,owner,'blocked',{'requires_intervention':True},str(exc))
                if changed:
                    await asyncio.to_thread(
                        publish_session_update,
                        incident,
                        'blocked',
                        'Auto-healing needs assistance before it can continue: '+str(exc),
                        {'requires_intervention':True},
                    )
            except Exception as exc:
                provider_retired='HTTP 410' in str(exc)
                next_state='blocked' if provider_retired else 'retrying' if incident['attempt']<3 else 'failed'
                changed=await asyncio.to_thread(finish,incident,owner,next_state,{},str(exc))
                if changed:
                    message=(
                        'The selected AI model is no longer available (HTTP 410). Select an active model and retry recovery.'
                        if provider_retired else
                        'The current recovery attempt stopped before verification. StackPilot will retry automatically.'
                        if next_state == 'retrying'
                        else 'Auto-healing failed after three attempts. Review the recorded recovery steps and deployment logs.'
                    )
                    await asyncio.to_thread(
                        publish_session_update,
                        incident,
                        next_state,
                        message,
                        {'error_type':type(exc).__name__},
                    )
            finally:
                work.cancel();lease.cancel()
                await asyncio.gather(work,lease,return_exceptions=True)
        except asyncio.CancelledError:raise
        except Exception as exc:
            # Never print provider settings or database credentials.
            log.warning('Deployment incident worker unavailable: %s',type(exc).__name__)
            await asyncio.sleep(10)


def monitoring_targets(owner):
    def work(cursor):
        cursor.execute("INSERT INTO deployment_monitor_leases(deployment_id) SELECT id FROM deployments WHERE status IN ('running','ready') AND runtime_paused=FALSE ON CONFLICT DO NOTHING")
        cursor.execute("""WITH due AS (
          SELECT m.deployment_id FROM deployment_monitor_leases m JOIN deployments d ON d.id=m.deployment_id
          WHERE d.status IN ('running','ready') AND d.runtime_paused=FALSE AND m.next_probe_at<=NOW()
          AND (m.locked_until IS NULL OR m.locked_until<NOW())
          ORDER BY m.next_probe_at FOR UPDATE OF m SKIP LOCKED LIMIT 32)
          UPDATE deployment_monitor_leases m SET locked_by=%s,locked_until=NOW()+INTERVAL '5 minutes',updated_at=NOW()
          FROM due WHERE m.deployment_id=due.deployment_id RETURNING m.deployment_id""",(owner,))
        claimed=[row[0] for row in cursor.fetchall()]
        if not claimed:return []
        cursor.execute("SELECT d.id::text,p.user_id::text,d.job_id::text,COALESCE(d.runtime_url,''),d.runtime_snapshot FROM deployments d JOIN projects p ON p.id=d.project_id WHERE d.id=ANY(%s::uuid[])",(claimed,))
        return cursor.fetchall()
    return database(work)


async def monitoring_worker():
    from .runtime_verification import verify_contract, verify_runtime
    slots=asyncio.Semaphore(max(1,min(16,int(os.getenv('STACKPILOT_MONITOR_CONCURRENCY','4')))))
    render_slots=asyncio.Semaphore(1)
    next_render={}
    owner=str(uuid.uuid4())
    async def renew_targets():
        while True:
            await asyncio.sleep(20)
            def renew(cursor):
                cursor.execute("UPDATE deployment_monitor_leases SET locked_until=NOW()+INTERVAL '5 minutes' WHERE locked_by=%s AND locked_until>NOW()",(owner,))
            await asyncio.to_thread(database,renew)
    async def probe(row):
        deployment,user,job,url,snapshot=row
        plan=(snapshot or {}).get('deployment_plan') or {'verification_scope':'render_smoke'}
        async with slots:
            # Cheap application contracts detect outages each cycle. Browser
            # qualification remains a promotion gate; monitoring must not
            # consume two browser sessions for every healthy app every minute.
            monitor_plan={**plan,'verification_scope':'http_contract'} if plan.get('verification_scope')=='render_smoke' else plan
            identity=(deployment,job,url)
            if plan.get('verification_scope')=='render_smoke' and time.monotonic()>=next_render.get(identity,0):
                # Release acceptance may mutate application data. Recurring
                # workflow replay requires a separately declared monitoring set.
                async with render_slots:result=await verify_runtime(url,monitoring_contract(plan))
                next_render[identity]=time.monotonic()+max(30,int(os.getenv('STACKPILOT_RENDER_MONITOR_INTERVAL','300'))) if result.get('verified') is True else 0
            elif plan.get('verification_scope')=='process':
                try:
                    async with httpx.AsyncClient(timeout=12,trust_env=False) as client:
                        response=await client.post(os.getenv('BACKEND_INTERNAL_URL','http://backend:8090')+'/api/v1/internal/runtime-observation/'+deployment,
                            headers={'x-stackpilot-service-token':os.getenv('STACKPILOT_AI_SERVICE_TOKEN','')},json={'job_id':job})
                        response.raise_for_status();result=response.json()
                except Exception as exc:result={'verified':False,'status':'unverified','scope':'process','reason':'Process verifier unavailable: '+type(exc).__name__}
            else:
                result=await verify_contract(url,monitor_plan,download_artifacts=False)
                if result.get('verified') and plan.get('workload')=='android' and (snapshot or {}).get('runtime_verification',{}).get('native',{}).get('preview_available'):
                    try:
                        worker=os.environ['STACKPILOT_ANDROID_WORKER_URL'].rstrip('/')
                        async with httpx.AsyncClient(timeout=12,trust_env=False) as client:
                            response=await client.get(worker+'/observe/'+deployment,headers={'x-stackpilot-service-token':os.getenv('STACKPILOT_AI_SERVICE_TOKEN','')})
                            response.raise_for_status();native=response.json()
                        result={**result,'native':native,'verified':native.get('verified') is True,'status':native.get('status','unverified'),'reason':native.get('reason','Native launch observation passed'),'scope':'artifact_and_native_observation','workflow_verified':False}
                    except Exception as exc:result={**result,'verified':False,'status':'unverified','reason':'Native observer unavailable: '+type(exc).__name__}
        unknown=result.get('status')=='unverified'
        healthy=result.get('verified') is True
        def record(cursor):
            cursor.execute("SELECT deployment_id FROM deployment_monitor_leases WHERE deployment_id=%s AND locked_by=%s AND locked_until>NOW() FOR UPDATE",(deployment,owner))
            if not cursor.fetchone():return
            cursor.execute("UPDATE deployment_monitor_leases SET locked_by=NULL,locked_until=NULL,next_probe_at=NOW()+(%s::text||' seconds')::interval,updated_at=NOW() WHERE deployment_id=%s",(max(15,int(os.getenv('STACKPILOT_DEPLOYMENT_MONITOR_INTERVAL','60'))),deployment))
            # Serialize observation against promotion; stale releases cannot
            # update health or enqueue repairs for the replacement release.
            cursor.execute("SELECT id FROM deployments WHERE id=%s AND job_id::text IS NOT DISTINCT FROM %s AND runtime_url=%s AND status IN ('running','ready') AND runtime_paused=FALSE FOR UPDATE",(deployment,job,url))
            if not cursor.fetchone():return
            evidence={**result,'source_job_id':job,'runtime_url':url,'health_state':'unknown' if unknown else 'healthy' if healthy else 'failed'}
            cursor.execute("INSERT INTO deployment_health_observations(deployment_id,healthy,consecutive_failures,evidence) VALUES(%s,%s,%s,%s::jsonb) ON CONFLICT(deployment_id) DO UPDATE SET healthy=EXCLUDED.healthy,consecutive_failures=CASE WHEN EXCLUDED.evidence->>'health_state'='unknown' THEN 0 WHEN EXCLUDED.healthy THEN 0 ELSE deployment_health_observations.consecutive_failures+1 END,evidence=EXCLUDED.evidence,observed_at=NOW() RETURNING consecutive_failures",(deployment,healthy,0 if healthy or unknown else 1,json.dumps(evidence)))
            failures=cursor.fetchone()[0]
            if failures>=3 and not unknown:
                cursor.execute("INSERT INTO deployment_incidents(deployment_id,user_id,source_job_id,kind,last_error) SELECT %s,%s,%s,'runtime',%s WHERE EXISTS(SELECT 1 FROM ai_preferences WHERE user_id=%s AND enabled=TRUE) ON CONFLICT DO NOTHING",(deployment,user,job or '',result.get('reason','Runtime contract failed'),user))
        await asyncio.to_thread(database,record)
    while True:
        try:
            rows=await asyncio.to_thread(monitoring_targets,owner)
            active={row[0] for row in rows}
            if len(next_render)>512:next_render={key:value for key,value in next_render.items() if key[0] in active}
            lease=asyncio.create_task(renew_targets())
            try:results=await asyncio.gather(*(probe(row) for row in rows),return_exceptions=True)
            finally:
                lease.cancel();await asyncio.gather(lease,return_exceptions=True)
            for result in results:
                if isinstance(result,Exception):log.warning('Runtime observation failed: %s',type(result).__name__)
        except asyncio.CancelledError:raise
        except Exception as exc:log.warning('Deployment monitoring unavailable: %s',type(exc).__name__)
        await asyncio.sleep(max(15,int(os.getenv('STACKPILOT_DEPLOYMENT_MONITOR_INTERVAL','60'))))
