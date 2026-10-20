"""Enforce a user's explicit, narrowly named one-click task constraint.

This is execution cardinality, not approval or website-success evidence. A
single dispatched click consumes the allowance even when its acknowledgement
or asynchronous result is unavailable. Ordinary repeatable controls are left
alone unless the user explicitly named their current observed label.
"""
from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urlsplit, urlunsplit


def _normalized(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def _names(control):
    return {_normalized(control.get(key)) for key in ("label", "aria_label", "text")
            if _normalized(control.get(key))}


def _explicit_once(goal, label):
    # Match the whole observed name; no substring targets, guessed synonyms,
    # or generic "click something once" inference. Quotes and "the ... button"
    # are presentation only and do not change the observed target.
    name = r"\s+".join(re.escape(part) for part in label.split())
    pattern = re.compile(
        r"\bclick\s+(?:the\s+)?(?:button\s+)?[\"'`“‘]?" + name +
        r"[\"'`”’]?(?:\s+button)?\s+(?:exactly|only)\s+once\b", re.I)
    matches = list(pattern.finditer(goal))
    # Multiple instructions with the same name may refer to separate scenes.
    if len(matches) != 1:
        return False
    prefix = goal[:matches[0].start()]
    return not re.search(r"\b(?:do\s+not|don['’]t|never|double|right)\s*$", prefix, re.I)


def _identity(session, control):
    raw_url = str(control.get("url") or getattr(session, "current_url", ""))
    try:
        parts = urlsplit(raw_url)
        url = urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))
    except ValueError:
        url = raw_url
    scope = {"url": url, "tab": getattr(session, "target_id", None),
             "frame": getattr(session, "_selected_frame", None)}
    if control.get("input_id"):
        scope["input_id"] = control["input_id"]
    else:
        scope.update({key: control.get(key) for key in
                      ("id", "tag", "role", "name", "href", "form_id", "card_context")})
    return hashlib.sha256(json.dumps(scope, sort_keys=True).encode()).hexdigest()


def _activation(arguments, control):
    action = arguments.get("action")
    if action in {"click", "double_click"}:
        return True
    return (action == "press_key"
            and str(arguments.get("key") or "").lower() in {"enter", "return", "space", " "}
            and (control.get("tag") in {"button", "a", "summary"}
                 or control.get("role") in {"button", "link", "tab", "menuitem"}
                 or control.get("tag") == "input" and control.get("type") in {"button", "submit", "image"}))


def _activation_target(arguments, control):
    # Enter in a form field can activate its freshly observed default submit
    # button. Bind that equivalent activation to the same explicit limit;
    # Space in a text field remains ordinary typing, not a guessed submission.
    if (control and arguments.get("action") == "press_key"
            and str(arguments.get("key") or "").lower() in {"enter", "return"}
            and control.get("form") and isinstance(control.get("submit_control"), dict)):
        return {**control["submit_control"], "url": control.get("url")}
    return control


def preflight_click_limit(session, arguments, control):
    """Return (blocked result, reservation), without dispatching or recording.

    The caller records a returned reservation only after the CDP activation
    counter advances. Passing preflight or scrolling into view consumes nothing.
    """
    control = _activation_target(arguments, control)
    if not control or not _activation(arguments, control):
        return None, None
    goal = str((getattr(session, "task_context", None) or {}).get("goal") or "")
    task = hashlib.sha256(goal.encode()).hexdigest()
    identity = _identity(session, control)
    recorded = getattr(session, "completed_click_limits", None) or {}
    previous = next((entry for entry in recorded.values() if isinstance(entry, dict)
                     and entry.get("task") == task and entry.get("identity") == identity), None)
    reservation = previous
    if reservation is None:
        # The label must be both user-specified and unique in current evidence.
        # Duplicate cards and partial matches remain for normal target resolution.
        for label in sorted(_names(control), key=len, reverse=True):
            if not _explicit_once(goal, label):
                continue
            matches = [item for item in getattr(session, "interactive_elements", [])
                       if label in _names(item)]
            if len(matches) != 1:
                continue
            observed_id = matches[0].get("id")
            if control.get("id") is not None and observed_id != control["id"]:
                continue
            key = hashlib.sha256((task + "\0" + label).encode()).hexdigest()
            reservation = {"key": key, "task": task, "identity": identity, "label": label}
            break
    if reservation is None:
        return None, None
    if reservation["key"] in recorded:
        return {"status": "blocked", "action": arguments.get("action"),
                "dispatch_state": "not_dispatched",
                "error": "The user requested this control be clicked exactly once, and its activation was already dispatched. A missing acknowledgement or failed check does not permit another click.",
                "verification": {"verified": False, "effect_type": "replay_prevented"},
                "recovery": {"reason": "explicit_click_limit_reached",
                             "requires_reconciliation": True,
                             "hint": "Wait for or inspect the current result with read-only observations; preserve the requested outcome assertion."}}, None
    if arguments.get("action") == "double_click":
        return {"status": "blocked", "action": "double_click", "dispatch_state": "not_dispatched",
                "error": "A double click exceeds the user's explicit one-click limit. No input was dispatched.",
                "recovery": {"reason": "explicit_click_limit", "hint": "Use one click on the current observed control."}}, None
    return None, reservation


def record_click_limit(session, reservation, before_activations):
    """Consume a reservation after native activation enqueue, including unknown ACK.

    Count only activation dispatches, not mouse movement, scrolling, typing, or
    merely beginning an action. This also runs safely from a cancellation finally.
    """
    if not reservation or getattr(session, "dispatched_activations", 0) <= before_activations:
        return False
    recorded = getattr(session, "completed_click_limits", None)
    if recorded is None:
        recorded = session.completed_click_limits = {}
    recorded[reservation["key"]] = dict(reservation)
    return True
