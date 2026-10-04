import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.browser_driver import browser_manager
from app.tools import AGENT_TOOLS, execute_tool_call, resolve_target_project_runtime_url


class GeneralObservationTests(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_local_and_unfamiliar_domains_are_not_replaced(self):
        for url in ("http://localhost:3000", "http://127.0.0.1:3000/records", "https://records.example.xyz"):
            with self.subTest(url=url), patch("app.tools.get_db_connection") as database:
                self.assertEqual(resolve_target_project_runtime_url(custom_url=url), url)
                self.assertEqual(resolve_target_project_runtime_url(user_message=f"Inspect {url}"), url)
                database.assert_not_called()

    async def test_all_controls_can_be_discovered_without_english_label_bias(self):
        # More controls than one observation can carry, including numeric and non-English labels.
        controls = [{"id": i, "tag": "button", "text": str(i), "is_in_viewport": True}
                    for i in range(90)]
        controls.extend([{"id": 90, "tag": "button", "text": "保存", "is_in_viewport": True},
                         {"id": 91, "tag": "button", "text": "Submit", "is_in_viewport": True}])
        session = SimpleNamespace(is_connected=True, current_url="about:blank", page_title="Fixture",
                                  interactive_elements=controls, extract_interactive_tree=AsyncMock(),
                                  capture_screenshot=AsyncMock(return_value="/9j/"))
        with patch.dict(browser_manager.sessions, {"observation-fixture": session}):
            first = await execute_tool_call("browser_observe", {"session_id": "observation-fixture"}, "fixture")
            second = await execute_tool_call("browser_observe", {
                "session_id": "observation-fixture", "offset": first["next_offset"]}, "fixture")
        self.assertEqual(first["total_controls"], 92)
        self.assertTrue(first["has_more"])
        self.assertFalse(second["has_more"])
        self.assertIsNone(second["next_offset"])
        self.assertEqual([el["id"] for el in first["interactive_elements"] + second["interactive_elements"]], list(range(92)))

    async def test_invalid_observation_offset_cannot_mutate_or_create_session(self):
        for offset in (-1, True, "80"):
            with self.subTest(offset=offset), patch.object(browser_manager, "get_or_create_session", AsyncMock()) as create:
                result = await execute_tool_call("browser_observe", {"offset": offset}, "fixture")
                self.assertEqual(result["status"], "failed")
                create.assert_not_awaited()

    async def test_structured_observation_can_omit_image_without_losing_controls(self):
        session = SimpleNamespace(is_connected=True, current_url="about:blank", page_title="Fixture",
            interactive_elements=[{"id": 1, "tag": "button", "text": "Continue", "is_in_viewport": True}],
            extract_interactive_tree=AsyncMock(), capture_screenshot=AsyncMock())
        with patch.dict(browser_manager.sessions, {"dom-only": session}):
            result = await execute_tool_call("browser_observe", {"session_id": "dom-only", "include_frame": False}, "fixture")
        self.assertEqual(result["status"], "observed")
        self.assertEqual(result["interactive_elements"][0]["id"], 1)
        self.assertFalse(result["visual_captured"])
        session.capture_screenshot.assert_not_awaited()

    async def test_retired_implicit_form_tool_never_fills_or_submits(self):
        with patch.object(browser_manager, "get_or_create_session", AsyncMock()) as create:
            result = await execute_tool_call("browser_fill_form", {"fields": {"name": "Zeta"}}, "fixture")
        self.assertEqual(result["status"], "failed")
        create.assert_not_awaited()
        self.assertNotIn("browser_fill_form", [tool["function"]["name"] for tool in AGENT_TOOLS])
