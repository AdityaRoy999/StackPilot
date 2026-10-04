"""
StackPilot Action-Perception-Verification (APV) Engine
Implements the closed-loop Action-Perception-Verification framework inspired by
SOTA computer-use architectures (Claude Computer Use, OpenAI Operator, Agent-Q).
Features Two-Tier Click Dispatch and Perceptual State Diffing.
"""

from dataclasses import dataclass, field
import hashlib
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("stackpilot.apv_engine")


@dataclass
class PerceptionSnapshot:
    url: str
    title: str = ""
    scroll_x: int = 0
    scroll_y: int = 0
    active_modals_count: int = 0
    alerts: List[str] = field(default_factory=list)
    elements_count: int = 0
    dom_hash: str = ""
    focused_id: Optional[str] = None
    control_state: str = ""
    visual_state: str = ""
    captured: bool = True
    timestamp: float = field(default_factory=time.time)


@dataclass
class ActionVerificationResult:
    action: str
    target: str
    verified: bool
    effect_type: str  # "route_change", "modal_open", "modal_close", "scroll", "form_submit", "dom_mutation", "focus", "no_effect"
    description: str
    delta_url: Optional[str] = None
    delta_scroll_y: int = 0
    new_alerts: List[str] = field(default_factory=list)
    pre_snapshot: Optional[PerceptionSnapshot] = None
    post_snapshot: Optional[PerceptionSnapshot] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "action": self.action,
            "target": self.target,
            "verified": self.verified,
            "effect_type": self.effect_type,
            "description": self.description,
            "delta_url": self.delta_url,
            "delta_scroll_y": self.delta_scroll_y,
            "new_alerts": self.new_alerts,
        }


class ActionPerceptionVerification:
    """
    Manages snapshot capture, two-tier click dispatch, and outcome verification.
    """

    @classmethod
    async def capture_snapshot(cls, session: Any) -> PerceptionSnapshot:
        """Captures a lightweight perceptual snapshot of the active page state."""
        url = (session.current_url or "").rstrip("/")
        title = getattr(session, "page_title", "")
        scroll_y = getattr(session, "scroll_y", 0)

        js_probe = """(() => {
            const isVisible = (e) => {
                if (!e || !e.isConnected) return false;
                if (e.closest && e.closest('[aria-hidden="true"],[inert]')) return false;
                if (typeof e.checkVisibility === 'function') {
                    return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
                }
                const s = window.getComputedStyle(e);
                return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
            };
            const modals = Array.from(document.querySelectorAll('[role="dialog"], dialog[open], .modal.show, [aria-modal="true"]'))
                .filter(m => isVisible(m));
            const infoKeywords = ['advisory', 'guideline', 'guidelines', 'covid', 'concession', 'disclaimer', 'bulletin', 'announcement', 'railway board', 'please note', 'caution', 'explore beta', 'advertisement', 'copyright', 'all rights reserved'];
            const alerts = Array.from(document.querySelectorAll('[role="alert"], .alert, .toast, .success, .error, [class*="toast"], [class*="alert"], .ui-message-error, .invalid-feedback'))
                .filter(a => isVisible(a))
                .map(a => (a.textContent || '').trim())
                .filter(t => {
                    if (!t || t.length < 3) return false;
                    const low = t.toLowerCase();
                    if (infoKeywords.some(kw => low.includes(kw))) return false;
                    return true;
                })
                .slice(0, 5);
            const activeEl = document.activeElement;
            const focusedId = activeEl ? (activeEl.getAttribute('data-sp-id') || activeEl.id || activeEl.name || '') : null;
            const keyText = Array.from(document.querySelectorAll('h1, h2, h3, [role="tab"][aria-selected="true"]'))
                .map(h => (h.textContent || '').trim())
                .filter(Boolean)
                .slice(0, 10)
                .join('|');
            return {
                url: window.location.href,
                title: document.title || '',
                scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
                scrollX: Math.round(window.scrollX || window.pageXOffset || 0),
                modalsCount: modals.length,
                alerts: alerts,
                focusedId: focusedId,
                keyText: keyText + '|' + (document.body?.innerText || '').slice(0, 12000),
                visualState: [document.documentElement.getAttribute('data-theme'),document.documentElement.className,
                    document.body?.getAttribute('data-theme'),document.body?.className,
                    getComputedStyle(document.documentElement).colorScheme,
                    document.body ? getComputedStyle(document.body).backgroundColor : ''],
                controlState: Array.from(document.querySelectorAll('input,textarea,select,[aria-selected],[aria-expanded],[aria-checked]'))
                    .filter(isVisible).slice(0, 200).map(e => [e.getAttribute('data-sp-id') || e.id || e.name,
                        e.type === 'password' ? '[redacted]' : e.value, e.checked,
                        e.getAttribute('aria-selected'), e.getAttribute('aria-expanded'), e.getAttribute('aria-checked')])
            };
        })()"""

        res = {}
        try:
            res = await session.send_command("Runtime.evaluate", {
                "expression": js_probe,
                "returnByValue": True
            }, timeout=2.0)
            val = res.get("result", {}).get("value", {}) if isinstance(res, dict) else {}
        except Exception:
            val = {}

        captured = bool(val.get("url")) and not res.get("exceptionDetails") if isinstance(res, dict) else False
        raw_live_url = val.get("url", "")
        if raw_live_url and "chrome-error://" not in raw_live_url:
            try:
                from .browser_driver import to_frontend_display_url
                disp = to_frontend_display_url(raw_live_url)
            except Exception:
                try:
                    from browser_driver import to_frontend_display_url
                    disp = to_frontend_display_url(raw_live_url)
                except Exception:
                    disp = raw_live_url
            session.current_url = disp
            url = disp.rstrip("/")

        live_title = val.get("title", "")
        if live_title:
            session.page_title = live_title
            title = live_title

        cur_scroll_y = val.get("scrollY", scroll_y)
        cur_scroll_x = val.get("scrollX", 0)
        session.scroll_x = cur_scroll_x
        session.scroll_y = cur_scroll_y
        modals_count = val.get("modalsCount", 0)
        alerts = val.get("alerts", [])
        session.last_alerts = alerts
        focused_id = val.get("focusedId")
        key_text = val.get("keyText", "")
        dom_hash = hashlib.md5(f"{len(session.interactive_elements)}:{key_text}".encode()).hexdigest()[:12]

        return PerceptionSnapshot(
            url=url,
            title=title,
            scroll_x=cur_scroll_x,
            scroll_y=cur_scroll_y,
            active_modals_count=modals_count,
            alerts=alerts,
            elements_count=len(session.interactive_elements or []),
            dom_hash=dom_hash,
            focused_id=focused_id,
            control_state=hashlib.sha256(repr(val.get("controlState", [])).encode()).hexdigest(),
            visual_state=hashlib.sha256(repr(val.get("visualState", [])).encode()).hexdigest(),
            captured=captured,
            timestamp=time.time()
        )

    @classmethod
    async def dispatch_two_tier_click(
        cls,
        session: Any,
        element_id: int,
        label: str = "",
        fast_mode: bool = False
    ) -> bool:
        """
        Hit-test the current target and dispatch native CDP input exactly once.
        The legacy method name is retained for callers; no DOM click replay occurs.
        """
        # Retrieve exact bounding box and element text
        from .browser_testing.actionability import prepare_pointer_target
        coords = await prepare_pointer_target(session, element_id)
        session.last_actionability = coords
        target_label = label or (coords.get("text") if coords else f"Element #{element_id}")
        clean_target = str(target_label).strip()
        while True:
            lower = clean_target.lower()
            if lower.startswith("click:"):
                clean_target = clean_target[6:].strip()
            elif lower.startswith("clicking:"):
                clean_target = clean_target[9:].strip()
            elif lower.startswith("clicking"):
                clean_target = clean_target[8:].strip()
            elif lower.startswith("click "):
                clean_target = clean_target[6:].strip()
            else:
                break
        display_label = f"Click: {clean_target}" if clean_target else "Click"

        # A real input click already emits the complete event sequence. Never replay
        # it with DOM events: options/checkboxes and submit handlers can fire twice.
        if not coords or coords.get("disabled") or not coords.get("is_in_viewport") or coords.get("is_occluded"):
            return False
        if coords.get("x") is None or coords.get("y") is None:
            return False
        await session.click(coords["x"], coords["y"], label=display_label,
                            fast_mode=True, exact_coords=True)
        return True

    @classmethod
    def verify_action_outcome(
        cls,
        pre: PerceptionSnapshot,
        post: PerceptionSnapshot,
        action: str = "click",
        target: str = ""
    ) -> ActionVerificationResult:
        """
        Computes the perceptual delta between pre and post action snapshots
        and verifies if the intended effect was achieved.
        """
        if not pre.captured or not post.captured:
            return ActionVerificationResult(action, target, False, "snapshot_failed",
                                            "Could not capture reliable before/after evidence.")
        new_alerts = [a for a in post.alerts if a not in pre.alerts]
        # Navigation identity takes precedence over incidental form/UI changes
        # caused by mounting the destination document.
        if post.url != pre.url:
            return ActionVerificationResult(action,target,True,'route_change',
                f"Navigated to new route: '{post.url}' (from '{pre.url}')",delta_url=post.url)
        if any(any(k in alert.lower() for k in ["required", "invalid", "error", "failed", "mandatory"])
               for alert in new_alerts):
            return ActionVerificationResult(action, target, False, "validation_error",
                                            "Validation feedback: " + "; ".join(new_alerts), new_alerts=new_alerts)
        if pre.control_state != post.control_state:
            return ActionVerificationResult(action, target, True, "control_change",
                                            "Observed form value or selected/expanded control state change.")
        if pre.visual_state != post.visual_state:
            return ActionVerificationResult(action,target,True,'visual_state_change',
                                            'Observed document theme/style state change; visual correctness is not asserted.')

        # 1. Route Navigation Check
        if post.url != pre.url:
            return ActionVerificationResult(
                action=action,
                target=target,
                verified=True,
                effect_type="route_change",
                description=f"Navigated to new route: '{post.url}' (from '{pre.url}')",
                delta_url=post.url,
                pre_snapshot=pre,
                post_snapshot=post
            )

        # 2. Form submission & Feedback Alerts Check
        new_alerts = [a for a in post.alerts if a not in pre.alerts]
        if new_alerts:
            is_form = any(kw in action.lower() or kw in target.lower() for kw in ["click", "submit", "type", "send", "save", "apply", "book", "inquiry", "contact"])
            return ActionVerificationResult(
                action=action,
                target=target,
                verified=True,
                effect_type="form_submit" if is_form else "alert_emitted",
                description=f"Received feedback alerts: {', '.join(new_alerts[:2])}",
                new_alerts=new_alerts,
                pre_snapshot=pre,
                post_snapshot=post
            )

        # 3. Modal Open / Close Check
        if post.active_modals_count > pre.active_modals_count:
            return ActionVerificationResult(
                action=action,
                target=target,
                verified=True,
                effect_type="modal_open",
                description="Triggered new interactive modal / overlay dialog",
                pre_snapshot=pre,
                post_snapshot=post
            )
        elif post.active_modals_count < pre.active_modals_count:
            return ActionVerificationResult(
                action=action,
                target=target,
                verified=True,
                effect_type="modal_close",
                description="Dismissed active modal overlay",
                pre_snapshot=pre,
                post_snapshot=post
            )

        # 4. Viewport Scroll Movement
        delta_y = post.scroll_y - pre.scroll_y
        if abs(delta_y) > 25:
            direction = "down" if delta_y > 0 else "up"
            return ActionVerificationResult(
                action=action,
                target=target,
                verified=True,
                effect_type="scroll",
                description=f"Smooth scroll displaced viewport by {abs(delta_y)}px {direction} (now at {post.scroll_y}px)",
                delta_scroll_y=delta_y,
                pre_snapshot=pre,
                post_snapshot=post
            )

        # 5. DOM Mutation / Tabpanel Switch Check
        if post.dom_hash != pre.dom_hash or post.elements_count != pre.elements_count:
            delta_count = post.elements_count - pre.elements_count
            count_str = f"({delta_count:+d} interactive controls)" if delta_count != 0 else ""
            return ActionVerificationResult(
                action=action,
                target=target,
                verified=True,
                effect_type="dom_mutation",
                description=f"DOM state updated {count_str}",
                pre_snapshot=pre,
                post_snapshot=post
            )

        # 6. Focus Shift Check
        if post.focused_id and post.focused_id != pre.focused_id:
            return ActionVerificationResult(
                action=action,
                target=target,
                verified=True,
                effect_type="focus",
                description=f"Active focus shifted to control '{post.focused_id}'",
                pre_snapshot=pre,
                post_snapshot=post
            )

        # Fallback: Action executed without detectable side-effect
        return ActionVerificationResult(
            action=action,
            target=target,
            verified=False,  # Dispatch is not evidence of the intended outcome
            effect_type="no_effect",
            description="No observable effect; the intended outcome remains unverified",
            pre_snapshot=pre,
            post_snapshot=post
        )
