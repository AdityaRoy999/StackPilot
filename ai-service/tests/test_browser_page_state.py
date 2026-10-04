import json
import asyncio
import unittest
from unittest.mock import AsyncMock

from app.browser_driver import BrowserSession
from app.browser_page_state import PAGE_STATE_BINDING
from app.browser_streaming import LiveControlBuffer


class PageIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_lightweight_identity_clears_old_title_and_controls_immediately(self):
        session = BrowserSession("identity")
        events = []
        session.add_listener(events.append)
        session.update_page_metadata("https://a.test/", "A")
        session.interactive_elements = [{"id": 1}]
        session.update_page_metadata("https://b.test/")
        self.assertEqual(session.page_title, "")
        self.assertEqual(session.interactive_elements, [])
        self.assertEqual(events[-1]["url"], "https://b.test/")
        self.assertEqual(events[-1]["state_seq"], 2)
        session.update_page_metadata("https://b.test/", "B")
        session.update_page_metadata("https://b.test/", "B")
        self.assertEqual(len(events), 3)
        session.update_page_metadata("https://b.test/", "")
        self.assertEqual(events[-1]["title"], "")

    async def test_slow_dom_result_cannot_rewind_a_navigation(self):
        session = BrowserSession("slow-tree")
        session.update_page_metadata("https://a.test/", "A")
        async def delayed(*args, **kwargs):
            session.update_page_metadata("https://b.test/", "B")
            return {"result": {"value": {"url": "https://a.test/", "title": "A", "elements": [{"id": 99}]}}}
        session.send_command = AsyncMock(side_effect=delayed)
        result = await session.extract_interactive_tree()
        self.assertEqual(result["url"], "https://b.test/")
        self.assertEqual(result["title"], "B")
        self.assertEqual(session.interactive_elements, [])

    async def test_iframe_navigation_and_binding_cannot_replace_main_page(self):
        session = BrowserSession("main-page")
        session._main_frame_id = "main"
        session._main_context_id = 7
        session.update_page_metadata("https://a.test/", "A")
        messages = [
            {"method": "Page.navigatedWithinDocument", "params": {"frameId": "iframe", "url": "https://iframe.test/#a"}},
            {"method": "Runtime.bindingCalled", "params": {"name": PAGE_STATE_BINDING, "executionContextId": 8,
                "payload": json.dumps({"url": "https://iframe.test/", "title": "Iframe"})}},
            {"method": "Runtime.bindingCalled", "params": {"name": PAGE_STATE_BINDING, "executionContextId": 7,
                "payload": json.dumps({"url": "https://a.test/", "title": "Updated"})}},
        ]
        class Socket:
            async def recv(self):
                if not messages:
                    session.is_connected = False
                    return "{}"
                return json.dumps(messages.pop(0))
        session.cdp_ws = Socket()
        session.is_connected = True
        await session._listen_loop()
        self.assertEqual(session.current_url, "https://a.test/")
        self.assertEqual(session.page_title, "Updated")

    async def test_control_backlog_coalesces_newest_identity_without_losing_click(self):
        buffer = LiveControlBuffer(capacity=3)
        for revision in range(1000):
            buffer.put_nowait({"type": "page_state", "url": "https://a.test/", "state_seq": revision})
            buffer.put_nowait({"type": "cursor_action", "action": "move", "x": revision})
        buffer.put_nowait({"type": "cursor_action", "action": "click"})
        self.assertEqual((await buffer.get())["state_seq"], 999)
        self.assertEqual((await buffer.get())["x"], 999)
        self.assertEqual((await buffer.get())["action"], "click")
        buffer.clear()
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(buffer.get(), 0.01)

    async def test_title_only_updates_preserve_same_page_tree_but_not_previous_route(self):
        buffer = LiveControlBuffer()
        buffer.put_nowait({"type": "page_state", "url": "https://a.test/", "state_seq": 1, "elements": [1]})
        buffer.put_nowait({"type": "page_state", "url": "https://a.test/", "state_seq": 2, "title": "A"})
        self.assertEqual((await buffer.get())["elements"], [1])
        buffer.put_nowait({"type": "page_state", "url": "https://a.test/", "state_seq": 3, "elements": [1]})
        buffer.put_nowait({"type": "page_state", "url": "https://b.test/", "state_seq": 4, "title": "B"})
        self.assertNotIn("elements", await buffer.get())
