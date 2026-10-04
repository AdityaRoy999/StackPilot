"""Evidence-based browser results shared by the planner and deterministic runner."""
from __future__ import annotations

import time
import os
from dataclasses import dataclass, field
from typing import Any


def action_status(result: Any) -> str:
    if not isinstance(result, dict):
        return "unverified"
    if result.get("error") or result.get("status") in {"failed", "error", "blocked", "stale_element"}:
        return "failed"
    if result.get("action") == "batch":
        statuses = [action_status(r) for r in result.get("results", [])]
        return "failed" if "failed" in statuses else ("passed" if statuses and all(s == "passed" for s in statuses) else "unverified")
    verification = result.get("verification") or {}
    if result.get("action") == "assert":
        assertions = result.get("assertions") or []
        if any(a.get("status") == "failed" for a in assertions):
            return "failed"
        return "passed" if assertions and all(a.get("status") == "passed" for a in assertions) and verification.get("verified") is True else "unverified"
    if verification.get("effect_type") in {"validation_error", "external_navigation", "dispatch_failed"}:
        return "failed"
    if verification.get("verified") is True and verification.get("effect_type") not in {"no_effect", "focus"}:
        return "passed"
    return "unverified"


def observed_result(case: dict) -> str:
    result = case.get("result") or case
    if not isinstance(result, dict):
        return "No outcome evidence recorded."
    return str(result.get("error") or (result.get("verification") or {}).get("description")
               or "Action dispatched; its intended outcome has not been verified.")


def build_test_report(cases: list[dict], url: str, title: str, console_errors: int = 0,
                      stop_reason: str = "", coverage: dict | None = None) -> str:
    counts = {"passed": 0, "failed": 0, "unverified": 0}
    for case in cases:
        counts[action_status(case.get("result") or case)] += 1
    assertions = [a for case in cases if isinstance(case.get("result") or case, dict)
                  for a in (case.get("result") or case).get("assertions", [])]
    overall = "FAILED" if counts["failed"] or console_errors else (
        "INCOMPLETE" if stop_reason or counts["unverified"] or not cases else "OBSERVED EFFECTS VERIFIED")
    if assertions and overall == "OBSERVED EFFECTS VERIFIED":
        overall = "EXPLICIT ASSERTIONS PASSED — LIMITED COVERAGE"
    if coverage and overall != 'FAILED' and (coverage.get('stop_reason') or coverage.get('controls_requiring_review')
                                            or coverage.get('assets') or any(r.get('status')!='visited' for r in coverage.get('routes',[]))):
        overall = 'INCOMPLETE — RECORDED CHECKS ONLY'
    lines = ["### Live Browser Test Report", f"- **Target URL:** `{url}`",
             f"- **Page Title:** {title}", f"- **Overall Status:** {overall}",
             f"- **Actions:** {counts['passed']} with observed effects, {counts['failed']} failed, "
             f"{counts['unverified']} unverified", f"- **Console errors observed:** {console_errors}"]
    if stop_reason:
        lines.append(f"- **Stopped:** {stop_reason}")
    if assertions:
        lines.append(f"- **Explicit expectations:** {sum(a.get('status') == 'passed' for a in assertions)} passed, "
                     f"{sum(a.get('status') == 'failed' for a in assertions)} failed, "
                     f"{sum(a.get('status') == 'unverified' for a in assertions)} unverified")
    if coverage:
        lines.extend(['',f"**Page coverage:** {coverage.get('visited_pages',0)}/{coverage.get('discovered_pages',0)} discovered same-origin pages visited.",
                      '**Scope:** '+str(coverage.get('scope','Recorded interactions only.')),
                      '', '| Discovered page | Status |', '| --- | --- |'])
        for route in coverage.get('routes',[]):
            lines.append('| '+str(route.get('url','')).replace('|','\\|')+' | '+str(route.get('status','untested'))+' |')
        if coverage.get('stop_reason'):
            lines.append('**Coverage stop:** '+coverage['stop_reason'])
        remaining = coverage.get('controls_requiring_review',[])
        if remaining:
            lines.extend(['','**Untested scenarios requiring review:**'])
            for control in remaining[:60]:
                lines.append('- '+str(control.get('label','Control'))+' on '+str(control.get('url',''))+': '+str(control.get('reason','Expected outcome is unknown.')))
            if len(remaining)>60:
                lines.append(f'- {len(remaining)-60} additional scenarios remain in the structured coverage ledger.')
        if coverage.get('assets'):
            lines.append(f"- {len(coverage['assets'])} discovered downloadable assets remain untested.")
        if coverage.get('external_links'):
            lines.append(f"- {len(coverage['external_links'])} external destinations are outside this same-origin audit.")
    lines.extend(["", "| Action | Target | Status | Observed result |",
                  "| --- | --- | --- | --- |"])
    def cell(value: Any) -> str:
        return str(value).replace("|", "\\|").replace("\n", " ")
    for case in cases:
        lines.append("| " + " | ".join(cell(v) for v in (
            case.get("action", "interaction"), case.get("label") or case.get("target", ""),
            action_status(case.get("result") or case).upper(), observed_result(case))) + " |")
    routes = list(dict.fromkeys(c.get("url") for c in cases if c.get("url")))
    lines.extend(["", f"Recorded actions on {len(routes)} route(s).",
                  "Coverage is limited to the recorded actions. Observed changes are not business assertions; "
                  "untested routes, API behavior, accessibility, and visual correctness remain unverified."])
    return "\n".join(lines)


@dataclass
class BrowserTestBudget:
    max_actions: int = 120
    max_seconds: float = 180.0
    started: float = field(default_factory=time.monotonic)

    @classmethod
    def from_env(cls) -> "BrowserTestBudget":
        return cls(max_actions=max(1, min(10000, int(os.getenv("STACKPILOT_AI_TEST_MAX_ACTIONS", "120")))),
                   max_seconds=max(5, min(3600, float(os.getenv("STACKPILOT_AI_TEST_MAX_SECONDS", "180")))))

    def stop_reason(self, action_count: int) -> str:
        if action_count >= self.max_actions:
            return f"Action budget reached ({self.max_actions}); remaining coverage is unverified."
        if time.monotonic() - self.started >= self.max_seconds:
            return f"Time budget reached ({self.max_seconds:g}s); remaining coverage is unverified."
        return ""
