import unittest

from app.browser_testing.evaluation import summarize_events


class EvaluationTests(unittest.TestCase):
    def test_checkpoint_cannot_raise_task_success(self):
        metrics = summarize_events([
            {'type':'browser_timing','phase':'planner','elapsed_ms':2000},
            {'type':'browser_timing','phase':'planner','elapsed_ms':3000},
            {'type':'browser_timing','phase':'tool','elapsed_ms':300},
            {'type':'tool_result','name':'browser_interact','result':{
                'status':'passed','dispatch_state':'dispatched','verification_state':'checkpoint_passed',
                'timing':{'dispatch_ms':12}}},
            {'type':'done','status':'verified'},
        ])
        self.assertTrue(metrics['false_completion_signal'])
        self.assertFalse(metrics['verified_task'])
        self.assertEqual(metrics['timings']['planner']['p50_ms'], 2000)
        self.assertEqual(metrics['timings']['planner']['p95_ms'], 3000)
        self.assertEqual(metrics['timings']['dispatch']['p50_ms'], 12)

    def test_explicit_outcome_marks_verified(self):
        metrics = summarize_events([
            {'type':'tool_result','name':'browser_assert','result':{
                'status':'passed','dispatch_state':'read_only','verification_state':'outcome_passed'}},
            {'type':'done','status':'verified'},
        ])
        self.assertTrue(metrics['verified_task'])
