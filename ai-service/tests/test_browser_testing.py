import asyncio
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.apv_engine import ActionPerceptionVerification as APV, PerceptionSnapshot
from app.browser_driver import BrowserSession, browser_manager
from app.system1_decision_engine import System1DecisionEngine, extract_goal_intent
from app.testing_runtime import BrowserTestBudget, action_status, build_test_report
from app.tools import execute_tool_call


class EvidenceTests(unittest.TestCase):
    def test_dispatch_alone_is_not_a_pass(self):
        self.assertEqual(action_status({"status": "passed"}), "unverified")
        self.assertEqual(action_status({"error": "broken"}), "failed")
        self.assertFalse(APV.verify_action_outcome(PerceptionSnapshot("/"), PerceptionSnapshot("/")).verified)

    def test_focus_is_not_business_outcome(self):
        result = APV.verify_action_outcome(PerceptionSnapshot("/"), PerceptionSnapshot("/", focused_id="1"))
        self.assertEqual(action_status({"verification": result.to_dict()}), "unverified")

    def test_failed_snapshot_does_not_verify_route_change(self):
        result = APV.verify_action_outcome(PerceptionSnapshot("/", captured=False), PerceptionSnapshot("/next"))
        self.assertFalse(result.verified)

    def test_validation_feedback_is_not_success(self):
        result = APV.verify_action_outcome(PerceptionSnapshot("/"), PerceptionSnapshot("/", alerts=["Email is required"]))
        self.assertEqual(action_status({"verification": result.to_dict()}), "failed")

    def test_control_changes_are_observed(self):
        result = APV.verify_action_outcome(PerceptionSnapshot("/", control_state="a"), PerceptionSnapshot("/", control_state="b"))
        self.assertEqual(result.effect_type, "control_change")
        self.assertEqual(action_status({"verification": result.to_dict()}), "passed")

    def test_report_does_not_claim_coverage_or_hide_errors(self):
        report = build_test_report([{"action": "click", "result": {"error": "bad | click"}}], "/", "Fixture")
        self.assertIn("Overall Status:** FAILED", report)
        self.assertIn("bad \\| click", report)
        self.assertNotIn("100%", report)
        self.assertIn("remain unverified", report)
        self.assertIn("INCOMPLETE", build_test_report([], "/", "Fixture"))

    def test_console_errors_prevent_clean_report(self):
        self.assertIn("FAILED", build_test_report([], "/", "Fixture", console_errors=1))

    def test_action_and_time_budgets(self):
        budget = BrowserTestBudget(max_actions=2, max_seconds=3)
        self.assertEqual(budget.stop_reason(1), "")
        self.assertIn("Action budget", budget.stop_reason(2))
        budget.started -= 4
        self.assertIn("Time budget", budget.stop_reason(0))

    def test_day_after_tomorrow(self):
        intent = extract_goal_intent("search tomorrow")
        later = extract_goal_intent("search day after tomorrow")
        self.assertEqual(datetime.strptime(later["date_alt"], "%Y-%m-%d") - datetime.strptime(intent["date_alt"], "%Y-%m-%d"), timedelta(days=1))

    def test_failed_submit_does_not_satisfy_goal(self):
        engine = System1DecisionEngine(api_key="")
        decision = engine._local_fast_path_evaluator(
            extract_goal_intent("search for books"),
            {"url": "/search", "interactive_elements": []},
            [{"subtask": "click_search", "status": "failed"}])
        self.assertFalse(decision.is_terminal)


class AsyncBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def test_option_click_dispatches_once(self):
        session = SimpleNamespace(evaluate=AsyncMock(return_value={"x": 10, "y": 10, "is_in_viewport": True}), click=AsyncMock())
        self.assertTrue(await APV.dispatch_two_tier_click(session, 1))
        self.assertEqual(session.evaluate.await_count, 1)
        session.click.assert_awaited_once()

    async def test_occluded_disabled_or_missing_target_not_clicked(self):
        for coords in [None, {"is_in_viewport": False}, {"is_in_viewport": True, "is_occluded": True}, {"disabled": True}]:
            session = SimpleNamespace(evaluate=AsyncMock(return_value=coords), click=AsyncMock())
            self.assertFalse(await APV.dispatch_two_tier_click(session, 1))
            session.click.assert_not_awaited()

    async def test_cdp_timeout_and_cancellation_release_pending_requests(self):
        session = BrowserSession("unit")
        session.is_connected = True
        session.cdp_ws = object()
        with self.assertRaises(asyncio.TimeoutError):
            await session.send_command("Runtime.evaluate", timeout=0.01)
        self.assertEqual(session._pending_requests, {})
        task = asyncio.create_task(session.send_command("Runtime.evaluate"))
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(session._pending_requests, {})

    async def test_snapshot_transport_failure_remains_unverified(self):
        session = SimpleNamespace(current_url="/", interactive_elements=[], send_command=AsyncMock(side_effect=RuntimeError("offline")))
        snapshot = await APV.capture_snapshot(session)
        self.assertFalse(snapshot.captured)

    async def test_batch_stops_on_validation_error_and_propagates_failure(self):
        session = SimpleNamespace(is_connected=True, current_url="/", page_title="Fixture", interactive_elements=[],
                                  discovered_subpages=[], console_logs=[], latest_frame="", capture_screenshot=AsyncMock(return_value=""))
        with patch.dict(browser_manager.sessions, {"unit": session}):
            with patch("app.tools.execute_tool_call", AsyncMock(return_value={"status": "failed", "verification": {"verified": False, "effect_type": "validation_error"}})) as execute:
                result = await execute_tool_call("browser_interact_batch", {"session_id": "unit", "actions": [{"action": "click"}, {"action": "type"}]}, "user")
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["executed_count"], 1)
                self.assertEqual(execute.call_args.args[2], "user")
                self.assertFalse(execute.call_args.args[1]["include_frame"])


if __name__ == "__main__":
    unittest.main()
