"""
StackPilot Pushdown Navigation Automaton (PNA) & 4-Tier Backtracking Engine
Provides hierarchical navigation state management, deep subpage exploration,
modal containment, cyclical trap detection, and 4-tier escalation backtracking.
"""

from dataclasses import dataclass, field
import logging
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

logger = logging.getLogger("stackpilot.navigation_pda")


@dataclass
class NavigationFrame:
    url: str
    title: str = ""
    archetype: str = "unknown"
    parent_url: str = ""
    trigger_label: str = ""
    trigger_element_id: Optional[int] = None
    scroll_x: int = 0
    scroll_y: int = 0
    is_modal: bool = False
    modal_selector: str = ""
    depth: int = 0
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "title": self.title,
            "archetype": self.archetype,
            "parent_url": self.parent_url,
            "trigger_label": self.trigger_label,
            "trigger_element_id": self.trigger_element_id,
            "scroll_y": self.scroll_y,
            "is_modal": self.is_modal,
            "depth": self.depth,
        }


class AntiTrapDetector:
    """
    Detects cyclical loops, oscillation (A -> B -> A -> B), and trapped modals
    to prevent the autonomous agent from wasting steps in infinite loops.
    """

    def __init__(self, window_size: int = 10):
        self.window_size = window_size
        self.history: List[str] = []
        self._action_history: List[str] = []

    def record(self, url: str, action_sig: str = "") -> Tuple[bool, str]:
        """
        Records a navigation transition.
        Returns (is_trapped: bool, trap_reason: str).
        """
        if not url:
            return False, ""

        clean = url.rstrip("/").lower()
        self.history.append(clean)
        if action_sig:
            self._action_history.append(action_sig)

        if len(self.history) > self.window_size:
            self.history.pop(0)
        if len(self._action_history) > self.window_size:
            self._action_history.pop(0)

        # 1. Immediate Ping-Pong Oscillation Check: A -> B -> A -> B
        if len(self.history) >= 4:
            if self.history[-1] == self.history[-3] and self.history[-2] == self.history[-4] and self.history[-1] != self.history[-2]:
                return True, f"Ping-pong navigation loop detected between '{self.history[-1]}' and '{self.history[-2]}'"

        # 2. Repeated visits without state progress
        if len(self.history) >= 5:
            counts = self.history.count(clean)
            if counts >= 4:
                return True, f"Stuck on route '{clean}' ({counts} visits in last {len(self.history)} steps)"

        # 3. Action repetition trap
        if len(self._action_history) >= 4:
            last_action = self._action_history[-1]
            if all(a == last_action for a in self._action_history[-4:]):
                return True, f"Repeated action trap detected: '{last_action}' fired 4 times continuously"

        return False, ""

    def reset(self):
        self.history.clear()
        self._action_history.clear()


class PushdownNavigationAutomaton:
    """
    Pushdown Automaton (PDA) that maintains an explicit hierarchical stack of
    navigation contexts, ensuring proper depth-first traversal of cards, modals,
    and subpages with deterministic 4-tier backtracking.
    """

    def __init__(self, root_url: str = ""):
        self.root_url = root_url
        self.stack: List[NavigationFrame] = []
        self.trap_detector = AntiTrapDetector()
        self.backtrack_history: List[Dict[str, Any]] = []

    @property
    def depth(self) -> int:
        return len(self.stack)

    def current_frame(self) -> Optional[NavigationFrame]:
        return self.stack[-1] if self.stack else None

    def push(
        self,
        url: str,
        title: str = "",
        archetype: str = "unknown",
        parent_url: str = "",
        trigger_label: str = "",
        trigger_element_id: Optional[int] = None,
        scroll_x: int = 0,
        scroll_y: int = 0,
        is_modal: bool = False,
        modal_selector: str = "",
    ) -> NavigationFrame:
        """Pushes a new navigation frame onto the exploration stack."""
        depth = len(self.stack) + 1
        frame = NavigationFrame(
            url=url,
            title=title,
            archetype=archetype,
            parent_url=parent_url or (self.stack[-1].url if self.stack else self.root_url),
            trigger_label=trigger_label,
            trigger_element_id=trigger_element_id,
            scroll_x=scroll_x,
            scroll_y=scroll_y,
            is_modal=is_modal,
            modal_selector=modal_selector,
            depth=depth,
        )
        self.stack.append(frame)
        logger.debug(f"PNA: Pushed frame depth={depth} url='{url}' (archetype={archetype})")
        return frame

    def pop(self) -> Optional[NavigationFrame]:
        """Pops the top frame upon returning to parent context."""
        if self.stack:
            popped = self.stack.pop()
            logger.debug(f"PNA: Popped frame depth={popped.depth} url='{popped.url}'")
            return popped
        return None

    def can_backtrack(self) -> bool:
        """Returns True if there is an ancestor navigation frame to return to."""
        return len(self.stack) >= 2 or (len(self.stack) == 1 and bool(self.stack[0].parent_url))

    async def backtrack_to_parent(self, session: Any, fallback_parent_url: str = "") -> Dict[str, Any]:
        """Restore an exact observed parent; never synthesize DOM clicks."""
        from .browser_testing.navigation import restore_parent
        frame = self.current_frame()
        target = fallback_parent_url or (frame.parent_url if frame else "") or self.root_url
        if not target or target == "about:blank":
            target = session.target_url
        result = await restore_parent(session, target)
        self.backtrack_history.append(result)
        if len(self.backtrack_history) > 100:
            self.backtrack_history.pop(0)
        if result.get('success'):
            matches = [i for i, parent in enumerate(self.stack) if parent.url == target and not parent.is_modal]
            if matches:
                self.stack = self.stack[:matches[-1] + 1]
            self.trap_detector.reset()
        return result

    def get_stack_summary(self) -> List[Dict[str, Any]]:
        return [frame.to_dict() for frame in self.stack]
