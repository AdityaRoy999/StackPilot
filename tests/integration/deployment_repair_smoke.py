"""Opt-in real local rebuild, using the service-token tool path without an LLM.

Run inside ai-service: PYTHONPATH=/app python deployment_repair_smoke.py DEPLOYMENT_ID.
Does not edit application code. Verifies build admission, source immutability,
exact job completion, render evidence, and rejection of a superseding job.
The selected deployment must have a valid Dockerfile and a local source workspace.
"""
import asyncio
import json
import sys
import time
import uuid
from app.tools import execute_tool_call, get_db_connection


async def main(deployment_id):
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute('SELECT p.user_id FROM deployments d JOIN projects p ON p.id=d.project_id WHERE d.id=%s',(deployment_id,))
            row = cursor.fetchone()
            assert row, 'Deployment not found'
            user_id = str(row[0])
    finally:
        conn.close()
    started = time.perf_counter()
    queued = await execute_tool_call('workspace_trigger_rebuild',{'deployment_id':deployment_id},user_id)
    assert queued.get('status') == 'rebuild_queued' and queued.get('job_id'), queued
    duplicate = await execute_tool_call('workspace_trigger_rebuild',{'deployment_id':deployment_id},user_id)
    assert duplicate.get('error') and not duplicate.get('job_id'), duplicate
    guard = await execute_tool_call('workspace_write_file',{'deployment_id':deployment_id,
        'file_path':'.stackpilot-build-guard-probe','content':'must not be written'},user_id)
    assert guard.get('error') and guard.get('status') != 'written', guard
    result = await execute_tool_call('wait_for_deployment',{'deployment_id':deployment_id,
        'job_id':queued['job_id'],'timeout_seconds':600},user_id)
    print('BUILD_RESULT '+json.dumps(result),flush=True)
    assert result.get('verified') is True and result.get('job_status') == 'completed', result
    status = await execute_tool_call('get_deployment_status',{'deployment_id':deployment_id},user_id)
    assert status.get('verified') is True and status.get('job_id') == queued['job_id'], status
    assert status.get('verification_scope') == 'render_smoke', status
    stale = await execute_tool_call('wait_for_deployment',{'deployment_id':deployment_id,
        'job_id':str(uuid.uuid4()),'timeout_seconds':10},user_id)
    assert stale.get('status') == 'superseded' and stale.get('verified') is False, stale
    print('DEPLOYMENT_REPAIR_SMOKE_PASS '+json.dumps({'job_id':queued['job_id'],
        'runtime_url':result.get('runtime_url'),'elapsed_ms':round((time.perf_counter()-started)*1000),
        'duplicate_build_rejected':True,'source_edit_during_build_rejected':True,'wrong_job_rejected':True,
        'status_exposes_exact_job_evidence':True}),flush=True)


if __name__ == '__main__':
    asyncio.run(main(sys.argv[1]))
