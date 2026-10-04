"""Pointer feedback must describe dispatched input and stay bounded under load."""
import asyncio
import unittest
from unittest.mock import AsyncMock, Mock

from app.browser_driver import BrowserSession


class PointerMotionTests(unittest.IsolatedAsyncioTestCase):
    def session(self):
        session = BrowserSession('pointer-fixture')
        session.send_command = AsyncMock(return_value={})
        session.send_command_nowait = Mock()
        session._notify_listeners = Mock()
        session.wait_for_action_quiescence = AsyncMock()
        return session

    async def test_long_move_sends_one_animation_then_acknowledges_exact_destination(self):
        session = self.session()
        await session._move_pointer(10, 20, 'Move')
        session._notify_listeners.assert_called_once()
        event = session._notify_listeners.call_args.args[0]
        self.assertEqual((event['x'], event['y']), (10, 20))
        self.assertLessEqual(event['duration_ms'], 120)
        self.assertGreater(event['duration_ms'], 0)
        self.assertEqual(session.send_command.await_args.args,
                         ('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': 10, 'y': 20, 'buttons': 0}))
        self.assertEqual((session.cursor_x, session.cursor_y), (10, 20))

    async def test_click_feedback_follows_mouse_release(self):
        session = self.session()
        order = []
        async def dispatch(name, params):
            order.append(params['type'])
            return {}
        session.send_command.side_effect = dispatch
        session._notify_listeners.side_effect = lambda event: order.append(event['action'])
        await session.click(123, 234, fast_mode=True, exact_coords=True)
        self.assertEqual(order[:5], ['move', 'mouseMoved', 'mousePressed', 'mouseReleased', 'click'])
        clicked = session._notify_listeners.call_args.args[0]
        self.assertEqual(clicked['phase'], 'applied')
        self.assertEqual(clicked['duration_ms'], 0)

    async def test_failed_final_move_never_dispatches_or_reports_a_click(self):
        session = self.session()
        session.send_command.side_effect = RuntimeError('CDP unavailable')
        with self.assertRaises(RuntimeError):
            await session.click(10, 20, fast_mode=True)
        self.assertEqual(session.send_command.await_count, 1)
        self.assertEqual([call.args[0]['action'] for call in session._notify_listeners.call_args_list], ['move'])

    async def test_cancelled_motion_does_not_continue_to_click(self):
        session = self.session()
        waiting = asyncio.Event()
        async def dispatch(name, params):
            waiting.set()
            await asyncio.Event().wait()
        session.send_command.side_effect = dispatch
        task = asyncio.create_task(session.click(10, 20, fast_mode=True))
        await waiting.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(session.send_command.await_count, 1)
        self.assertFalse(any(call.args[0]['action'] == 'click' for call in session._notify_listeners.call_args_list))

    async def test_failed_drag_releases_native_button_without_reporting_drop(self):
        session = self.session()
        calls = 0
        async def move(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError('Move failed')
        session._move_pointer = AsyncMock(side_effect=move)
        with self.assertRaises(RuntimeError):
            await session.drag_and_drop(20, 30, 400, 500)
        self.assertEqual(session.send_command.await_args.args[1]['type'], 'mouseReleased')
        self.assertFalse(any(call.args[0]['action'] == 'drag_end' for call in session._notify_listeners.call_args_list))

    async def test_cancellation_during_press_acknowledgement_still_releases(self):
        for gesture in ('click', 'double_click', 'right_click', 'drag_and_drop'):
            with self.subTest(gesture=gesture):
                session = self.session()
                session._move_pointer = AsyncMock()
                pressed = asyncio.Event()
                released = asyncio.Event()
                async def dispatch(name, params):
                    if params['type'] == 'mousePressed':
                        pressed.set()
                        await asyncio.Event().wait()
                    elif params['type'] == 'mouseReleased':
                        released.set()
                    return {}
                session.send_command.side_effect = dispatch
                args = (10, 20, 300, 400) if gesture == 'drag_and_drop' else (10, 20)
                task = asyncio.create_task(getattr(session, gesture)(*args))
                await pressed.wait()
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertTrue(released.is_set())
                self.assertFalse(any(call.args[0].get('phase') == 'applied' for call in session._notify_listeners.call_args_list))

    async def test_lost_drag_move_acknowledgement_releases_at_last_dispatched_point(self):
        session = self.session()
        session._generate_bezier_path = lambda _x, _y, x, y, **kwargs: [(x, y)]
        async def dispatch(name, params):
            if params['type'] == 'mouseMoved' and params['buttons'] == 1:
                raise asyncio.TimeoutError('Final movement acknowledgement lost')
            return {}
        session.send_command.side_effect = dispatch
        with self.assertRaises(asyncio.TimeoutError):
            await session.drag_and_drop(20, 30, 400, 500)
        self.assertEqual(session.send_command.await_args.args[1]['type'], 'mouseReleased')
        self.assertEqual((session.send_command.await_args.args[1]['x'],
                          session.send_command.await_args.args[1]['y']), (400, 500))
        self.assertFalse(any(call.args[0]['action'] == 'drag_end' for call in session._notify_listeners.call_args_list))
