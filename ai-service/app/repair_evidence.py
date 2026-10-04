"""Repair outcomes derive from executor facts, never assistant wording."""

def pending_build_wait(calls):
    for call in reversed(calls):
        result = call.get('result') or {}
        if call.get('name') in {'workspace_trigger_rebuild','trigger_build','repair_deployment'} and isinstance(result,dict) and result.get('job_id'):
            if result.get('status') not in {'rebuild_queued','build_queued'} or result.get('error'):
                return None
            job = result['job_id']
            if not any(c.get('name') == 'wait_for_deployment' and (c.get('arguments') or {}).get('job_id') == job for c in calls):
                return {'deployment_id':result['deployment_id'], 'job_id':job}
            return None
    return None

def repair_evidence(calls):
    written = []
    expected_job = None
    verified = False
    scope = 'unverified'
    reason = 'No rebuild completion and runtime verification were recorded.'
    for call in calls:
        result = call.get('result') or {}
        if not isinstance(result, dict):
            continue
        if call.get('name') in {'workspace_write_file','workspace_edit_file'} and result.get('status') in {'written','edited'} and not result.get('error'):
            written.append((call.get('arguments') or {}).get('file_path'))
        if call.get('name') in {'workspace_trigger_rebuild','trigger_build','repair_deployment'}:
            verified = False
            scope = 'unverified'
            expected_job = result.get('job_id') if result.get('status') in {'rebuild_queued','build_queued'} and not result.get('error') else None
            reason = 'Rebuild was queued but has no verified completion.' if expected_job else 'No rebuild was successfully queued.'
        if call.get('name') == 'wait_for_deployment':
            verified = bool(expected_job and result.get('job_id') == expected_job and
                result.get('job_status') == 'completed' and result.get('verified') is True and
                result.get('status') in {'running','ready'} and not result.get('error'))
            scope = result.get('verification_scope', 'unverified') if verified else 'unverified'
            reason = f'Exact rebuild completed and passed its declared runtime verification ({scope}).' if verified else 'Rebuild completion or runtime verification is missing, failed, or belongs to another job.'
    return {'verified':verified, 'job_id':expected_job, 'scope':scope, 'reason':reason, 'written_paths':written}
