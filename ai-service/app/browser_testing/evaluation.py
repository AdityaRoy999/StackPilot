"""Aggregate browser-run evidence without retaining URLs, prompts, or input values."""
from __future__ import annotations

from collections import Counter
import math


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[max(0, math.ceil(percentile * len(ordered)) - 1)], 1)


def summarize_events(events: list[dict]) -> dict:
    phases: dict[str, list[float]] = {}
    statuses = Counter()
    dispatches = Counter()
    verifications = Counter()
    outcome_passed = False
    final = None
    for event in events:
        if event.get('type') == 'browser_timing':
            phase = str(event.get('phase') or 'unknown')
            if isinstance(event.get('elapsed_ms'), (int, float)):
                phases.setdefault(phase, []).append(float(event['elapsed_ms']))
        elif event.get('type') == 'tool_result' and str(event.get('name', '')).startswith('browser_'):
            result = event.get('result') or {}
            for step in [result, *(result.get('results') or [])]:
                if not isinstance(step, dict):
                    continue
                for phase, elapsed in (step.get('timing') or {}).items():
                    if phase.endswith('_ms') and isinstance(elapsed, (int, float)):
                        phases.setdefault(phase[:-3], []).append(float(elapsed))
            from ..testing_runtime import action_status
            from .result_contract import classify_browser_result
            status = action_status(result)
            statuses[status] += 1
            contract = classify_browser_result(str(event['name']), {**result, 'status': status})
            dispatches[str(result.get('dispatch_state') or contract['dispatch_state'])] += 1
            verification = str(result.get('verification_state') or contract['verification_state'])
            verifications[verification] += 1
            outcome_passed |= verification == 'outcome_passed'
        elif event.get('type') == 'done':
            final = event
    final_verified = bool(final and final.get('status') == 'verified')
    return {
        'verified_task': final_verified and outcome_passed,
        'false_completion_signal': final_verified and not outcome_passed,
        'browser_calls': sum(statuses.values()),
        'action_statuses': dict(statuses),
        'dispatch_states': dict(dispatches),
        'verification_states': dict(verifications),
        'timings': {phase: {'count': len(values), 'total_ms': round(sum(values), 1),
                            'p50_ms': _percentile(values, .5), 'p95_ms': _percentile(values, .95)}
                    for phase, values in phases.items()},
    }
