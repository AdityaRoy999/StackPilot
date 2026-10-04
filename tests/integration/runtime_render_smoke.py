"""Run inside ai-service with PYTHONPATH=/app; no LLM or external requests.

Proves HTTP 200/raw SPA/blank pages are rejected, real rendered pages accepted,
and verification contexts are disposed. Uses a disposable local HTTP fixture.
"""
import asyncio
import json
import time
from app.runtime_verification import verify_runtime
from app.browser_driver import CHROME_HOST
from app.browser_testing.isolation import browser_command


async def main():
    fixtures = {
        '/source': '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
        '/blank': '<title>Looks successful</title><div id="root"></div>',
        '/working': '<h1>Working deployment</h1><button>Continue</button>',
        '/broken-asset': '<h1>Partially loaded</h1><script src="/missing.js"></script>',
        '/busy': '<div role="progressbar">Loading...</div>',
        '/console-error': '<h1>Visible application</h1><script>console.error("fixture failure")</script>',
        '/form': '<h1>Release scenario</h1><input id="name"><button id="submit" onclick="document.getElementById(\'result\').textContent=document.getElementById(\'name\').value">Submit</button><p id="result"></p>',
    }
    async def serve(reader, writer):
        try:
            line = await reader.readline()
            path = line.decode().split(' ')[1]
            html = fixtures.get(path, 'Missing')
            status = 200 if path in fixtures else 404
            body = html.encode()
            writer.write(f'HTTP/1.1 {status} OK\r\nContent-Type: text/html\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode()+body)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
    before = await browser_command(CHROME_HOST,'Target.getBrowserContexts')
    server = await asyncio.start_server(serve,'0.0.0.0',0)
    port = server.sockets[0].getsockname()[1]
    results = {}
    try:
        for path, expected in [('/source',False),('/blank',False),('/working',True),('/broken-asset',False),('/busy',False),('/console-error',False)]:
            started = time.perf_counter()
            result = await verify_runtime(f'http://ai-service:{port}{path}')
            assert result['verified'] is expected, (path,result)
            results[path] = {**result,'elapsed_ms':round((time.perf_counter()-started)*1000)}
        scenario={'name':'Fill and submit','path':'/form','steps':[
            {'action':'fill','selector':'#name','value':'Alice'},
            {'action':'click','selector':'#submit'},
            {'action':'assert','expectations':[{'kind':'text','selector':'#result','expected':'Alice'}]}]}
        result=await verify_runtime(f'http://ai-service:{port}/form',{'scenarios':[scenario]})
        assert result['verified'] and result['workflow_verified'],result
        results['form_workflow']=result
        scenario['steps'][-1]['expectations'][0]['expected']='Incorrect outcome'
        result=await verify_runtime(f'http://ai-service:{port}/form',{'scenarios':[scenario]})
        assert not result['verified'],result
        results['wrong_outcome']=result
    finally:
        server.close()
        await server.wait_closed()
    after = await browser_command(CHROME_HOST,'Target.getBrowserContexts')
    assert set(before['browserContextIds']) == set(after['browserContextIds']), 'Verification leaked a browser context'
    print('RUNTIME_SMOKE_PASS '+json.dumps(results))


if __name__ == '__main__':
    asyncio.run(main())
