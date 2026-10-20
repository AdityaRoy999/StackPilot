"""One-click task constraints survive delayed results without broad click bans."""
import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from app.browser_testing.cardinality import preflight_click_limit, record_click_limit
from app.browser_testing.assertions import assert_browser_state


class ExplicitClickLimits(unittest.TestCase):
    def fixture(self, goal="Click Button Triggering AJAX Request exactly once, then wait for the result."):
        control = {"id": 7, "tag": "button", "type": "button", "input_id": "ajax-trigger",
                   "label": "Button Triggering AJAX Request", "url": "https://fixture.invalid/ajax"}
        session = SimpleNamespace(task_context={"goal": goal}, target_id="tab", _selected_frame=None,
                                  current_url=control["url"], interactive_elements=[control],
                                  dispatched_activations=0, dispatched_inputs=0)
        return session, control, {"action": "click", "element_id": 7}

    def test_exact_user_once_name_allows_one_dispatch_then_blocks_a_retry(self):
        session, control, arguments = self.fixture()
        blocked, reservation = preflight_click_limit(session, arguments, control)
        self.assertIsNone(blocked)
        self.assertIsNotNone(reservation)
        session.dispatched_activations += 1
        self.assertTrue(record_click_limit(session, reservation, 0))
        blocked, reservation = preflight_click_limit(session, arguments, control)
        self.assertEqual(blocked["recovery"]["reason"], "explicit_click_limit_reached")
        self.assertEqual(blocked["dispatch_state"], "not_dispatched")
        self.assertIsNone(reservation)

    def test_quotes_whitespace_case_and_optional_button_description(self):
        for goal in ("Click the ‘Button Triggering AJAX Request’ only once.",
                     'Click "Button Triggering AJAX Request" exactly once.',
                     "click the Button   Triggering AJAX Request button exactly once"):
            with self.subTest(goal=goal):
                session, control, arguments = self.fixture(goal)
                self.assertIsNotNone(preflight_click_limit(session, arguments, control)[1])

    def test_without_explicit_named_once_constraint_controls_remain_repeatable(self):
        for goal in ("Test the whole website", "Click the trigger and inspect its output",
                     "Click Button Triggering AJAX Request twice",
                     "Click Button Triggering AJAX Request. Only once the output appears, verify it.",
                     "Do not click Button Triggering AJAX Request exactly once",
                     "Double click Button Triggering AJAX Request exactly once"):
            with self.subTest(goal=goal):
                session, control, arguments = self.fixture(goal)
                self.assertEqual(preflight_click_limit(session, arguments, control), (None, None))

    def test_partial_label_does_not_match_longer_observed_name(self):
        session, control, arguments = self.fixture("Click Button Triggering exactly once.")
        self.assertEqual(preflight_click_limit(session, arguments, control), (None, None))

    def test_duplicate_observed_labels_do_not_guess_the_card(self):
        session, control, arguments = self.fixture()
        session.interactive_elements.append({**control, "id": 8, "input_id": "another-trigger"})
        self.assertEqual(preflight_click_limit(session, arguments, control), (None, None))

    def test_missing_or_wrong_observed_control_does_not_bind_a_constraint(self):
        session, control, arguments = self.fixture()
        session.interactive_elements = [{**control, "id": 8}]
        self.assertEqual(preflight_click_limit(session, arguments, control), (None, None))
        session.interactive_elements = []
        self.assertEqual(preflight_click_limit(session, arguments, control), (None, None))

    def test_repeated_instruction_with_same_label_has_no_unambiguous_limit(self):
        session, control, arguments = self.fixture(
            "Click Button Triggering AJAX Request exactly once in each page; "
            "then click Button Triggering AJAX Request only once in the next page.")
        self.assertEqual(preflight_click_limit(session, arguments, control), (None, None))

    def test_movement_scroll_or_preflight_failure_does_not_consume_allowance(self):
        session, control, arguments = self.fixture()
        _, reservation = preflight_click_limit(session, arguments, control)
        session.dispatched_inputs += 2  # Wheel or other non-activation inputs.
        self.assertFalse(record_click_limit(session, reservation, 0))
        self.assertIsNotNone(preflight_click_limit(session, arguments, control)[1])

    def test_changed_loading_label_and_rebound_reference_cannot_replay_same_control(self):
        session, control, arguments = self.fixture()
        _, reservation = preflight_click_limit(session, arguments, control)
        session.dispatched_activations += 1
        record_click_limit(session, reservation, 0)
        changed = {**control, "label": "Loading…", "id": 99}
        session.interactive_elements = [changed]
        blocked, _ = preflight_click_limit(session, {**arguments, "element_id": 99}, changed)
        self.assertEqual(blocked["recovery"]["reason"], "explicit_click_limit_reached")

    def test_other_control_and_legitimate_toggle_repeats_remain_allowed(self):
        session, control, arguments = self.fixture()
        _, reservation = preflight_click_limit(session, arguments, control)
        session.dispatched_activations += 1
        record_click_limit(session, reservation, 0)
        toggle = {"id": 8, "tag": "button", "input_id": "toggle", "label": "Show details"}
        session.interactive_elements.append(toggle)
        for action in ("click", "double_click", "toggle_checkbox", "set_checked"):
            self.assertEqual(preflight_click_limit(session, {"action": action, "element_id": 8}, toggle), (None, None))

    def test_double_click_is_rejected_before_any_dispatch(self):
        session, control, arguments = self.fixture()
        blocked, reservation = preflight_click_limit(session, {**arguments, "action": "double_click"}, control)
        self.assertEqual(blocked["recovery"]["reason"], "explicit_click_limit")
        self.assertEqual(session.dispatched_activations, 0)
        self.assertIsNone(reservation)

    def test_keyboard_activation_is_equivalent_but_focus_and_nonactivation_keys_are_not(self):
        session, control, _ = self.fixture()
        for key in ("Enter", "Space", " "):
            self.assertIsNotNone(preflight_click_limit(session, {"action": "press_key", "key": key}, control)[1])
        for arguments in ({"action": "press_key", "key": "Tab"}, {"action": "hover"},
                          {"action": "right_click"}, {"action": "type", "text": "a"}):
            self.assertEqual(preflight_click_limit(session, arguments, control), (None, None))

    def test_new_task_does_not_inherit_the_prior_tasks_limit(self):
        session, control, arguments = self.fixture()
        _, reservation = preflight_click_limit(session, arguments, control)
        session.dispatched_activations += 1
        record_click_limit(session, reservation, 0)
        session.task_context = {"goal": "A new run: click Button Triggering AJAX Request exactly once."}
        self.assertIsNotNone(preflight_click_limit(session, arguments, control)[1])

    def test_enter_in_field_shares_observed_default_buttons_once_limit(self):
        session, control, arguments = self.fixture()
        control.update(type="submit", form=True)
        field = {"id": 8, "tag": "input", "type": "search", "label": "Query", "form": True,
                 "url": control["url"], "submit_control": {key: control[key] for key in
                    ("tag", "type", "input_id", "label")}}
        session.interactive_elements.append(field)
        _, reservation = preflight_click_limit(session, arguments, control)
        session.dispatched_activations += 1
        record_click_limit(session, reservation, 0)
        blocked, _ = preflight_click_limit(session, {"action": "press_key", "key": "Enter", "element_id": 8}, field)
        self.assertEqual(blocked["recovery"]["reason"], "explicit_click_limit_reached")
        self.assertEqual(preflight_click_limit(session, {"action": "press_key", "key": "Space", "element_id": 8}, field), (None, None))
        self.assertEqual(preflight_click_limit(session, {"action": "press_key", "key": "Enter", "element_id": 8},
            {**field, "submit_control": None}), (None, None))


class ReplayAndAssertionContracts(unittest.IsolatedAsyncioTestCase):
    async def test_unknown_acknowledgement_and_cancellation_still_consume_activation(self):
        for error in (TimeoutError("Unknown input ACK"), asyncio.CancelledError()):
            with self.subTest(error=type(error).__name__):
                session, control, arguments = ExplicitClickLimits().fixture()
                _, reservation = preflight_click_limit(session, arguments, control)
                async def operation():
                    try:
                        session.dispatched_activations += 1  # Native activation enqueued.
                        raise error
                    finally:
                        record_click_limit(session, reservation, 0)
                with self.assertRaises(type(error)):
                    await operation()
                blocked, _ = preflight_click_limit(session, arguments, control)
                self.assertEqual(blocked["recovery"]["reason"], "explicit_click_limit_reached")

    async def test_retargeted_same_expectation_is_reprobed_once_and_can_pass(self):
        session = SimpleNamespace(dispatched_inputs=1, current_url="https://fixture.invalid/ajax",
            evaluate=AsyncMock(side_effect=[[{"matched": False, "actual": "Trigger"}],
                                            [{"matched": True, "actual": "Data loaded"}]]))
        first = await assert_browser_state(session, [{"kind": "text", "element_id": 7, "expected": "Data loaded"}], 0, "outcome")
        second = await assert_browser_state(session, [{"kind": "text", "element_id": 9, "expected": "Data loaded"}], 5, "outcome")
        self.assertEqual(first["status"], "failed")
        self.assertEqual(second["status"], "passed")
        self.assertEqual(second["attempts"], 1)
        self.assertEqual(second["assertions"][0]["expectation"]["expected"], "Data loaded")

    async def test_retargeting_does_not_relax_or_invent_the_requested_outcome(self):
        session = SimpleNamespace(dispatched_inputs=1, current_url="https://fixture.invalid/ajax",
            evaluate=AsyncMock(return_value=[{"matched": False, "actual": "Loading"}]))
        await assert_browser_state(session, [{"kind": "text", "element_id": 7, "expected": "Data loaded"}], 0, "outcome")
        second = await assert_browser_state(session, [{"kind": "text", "element_id": 9, "expected": "Data loaded"}], 5, "outcome")
        self.assertEqual(second["status"], "failed")
        self.assertFalse(second["verification"]["verified"])
        self.assertEqual(second["attempts"], 1)
        self.assertEqual(second["assertions"][0]["actual"], "Loading")

    async def test_new_expected_value_and_post_input_state_get_normal_bounded_wait(self):
        session = SimpleNamespace(dispatched_inputs=1, current_url="https://fixture.invalid/ajax",
                                  evaluate=AsyncMock(return_value=[{"matched": False, "actual": "Loading"}]))
        await assert_browser_state(session, [{"kind": "text", "element_id": 7, "expected": "First result"}], 0)
        result = await assert_browser_state(session, [{"kind": "text", "element_id": 7, "expected": "Second result"}], .11)
        self.assertGreater(result["attempts"], 1)
        session.dispatched_inputs += 1
        after_input = await assert_browser_state(session, [{"kind": "text", "element_id": 7, "expected": "Second result"}], .11)
        self.assertGreater(after_input["attempts"], 1)


class ExecutorClickLimitIntegration(unittest.IsolatedAsyncioTestCase):
    """Use the real executor wrapper/preflight and real CDP enqueue accounting.

    Only the browser transport and page reads are replaced. No provider calls,
    external website, synthetic DOM click, or test-specific executor bypass.
    """
    async def asyncSetUp(self):
        from app.browser_driver import BrowserSession, browser_manager
        _, control, self.arguments = ExplicitClickLimits().fixture()
        self.session = BrowserSession("once-click-integration", target_url=control["url"])
        self.session.current_url = control["url"]
        self.session.task_context = {"goal": "Click Button Triggering AJAX Request exactly once, then wait for the result."}
        self.control = {**control, "text": control["label"]}
        self.session.interactive_elements = [self.control]
        self.session.agent_access_mode = "full_access"
        self.session.is_connected = True
        self.session.cdp_ws = object()
        self.mode = "ack"
        self.dispatches = []
        self.activated = asyncio.Event()

        def enqueue(item):
            command = json.loads(item[2])
            self.dispatches.append(command)
            params = command.get("params", {})
            if params.get("type") == "mousePressed" and params.get("button") == "left":
                self.activated.set()
                if self.mode in {"timeout", "cancel"}:
                    return
            future = self.session._pending_requests[command["id"]]
            future.set_result({})
        self.session._send_queue = SimpleNamespace(put_nowait=Mock(side_effect=enqueue))

        async def read(expression, **kwargs):
            if expression.startswith("Boolean(window.__spFast?"):
                return True
            return dict(self.control)
        self.session.evaluate = AsyncMock(side_effect=read)
        self.session.extract_interactive_tree = AsyncMock(return_value={"fresh": True})

        async def click(*args, **kwargs):
            if self.mode == "scroll_only":
                await self.session.send_command("Input.dispatchMouseEvent", {"type": "mouseWheel", "deltaY": 80}, timeout=.01)
                return False
            await self.session.send_command("Input.dispatchMouseEvent", {
                "type": "mousePressed", "button": "left", "x": 20, "y": 30},
                timeout=30 if self.mode == "cancel" else .01)
            await self.session.send_command("Input.dispatchMouseEvent", {
                "type": "mouseReleased", "button": "left", "x": 20, "y": 30}, timeout=.01)
            # Acknowledged input can produce only focus before the AJAX result.
            self.session.last_action_verification = {"verified": False, "effect_type": "focus"}
            return True
        self.session.click_element = AsyncMock(side_effect=click)
        browser_manager.sessions[self.session.session_id] = self.session
        self.widget_patch = patch("app.browser_testing.widgets.observe_widgets", new_callable=AsyncMock, return_value={})
        self.widget_patch.start()

    async def asyncTearDown(self):
        from app.browser_driver import browser_manager
        self.widget_patch.stop()
        browser_manager.sessions.pop(self.session.session_id, None)
        browser_manager.operation_locks.pop(self.session.session_id, None)
        browser_manager.busy_sessions.discard(self.session.session_id)

    async def interact(self):
        from app.tools import _execute_legacy_tool
        return await _execute_legacy_tool("browser_interact", {
            **self.arguments, "session_id": self.session.session_id, "include_frame": False}, "fixture")

    async def test_acknowledged_focus_only_click_cannot_be_retried(self):
        first = await self.interact()
        self.assertEqual(first["status"], "unverified", first)
        self.assertEqual(first["explicit_click_dispatch"], "dispatched_once", first)
        calls = len(self.dispatches)
        second = await self.interact()
        self.assertEqual(second["recovery"]["reason"], "explicit_click_limit_reached", second)
        self.assertEqual(self.session.dispatched_activations, 1)
        self.assertEqual(len(self.dispatches), calls)
        self.assertEqual(self.session.click_element.await_count, 1)

    async def test_unknown_acknowledgement_is_consumed_and_not_replayed(self):
        self.mode = "timeout"
        first = await self.interact()
        self.assertEqual(first["status"], "failed", first)
        self.assertIn("acknowledgment timed out", first["error"])
        self.assertEqual(first["explicit_click_dispatch"], "dispatched_once")
        second = await self.interact()
        self.assertEqual(second["recovery"]["reason"], "explicit_click_limit_reached", second)
        self.assertEqual(self.session.dispatched_activations, 1)
        self.assertEqual(self.session.click_element.await_count, 1)

    async def test_scroll_only_preparation_leaves_one_click_available(self):
        self.mode = "scroll_only"
        first = await self.interact()
        self.assertEqual(first["status"], "failed", first)
        self.assertNotIn("explicit_click_dispatch", first)
        self.assertGreater(self.session.dispatched_inputs, 0)
        self.assertEqual(self.session.dispatched_activations, 0)
        self.mode = "ack"
        second = await self.interact()
        self.assertEqual(second["explicit_click_dispatch"], "dispatched_once", second)
        third = await self.interact()
        self.assertEqual(third["recovery"]["reason"], "explicit_click_limit_reached", third)
        self.assertEqual(self.session.dispatched_activations, 1)
        self.assertEqual(self.session.click_element.await_count, 2)

    async def test_cancellation_after_native_enqueue_cannot_make_a_second_click(self):
        self.mode = "cancel"
        running = asyncio.create_task(self.interact())
        await asyncio.wait_for(self.activated.wait(), 2)
        running.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await running
        self.mode = "ack"
        result = await self.interact()
        self.assertEqual(result["recovery"]["reason"], "explicit_click_limit_reached", result)
        self.assertEqual(self.session.dispatched_activations, 1)
        self.assertEqual(self.session.click_element.await_count, 1)

    async def test_native_counter_excludes_movement_wheel_release_and_typing(self):
        for method, params in (
            ("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 2, "y": 3}),
            ("Input.dispatchMouseEvent", {"type": "mouseWheel", "deltaY": 80}),
            ("Input.dispatchMouseEvent", {"type": "mousePressed", "button": "right"}),
            ("Input.dispatchMouseEvent", {"type": "mouseReleased", "button": "left"}),
            ("Input.insertText", {"text": "Fixture text"}),
            ("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "A"}),
            ("Input.dispatchKeyEvent", {"type": "char", "text": " "}),
            ("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter"}),
        ):
            await self.session.send_command(method, params, timeout=.01)
        self.assertEqual(self.session.dispatched_activations, 0)
        await self.session.send_command("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "Enter"}, timeout=.01)
        await self.session.send_command("Input.dispatchKeyEvent", {"type": "keyDown", "key": " "}, timeout=.01)
        self.assertEqual(self.session.dispatched_activations, 2)
