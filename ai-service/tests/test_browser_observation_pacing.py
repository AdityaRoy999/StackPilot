"""Passive observation cannot compete with explicit agent snapshots or pile up."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch
from app.browser_driver import BrowserSession, browser_manager


class ObservationPacingTests(unittest.IsolatedAsyncioTestCase):
    async def test_scroll_burst_schedules_one_observation(self):
        session=BrowserSession('passive-scroll-fixture')
        session.is_connected=True
        session.extract_interactive_tree=AsyncMock()
        for _ in range(30):
            session.schedule_tree_refresh()
        task=session._tree_refresh_task
        await task
        session.extract_interactive_tree.assert_awaited_once()
        self.assertIsNone(session._tree_refresh_task)

    async def test_agent_owned_scroll_leaves_refresh_to_its_explicit_observation(self):
        session=BrowserSession('agent-scroll-fixture')
        session.is_connected=True
        session.extract_interactive_tree=AsyncMock()
        with patch.object(browser_manager,'busy_sessions',{session.session_id}):
            session.schedule_tree_refresh()
            await session._tree_refresh_task
        session.extract_interactive_tree.assert_not_awaited()

    async def test_explicit_observations_are_serial_and_each_remains_fresh(self):
        session=BrowserSession('snapshot-fixture')
        running=0
        maximum=0
        sequence=0
        async def observe():
            nonlocal running,maximum,sequence
            running+=1
            maximum=max(maximum,running)
            await asyncio.sleep(.01)
            running-=1
            sequence+=1
            return {'snapshot':sequence}
        session._extract_interactive_tree=observe
        results=await asyncio.gather(*(session.extract_interactive_tree() for _ in range(5)))
        self.assertEqual(maximum,1)
        self.assertEqual([r['snapshot'] for r in results],[1,2,3,4,5])

    async def test_disconnected_session_does_not_execute_passive_scan(self):
        session=BrowserSession('closed-scroll-fixture')
        session.extract_interactive_tree=AsyncMock()
        session.schedule_tree_refresh()
        await session._tree_refresh_task
        session.extract_interactive_tree.assert_not_awaited()
