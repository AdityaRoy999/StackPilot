"""Opt-in, real-provider broad audit. Supply an authorized URL as argv[1].

Uses an owned disposable browser context and the actual planner/executor.
Only project-context recovery is bypassed (this run has no deployment).
Does not persist a chat or submit contact forms. JSON output omits images.
"""
import asyncio
import json
import sys
import time
import uuid
from unittest.mock import AsyncMock, patch

from app.main import AgentRequest, stream_agent_reply
from app.browser_driver import browser_manager


async def main():
    url=sys.argv[1]
    session_id='audit-smoke-'+uuid.uuid4().hex
    started=time.monotonic()
    trace=[]
    report=[]
    coverage=None
    cases=[]
    error=None
    try:
        with patch('app.main.recover_session_context',AsyncMock()):
            async with asyncio.timeout(240):
                async for raw in stream_agent_reply(AgentRequest(message='test the website',custom_url=url,session_id=session_id)):
                    if not raw.startswith('data: '):
                        continue
                    event=json.loads(raw[6:].strip())
                    kind=event.get('type')
                    if kind=='tool_call':
                        trace.append({'at_seconds':round(time.monotonic()-started,2),'tool':event.get('name'),'args':event.get('arguments')})
                    elif kind=='tool_result':
                        result=event.get('result') or {}
                        trace.append({'at_seconds':round(time.monotonic()-started,2),'tool_result':event.get('name'),'status':result.get('status'),'error':result.get('error')})
                        if result.get('coverage'):
                            coverage=result['coverage']
                            cases=result.get('cases',[])
                    elif kind=='browser_timing':
                        trace.append(event)
                    elif kind=='content':
                        report.append(event.get('delta',''))
                    elif kind=='error':
                        error=str(event.get('message') or event.get('error'))[:500]
    except TimeoutError:
        error='240 second run deadline exceeded; partial coverage only.'
    finally:
        session=browser_manager.sessions.get(session_id)
        if coverage is None and session and getattr(session,'last_site_audit',None):
            audit=session.last_site_audit
            coverage=audit['coverage']
            cases=audit['cases']
        elapsed=round(time.monotonic()-started,2)
        await browser_manager.close_session(session_id)
    print(json.dumps({'prompt':'test the website','url':url,'elapsed_seconds':elapsed,'coverage':coverage,'cases':cases,'trace':trace,'report':''.join(report),'error':error},ensure_ascii=True))


if __name__=='__main__':
    asyncio.run(main())
