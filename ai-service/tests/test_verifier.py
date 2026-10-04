import unittest

from app.swarm import VerificationReport, VerifierAgent
from app.tools import execute_tool_call


class VerifierTests(unittest.TestCase):
    def test_default_report_has_no_false_evidence(self):
        report = VerificationReport()
        self.assertEqual(report.status, "warning")
        self.assertFalse(report.network_endpoints_live)

    def test_one_healthy_endpoint_cannot_hide_a_broken_endpoint(self):
        report = VerifierAgent().validate_build_integrity(
            {"status": "running"}, tested_endpoints=[{"healthy": True}, {"healthy": False}])
        self.assertEqual(report.status, "failed")
        self.assertFalse(report.network_endpoints_live)

    def test_no_endpoint_probes_is_incomplete(self):
        report = VerifierAgent().validate_build_integrity({"status": "running"})
        self.assertEqual(report.status, "warning")
        self.assertFalse(report.network_endpoints_live)

    def test_http_success_without_browser_verification_is_incomplete(self):
        report = VerifierAgent().validate_build_integrity(
            {"status": "running"}, tested_endpoints=[{"healthy": True}, {"healthy": True}])
        self.assertEqual(report.status, "warning")

    def test_verified_running_with_all_healthy_endpoints_passes(self):
        report = VerifierAgent().validate_build_integrity(
            {"status": "running", "verified": True}, tested_endpoints=[{"healthy": True}, {"healthy": True}])
        self.assertEqual(report.status, "passed")


class SubagentTests(unittest.IsolatedAsyncioTestCase):
    async def test_unscoped_subagent_cannot_claim_work_completed(self):
        report = await execute_tool_call("invoke_subagent", {"role": "Verifier", "task": "test app"}, "fixture")
        self.assertEqual(report["status"], "blocked")
        self.assertIn("error", report)
        self.assertNotIn("output", report)


if __name__ == "__main__":
    unittest.main()
