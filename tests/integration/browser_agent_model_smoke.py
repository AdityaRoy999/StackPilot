"""Opt-in real-provider smoke test, using only a disposable browser fixture.

Requires PYTHONPATH=ai-service:ai-service/tests (Linux), configured provider
credentials and AI_BROWSER_LIVE_TESTS=1. No model or executor is mocked.
This is one small scenario, not a general website reliability benchmark.
"""
import asyncio
import json
import os
import time
from unittest.mock import AsyncMock, patch

from app.main import AgentRequest, stream_agent_reply
from app.browser_driver import BrowserSession,browser_manager
from test_browser_live import LiveBrowserTests, FIXTURE


async def main():
    async def serve(reader, writer):
        try:
            await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), timeout=2)
            body = FIXTURE.encode()
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
            await writer.drain()
        except (asyncio.IncompleteReadError, TimeoutError, ConnectionError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()
    server = await asyncio.start_server(serve, '0.0.0.0', 0)
    port = server.sockets[0].getsockname()[1]
    qa = LiveBrowserTests('test_no_effect_is_unverified')
    await qa.asyncSetUp()
    if os.getenv('MODEL_SMOKE_ISOLATED','1') == '1':
        await qa.session.close()
        qa.session = BrowserSession('qa-regression-fixture')
        await qa.session.connect()
        browser_manager.sessions[qa.session.session_id] = qa.session
    await qa.session.navigate(f"http://{os.getenv('MODEL_SMOKE_FIXTURE_HOST', 'ai-service')}:{port}/")
    started = time.monotonic()
    trace = []
    error = None
    try:
        request = AgentRequest(message='Tick Toggle flag and enter qa@example.com in Email. Check both values.',
                               custom_url=qa.session.current_url, session_id=qa.session.session_id,
                               model=os.getenv('MODEL_SMOKE_MODEL') or None)
        # Context recovery talks to the project backend; this run has no project.
        # Browser tools, provider HTTP requests and planning remain real.
        with patch('app.main.recover_session_context', AsyncMock()):
            async with asyncio.timeout(100):
                async for raw in stream_agent_reply(request):
                    if not raw.startswith('data: '):
                        continue
                    event = json.loads(raw[6:].strip())
                    if event.get('type') == 'tool_call':
                        trace.append({'tool':event.get('name'), 'args':event.get('arguments')})
                    elif event.get('type') == 'browser_timing':
                        trace.append(event)
                    elif event.get('type') == 'tool_result':
                        result = event.get('result') or {}
                        trace.append({'tool_result':event.get('name'), 'status':result.get('status'),
                                      'error':result.get('error'), 'completion_verified':result.get('completion_verified')})
                    elif event.get('type') == 'error':
                        error = str(event.get('message') or event.get('error') or 'provider error')[:500]
    except TimeoutError:
        error = 'Run exceeded 100 second smoke deadline'
    finally:
        values = await qa.session.evaluate("({checked:document.getElementById('checkbox').checked,email:document.getElementById('email').value})")
        await qa.cleanup_fixture()
        server.close()
        # Chromium may keep speculative sockets open after closing its tab.
        # Their bounded handlers finish independently of the model result.
    print(json.dumps({'scenario':'checkbox_and_email', 'elapsed_seconds':round(time.monotonic()-started,2),
                      'independent_outcome':values, 'success':bool(values and values.get('checked') and values.get('email')=='qa@example.com'),
                      'error':error, 'trace':trace}, ensure_ascii=True))


if __name__ == '__main__':
    asyncio.run(main())
