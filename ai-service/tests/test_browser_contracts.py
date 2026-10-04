import asyncio
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.browser_testing.intent import browser_task_context
from app.browser_testing.assertions import assert_browser_state
from app.system1_decision_engine import extract_goal_intent, System1DecisionEngine
from app.testing_runtime import action_status, build_test_report
from app.browser_testing.observations import visual_observation_message, retain_recent_visual_observations
from app.browser_testing.models import select_browser_planner


class ObservedEffectsTests(unittest.TestCase):
    def test_navigation_takes_precedence_over_incidental_control_changes(self):
        from app.apv_engine import ActionPerceptionVerification,PerceptionSnapshot
        before=PerceptionSnapshot(url='https://fixture.invalid/',control_state='old')
        after=PerceptionSnapshot(url='https://fixture.invalid/detail',control_state='new')
        result=ActionPerceptionVerification.verify_action_outcome(before,after,'click','detail')
        self.assertEqual(result.effect_type,'route_change')

    def test_theme_change_is_observed_even_without_text_or_control_mutation(self):
        from app.apv_engine import ActionPerceptionVerification,PerceptionSnapshot
        before=PerceptionSnapshot(url='https://fixture.invalid/',visual_state='dark')
        after=PerceptionSnapshot(url=before.url,visual_state='light')
        result=ActionPerceptionVerification.verify_action_outcome(before,after,'click','Theme')
        self.assertTrue(result.verified)
        self.assertEqual(result.effect_type,'visual_state_change')


class PlannerModelTests(unittest.TestCase):
    def test_known_incompatible_vision_model_uses_configured_planner(self):
        model, notice = select_browser_planner('nvidia_nim', 'meta/llama-3.2-11b-vision-instruct', {}, ['openai/gpt-oss-20b'])
        self.assertEqual(model, 'openai/gpt-oss-20b')
        self.assertIn('function calling', notice)

    def test_no_compatible_configuration_is_an_explicit_error(self):
        with self.assertRaises(ValueError):
            select_browser_planner('nvidia_nim', 'meta/llama-3.2-11b-vision-instruct', {}, [''])

    def test_custom_verified_tool_endpoint_and_other_models_are_preserved(self):
        original = 'meta/llama-3.2-11b-vision-instruct'
        self.assertEqual(select_browser_planner('nvidia_nim', original, {'browser_tool_calling_enabled':True}, [])[0], original)
        self.assertEqual(select_browser_planner('openai_compatible', 'my-planner', {}, [])[0], 'my-planner')


class IntentTests(unittest.TestCase):
    def test_tomorrow_uses_user_timezone_at_utc_midnight_boundary(self):
        now = datetime(2026, 12, 31, 20, 0, tzinfo=timezone.utc)
        context = browser_task_context("flights from Mumbai to Delhi tommorow", {"timezone": "Asia/Kolkata"}, [], now=now)
        intent = extract_goal_intent(context["effective_goal"], datetime.fromisoformat(context["reference_time"]))
        self.assertEqual(intent["date_alt"], "2027-01-02")
        self.assertEqual(context["today"], "01/01/2027")

    def test_followup_retains_goal_and_date_anchor_across_midnight(self):
        previous = browser_task_context("search from Mumbai to Delhi tomorrow", {"timezone": "UTC"}, [],
                                        now=datetime(2026, 12, 31, 23, 59, tzinfo=timezone.utc))
        context = browser_task_context("from_selection: Mumbai Central", {"timezone": "UTC"}, [], previous,
                                       now=datetime(2027, 1, 1, 0, 1, tzinfo=timezone.utc))
        self.assertEqual(context["tomorrow"], "01/01/2027")
        self.assertEqual(extract_goal_intent(context["effective_goal"])["origin"], "Mumbai Central")
        self.assertIn("Delhi", context["goal"])

    def test_new_task_does_not_inherit_previous_goal(self):
        previous = browser_task_context("search for books", {}, [])
        self.assertEqual(browser_task_context("test cart", {}, [], previous)["goal"], "test cart")

    def test_multiple_answers_preserve_resolved_entities(self):
        original = browser_task_context("search from Mumbai to Delhi tomorrow", {}, [])
        first = browser_task_context("from_selection: Mumbai Central", {}, [], original)
        second = browser_task_context("to_selection: New Delhi", {}, [], first)
        intent = extract_goal_intent(second["effective_goal"])
        self.assertEqual(intent["origin"], "Mumbai Central")
        self.assertEqual(intent["destination"], "New Delhi")

    def test_structured_followup_recovers_history(self):
        context = browser_task_context('[System] User answered: to_selection: Delhi', {},
                                        [{"role": "user", "content": "search from Mumbai to Delhi tomorrow"},
                                         {"role": "assistant", "content": "Which airport?"}])
        self.assertIn("from Mumbai", context["goal"])

    def test_invalid_timezone_has_explicit_fallback(self):
        context = browser_task_context("tomorrow", {"timezone": "invalid/zone"}, [])
        self.assertEqual(context["timezone"], "UTC")
        self.assertTrue(context["warning"])

    def test_invalid_date_is_not_silently_replaced(self):
        intent = extract_goal_intent("search from Mumbai to Delhi on 31/02/2026")
        self.assertIsNone(intent["date"])
        self.assertTrue(intent["clarification_required"])

    def test_iso_date_and_leap_day(self):
        self.assertEqual(extract_goal_intent("search from Mumbai to Delhi on 2028-02-29")["date"], "29/02/2028")
        self.assertTrue(extract_goal_intent("search from Mumbai to Delhi on 2027-02-29")["clarification_required"])

    def test_missing_date_requires_clarification(self):
        intent = extract_goal_intent("search from Mumbai to Delhi")
        self.assertIsNone(intent["date"])
        self.assertEqual(System1DecisionEngine(api_key="")._local_fast_path_evaluator(intent, {}, []).action_type, "escalate")

    def test_identical_route_requires_clarification(self):
        self.assertTrue(extract_goal_intent("search from Mumbai to Mumbai tomorrow")["clarification_required"])

    def test_results_url_and_cards_do_not_prove_goal(self):
        decision = System1DecisionEngine(api_key="")._local_fast_path_evaluator(
            extract_goal_intent("search for books"),
            {"url": "https://fixture/search", "interactive_elements": [{"id": 1, "text": "Modify search", "tag": "button"}]},
            [{"subtask": "click_search", "status": "success"}])
        self.assertFalse(decision.is_terminal)
        self.assertEqual(decision.subtask, "verify_expected_outcome")


class AssertionTests(unittest.IsolatedAsyncioTestCase):
    async def test_unsupported_expectation_returns_without_waiting_for_deadline(self):
        session = SimpleNamespace(evaluate=AsyncMock(return_value=[{'matched':False,'unavailable':True,'reason':'Use checked'}]))
        result = await assert_browser_state(session, [{'kind':'value','selector':'input','expected':'on'}], 30)
        self.assertEqual(result['status'], 'unverified')
        self.assertEqual(session.evaluate.await_count, 1)

    async def test_transport_timeout_does_not_erase_observed_mismatch(self):
        session = SimpleNamespace(evaluate=AsyncMock(side_effect=[[{"matched":False,"actual":"Wrong route"}], TimeoutError()]))
        result = await assert_browser_state(session, [{"kind":"text","expected":"Right route"}], .1, "outcome")
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['assertions'][0]['actual'], 'Wrong route')

    async def test_waits_for_expected_result_instead_of_initial_dom_change(self):
        session = SimpleNamespace(evaluate=AsyncMock(side_effect=[[{"matched": False, "actual": "Loading"}],
                                                                [{"matched": True, "actual": "Results"}]]))
        result = await assert_browser_state(session, [{"kind": "text", "expected": "Results"}], .5, "outcome")
        self.assertEqual(action_status(result), "passed")
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(result["purpose"], "outcome")

    async def test_wrong_result_fails(self):
        result = await assert_browser_state(SimpleNamespace(evaluate=AsyncMock(return_value=[{"matched": False, "actual": "Wrong route"}])),
                                            [{"kind": "text", "expected": "Correct route"}], 0)
        self.assertEqual(action_status(result), "failed")

    async def test_disconnected_observation_cannot_pass(self):
        result = await assert_browser_state(SimpleNamespace(evaluate=AsyncMock(return_value=None)),
                                            [{"kind": "text", "expected": "Result"}], 0)
        self.assertEqual(action_status(result), "unverified")

    async def test_transport_exception_cannot_pass(self):
        result = await assert_browser_state(SimpleNamespace(evaluate=AsyncMock(side_effect=RuntimeError("offline"))),
                                            [{"kind": "text", "expected": "Result"}], 0)
        self.assertEqual(action_status(result), "unverified")

    async def test_empty_invalid_contracts_do_not_read_page(self):
        session = SimpleNamespace(evaluate=AsyncMock())
        for expectations in [[], [{"kind": "text", "expected": ""}], [{"kind": "value", "expected": "a"}],
                             [{"kind": "checked", "selector": "#flag", "expected": "false"}],
                             [{"kind": "url", "selector": "#x", "expected": "https://fixture"}],
                             [{"kind": "visible", "selector": "#flag", "expected": False}]]:
            self.assertEqual((await assert_browser_state(session, expectations, 0))["status"], "failed")
        session.evaluate.assert_not_awaited()

    async def test_timeout_contract_is_bounded(self):
        session = SimpleNamespace(evaluate=AsyncMock())
        for timeout in [-1, 31, float("nan"), "five", True]:
            self.assertEqual((await assert_browser_state(session, [{"kind": "text", "expected": "Result"}], timeout))["status"], "failed")
        session.evaluate.assert_not_awaited()

    async def test_cancel_interrupts_polling(self):
        session = SimpleNamespace(evaluate=AsyncMock(return_value=[{"matched": False, "actual": "Loading"}]))
        task = asyncio.create_task(assert_browser_state(session, [{"kind": "text", "expected": "Result"}], 30))
        await asyncio.sleep(.01)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_password_expectation_is_redacted(self):
        result = await assert_browser_state(SimpleNamespace(evaluate=AsyncMock(return_value=[{"matched": False, "actual": "[redacted]", "unavailable": True}])),
                                            [{"kind": "value", "selector": "#password", "expected": "secret123"}], 0)
        self.assertNotIn("secret123", str(result))
        self.assertEqual(result["status"], "unverified")

    def test_assertion_report_and_no_empty_pass(self):
        self.assertEqual(action_status({"action": "assert", "verification": {"verified": True}}), "unverified")
        result = {"action": "assert", "assertions": [{"status": "passed"}], "verification": {"verified": True, "effect_type": "assertion"}}
        report = build_test_report([{"action": "assert", "result": result}], "/", "Fixture")
        self.assertIn("Explicit expectations:** 1 passed", report)
        self.assertIn("LIMITED COVERAGE", report)


class VisualObservationTests(unittest.TestCase):
    def test_only_configured_vision_lane_receives_fresh_images(self):
        result = {"frame": "data:image/jpeg;base64,/9j/", "visual_captured": True}
        self.assertIsNotNone(visual_observation_message(result, "fixture-vision", {}))
        self.assertIsNone(visual_observation_message(result, "text-model", {}))
        self.assertIsNotNone(visual_observation_message(result, "custom-model", {"browser_vision_enabled": True}))
        self.assertIsNone(visual_observation_message(result, "vision-model", {"browser_vision_enabled": False}))
        self.assertIsNone(visual_observation_message({**result, "visual_captured": False}, "vision", {}))

    def test_mutation_result_image_is_available_without_a_second_observe_call(self):
        result = {"action":"click", "frame":"data:image/jpeg;base64,/9j/"}
        self.assertIsNotNone(visual_observation_message(result, "gpt-4.1", {}))
        self.assertIsNotNone(visual_observation_message(result, "qwen-vl", {}))
        self.assertIsNone(visual_observation_message(result, "gpt-oss-20b", {}))

    def test_invalid_frame_is_not_forwarded(self):
        for frame in ["http://untrusted/remote.jpg", "data:image/jpeg;base64,bad", "data:image/jpeg;base64,YWJj"]:
            self.assertIsNone(visual_observation_message({"frame": frame, "visual_captured": True}, "vision", {}))

    def test_visual_context_is_bounded_and_preserves_user_uploads(self):
        upload = {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "user-upload"}}]}
        observation = visual_observation_message({"frame": "data:image/jpeg;base64,/9j/", "visual_captured": True}, "vision", {})
        messages = [upload, observation, observation, observation]
        retain_recent_visual_observations(messages)
        self.assertEqual(messages[0], upload)
        self.assertIsInstance(messages[1]["content"], str)
        self.assertIsInstance(messages[2]["content"], list)


if __name__ == "__main__":
    unittest.main()
