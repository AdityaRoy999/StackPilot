import unittest
from app.agent_runtime.command_failures import failure_summary


class CommandFailureTests(unittest.TestCase):
    def test_node_build_heap_failure_reports_resource_cause(self):
        reason=failure_summary({'exit_code':134,'output':'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'})
        self.assertIn('worker memory limit',reason)
        self.assertNotIn('Missing command/dependency',reason)

    def test_actual_test_failure_takes_priority_over_coverage_failure(self):
        reason=failure_summary({'exit_code':1,'output':'FAIL Required test coverage of 90% not reached\nFAILED tests/test_added.py::test_behavior - AssertionError: expected 2\n1 failed, 151 passed'})
        self.assertEqual(reason,'Repository test failed: tests/test_added.py::test_behavior - AssertionError: expected 2')

    def test_passing_tests_with_failed_coverage_keep_original_requirement(self):
        reason=failure_summary({'exit_code':1,'output':'FAIL Required test coverage of 90% not reached. Total coverage: 86.12%\n151 passed'})
        self.assertIn('Original test coverage requirement',reason)

    def test_bad_pytest_options_and_paths_have_actionable_reasons(self):
        self.assertIn('reported option syntax',failure_summary({'exit_code':4,'output':'pytest: error: argument --cov-report: invalid choice'}))
        self.assertIn('relative to root',failure_summary({'exit_code':4,'output':'ERROR: file or directory not found: apps/api/tests/test_added.py'}))

    def test_failure_reason_is_bounded(self):
        self.assertLess(len(failure_summary({'exit_code':1,'output':'FAILED tests/test.py - '+('x'*10000)})),750)


if __name__=='__main__':unittest.main()
