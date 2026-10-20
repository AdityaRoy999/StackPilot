"""The qualification harness must not promote agent claims to ground truth.

python -m unittest discover -s tests/unit -p test_browser_unseen_benchmark.py -v
"""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch


HARNESS = Path(__file__).resolve().parents[2] / "tests" / "integration" / "browser_unseen_benchmark.py"
spec = importlib.util.spec_from_file_location("unseen_benchmark", HARNESS)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class UnseenBenchmarkTests(unittest.TestCase):
    def test_six_distinct_public_domains(self):
        from urllib.parse import urlparse
        self.assertEqual(len(benchmark.SCENARIOS), 6)
        self.assertEqual(len({urlparse(row["url"]).hostname for row in benchmark.SCENARIOS}), 6)
        self.assertEqual(len({row["category"] for row in benchmark.SCENARIOS}), 6)

    def test_identity_captures_source_changes_without_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            (package / "main.py").write_text("version = 1", encoding="utf-8")
            with patch.dict("sys.modules", {"app": SimpleNamespace(__file__=str(package / "__init__.py"))}):
                first = benchmark.qualification_identity()
                (package / "main.py").write_text("version = 2", encoding="utf-8")
                second = benchmark.qualification_identity()
            self.assertEqual(first["manifest_sha256"], second["manifest_sha256"])
            self.assertNotEqual(first["implementation_sha256"]["main.py"], second["implementation_sha256"]["main.py"])
            self.assertEqual(set(first), {"manifest_sha256", "implementation_sha256"})

    def test_native_select_must_reach_requested_option_not_just_confirmation(self):
        evidence = dict(received=True, text="StackPilot QA", selected="1", checkboxes=[])
        self.assertFalse(benchmark.oracle_passes("selenium_form", evidence))
        evidence["selected"] = "2"
        self.assertTrue(benchmark.oracle_passes("selenium_form", evidence))
        evidence["checkboxes"] = ["on"]
        self.assertFalse(benchmark.oracle_passes("selenium_form", evidence))

    def test_unrelated_cart_item_and_wrong_quantity_fail(self):
        evidence = dict(url="https://www.saucedemo.com/cart.html", items=[dict(name="Sauce Labs Backpack", quantity="1")])
        self.assertTrue(benchmark.oracle_passes("sauce_cart", evidence))
        evidence["items"][0]["quantity"] = "2"
        self.assertFalse(benchmark.oracle_passes("sauce_cart", evidence))
        evidence["items"] = []
        self.assertFalse(benchmark.oracle_passes("sauce_cart", evidence))

    def test_task_must_be_visible_in_completed_filter(self):
        evidence = dict(filter="Completed", tasks=[dict(text="StackPilot unseen QA", completed=True, checked=True, visible=True)])
        self.assertTrue(benchmark.oracle_passes("todo_workflow", evidence))
        evidence["tasks"][0]["visible"] = False
        self.assertFalse(benchmark.oracle_passes("todo_workflow", evidence))

    def test_repeat_candidates_require_same_arguments_and_observed_state(self):
        session = SimpleNamespace(target_id="tab", _navigation_generation=1, current_url="https://example.test", scroll_y=0,
                                  interactive_elements=[dict(id="flag", checked=False)])
        first_state = benchmark.state_signature(session)
        first = benchmark.call_fingerprint("browser_interact", dict(action="click", element_id="flag", session_id="owned-a"), first_state)
        same = benchmark.call_fingerprint("browser_interact", dict(action="click", element_id="flag", session_id="owned-b", include_frame=False), first_state)
        self.assertEqual(first, same)
        session.interactive_elements[0]["checked"] = True
        changed = benchmark.call_fingerprint("browser_interact", dict(action="click", element_id="flag"), benchmark.state_signature(session))
        self.assertNotEqual(first, changed)
        trace = [dict(type="tool_call", fingerprint=value) for value in [first, same, changed]]
        self.assertEqual(benchmark.summarize_trace(trace)["same_state_repeat_candidates"], 1)

    def test_checkpoint_and_outcome_assertions_are_distinct_calls(self):
        args = dict(expectations=[dict(kind="checked", expected=True)], purpose="checkpoint")
        first = benchmark.call_fingerprint("browser_assert", args, "same_state")
        args["purpose"] = "outcome"
        self.assertNotEqual(first, benchmark.call_fingerprint("browser_assert", args, "same_state"))

    def test_arguments_summary_omits_form_values_and_demo_password(self):
        output = benchmark._arguments_summary(dict(action="type", element_id="password", text="public-demo-password"))
        self.assertNotIn("public-demo-password", str(output))
        self.assertEqual(output["element_id"], "password")

    def test_metrics_do_not_double_count_batch_envelope(self):
        trace = [dict(type="tool_result", steps=[dict(action="type", status="passed"), dict(action="assert", status="passed", assertions=[dict(status="passed")])])]
        metrics = benchmark.summarize_trace(trace)
        self.assertEqual(metrics["action_count"], 1)
        self.assertEqual(metrics["passed_assertions"], 1)


if __name__ == "__main__":
    unittest.main()
