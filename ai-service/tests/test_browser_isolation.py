import asyncio
import os
import unittest
from unittest.mock import AsyncMock,patch

from app.browser_driver import BrowserSession,BrowserManager,CHROME_HOST
from app.browser_testing.isolation import create_isolated_target,browser_command


class IsolationTests(unittest.IsolatedAsyncioTestCase):
    async def test_idle_reaper_preserves_viewed_and_active_sessions(self):
        import time
        manager = BrowserManager()
        for key in ('idle','viewed','active'):
            session = BrowserSession(key)
            session.last_used = time.monotonic()-2000
            session.close = AsyncMock()
            manager.sessions[key] = session
        manager.sessions['viewed'].listeners.add(lambda event:None)
        await manager.reap_idle(protected={'active'})
        self.assertEqual(set(manager.sessions),{'viewed','active'})

    async def test_capacity_refuses_to_allocate_another_tab(self):
        manager = BrowserManager()
        manager.sessions['existing'] = BrowserSession('existing')
        manager.sessions['existing'].is_connected = True
        with patch.dict('os.environ',{'BROWSER_MAX_SESSIONS':'1'}), patch.object(BrowserSession,'connect',AsyncMock()) as connect:
            with self.assertRaisesRegex(RuntimeError,'capacity'):
                await manager.get_or_create_session('overflow')
            connect.assert_not_awaited()
    async def test_context_lifetime_is_bound_to_persistent_owner_connection(self):
        commands = AsyncMock(side_effect=[{'browserContextId':'owned'}, {'targetId':'target'},
                                         {'windowId':7}, {}])
        owner = object()
        with patch('app.browser_testing.isolation.command', commands), \
             patch('app.browser_testing.isolation.browser_command', AsyncMock()) as temporary:
            self.assertEqual(await create_isolated_target('http://fixture.invalid', owner), ('owned','target'))
        self.assertEqual(commands.call_args_list[0].args,
                         (owner, 'Target.createBrowserContext', {'disposeOnDetach': True}))
        temporary.assert_not_awaited()

    async def test_replacing_disconnected_session_releases_its_context(self):
        manager = BrowserManager()
        stale = BrowserSession('reused')
        manager.sessions['reused'] = stale
        with patch.object(stale,'close',AsyncMock()) as close, \
             patch.object(BrowserSession,'connect',AsyncMock()):
            replacement = await manager.get_or_create_session('reused')
        close.assert_awaited_once()
        self.assertIsNot(replacement,stale)

    async def test_failed_target_creation_disposes_only_owned_context(self):
        commands = AsyncMock(side_effect=[{'browserContextId':'owned'},RuntimeError('unavailable'),{}])
        with patch('app.browser_testing.isolation.browser_command',commands):
            with self.assertRaises(RuntimeError):
                await create_isolated_target('http://fixture.invalid')
        self.assertEqual(commands.call_args.args,
            ('http://fixture.invalid','Target.disposeBrowserContext',{'browserContextId':'owned'}))

    async def test_concurrent_creation_does_not_leak_duplicate_session(self):
        manager = BrowserManager()
        async def connect(session):
            await asyncio.sleep(0.02)
            session.is_connected = True
        with patch.object(BrowserSession,'connect',connect):
            one,two = await asyncio.gather(manager.get_or_create_session('same'),manager.get_or_create_session('same'))
        self.assertIs(one,two)
        self.assertEqual(len(manager.sessions),1)


@unittest.skipUnless(os.getenv('AI_BROWSER_LIVE_TESTS') == '1','Opt-in Chromium isolation tests')
class LiveIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def test_browser_reaps_context_if_worker_owner_disconnects(self):
        session = BrowserSession('owner-disconnect')
        try:
            await session.connect()
            owned = session.browser_context_id
            await session._context_owner.close()
            async with asyncio.timeout(3):
                while owned in (await browser_command(CHROME_HOST,'Target.getBrowserContexts'))['browserContextIds']:
                    await asyncio.sleep(0.02)
        finally:
            await session.close()

    async def test_sessions_isolate_cookies_storage_and_cleanup_contexts(self):
        before = await browser_command(CHROME_HOST,'Target.getBrowserContexts')
        one,two = BrowserSession('isolated-one'),BrowserSession('isolated-two')
        try:
            await one.connect()
            await two.connect()
            self.assertNotEqual(one.browser_context_id,two.browser_context_id)
            for session in (one,two):
                window = await browser_command(CHROME_HOST,'Browser.getWindowForTarget',{'targetId':session.target_id})
                self.assertEqual(window['bounds']['windowState'],'fullscreen')
            result = await one.send_command('Network.setCookie',
                {'name':'qa-isolated-cookie','value':'one-only','url':'http://storage-fixture.invalid/'})
            self.assertTrue(result['success'])
            cookie1 = await one.send_command('Network.getCookies',{'urls':['http://storage-fixture.invalid/']})
            cookie2 = await two.send_command('Network.getCookies',{'urls':['http://storage-fixture.invalid/']})
            self.assertTrue(cookie1['cookies'])
            self.assertFalse(cookie2['cookies'])
            # Read-only same-origin local endpoint; no external website or account.
            await one.navigate('http://ai-service:8010/health')
            await two.navigate('http://ai-service:8010/health')
            await one.evaluate("localStorage.setItem('qa-context-value','one-only')")
            self.assertEqual(await one.evaluate("localStorage.getItem('qa-context-value')"),'one-only')
            self.assertIsNone(await two.evaluate("localStorage.getItem('qa-context-value')"))
        finally:
            await one.close()
            await two.close()
        after = await browser_command(CHROME_HOST,'Target.getBrowserContexts')
        self.assertEqual(set(before['browserContextIds']),set(after['browserContextIds']))
