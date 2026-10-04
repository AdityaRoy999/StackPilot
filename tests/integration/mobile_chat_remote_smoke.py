"""Phone chat and populated Remote UI in an owned context with intercepted APIs.

Devices, pairing links, conversations and tool results below are fixtures.
No real device, browser input, model call or deployment is changed.
MOBILE_CHAT_BASELINE=1 records the old layout without asserting the redesign.
"""
import asyncio
import base64
import json
import os
from pathlib import Path

import websockets
from mobile_platform_layout_smoke import LayoutCDP, INSTRUMENT, MEASURE, ORIGIN
from mobile_layout_smoke import wait_for
from remote_phone_ui_smoke import SESSION
from app.browser_config import browser_config
from app.browser_testing.isolation import open_context_owner, create_isolated_target, dispose_context

OUT = Path('/tmp/mobile-chat-remote-qa')
BASELINE = os.getenv('MOBILE_CHAT_BASELINE') == '1'
HOST = 'https://modification-please-grammar-motorcycle-responsive-fixture.example.test'
TOOLS = [
    dict(name='browser_open_live_session', arguments=dict(url=HOST), result=dict(title='Fixture', status='ok')),
    dict(name='browser_interact_batch', arguments=dict(actions=[dict(action='navigate', url=HOST), dict(action='click', element_id=4)]), result=dict(status='ok')),
    dict(name='browser_interact', arguments=dict(action='navigate', url=HOST), result=dict(status='ok', url=HOST)),
    dict(name='browser_observe', arguments=dict(session_id=SESSION), result=dict(title='Fixture application', url=HOST, status='ok')),
    dict(name='browser_interact', arguments=dict(action='click', element_id=4), result=dict(status='ok', target='Open fixture menu')),
    dict(name='browser_assert', arguments=dict(session_id=SESSION), result=dict(status='ok')),
]
REPORT = ('## Website test report\n\nThe fixture navigation and its menu were checked.\n\n'
          '- Target: '+HOST+'\n- Result: the menu opened.\n\n'
          '### Actions performed\n\n| # | Action | Target | Status |\n|---|---|---|---|\n'
          '| 1 | Navigate | '+HOST+' | Passed |\n| 2 | Click | Open fixture menu | Passed |\n')


class MobileCDP(LayoutCDP):
    async def fulfill(self, params):
        url = params['request']['url']
        if '/remote/access' in url:
            data = dict(available=True, running=True, url=HOST)
        elif '/remote/devices' in url:
            data = dict(devices=[dict(id='fixture-phone', name='iPhone aditya with a very long device name',
                status='approved', confirmation_code='123456', last_seen_at='2026-10-04T05:12:36Z', expires_at='2099-11-03'),
                dict(id='pending-phone', name='New phone waiting for permission', status='pending',
                     confirmation_code='654321', last_seen_at=None, expires_at='2099-11-03')])
        elif '/remote/runs' in url:
            data = dict(runs=[dict(id='fixture-run', session_id=SESSION, title='Check the entire application with a long project title', state='completed')])
        elif '/ai/sessions/' in url:
            data = dict(session=dict(id=SESSION, title='Mobile chat fixture'), messages=[
                dict(id='question', role='user', content='hi', metadata={}),
                dict(id='answer', role='assistant', content=REPORT,
                     metadata=dict(reasoning='Inspected the fixture page.', tool_calls=TOOLS))])
        else:
            return await super().fulfill(params)
        await self.call('Fetch.fulfillRequest', dict(requestId=params['requestId'], responseCode=200,
            responseHeaders=[dict(name='Content-Type', value='application/json'),
                             dict(name='Access-Control-Allow-Origin', value=ORIGIN),
                             dict(name='Access-Control-Allow-Credentials', value='true'),
                             dict(name='Access-Control-Allow-Headers', value='Content-Type,Authorization,X-stackpilot-CSRF')],
            body=base64.b64encode(json.dumps(data).encode()).decode()))


async def screenshot(cdp, name):
    shot = await cdp.call('Page.captureScreenshot', dict(format='png'))
    (OUT/(name+'.png')).write_bytes(base64.b64decode(shot['data']))


async def main():
    OUT.mkdir(exist_ok=True)
    config = browser_config('local')
    owner = await open_context_owner(config.endpoint, config.headers)
    context, target = await create_isolated_target(config.endpoint, owner, fullscreen=False)
    results = []
    try:
        async with websockets.connect(config.endpoint.replace('http://', 'ws://')+'/devtools/page/'+target,
                                      additional_headers=config.headers, max_size=16*1024*1024) as socket:
            cdp = MobileCDP(socket); cdp.origin = ORIGIN
            await cdp.call('Page.enable'); await cdp.call('Runtime.enable')
            await cdp.call('Fetch.enable', dict(patterns=[dict(urlPattern='*api/v1/*')]))
            for theme in ['light', 'dark']:
                source = INSTRUMENT.replace("'theme','dark'", "'theme','"+theme+"'")
                script = await cdp.call('Page.addScriptToEvaluateOnNewDocument', dict(source=source))
                for width, height in [(320,740),(375,812),(390,844),(430,932),(768,1024),(1280,800)]:
                    await cdp.call('Emulation.setDeviceMetricsOverride', dict(width=width,height=height,deviceScaleFactor=1,mobile=width<640))
                    for route in ['/dashboard/remote', '/dashboard/ai?session_id='+SESSION]:
                        cdp.errors.clear()
                        await cdp.call('Page.navigate', dict(url=ORIGIN+route))
                        ready = "document.querySelector('#remote-origin')?.value.includes('responsive-fixture')" if route.endswith('remote') else "!!document.querySelector('[data-chat-message=assistant] .prose-ai table')"
                        await wait_for(cdp, ready, 40)
                        await asyncio.sleep(.4)
                        await cdp.evaluate("document.querySelector('[aria-label=\"Close browser\"]')?.click()")
                        sample = await cdp.evaluate(MEASURE)
                        sample.update(theme=theme, configuredWidth=width, route=route, errors=list(cdp.errors))
                        if route.endswith('remote'):
                            sample['cards'] = await cdp.evaluate("[...document.querySelectorAll('main section')].map(e=>({width:e.getBoundingClientRect().width,content:e.scrollWidth,right:e.getBoundingClientRect().right}))")
                            if not BASELINE:
                                assert all(c['right']<=width+1 and c['content']<=c['width']+1 for c in sample['cards']), sample
                                assert await cdp.evaluate("[...document.querySelectorAll('button[aria-label^=Disconnect]')].every(e=>e.getBoundingClientRect().right<=innerWidth)"), sample
                            if width==390: await screenshot(cdp,'remote-'+theme)
                            if width<640 and not BASELINE:
                                await cdp.evaluate("[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Pair a phone')).click()")
                                await wait_for(cdp, "document.body.innerText.includes('Copy private pairing link')",15)
                                assert await cdp.evaluate("document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('[data-remote-card] button')].every(e=>e.getBoundingClientRect().right<=innerWidth)")
                                sample['pairingFits'] = True
                        elif width<640 and not BASELINE:
                            sample['composer'] = await cdp.evaluate("(()=>{const row=document.querySelector('[data-mobile-composer-controls]');const b=[...row.querySelectorAll('button')].map(e=>e.getBoundingClientRect());return {width:row.clientWidth,content:row.scrollWidth,oneRow:b.every(r=>Math.abs(r.top-b[0].top)<2),touch:b.every(r=>r.width>=44&&r.height>=44)}})()")
                            assert sample['composer']['oneRow'] and sample['composer']['touch'] and sample['composer']['content']<=sample['composer']['width']+1, sample
                            assert await cdp.evaluate("document.querySelector('[aria-label=\"Tool activity\"]').getAttribute('aria-expanded')==='false'"), sample
                            assert await cdp.evaluate("(()=>{const body=document.querySelector('[data-chat-message=assistant] .prose-ai').parentElement;return getComputedStyle(body).borderTopWidth==='0px'&&body.getBoundingClientRect().width>=innerWidth-40})()"), sample
                            assert await cdp.evaluate("(()=>{const t=document.querySelector('[aria-label=\"Report table\"]');return [...t.querySelectorAll('th')].every(e=>e.getBoundingClientRect().right<=t.getBoundingClientRect().right+1)})()"), sample
                            if width==390: await screenshot(cdp,'chat-'+theme)
                            await cdp.evaluate("document.querySelector('[aria-label=\"Tool activity\"]').click()")
                            await asyncio.sleep(.3)
                            assert not await cdp.evaluate("document.body.innerText.includes('[object Object]')")
                            assert await cdp.evaluate("document.body.innerText.includes('2 actions · navigate · click')")
                            assert await cdp.evaluate("[...document.querySelectorAll('[data-tool-activity] button')].filter(e=>e.getBoundingClientRect().height).every(e=>e.getBoundingClientRect().right<=innerWidth+1)")
                            sample['toolBatchReadable'] = True
                            await cdp.evaluate("document.querySelector('[aria-label=\"Tool activity\"]').click()")
                            await cdp.evaluate("const t=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'Keep my draft');t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[aria-label=\"Chat options\"]').click()")
                            await wait_for(cdp,"!!document.querySelector('[data-mobile-chat-options]')",10)
                            assert await cdp.evaluate("(()=>{const r=document.querySelector('[data-mobile-chat-options]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})()")
                            if width==390: await screenshot(cdp,'options-'+theme)
                            await cdp.evaluate("[...document.querySelectorAll('[data-mobile-chat-options] button')].find(e=>e.textContent==='Commands').click()")
                            await wait_for(cdp,"document.body.innerText.includes('/deploy')",10)
                            assert await cdp.evaluate("document.querySelector('textarea').value==='Keep my draft'")
                            sample['commandsAccessibleDraftKept'] = True
                            await cdp.evaluate("document.querySelector('[aria-label=\"Chat options\"]').click()")
                            await wait_for(cdp,"!!document.querySelector('[data-mobile-chat-options]')",10)
                            await cdp.evaluate("[...document.querySelectorAll('[data-mobile-chat-options] button')].find(e=>e.textContent.includes('Choose project or website')).click()")
                            await wait_for(cdp,"document.querySelector('[data-chat-composer]')?.textContent.includes('Target Project')",10)
                            await cdp.evaluate("[...document.querySelectorAll('button')].find(e=>e.textContent==='club website').click()")
                            await wait_for(cdp,"document.querySelector('[aria-label=\"Change chat target\"]')?.textContent.includes('club website')",10)
                            assert await cdp.evaluate("document.querySelector('textarea').value==='Keep my draft'")
                            await cdp.evaluate("document.querySelector('[aria-label^=\"Choose model:\"]').click()")
                            await wait_for(cdp,"!!document.querySelector('[role=dialog]')",10)
                            sample['projectAndModelAccessible'] = True
                            await cdp.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent==='Close')?.click()")
                            await asyncio.sleep(.2)
                            await cdp.evaluate("document.querySelector('[aria-label=\"Chat options\"]').click()")
                            await wait_for(cdp,"!!document.querySelector('[data-mobile-chat-options]')",10)
                            await cdp.evaluate("window.__attachmentRequests=0;document.querySelector('input[type=file]').addEventListener('click',e=>{e.preventDefault();window.__attachmentRequests++},{once:true});[...document.querySelectorAll('[data-mobile-chat-options] button')].find(e=>e.textContent.includes('Attach files')).click()")
                            assert await cdp.evaluate("window.__attachmentRequests===1 && document.querySelector('textarea').value==='Keep my draft'")
                            sample['attachmentAccessibleDraftKept'] = True
                        if BASELINE and width==390: await screenshot(cdp,'before-'+theme+('-remote' if route.endswith('remote') else '-chat'))
                        if not BASELINE:
                            assert sample['root']<=width+1 and not sample['clipped'] and not sample['errors'], sample
                        results.append(sample)
                        print('MOBILE_CHAT_LAYOUT '+json.dumps(sample), flush=True)
                await cdp.call('Page.removeScriptToEvaluateOnNewDocument',dict(identifier=script['identifier']))
        (OUT/('baseline.json' if BASELINE else 'qualification.json')).write_text(json.dumps(results,indent=2))
        print('MOBILE_CHAT_REMOTE_'+('BASELINE' if BASELINE else 'PASS')+' '+str(len(results)),flush=True)
    finally:
        await dispose_context(config.endpoint,context,config.headers)
        await owner.close()


if __name__=='__main__':
    asyncio.run(main())
