import unittest
from unittest.mock import MagicMock, patch
from app.deployment_incidents import close_terminal_runs, session


class IncidentLifecycleTests(unittest.TestCase):
    def test_early_build_failure_with_null_plan_can_start_recovery(self):
        for snapshot in (None, {}, {'deployment_plan': None}):
            cursor = MagicMock()
            cursor.fetchone.side_effect = [('project', 'Project', 'failed', snapshot), ('session',), ('message',)]
            with patch('app.deployment_incidents.database', side_effect=lambda operation: operation(cursor)):
                result = session({'deployment_id': 'deployment', 'user_id': 'user', 'session_id': None,
                                  'id': 'incident', 'attempt': 1}, 'owner')
            self.assertEqual(result, ('session', 'message', 'project', 'Project', None))

    def test_terminal_repair_closes_run_and_revokes_live_task_leases(self):
        cursor=MagicMock(); cursor.fetchall.return_value=[('fixture-run',)]
        close_terminal_runs(cursor)
        query=cursor.execute.call_args_list[0].args[0]
        self.assertIn("i.status IN ('failed','blocked','canceled','healed')",query)
        self.assertIn("active.status IN ('queued','running','retrying')",query)
        self.assertIn("deployment_repair",query)
        self.assertIn('r.deployment_id=i.deployment_id::text',query)
        self.assertIn('lease_until=0',cursor.execute.call_args_list[1].args[0])

    def test_retrying_incident_has_no_terminal_runs_to_close(self):
        cursor=MagicMock(); cursor.fetchall.return_value=[]
        close_terminal_runs(cursor)
        self.assertEqual(cursor.execute.call_count,1)
