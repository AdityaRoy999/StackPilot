"""Read-only, bounded assertions against the live page, independent of DOM deltas."""
from __future__ import annotations

import asyncio
import json
import math
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator


class BrowserExpectation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["text", "value", "visible", "in_viewport", "absent", "checked", "validity", "url", "title"]
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
        if self.kind in {"value", "visible", "in_viewport", "absent", "checked", "validity"} and not (self.selector or self.element_id is not None):
            raise ValueError("This assertion requires an explicit element target")
        if self.kind in {"text", "value", "url", "title"}:
            if not isinstance(self.expected, str) or not self.expected.strip() or len(self.expected) > 2000:
                raise ValueError("Text assertions require a nonempty expected string of at most 2000 characters")
        elif self.kind in {"checked", "validity"} and not isinstance(self.expected, bool):
            raise ValueError(self.kind+" requires an expected boolean")
        elif self.kind in {"visible", "in_viewport", "absent"} and self.expected is not None:
            raise ValueError("Visibility assertions do not take an expected value")
        if self.kind not in {"text", "value", "url", "title"} and self.match != "exact":
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
     else if (spec.kind === 'value') {
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
    if not isinstance(expectations, list) or not 1 <= len(expectations) <= 20:
        return {"status": "failed", "action": "assert", "error": "Provide 1–20 explicit expectations."}
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
    deadline = started + timeout_seconds
    probe = PROBE.replace("__SPECS__", json.dumps(specs, ensure_ascii=True))
    observations = None
    captured = False
    attempts = 0
    while True:
        attempts += 1
        try:
            candidate = await session.evaluate(probe, timeout=max(0.25 if attempts == 1 else 0.1, min(2, deadline - time.monotonic())))
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
    return {"status": state, "action": "assert", "purpose": purpose, "assertions": results, "attempts": attempts,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "url": getattr(session, "current_url", ""),
            "verification": {"verified": passed, "effect_type": "assertion",
                             "description": f"{sum(r['status'] == 'passed' for r in results)}/{len(results)} explicit expectations passed"}}
