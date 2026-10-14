"""Readiness observes dependencies; liveness alone never asserts deployability."""
import asyncio
import os
import httpx


async def observe():
    from .tools import get_db_connection
    def database():
        connection=get_db_connection()
        try:
            with connection.cursor() as cursor:cursor.execute('SELECT 1');return cursor.fetchone()[0]==1
        finally:connection.close()
    async def browser(url, remote=False):
        async with httpx.AsyncClient(timeout=3,trust_env=False) as client:
            response=await client.get(url.rstrip('/')+'/json/version',
                                      headers={'Host':'localhost'} if remote else None)
            return response.status_code==200 and bool(response.json().get('webSocketDebuggerUrl'))
    def browser_journal():
        from .browser_testing.run_state import RunJournal
        journal = RunJournal()
        with journal.connection() as connection:
            connection.execute('BEGIN IMMEDIATE')
            connection.rollback()
        return True
    remote_url=os.getenv('REMOTE_BROWSER_SANDBOX_URL','').strip()
    results=await asyncio.gather(
        asyncio.to_thread(database),
        browser(os.getenv('BROWSER_SANDBOX_URL','http://browser-sandbox:9222')),
        browser(remote_url,remote=True) if remote_url else asyncio.sleep(0,result=False),
        asyncio.to_thread(browser_journal),return_exceptions=True)
    checks={'database':results[0] is True,'browser':results[1] is True or results[2] is True,
            'browser_checkpoint_storage':results[3] is True,
            'service_authentication':bool(os.getenv('STACKPILOT_AI_SERVICE_TOKEN','').strip())}
    return {'ready':all(checks.values()),'dependencies':checks,
            'browser_modes':{'local':results[1] is True,'remote':results[2] is True},
            'service':'stackpilot-ai-service'}
