"""Approval belongs to the authenticated request, never model tool arguments."""
import base64
import hashlib
import hmac
import json
import os
import time
import uuid


def argument_digest(arguments):
    return hashlib.sha256(json.dumps(arguments, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def issue(request, tool, arguments):
    key = os.getenv('STACKPILOT_AI_SERVICE_TOKEN', '')
    if not key:
        raise RuntimeError('Approval signing is not configured')
    payload = {'user':request.user_id,'session':request.session_id,'tool':tool,'arguments':argument_digest(arguments),
               'parameters':arguments if tool not in {'browser_interact','browser_interact_batch'} else None,
               'run':(request.runtime or {}).get('agent_run_id',''), 'expires':int(time.time())+600, 'nonce':str(uuid.uuid4())}
    encoded = base64.urlsafe_b64encode(json.dumps(payload,sort_keys=True,separators=(',', ':')).encode()).decode().rstrip('=')
    return encoded+'.'+hmac.new(key.encode(),encoded.encode(),hashlib.sha256).hexdigest()


def resolve(token, request, *, check_run=True):
    """Recover the exact signed action without asking a model to recreate it."""
    try:
        encoded, signature = token.split('.')
        key = os.getenv('STACKPILOT_AI_SERVICE_TOKEN', '')
        if not key or not hmac.compare_digest(signature,hmac.new(key.encode(),encoded.encode(),hashlib.sha256).hexdigest()):
            return None
        payload = json.loads(base64.urlsafe_b64decode(encoded+'='*(-len(encoded)%4)))
        if payload['expires'] < time.time() or payload['user'] != request.user_id or payload['session'] != request.session_id:
            return None
        if check_run and payload['run'] != (request.runtime or {}).get('agent_run_id',''):
            return None
        return payload
    except (ValueError, KeyError, TypeError):
        return None


def validate(token, request, tool, arguments):
    payload=resolve(token,request)
    if not payload or payload.get('tool') != tool or payload.get('arguments') != argument_digest(arguments):
        return None
    return payload


def queued_build(result):
    return isinstance(result,dict) and result.get('status') in {'rebuild_queued','build_queued'} and bool(result.get('job_id'))


def consume(token, request, tool, arguments):
    payload = validate(token or '',request,tool,arguments)
    if not payload:
        return False
    from app.tools import get_db_connection
    connection = get_db_connection()
    try:
        with connection.cursor() as cursor:
            cursor.execute('INSERT INTO agent_approvals(nonce,user_id,expires) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING RETURNING nonce',
                           (payload['nonce'],request.user_id,payload['expires']))
            accepted = cursor.fetchone() is not None
        connection.commit()
        return accepted
    finally:
        connection.close()
