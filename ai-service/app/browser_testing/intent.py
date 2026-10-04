"""Capture one timezone-aware temporal context for a browser task."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def is_task_followup(message: str) -> bool:
    return message.strip().lower() in {'continue','continue testing','resume testing','continue the test'} or message.startswith(("[System] User answered", "Selection for ", "Confirmed: Approve execution of browser_")) or any(
        line.strip().lower().startswith(("from_selection:", "to_selection:"))
        for line in message.splitlines())


def browser_task_context(message: str, runtime: dict, history: list,
                         previous: dict | None = None, now: datetime | None = None) -> dict:
    zone_name = str(runtime.get("timezone") or os.getenv("STACKPILOT_AI_TIMEZONE", "UTC"))
    warning = ""
    try:
        zone = ZoneInfo(zone_name)
    except (ZoneInfoNotFoundError, ValueError):
        zone_name, zone = "UTC", timezone.utc
        warning = "Invalid or unavailable timezone; using UTC. Clarify date-sensitive requests."
    reference = (now or datetime.now(timezone.utc)).astimezone(zone)
    goal = message
    answers = []
    if is_task_followup(message):
        if previous and previous.get("goal") and previous.get("reference_time"):
            goal = previous["goal"]
            # Keep 'tomorrow' anchored to the original request across midnight.
            reference = datetime.fromisoformat(previous["reference_time"])
            zone_name = previous.get("timezone", zone_name)
            warning = previous.get("warning", warning)
            answers = list(previous.get("answers", []))[-19:]
        else:
            goal = next((turn["content"] for turn in reversed(history)
                         if turn.get("role") == "user" and isinstance(turn.get("content"), str)
                         and not is_task_followup(turn["content"])), message)
        if goal != message:
            answers.append(message)
    return {"goal": goal, "answers": answers, "effective_goal": "\n".join([goal, *answers]),
            "timezone": zone_name, "reference_time": reference.isoformat(),
            "today": reference.strftime("%d/%m/%Y"),
            "tomorrow": (reference + timedelta(days=1)).strftime("%d/%m/%Y"),
            "warning": warning}


def task_contract_prompt(context: dict) -> str:
    return (
        "\nBROWSER TASK CONTRACT:\n"
        f"Original goal: {context['goal']}\n"
        f"User timezone: {context['timezone']}; reference time: {context['reference_time']}.\n"
        f"Today: {context['today']}; tomorrow: {context['tomorrow']}. "
        "Keep relative dates anchored to this reference across follow-up answers.\n"
        "Resolve ambiguous locations and missing required inputs before submitting; do not invent them. "
        "Read back committed autocomplete selections and dates. Define expected outcomes before acting. "
        "Use browser_assert with purpose='checkpoint' for intermediate values and purpose='outcome' "
        "for the requested terminal results, including route/date/query identity and persistence "
        "where observable. A click, page mutation, listing card or URL alone is not task completion. "
        "Expected validation rejection can PASS a negative test when its exact expected outcome is asserted. "
        "Use browser_observe for fresh visual layout and semantic controls when current observations are insufficient. "
        "If the user asks for a website audit, state a finite coverage plan and list untested areas.\n"
        + (context['warning'] + "\n" if context['warning'] else ""))
