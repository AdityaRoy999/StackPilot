"""Read-only, bounded assertions against the live page, independent of DOM deltas."""
from __future__ import annotations

import asyncio
import json
import math
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator


def normalize_expectation(spec):
    """Discard only redundant fields that cannot change the asserted outcome."""
    if not isinstance(spec, dict):
        return spec
    normalized = dict(spec)
    # Some tool-calling models put the call-level purpose on each expectation.
    # The executor receives purpose separately; this redundant field must not
    # turn an otherwise valid read-only check into a failed website test.
    normalized.pop("purpose", None)
    if normalized.get("kind") in {"url", "title"}:
        normalized.pop("element_id", None)
        normalized.pop("selector", None)
    if normalized.get("kind") in {"visible", "in_viewport"} and normalized.get("expected") is True:
        normalized.pop("expected", None)
    return normalized


class BrowserExpectation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["text", "accessible_name", "value", "editor_value", "visible", "in_viewport", "absent", "checked", "validity", "expanded", "selected", "pressed", "focused", "url", "title"]
    selector: StrictStr | None = Field(default=None, max_length=500)
    element_id: StrictInt | None = Field(default=None, ge=0)
    expected: StrictStr | StrictBool | None = None
    match: Literal["exact", "contains"] = "exact"

    @model_validator(mode="after")
    def validate_contract(self):
        if self.selector is not None and not self.selector.strip():
            raise ValueError("selector cannot be empty")
        if self.selector is not None and self.element_id is not None:
            raise ValueError("Use selector or element_id, not both")
        if self.kind in {"url", "title"} and (self.selector or self.element_id is not None):
            raise ValueError("Page assertions do not take an element target")
        if self.kind in {"accessible_name", "value", "editor_value", "visible", "in_viewport", "absent", "checked", "validity", "expanded", "selected", "pressed", "focused"} and not (self.selector or self.element_id is not None):
            raise ValueError("This assertion requires an explicit element target")
        if self.kind in {"text", "accessible_name", "value", "editor_value", "url", "title"}:
            if not isinstance(self.expected, str) or (self.kind not in {'value','editor_value'} and not self.expected.strip()) or len(self.expected) > (32000 if self.kind=='editor_value' else 2000) or (self.match == 'contains' and not self.expected):
                raise ValueError("Text assertions require a nonempty expected string of at most 2000 characters")
        elif self.kind in {"checked", "validity", "expanded", "selected", "pressed", "focused"} and not isinstance(self.expected, bool):
            raise ValueError(self.kind+" requires an expected boolean")
        elif self.kind in {"visible", "in_viewport", "absent"} and self.expected is not None:
            raise ValueError("Visibility assertions do not take an expected value")
        if self.kind not in {"text", "accessible_name", "value", "url", "title"} and self.match != "exact":
            raise ValueError("contains is only supported for text assertions")
        return self


PROBE = r"""(() => {
 const specs = __SPECS__;
 const visible = e => {
   if (!e || !e.isConnected || e.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
   if (typeof e.checkVisibility === 'function' && !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
   const s = getComputedStyle(e);
   return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && e.getClientRects().length > 0;
 };
 return specs.map(spec => {
   try {
     const selector = spec.selector;
     const referenced = spec.element_id != null && window.__spFast?.nodes.get(spec.element_id);
     const nodes = spec.element_id != null ? (referenced?.isConnected ? [referenced] : []) : selector ? [...document.querySelectorAll(selector)] : [];
     const e = nodes[0];
     if (spec.kind === 'absent') return {matched: !nodes.some(visible), actual: nodes.filter(visible).length};
     if ((selector || spec.element_id != null) && nodes.length !== 1) return {matched:false, actual: null, reason:'Expected one current target; found ' + nodes.length};
     if (e && e.type === 'password') return {matched:false, actual:'[redacted]', unavailable:true, reason:'Password assertions are not exposed'};
      if (spec.kind === 'visible') return {matched:visible(e), actual:visible(e)};
      if (['expanded','selected','pressed','focused'].includes(spec.kind)) {
        const attribute = 'aria-' + spec.kind;
        const actual = spec.kind === 'focused' ? e.getRootNode().activeElement === e :
          spec.kind === 'selected' && e.tagName === 'OPTION' ? e.selected : e.getAttribute(attribute) === 'true';
        if (spec.kind !== 'focused' && !(spec.kind === 'selected' && e.tagName === 'OPTION') && !e.hasAttribute(attribute))
          return {matched:false,actual:null,unavailable:true,reason:'Target does not expose '+attribute};
        return {matched:actual===spec.expected,actual};
      }
     if (spec.kind === 'in_viewport') {
       const r=e.getBoundingClientRect();
       const inView=visible(e) && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth;
       return {matched:inView,actual:{in_viewport:inView,top:Math.round(r.top),bottom:Math.round(r.bottom)}};
     }
     if (spec.kind === 'validity') {
       // Read validity without dispatching invalid/submit events or sending data.
       const controls=e.tagName==='FORM' ? [...e.elements].filter(n=>n.willValidate) : [e];
       if (!controls.length || controls.some(n=>!n.validity)) return {matched:false,actual:null,unavailable:true,reason:'Target has no native validation state'};
       const actual=controls.every(n=>n.validity.valid);
       return {matched:visible(e) && actual===spec.expected,actual};
     }
     if (spec.kind === 'checked') {
       const supported = ['checkbox','radio'].includes(e.type) || e.hasAttribute('aria-checked');
       if (!supported) return {matched:false, actual:null, reason:'Target has no checked state'};
       const actual = ['checkbox','radio'].includes(e.type) ? e.checked : ({true:true,false:false}[e.getAttribute('aria-checked')] ?? null);
       return {matched:visible(e) && actual === spec.expected, actual};
     }
     let actual;
     if (spec.kind === 'url') actual = location.href;
     else if (spec.kind === 'title') actual = document.title;
     else if (spec.kind === 'accessible_name') {
       const labelledBy=e.getAttribute('aria-labelledby');
       const labels=labelledBy ? labelledBy.split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim() : '';
       actual = e.getAttribute('aria-label') || labels || e.getAttribute('title') || e.innerText || e.textContent || '';
     } else if (spec.kind === 'value') {
       if (['checkbox','radio'].includes(e.type)) return {matched:false,actual:null,unavailable:true,reason:'Use kind checked with an expected boolean to verify a checkbox or radio; its value does not prove selection'};
       if (!('value' in e)) return {matched:false,actual:null,reason:'Target has no value'};
       actual = String(e.value);
     } else actual = (selector || spec.element_id != null) ? (visible(e) ? e.innerText || e.textContent || '' : '') : document.body?.innerText || '';
     const normalize = s => String(s).replace(/\s+/g, ' ').trim();
     const value = normalize(actual), expected = normalize(spec.expected);
     const matched = spec.match === 'contains' ? value.includes(expected) : value === expected;
     return {matched: matched && (!e || visible(e)), actual:String(actual).slice(0,2000)};
   } catch(err) { return {matched:false,actual:null,unavailable:true,reason:'Invalid target or page observation'}; }
 });
})()"""


async def assert_browser_state(session, expectations: list, timeout_seconds: float = 5,
                               purpose: str = "checkpoint") -> dict:
    from .outcomes import outcome_guard_for
    guard = outcome_guard_for(session)
    if not isinstance(expectations, list) or not 1 <= len(expectations) <= 20:
        return {"status": "failed", "action": "assert", "error": "Provide 1–20 explicit expectations."}
    expectations = [normalize_expectation(expectation) for expectation in expectations]
    from .widgets import outcome_contract_error
    outcome_error = outcome_contract_error(session, expectations, purpose)
    if outcome_error:
        return {"status":"failed", "action":"assert", "purpose":purpose, "error":outcome_error,
                "verification":{"verified":False,"effect_type":"incomplete_outcome"}}
    try:
        if purpose not in {"checkpoint", "outcome"}:
            raise ValueError("Assertion purpose must be checkpoint or outcome")
        specs = [BrowserExpectation.model_validate(e).model_dump(exclude_none=True) for e in expectations]
        if not isinstance(timeout_seconds, (int, float)) or isinstance(timeout_seconds, bool) or not math.isfinite(timeout_seconds) or not 0 <= timeout_seconds <= 30:
            raise ValueError("Assertion timeout must be between 0 and 30 seconds")
    except (ValueError, TypeError) as exc:
        # Validation errors can contain supplied secrets; do not echo their input.
        return {"status": "failed", "action": "assert", "error": "Invalid assertion contract: " + (str(exc) if isinstance(exc, ValueError) and type(exc) is ValueError else "check target, kind, expected value and timeout")}
    started = time.monotonic()
    key = json.dumps(specs, sort_keys=True)
    observation_state = (key, getattr(session, 'dispatched_inputs', None), getattr(session, 'current_url', None))
    previous = getattr(session, '_last_assertion_record', None)
    repeated_mismatch = bool(previous and previous.get('state') == observation_state and previous.get('status') == 'failed'
                             and timeout_seconds <= 5)
    # Reprobe once so an asynchronous page update can pass, but do not spend
    # another five seconds polling the exact same mismatch with no new input.
    deadline = started + (0 if repeated_mismatch else timeout_seconds)
    probe = PROBE.replace("__SPECS__", json.dumps(specs, ensure_ascii=True))
    observations = None
    captured = False
    attempts = 0
    while True:
        attempts += 1
        try:
            candidate = await session.evaluate(probe, timeout=max(0.25 if attempts == 1 else 0.1, min(2, deadline - time.monotonic())))
            if any(spec['kind']=='editor_value' for spec in specs):
                from .editors import editor_assertion_probe
                indexes=[i for i,spec in enumerate(specs) if spec['kind']=='editor_value']
                documents=await session.evaluate(editor_assertion_probe([specs[i] for i in indexes]))
                if not isinstance(candidate,list) or not isinstance(documents,list) or len(documents)!=len(indexes):
                    candidate=None
                else:
                    for i,document in zip(indexes,documents): candidate[i]=document
        except Exception:
            candidate = None
        # A transport timeout near the deadline must not erase an earlier
        # observed mismatch and turn a known failed expectation into unknown.
        valid = isinstance(candidate, list) and len(candidate) == len(specs) and all(isinstance(o, dict) for o in candidate)
        if valid:
            observations, captured = candidate, True
        if captured and all(o.get("matched") is True for o in observations):
            break
        if valid and any(o.get('unavailable') is True for o in candidate):
            # Invalid selectors and unsupported assertion kinds cannot become
            # valid by waiting; return the contract feedback to the planner.
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        await asyncio.sleep(min(0.1, remaining))
    results = []
    for index, spec in enumerate(specs):
        obs = observations[index] if captured else {"actual": None, "unavailable": True, "reason": "Page observation unavailable"}
        state = "unverified" if obs.get("unavailable") else ("passed" if obs.get("matched") is True else "failed")
        public_spec = {**spec, "expected": "[redacted]"} if obs.get("actual") == "[redacted]" else spec
        results.append({"expectation": public_spec, "status": state, "actual": obs.get("actual"), "reason": obs.get("reason", "")})
    passed = all(r["status"] == "passed" for r in results)
    state = "passed" if passed else ("failed" if any(r["status"] == "failed" for r in results) else "unverified")
    session._last_assertion_record = {'state': observation_state, 'status': state}
    result = {"status": state, "action": "assert", "purpose": purpose, "assertions": results, "attempts": attempts,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "url": getattr(session, "current_url", ""),
            "hint": "Unchanged failed expectation was reprobed once; inspect actual values or change the test strategy." if repeated_mismatch and state != 'passed' else "",
            "verification": {"verified": passed, "effect_type": "assertion",
                             "description": f"{sum(r['status'] == 'passed' for r in results)}/{len(results)} explicit expectations passed"}}
    return guard.assertion_result(result, specs) if guard else result
