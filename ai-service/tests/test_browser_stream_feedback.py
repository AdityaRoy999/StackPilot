"""Multiple sockets share one TCP encoder; hidden sockets must not win by order."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock

from app.browser_driver import BrowserSession
from app.browser_streaming import ViewerFeedbackAggregator


HEALTHY = {"type": "feedback", "visible": True, "gap_ms": 0, "decode_queue": 0,
           "rtt_ms": 20, "presentation_interval_ms": 33, "frames_presented": 30, "jitter_buffer_ms": 0}


class SharedStreamFeedbackTests(unittest.TestCase):
    def session(self):
        session = BrowserSession('shared-encoder-feedback')
        session._stream_writer = Mock(is_closing=Mock(return_value=False))
        return session

    def feedback(self, session):
        return json.loads(session._stream_writer.write.call_args.args[0])

    def policy(self, writer):
        source = Path(__file__).with_name('streamer_module.py')
        if not source.exists():
            source = Path(__file__).resolve().parents[2] / 'browser-sandbox' / 'streamer.py'
        if not source.exists():
            self.skipTest('Producer source must be available for shared TCP path qualification')
        spec = importlib.util.spec_from_file_location('feedback_producer', source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.active_clients.add(writer)
        return module, module.CapturePolicy()

    def test_hidden_feedback_cannot_override_visible_through_the_same_tcp_writer(self):
        session = self.session()
        visible, hidden = lambda _: None, lambda _: None
        session.add_listener(visible)
        session.add_listener(hidden)
        session.forward_stream_feedback(visible, HEALTHY)
        session.forward_stream_feedback(hidden, {**HEALTHY, 'visible': False, 'gap_ms': 1000,
                                                'decode_queue': 100, 'rtt_ms': 1000})
        module, policy = self.policy(session._stream_writer)
        policy.update(session._stream_writer, self.feedback(session))
        self.assertEqual(policy.rate(), module.MAX_FPS)
        session.remove_listener(visible)
        policy.update(session._stream_writer, self.feedback(session))
        self.assertEqual(policy.rate(), module.IDLE_FPS)

    def test_visible_pressure_is_preserved_and_removed_viewer_stops_throttling(self):
        session = self.session()
        healthy, congested = lambda _: None, lambda _: None
        session.add_listener(healthy)
        session.add_listener(congested)
        session.forward_stream_feedback(congested, {**HEALTHY, 'decode_queue': 5, 'rtt_ms': 300})
        session.forward_stream_feedback(healthy, HEALTHY)
        module, policy = self.policy(session._stream_writer)
        policy.update(session._stream_writer, self.feedback(session))
        self.assertEqual(policy.rate(), 15)
        session.remove_listener(congested)
        policy.update(session._stream_writer, self.feedback(session))
        self.assertEqual(policy.rate(), module.MAX_FPS)

    def test_unknown_visible_measurements_cannot_be_masked_by_a_healthy_viewer(self):
        session = self.session()
        healthy, unknown = lambda _: None, lambda _: None
        session.add_listener(healthy)
        session.add_listener(unknown)
        session.forward_stream_feedback(unknown, {**HEALTHY, 'rtt_ms': None})
        session.forward_stream_feedback(healthy, HEALTHY)
        event = self.feedback(session)
        self.assertFalse(event['all_viewers_measured'])
        module, policy = self.policy(session._stream_writer)
        policy.update(session._stream_writer, event)
        self.assertEqual(policy.rate(), module.FPS)

    def test_feedback_from_orphaned_callback_is_not_sent(self):
        session = self.session()
        orphan = lambda _: None
        session.forward_stream_feedback(orphan, HEALTHY)
        session._stream_writer.write.assert_not_called()
        self.assertFalse(session._viewer_feedback.viewers)

    def test_removal_does_not_invent_hidden_state_for_a_new_unmeasured_viewer(self):
        session = self.session()
        old, new = lambda _: None, lambda _: None
        session.add_listener(old)
        session.add_listener(new)
        session.forward_stream_feedback(old, HEALTHY)
        session._stream_writer.write.reset_mock()
        session.remove_listener(old)
        session._stream_writer.write.assert_not_called()

    def test_expired_visible_viewer_does_not_mask_fresh_hidden_feedback(self):
        aggregator = ViewerFeedbackAggregator()
        visible, hidden = object(), object()
        aggregator.put(visible, HEALTHY, now=10)
        aggregator.put(hidden, {**HEALTHY, 'visible': False}, now=20)
        self.assertEqual(aggregator.aggregate({visible, hidden}, now=20), {'type': 'feedback', 'visible': False})
        self.assertEqual(set(aggregator.viewers), {hidden})

    def test_invalid_and_nonfinite_measurements_do_not_qualify_a_boost(self):
        aggregator = ViewerFeedbackAggregator()
        viewer = object()
        aggregator.put(viewer, {**HEALTHY, 'rtt_ms': float('nan'), 'frames_presented': True}, now=10)
        event = aggregator.aggregate({viewer}, now=11)
        self.assertEqual(event['rtt_ms'], 0)
        self.assertEqual(event['frames_presented'], 0)
        self.assertFalse(event['all_viewers_measured'])
