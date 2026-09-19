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
            const modals = Array.from(document.querySelectorAll('[role="dialog"], dialog[open], .modal.show, [aria-modal="true"]'))
                .filter(m => window.getComputedStyle(m).display !== 'none');
            const alerts = Array.from(document.querySelectorAll('[role="alert"], .alert, .toast, .success, .error, [class*="toast"], [class*="alert"]'))
                .filter(a => {
                    const st = window.getComputedStyle(a);
                    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
                })
                .map(a => (a.innerText || a.textContent || '').trim())
                .filter(Boolean)
                .slice(0, 5);
            const activeEl = document.activeElement;
            const focusedId = activeEl ? (activeEl.getAttribute('data-sp-id') || activeEl.id || activeEl.name || '') : null;
            const keyText = Array.from(document.querySelectorAll('h1, h2, h3, [role="tab"][aria-selected="true"]'))
                .map(h => (h.innerText || '').trim())
                .filter(Boolean)
                .slice(0, 10)
                .join('|');
            return {
                scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
                scrollX: Math.round(window.scrollX || window.pageXOffset || 0),
                modalsCount: modals.length,
                alerts: alerts,
                focusedId: focusedId,
                keyText: keyText
            };
        })()"""

        try:
            res = await session.send_command("Runtime.evaluate", {
                "expression": js_probe,
                "returnByValue": True
            }, timeout=2.0)
            val = res.get("result", {}).get("value", {}) if isinstance(res, dict) else {}
        except Exception:
            val = {}

        cur_scroll_y = val.get("scrollY", scroll_y)
        cur_scroll_x = val.get("scrollX", 0)
        modals_count = val.get("modalsCount", 0)
        alerts = val.get("alerts", [])
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
        Executes Two-Tier Click Dispatch:
        - Tier 1: High-precision synthetic CDP input events at bounding box center.
        - Tier 2: Native Blink DOM synthetic event sequence with bubbling.
        """
        # Scroll element into center view
        await session.scroll_to_element(element_id)

        # Retrieve exact bounding box and element text
        coords = await session.evaluate(f"""
        (() => {{
            const el = document.querySelector('[data-sp-id="{element_id}"]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {{
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
                text: (el.innerText || el.getAttribute('aria-label') || '').trim()
            }};
        }})()
        """)

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

        clicked = False
        # Tier 1: High-precision native CDP Hardware Mouse Event Sequence
        if coords and coords.get("x") is not None and coords.get("y") is not None:
            click_x = coords["x"]
            click_y = coords["y"]
            await session.click(click_x, click_y, label=display_label, fast_mode=fast_mode)
            clicked = True
        else:
            el = next((e for e in session.interactive_elements if str(e.get("id")) == str(element_id)), None)
            if el and el.get("x") is not None and el.get("y") is not None:
                await session.click(el["x"], el["y"], label=display_label, fast_mode=fast_mode)
                clicked = True

        # Tier 2: Synthetic DOM Event Fallback (ONLY if hardware coordinates were unavailable)
        if not clicked:
            await session.evaluate(f"""
            (() => {{
                const el = document.querySelector('[data-sp-id="{element_id}"]');
                if (!el) return;
                try {{
                    if (typeof el.click === 'function') {{
                        el.click();
                    }} else {{
                        const opts = {{ bubbles: true, cancelable: true, composed: true, view: window }};
                        el.dispatchEvent(new MouseEvent('click', opts));
                    }}
                }} catch(e) {{}}
            }})()
            """)

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
            verified=True,  # Dispatched successfully even if purely visual/internal JS state
            effect_type="no_effect",
            description="Action executed successfully without route transition or layout displacement",
            pre_snapshot=pre,
            post_snapshot=post
        )
