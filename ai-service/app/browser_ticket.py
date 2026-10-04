"""Short-lived capabilities issued only after backend session authorization."""
import hashlib
import hmac
import json
import time

def remote_device_active(claims):
    """Revoke ongoing phone viewers without making every video frame query SQL."""
    if not claims.get('remote_device_id'):
        return True
    from .tools import get_db_connection
    try:
        connection = get_db_connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT d.id FROM remote_devices d JOIN users u ON u.id=d.user_id WHERE d.id=%s AND d.user_id=%s AND d.status='approved' AND d.expires_at>NOW() AND (u.token_invalid_before IS NULL OR d.created_at>=u.token_invalid_before)", (claims['remote_device_id'], claims['user_id']))
                return cursor.fetchone() is not None
        finally:
            connection.close()
    except Exception:
        return False

def verify(ticket, session_id, key, now=None):
    if not key or not isinstance(ticket,str) or len(ticket)>4096:raise ValueError('Missing browser capability')
    try:
        encoded,signature=ticket.split('.')
        data=bytes.fromhex(encoded)
        if not hmac.compare_digest(hmac.new(key.encode(),data,hashlib.sha256).hexdigest(),signature):raise ValueError()
        claims=json.loads(data)
        if claims.get('kind','browser')!='browser':raise ValueError()
        current=time.time() if now is None else now
        if claims['session_id']!=session_id or not isinstance(claims['user_id'],str) or not claims['user_id']:raise ValueError()
        if type(claims['control']) is not bool or type(claims['expires']) is not int or not current<claims['expires']<=current+305:raise ValueError()
        return claims
    except (KeyError,ValueError,TypeError):raise ValueError('Invalid browser capability') from None
