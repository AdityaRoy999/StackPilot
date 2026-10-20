"""Opt-in real-provider browser benchmark on six unrelated public demo/reference sites.

Run in the ai-service runtime, with PYTHONPATH=/app and configured provider and
browser worker. This invokes StackPilot's real planner, tools and Chromium. Only
backend project-context recovery is bypassed because every task owns an anonymous
browser context and has no StackPilot project. Oracles are read-only observations
after the agent stops, never instructions/locators supplied to the planner.

The six tasks are deliberately narrow and safe. They measure workflow completion,
not exhaustive website testing, and are not proof of universal CUA reliability.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import statistics
import time
from typing import Any
import uuid
from unittest.mock import AsyncMock, patch


SCENARIOS = [
    {
        "id": "selenium_form", "category": "native form controls",
        "url": "https://www.selenium.dev/selenium/web/web-form.html",
        "goal": "Test the demo web form: enter StackPilot QA in Text input, choose Two in Dropdown (select), untick Checked checkbox, then Submit. Verify the received confirmation. Leave other controls at their defaults. This is Selenium's public test fixture; submitting synthetic data here is authorized.",
        "oracle": """(() => ({url:location.href,title:document.title,
          received:document.body.innerText.includes('Received!'),
          text:new URL(location.href).searchParams.get('my-text'),
          selected:new URL(location.href).searchParams.get('my-select'),
          checkboxes:new URL(location.href).searchParams.getAll('my-check')}))()""",
    },
    {
        "id": "sauce_cart", "category": "demo commerce",
        "url": "https://www.saucedemo.com/",
        "goal": "Test this public demo shop: sign in with the demo account standard_user and the demo password secret_sauce shown on the page. Add exactly one Sauce Labs Backpack to the cart and open the cart. Verify that this exact product and quantity 1 are in the cart. Do not check out, purchase, create an account, or enter personal details.",
        "oracle": """(() => ({url:location.href,title:document.title,
          items:[...document.querySelectorAll('.cart_item')].map(e=>({
            name:e.querySelector('.inventory_item_name')?.textContent?.trim(),
            quantity:e.querySelector('.cart_quantity')?.textContent?.trim()}))}))()""",
    },
    {
        "id": "todo_workflow", "category": "local productivity",
        "url": "https://todomvc.com/examples/react/dist/",
        "goal": "Test this TodoMVC demo: add a new task named StackPilot unseen QA, mark that task complete, and switch to the Completed filter. Verify that the same task is visible and completed. Only change the task created in this anonymous demo browser; do not delete any pre-existing task.",
        "oracle": """(() => ({url:location.href,title:document.title,
          tasks:[...document.querySelectorAll('.todo-list li')].map(e=>({
            text:e.querySelector('label')?.textContent?.trim(),
            completed:e.classList.contains('completed'),
            checked:!!e.querySelector('input[type=checkbox]')?.checked,
            visible:!!e.getClientRects().length})),
          filter:document.querySelector('.filters .selected')?.textContent?.trim()}))()""",
    },
    {
        "id": "dynamic_ajax", "category": "asynchronous interface",
        "url": "http://uitestingplayground.com/ajax",
        "goal": "Test the AJAX Data demo: click Button Triggering AJAX Request exactly once, wait for its deliberately slow server response, and verify the green Data loaded with AJAX get request result. Do not click the trigger again while the request is pending.",
        "oracle": """(() => ({url:location.href,title:document.title,
          loaded:[...document.querySelectorAll('#content p')].some(e=>
            /Data loaded with AJAX get request/.test(e.textContent||'')),
          result:document.querySelector('#content')?.innerText?.trim()?.slice(0,240)}))()""",
    },
    {
        "id": "python_docs", "category": "technical documentation search",
        "url": "https://docs.python.org/3/",
        "goal": "Use this documentation website's search to search for dataclasses, then open the dataclasses module documentation from the results. Verify the dataclasses module heading and that its page describes data classes. Do not use a search engine or navigate to an invented URL.",
        "oracle": """(() => ({url:location.href,title:document.title,
          heading:document.querySelector('h1')?.innerText?.trim(),
          modulePage:!!document.querySelector('#module-dataclasses'),
          describes:/[Dd]ata [Cc]lasses/.test(document.body.innerText)}))()""",
    },
    {
        "id": "wikipedia_reference", "category": "encyclopedia navigation",
        "url": "https://en.wikipedia.org/wiki/Main_Page",
        "goal": "Use Wikipedia's search to find Ada Lovelace and open her article. Verify that the article heading is Ada Lovelace and that its lead describes her as a mathematician. Only read and search; do not edit, log in, donate, or open external websites.",
        "oracle": """(() => ({url:location.href,title:document.title,
          heading:document.querySelector('#firstHeading')?.innerText?.trim(),
          mathematician:/mathematician/i.test([...document.querySelectorAll('#mw-content-text p')]
            .map(e=>e.innerText.trim()).filter(Boolean).slice(0,3).join(' '))}))()""",
    },
]


def oracle_passes(scenario_id: str, evidence: dict) -> bool:
    if scenario_id == "selenium_form":
        return bool(evidence.get("received") and evidence.get("text") == "StackPilot QA" and evidence.get("selected") == "2" and evidence.get("checkboxes") == [])
    if scenario_id == "sauce_cart":
        return bool("/cart.html" in evidence.get("url", "") and evidence.get("items") == [{"name": "Sauce Labs Backpack", "quantity": "1"}])
    if scenario_id == "todo_workflow":
        return bool(evidence.get("filter") == "Completed" and any(
            row.get("text") == "StackPilot unseen QA" and row.get("completed") and row.get("checked") and row.get("visible")
            for row in evidence.get("tasks", [])))
    if scenario_id == "dynamic_ajax":
        return evidence.get("loaded") is True
    if scenario_id == "python_docs":
        return bool("/library/dataclasses.html" in evidence.get("url", "") and evidence.get("modulePage") and evidence.get("describes"))
    if scenario_id == "wikipedia_reference":
        return bool(evidence.get("heading") == "Ada Lovelace" and evidence.get("mathematician"))
    raise ValueError("Unknown benchmark scenario: " + scenario_id)


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:20]


def qualification_identity() -> dict:
    """Record manifest and implementation identity without runtime configuration."""
    import app
    package = Path(app.__file__).resolve().parent
    paths = ["main.py", "tools.py", "browser_driver.py", "browser_config.py",
             "testing_runtime.py", "apv_engine.py"]
    paths += [str(path.relative_to(package)).replace("\\", "/")
              for path in sorted((package / "browser_testing").rglob("*.py"))]
    sources = {name: hashlib.sha256((package / name).read_bytes()).hexdigest()
               for name in paths if (package / name).is_file()}
    return {"manifest_sha256": hashlib.sha256(json.dumps(SCENARIOS, sort_keys=True).encode()).hexdigest(),
            "implementation_sha256": sources}


def state_signature(session: Any) -> str:
    """Use cached observed UI state; do not add CDP reads to measured decisions."""
    if session is None:
        return "no_session"
    return _digest([
        getattr(session, "target_id", None), getattr(session, "_navigation_generation", None),
        getattr(session, "current_url", ""), getattr(session, "scroll_y", 0),
        [{key: row.get(key) for key in ("id", "text", "value", "checked", "selected", "expanded", "disabled", "pressed")}
         for row in getattr(session, "interactive_elements", [])],
    ])


def call_fingerprint(name: str, arguments: dict, state: str) -> str:
    # Frame capture and an owned session ID do not change what an action checks.
    normalized = {key: value for key, value in arguments.items() if key not in {"session_id", "include_frame"}}
    return _digest([name, normalized, state])


def _safe_step(result: dict) -> dict:
    fields = ("action", "status", "target", "error", "purpose", "dispatch_state", "verification_state", "completion_verified", "timing")
    safe = {key: result[key] for key in fields if key in result}
    if result.get("recovery"):
        safe["recovery_reason"] = result["recovery"].get("reason")
    if result.get("verification"):
        verification = result["verification"]
        safe["verification"] = {key: verification[key] for key in ("verified", "effect_type", "description") if key in verification}
    if result.get("assertions"):
        safe["assertions"] = [{"status": row.get("status"), "expectation": row.get("expectation")} for row in result["assertions"]]
    if result.get("interactive_elements"):
        # Needed to diagnose a guessed/stale/wrong card ID. Never retain field
        # values: the synthetic demo password is still treated as sensitive.
        control_fields = ("id", "tag", "role", "text", "aria_label", "placeholder", "card_context", "checked", "selected", "disabled", "is_in_viewport")
        safe["observed_controls"] = [{key: row[key] for key in control_fields if key in row}
                                     for row in result["interactive_elements"][:100] if isinstance(row, dict)]
    return safe


def _arguments_summary(arguments: dict) -> dict:
    # The public tasks contain only synthetic inputs, but still avoid retaining
    # passwords and form values. Action shapes/targets are enough for diagnosis.
    fields = ("action", "element_id", "query", "purpose", "offset", "scope", "max_seconds", "max_actions")
    output = {key: arguments[key] for key in fields if key in arguments}
    if "actions" in arguments:
        output["actions"] = [_arguments_summary(row) for row in arguments["actions"] if isinstance(row, dict)]
    if isinstance(arguments.get("expectations"), list):
        output["expectations"] = [
            {**{key: row[key] for key in ("kind", "element_id", "match") if key in row},
             "expected_type": type(row.get("expected")).__name__, "fields": sorted(row)}
            for row in arguments["expectations"] if isinstance(row, dict)]
    output["argument_fields"] = sorted(arguments)
    return output


def summarize_trace(trace: list[dict]) -> dict:
    calls = [row for row in trace if row.get("type") == "tool_call"]
    planners = [row for row in trace if row.get("type") == "browser_timing" and row.get("phase") == "planner"]
    durations = [float(row["elapsed_ms"]) for row in planners if isinstance(row.get("elapsed_ms"), (float, int))]
    fingerprints = Counter(row["fingerprint"] for row in calls if row.get("fingerprint"))
    steps = [step for row in trace if row.get("type") == "tool_result" for step in row.get("steps", [])]
    return {
        "tool_calls": len(calls), "planner_turns": len(planners),
        "planner_seconds": round(sum(durations) / 1000, 3),
        "planner_median_ms": round(statistics.median(durations), 1) if durations else None,
        "planner_timing_note": "Completed timing events only; a provider timeout without a timing event is included in total elapsed time, not planner_seconds.",
        "same_state_repeat_candidates": sum(count - 1 for count in fingerprints.values()),
        "repeat_candidate_note": "Exact same call and cached observed state; review intent before classifying as redundant.",
        "action_count": sum(step.get("action") not in {None, "assert", "observe", "batch"} for step in steps),
        "action_statuses": dict(Counter(str(step.get("status") or "unknown") for step in steps)),
        "replay_preventions": sum(step.get("recovery_reason") in {"repeated_operation", "submission_already_dispatched", "observation_cycle"} for step in steps),
        "passed_assertions": sum(check.get("status") == "passed" for step in steps for check in step.get("assertions", [])),
    }


async def run_scenario(scenario: dict, args: argparse.Namespace) -> dict:
    from app.browser_driver import browser_manager
    from app.main import AgentRequest, stream_agent_reply

    session_id = "unseen-qa-" + uuid.uuid4().hex
    started = time.monotonic()
    trace, final, evidence = [], {}, {}
    # Persist sanitized partial evidence before a long provider turn/deadline,
    # so a failing run can be diagnosed without waiting or touching its tab.
    event_path = Path(args.output).parent / (scenario["id"] + ".events.jsonl")
    event_path.parent.mkdir(parents=True, exist_ok=True)
    event_path.write_text("", encoding="utf-8")

    def record(row: dict) -> None:
        trace.append(row)
        with event_path.open("a", encoding="utf-8") as target:
            target.write(json.dumps(row, ensure_ascii=True) + "\n")

    run_id = error = None
    first_action = None
    screenshot = None
    request = AgentRequest(
        message=scenario["goal"], custom_url=scenario["url"], session_id=session_id,
        provider=args.provider or None, model=args.model or None, model_mode="fast",
        agent_access_mode="full_access", allow_agent_questions=False,
        runtime={"timezone": "UTC", "permissions": {"agent_access_mode": "full_access", "allow_agent_questions": False}},
    )
    try:
        with patch("app.main.recover_session_context", AsyncMock()):
            async with asyncio.timeout(args.deadline):
                async for raw in stream_agent_reply(request):
                    if not raw.startswith("data: "):
                        continue
                    event = json.loads(raw[6:].strip())
                    kind = event.get("type")
                    at = round(time.monotonic() - started, 3)
                    if kind == "browser_run":
                        run_id = event.get("run_id")
                    elif kind == "tool_call":
                        name, arguments = event.get("name", ""), event.get("arguments") or {}
                        actions = arguments.get("actions") or [arguments]
                        if first_action is None and (name == "browser_interact" or any(row.get("action") not in {None, "assert", "observe"} for row in actions)):
                            first_action = at
                        record({"type": kind, "at_seconds": at, "name": name,
                                      "arguments": _arguments_summary(arguments),
                                      "fingerprint": call_fingerprint(name, arguments, state_signature(browser_manager.sessions.get(session_id)))})
                    elif kind == "tool_result":
                        result = event.get("result") or {}
                        record({"type": kind, "at_seconds": at, "name": event.get("name"),
                                      **_safe_step(result),
                                      "steps": [_safe_step(row) for row in (result.get("results") or [result]) if isinstance(row, dict)]})
                    elif kind == "browser_timing":
                        record({key: event[key] for key in ("type", "phase", "iteration", "elapsed_ms", "first_delta_ms", "tool_count", "finish_reason", "model", "source") if key in event})
                    elif kind == "done":
                        final = {key: event[key] for key in ("status", "verified", "provider", "model", "browser_run_state", "trace_id") if key in event}
                    elif kind == "error":
                        error = str(event.get("message") or event.get("error") or "Unknown stream error")[:1000]
                    elif kind in {"permission_request", "agent_question"}:
                        record({"type": kind, "at_seconds": at})
    except TimeoutError:
        error = f"Scenario deadline exceeded ({args.deadline:g} seconds)"
    except Exception as exc:
        # Runtime diagnostic only. No request/provider configuration is included.
        error = type(exc).__name__ + ": " + str(exc)[:500]
    finally:
        agent_elapsed = round(time.monotonic() - started, 3)
        session = browser_manager.sessions.get(session_id)
        if session is not None and session.is_connected:
            try:
                evidence = await session.evaluate(scenario["oracle"], timeout=5) or {}
                evidence["page_diagnostic"] = await session.evaluate("({url:location.href,title:document.title,body_excerpt:document.body.innerText.slice(0,500)})", timeout=5)
                if args.screenshots:
                    image = await session.capture_screenshot(quality=75, use_cache=False)
                    if image:
                        screenshot = scenario["id"] + ".jpg"
                        (Path(args.output).parent / screenshot).write_bytes(base64.b64decode(image))
            except Exception as exc:
                evidence["oracle_error"] = type(exc).__name__ + ": " + str(exc)[:400]
        await browser_manager.close_session(session_id)
    passed = oracle_passes(scenario["id"], evidence)
    claimed = final.get("status") == "verified" or final.get("verified") is True
    return {"id": scenario["id"], "category": scenario["category"], "url": scenario["url"],
            "goal": scenario["goal"], "run_id": run_id, "agent_elapsed_seconds": agent_elapsed,
            "first_action_seconds": first_action, "independent_success": passed,
            "agent_claimed_verified": claimed, "false_completion": bool(claimed and not passed),
            "strict_success": bool(passed and claimed and not error), "error": error,
            "final": final, "independent_evidence": evidence, "metrics": summarize_trace(trace),
            "trace": trace, "event_log": event_path.name, "screenshot": screenshot,
            "owned_browser_closed": session_id not in browser_manager.sessions}


async def main(args: argparse.Namespace) -> int:
    if not args.run_live:
        raise SystemExit("Live provider calls require --run-live. Use --list to inspect the fixed tasks.")
    selected = [row for row in SCENARIOS if not args.only or row["id"] in args.only]
    unknown = set(args.only or []) - {row["id"] for row in SCENARIOS}
    if unknown:
        raise SystemExit("Unknown scenarios: " + ", ".join(sorted(unknown)))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"started_at_utc": datetime.now(timezone.utc).isoformat(),
              "qualification_identity": qualification_identity(),
              "scope": "Six fixed public workflows; no application-specific execution adapters; post-run read-only oracles. Not an exhaustive audit or a trained/test holdout guarantee.",
              "runtime": {"requested_model": args.model or "configured_default", "requested_provider": args.provider or "configured_default",
                          "deadline_seconds": args.deadline, "model_mode": "fast",
                          "worker": args.runtime_label}, "results": []}
    for scenario in selected:
        print(json.dumps({"event": "scenario_started", "id": scenario["id"], "url": scenario["url"]}), flush=True)
        result = await run_scenario(scenario, args)
        result["implementation_unchanged_since_start"] = qualification_identity() == report["qualification_identity"]
        report["results"].append(result)
        report["summary"] = {"tested": len(report["results"]),
                             "independent_passed": sum(row["independent_success"] for row in report["results"]),
                             "strict_passed": sum(row["strict_success"] for row in report["results"]),
                             "false_completions": sum(row["false_completion"] for row in report["results"]),
                             "implementation_stable": all(row["implementation_unchanged_since_start"] for row in report["results"])}
        output.write_text(json.dumps(report, indent=2, ensure_ascii=True), encoding="utf-8")
        print(json.dumps({key: result[key] for key in ("id", "agent_elapsed_seconds", "first_action_seconds", "independent_success", "agent_claimed_verified", "error", "metrics")}), flush=True)
    return 0 if all(row["strict_success"] for row in report["results"]) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--run-live", action="store_true")
    parser.add_argument("--only", nargs="+", metavar="SCENARIO_ID")
    parser.add_argument("--provider", default=os.getenv("UNSEEN_BENCHMARK_PROVIDER", ""))
    parser.add_argument("--model", default=os.getenv("UNSEEN_BENCHMARK_MODEL", ""))
    parser.add_argument("--deadline", type=float, default=180)
    parser.add_argument("--screenshots", action="store_true")
    parser.add_argument("--runtime-label", default="AI service configured Chromium worker")
    parser.add_argument("--output", default="/tmp/stackpilot-unseen/benchmark.json")
    arguments = parser.parse_args()
    if arguments.list:
        print(json.dumps([{key: row[key] for key in ("id", "category", "url", "goal")} for row in SCENARIOS], indent=2))
    else:
        raise SystemExit(asyncio.run(main(arguments)))
