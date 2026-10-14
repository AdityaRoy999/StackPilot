"""Capture only the owned browser context; restore storage before navigation."""
import json

from .isolation import browser_command
from .site_audit import canonical_url


async def capture_session(session, previous=None):
    if not session.browser_context_id: raise RuntimeError('An isolated browser context is required')
    cookies=await browser_command(session.config.endpoint,'Storage.getCookies',
                                  {'browserContextId':session.browser_context_id},session.config.headers)
    storage=await session.evaluate("(() => ({origin:location.origin,local:Object.fromEntries(Object.entries(localStorage)),session:Object.fromEntries(Object.entries(sessionStorage))}))()")
    origins=dict((previous or {}).get('origins') or {})
    if isinstance(storage,dict) and storage.get('origin','').startswith(('http://','https://')):
        origins[storage['origin']]={'local':storage.get('local',{}),'session':storage.get('session',{})}
    return {'cookies':cookies.get('cookies',[]),'origins':origins,'url':session.current_url,
            'tabs':[{'url':tab.get('url'),'title':tab.get('title','')} for tab in session.related_targets.values()],
            'consequential_dispatches':[{'key':list(key),'value':value} for key,value in getattr(session,'consequential_dispatches',{}).items()],
            'dispatched_inputs':getattr(session,'dispatched_inputs',0)}


async def restore_session(session, checkpoint, root):
    if not checkpoint: return
    if not session.browser_context_id: raise RuntimeError('An isolated browser context is required')
    cookies=[{key:value for key,value in cookie.items() if key in {'name','value','domain','path','expires','httpOnly','secure','sameSite','priority','sameParty','sourceScheme','sourcePort','partitionKey'}} for cookie in checkpoint.get('cookies',[])]
    if cookies:
        await browser_command(session.config.endpoint,'Storage.setCookies',
                              {'browserContextId':session.browser_context_id,'cookies':cookies},session.config.headers)
    origins=checkpoint.get('origins',{})
    source="(() => {const states="+json.dumps(origins)+"; const s=states[location.origin];if(s){for(const [k,v] of Object.entries(s.local||{}))localStorage.setItem(k,v);for(const [k,v] of Object.entries(s.session||{}))sessionStorage.setItem(k,v);}})()"
    injection=await session.send_command('Page.addScriptToEvaluateOnNewDocument',{'source':source})
    try:
        await session.navigate(canonical_url(checkpoint.get('url') or root,root) or root,force=True)
    finally:
        if injection.get('identifier'):
            await session.send_command('Page.removeScriptToEvaluateOnNewDocument',{'identifier':injection['identifier']})
    session.consequential_dispatches={tuple(entry['key']):entry['value'] for entry in checkpoint.get('consequential_dispatches',[]) if isinstance(entry,dict) and isinstance(entry.get('key'),list)}
    session.dispatched_inputs=checkpoint.get('dispatched_inputs',0)
    # Reacquire all IDs after a crash. External login transitions need review.
    for tab in checkpoint.get('tabs',[])[:8]:
        url=canonical_url(tab.get('url') or '',root)
        if url and url!=session.current_url:
            created=await browser_command(session.config.endpoint,'Target.createTarget',{'url':url,'browserContextId':session.browser_context_id},session.config.headers)
            session.related_targets[created['targetId']]={'targetId':created['targetId'],'url':url,'title':tab.get('title',''),'browserContextId':session.browser_context_id}
