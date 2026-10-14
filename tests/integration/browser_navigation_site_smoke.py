"""Opt-in navigation-only smoke using a separate anonymous browser context.

Set STACKPILOT_NAVIGATION_SMOKE_URL to an explicitly authorized target. No
provider, form filling, submissions, downloads or external links are executed.
Run in the ai-service runtime with its browser worker available.
"""
import asyncio
import json
import os
import uuid

from app.browser_driver import BrowserSession, browser_manager
from app.tools import execute_tool_call


async def main():
    url = os.environ['STACKPILOT_NAVIGATION_SMOKE_URL']
    session = BrowserSession('navigation-smoke-'+uuid.uuid4().hex, target_url=url)
    await session.connect()
    browser_manager.sessions[session.session_id] = session
    session.task_context = {'goal':'test safe navigation and detail views'}
    session.audit_read_only = True
    session.agent_access_mode = 'full_access'
    try:
        await session.navigate(url)
        result = await execute_tool_call('browser_audit_site', {
            'session_id':session.session_id,'ui_control_ids':[],
            'include_hover':False,'include_frame':False,'autonomous':False,
            'max_pages':5,'max_actions':60,'max_seconds':60},'navigation-smoke')
        coverage = result.get('coverage') or {}
        report = {'status':result.get('status'),'elapsed_ms':result.get('elapsed_ms'),
                  'routes':coverage.get('routes'),'detail_views':coverage.get('detail_views'),
                  'starting_page_restoration':coverage.get('starting_page_restoration'),
                  'stop_reason':coverage.get('stop_reason'),
                  'review_count':len(coverage.get('controls_requiring_review',[])),
                  'cases':[{'action':case.get('action'),'label':case.get('label'),
                      'status':case.get('result',{}).get('status'),
                      'recovery':case.get('result',{}).get('recovery'),
                      'reason':case.get('result',{}).get('error') or case.get('result',{}).get('verification',{}).get('description')}
                      for case in result.get('cases',[])]}
        print(json.dumps(report,ensure_ascii=True))
        assert not any(case.get('action')=='type' for case in result.get('cases',[]))
        assert coverage.get('starting_page_restoration',{}).get('status') == 'passed',report
    finally:
        await browser_manager.close_session(session.session_id)


if __name__ == '__main__':
    asyncio.run(main())
