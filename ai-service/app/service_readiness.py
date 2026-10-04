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
    async def browser():
        async with httpx.AsyncClient(timeout=3,trust_env=False) as client:
            response=await client.get(os.getenv('BROWSER_SANDBOX_URL','http://browser-sandbox:9222').rstrip('/')+'/json/version')
            return response.status_code==200 and bool(response.json().get('webSocketDebuggerUrl'))
    def browser_journal():
        from .browser_testing.run_state import RunJournal
        journal = RunJournal()
        with journal.connection() as connection:
            connection.execute('BEGIN IMMEDIATE')
            connection.rollback()
        return True
    results=await asyncio.gather(asyncio.to_thread(database),browser(),asyncio.to_thread(browser_journal),return_exceptions=True)
    checks={'database':results[0] is True,'browser':results[1] is True,
            'browser_checkpoint_storage':results[2] is True,
            'service_authentication':bool(os.getenv('STACKPILOT_AI_SERVICE_TOKEN','').strip())}
    return {'ready':all(checks.values()),'dependencies':checks,'service':'stackpilot-ai-service'}
