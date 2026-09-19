"""
StackPilot Site Knowledge Graph (SKG) & Dynamic Page Archetype Classifier
Provides whole-website comprehension, dynamic route hierarchy tracking,
and page classification into 6 core archetypes based on academic literature
(WebArena, Mind2Web, VisualWebArena) and SOTA web agent architectures.
"""

from dataclasses import dataclass, field
from enum import Enum
import re
import time
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse


class PageArchetype(str, Enum):
    LANDING = "landing"
    CATALOG = "catalog"
    ENTITY_DETAIL = "entity_detail"
    FORM_INPUT = "form_input"
    DASHBOARD = "dashboard"
    AUTH = "auth"
    MODAL_VIEW = "modal_view"
    UNKNOWN = "unknown"


@dataclass
class RouteEdge:
    source_url: str
    target_url: str
    edge_type: str = "link"  # link, card_click, form_submit, tab, breadcrumb, backtrack
    trigger_label: str = ""
    trigger_element_id: Optional[int] = None
    timestamp: float = field(default_factory=time.time)


@dataclass
class RouteNode:
    url: str
    path: str
    title: str = ""
    archetype: PageArchetype = PageArchetype.UNKNOWN
    archetype_confidence: float = 0.0
    discovered_from: Optional[str] = None
    depth: int = 0
    visited: bool = False
    visit_count: int = 0
    last_visited_at: float = 0.0
    controls_count: int = 0
    forms_count: int = 0
    child_routes: Set[str] = field(default_factory=set)
    tags: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "path": self.path,
            "title": self.title,
            "archetype": self.archetype.value,
            "archetype_confidence": round(self.archetype_confidence, 2),
            "discovered_from": self.discovered_from,
            "depth": self.depth,
            "visited": self.visited,
            "visit_count": self.visit_count,
            "controls_count": self.controls_count,
            "forms_count": self.forms_count,
            "child_routes": sorted(list(self.child_routes)),
            "tags": self.tags,
        }


class ArchetypeClassifier:
    """
    Sub-millisecond heuristic & element-density classifier that categorizes
    any webpage into one of 6 Page Archetypes.
    """

    AUTH_KEYWORDS = {"login", "signin", "sign-in", "signup", "sign-up", "register", "password", "forgot-password", "auth", "oauth"}
    FORM_KEYWORDS = {"contact", "inquiry", "feedback", "support", "apply", "checkout", "quote", "book", "schedule", "register"}
    CATALOG_KEYWORDS = {"products", "catalog", "shop", "items", "browse", "services", "listings", "explore", "search", "store"}
    DASHBOARD_KEYWORDS = {"dashboard", "admin", "analytics", "metrics", "overview", "settings", "reports", "manage"}

    @classmethod
    def classify(
        cls,
        url: str,
        title: str,
        elements: List[Dict[str, Any]],
        is_modal: bool = False,
    ) -> Tuple[PageArchetype, float, str]:
        """
        Classifies page state into an archetype with confidence score and explanation.
        """
        if is_modal:
            return PageArchetype.MODAL_VIEW, 0.95, "Active modal dialog or overlay detected"

        path = urlparse(url).path.lower()
        title_lower = (title or "").lower()
        full_text_hints = f"{path} {title_lower}"

        # 1. Auth Page Check
        has_password_input = any(
            (e.get("tag") == "input" and (e.get("type") or "").lower() == "password") or
            "password" in (e.get("name") or "").lower()
            for e in elements
        )
        auth_kw_matches = sum(1 for kw in cls.AUTH_KEYWORDS if kw in full_text_hints)
        if has_password_input or auth_kw_matches >= 2:
            return PageArchetype.AUTH, 0.92, "Detected password credential input or authentication route tokens"

        # Count control surface distributions
        input_elements = [
            e for e in elements
            if e.get("tag") in {"input", "textarea", "select"} and (e.get("type") or "").lower() not in {"hidden", "submit", "button"}
        ]
        submit_buttons = [
            e for e in elements
            if e.get("type") == "submit" or any(kw in (e.get("text") or "").lower() for kw in ["submit", "send", "save", "apply", "book", "contact"])
        ]
        card_elements = [
            e for e in elements
            if e.get("card_context") or any(kw in (e.get("tag") or "") for kw in ["article"])
        ]
        tab_elements = [e for e in elements if e.get("role") == "tab"]
        table_elements = [e for e in elements if e.get("tag") == "table" or "table" in (e.get("role") or "")]

        # 2. Dashboard Archetype
        dash_kw_matches = sum(1 for kw in cls.DASHBOARD_KEYWORDS if kw in full_text_hints)
        if (dash_kw_matches >= 1 and (len(table_elements) > 0 or len(tab_elements) >= 3 or "admin" in path)) or dash_kw_matches >= 2:
            return PageArchetype.DASHBOARD, 0.88, f"Dashboard route indicators (metrics/tables/tabs) on path '{path}'"

        # 3. Form Input Archetype
        form_kw_matches = sum(1 for kw in cls.FORM_KEYWORDS if kw in full_text_hints)
        if len(input_elements) >= 3 and len(submit_buttons) >= 1:
            return PageArchetype.FORM_INPUT, 0.90, f"Multi-input form surface detected ({len(input_elements)} fields, submit button present)"
        if form_kw_matches >= 1 and len(input_elements) >= 2:
            return PageArchetype.FORM_INPUT, 0.85, f"Form route keywords matching '{form_kw_matches}' with {len(input_elements)} active inputs"

        # 4. Catalog Archetype
        catalog_kw_matches = sum(1 for kw in cls.CATALOG_KEYWORDS if kw in full_text_hints)
        if len(card_elements) >= 3 or catalog_kw_matches >= 2:
            return PageArchetype.CATALOG, 0.86, f"Repeated card grid/list detected ({len(card_elements)} structured item triggers)"

        # 5. Entity Detail Archetype
        # If the path has multiple segments like /services/telehealth or /products/123 or has specific card context
        path_segments = [s for s in path.split("/") if s]
        if len(path_segments) >= 2 and any(p in path_segments[0] for p in ["product", "item", "service", "doctor", "profile", "post", "blog", "detail"]):
            return PageArchetype.ENTITY_DETAIL, 0.82, f"Hierarchical detail path structure '{path}'"

        # 6. Landing Archetype
        if path in {"", "/", "/index.html", "/home"} or any(kw in full_text_hints for kw in ["welcome", "home", "landing", "hero"]):
            return PageArchetype.LANDING, 0.89, "Root or homepage route with overview/hero structures"

        if len(card_elements) >= 1:
            return PageArchetype.CATALOG, 0.65, "Contains structured entity cards"

        return PageArchetype.UNKNOWN, 0.50, "General content or utility page"


class SiteKnowledgeGraph:
    """
    Dynamic semantic knowledge graph representing a website's architectural topology,
    routes, archetypes, and inter-page transitions.
    """

    def __init__(self, origin_url: str = ""):
        self.origin_url = origin_url
        self.nodes: Dict[str, RouteNode] = {}
        self.edges: List[RouteEdge] = []
        self._route_aliases: Dict[str, str] = {}  # Resolves trailing slash, casing, or query variations

    @staticmethod
    def canonicalize_url(raw_url: str) -> str:
        """Normalizes URLs for robust deduplication across redirects and hashes."""
        if not raw_url:
            return ""
        parsed = urlparse(raw_url)
        norm_path = parsed.path.rstrip("/") or "/"
        # Preserve fragment if it's an SPA hash route (e.g. #/dashboard)
        frag = f"#{parsed.fragment}" if parsed.fragment and (parsed.fragment.startswith("/") or parsed.fragment.startswith("!/")) else ""
        return f"{parsed.scheme}://{parsed.netloc}{norm_path}{frag}".lower()

    def is_same_domain(self, url: str) -> bool:
        """Verifies candidate route URL belongs to the target site domain."""
        if not self.origin_url or not url:
            return True
        try:
            orig_host = urlparse(self.origin_url).hostname
            url_host = urlparse(url).hostname
            if not orig_host or not url_host:
                return True
            orig_h = orig_host.lower().lstrip("www.")
            url_h = url_host.lower().lstrip("www.")
            if url_h == orig_h or url_h.endswith("." + orig_h):
                return True
            if orig_h in {"localhost", "127.0.0.1", "host.docker.internal"} and url_h in {"localhost", "127.0.0.1", "host.docker.internal"}:
                return True
            return False
        except Exception:
            return False

    def get_or_create_node(
        self,
        url: str,
        title: str = "",
        discovered_from: Optional[str] = None,
        depth: int = 0
    ) -> RouteNode:
        canonical = self.canonicalize_url(url)
        if not self.is_same_domain(canonical):
            # Do not register external URLs in site knowledge graph
            return self.nodes.get(self.canonicalize_url(self.origin_url)) or RouteNode(url=canonical, path="/", title=title)

        if canonical not in self.nodes:
            path = urlparse(canonical).path or "/"
            self.nodes[canonical] = RouteNode(
                url=canonical,
                path=path,
                title=title,
                discovered_from=discovered_from,
                depth=depth
            )
            if discovered_from:
                p_canon = self.canonicalize_url(discovered_from)
                if p_canon in self.nodes:
                    self.nodes[p_canon].child_routes.add(canonical)
        return self.nodes[canonical]

    def update_page_state(
        self,
        url: str,
        title: str,
        elements: List[Dict[str, Any]],
        is_modal: bool = False
    ) -> RouteNode:
        """Updates or registers a route node with latest title, element counts, and archetype classification."""
        node = self.get_or_create_node(url, title=title)
        node.title = title or node.title
        node.controls_count = len(elements)
        node.forms_count = len(set(e.get("form_id") for e in elements if e.get("form_id")))
        node.visited = True
        node.visit_count += 1
        node.last_visited_at = time.time()

        archetype, confidence, reasoning = ArchetypeClassifier.classify(url, title, elements, is_modal=is_modal)
        node.archetype = archetype
        node.archetype_confidence = confidence
        node.metadata["classification_reasoning"] = reasoning

        # Extract tags
        tags = set(node.tags)
        if node.forms_count > 0:
            tags.add("has_forms")
        if any(e.get("card_context") for e in elements):
            tags.add("has_cards")
        if any(e.get("role") == "tab" for e in elements):
            tags.add("has_tabs")
        node.tags = sorted(list(tags))

        return node

    def record_transition(
        self,
        source_url: str,
        target_url: str,
        edge_type: str = "link",
        trigger_label: str = "",
        trigger_element_id: Optional[int] = None
    ) -> RouteEdge:
        """Records an edge representing navigation between pages or into a modal."""
        src_canon = self.canonicalize_url(source_url)
        tgt_canon = self.canonicalize_url(target_url)

        # Update child link relationship
        if src_canon in self.nodes:
            self.nodes[src_canon].child_routes.add(tgt_canon)

        edge = RouteEdge(
            source_url=src_canon,
            target_url=tgt_canon,
            edge_type=edge_type,
            trigger_label=trigger_label,
            trigger_element_id=trigger_element_id,
            timestamp=time.time()
        )
        self.edges.append(edge)
        return edge

    def get_unvisited_frontier(self) -> List[RouteNode]:
        """Returns discovered routes that have not yet been crawled, ordered by shallowest depth first."""
        unvisited = [node for node in self.nodes.values() if not node.visited]
        return sorted(unvisited, key=lambda n: n.depth)

    def get_summary(self) -> Dict[str, Any]:
        """Provides a statistical overview of the site knowledge graph."""
        archetypes_count = {}
        for n in self.nodes.values():
            val = n.archetype.value
            archetypes_count[val] = archetypes_count.get(val, 0) + 1

        return {
            "total_routes_discovered": len(self.nodes),
            "visited_routes_count": sum(1 for n in self.nodes.values() if n.visited),
            "unvisited_frontier_count": sum(1 for n in self.nodes.values() if not n.visited),
            "total_transitions_recorded": len(self.edges),
            "archetypes_breakdown": archetypes_count,
            "routes": [n.to_dict() for n in self.nodes.values()]
        }

    def format_for_llm(self) -> str:
        """Generates an intuitive markdown diagram and summary for model reasoning."""
        if not self.nodes:
            return "Site Knowledge Graph: No routes discovered yet."

        lines = ["### 🗺️ Dynamic Site Knowledge Graph (SKG)"]
        visited = [n for n in self.nodes.values() if n.visited]
        unvisited = [n for n in self.nodes.values() if not n.visited]

        lines.append(f"- **Explored Routes ({len(visited)})**:")
        for n in visited:
            arch_badge = f"[{n.archetype.value.upper()}]"
            lines.append(f"  * `{n.path}` {arch_badge} - '{n.title}' ({n.controls_count} controls, {n.forms_count} forms)")

        if unvisited:
            lines.append(f"- **Unvisited Frontier ({len(unvisited)})**:")
            for n in unvisited[:8]:
                lines.append(f"  * `{n.path}` (queued from `{n.discovered_from or 'root'}`)")
            if len(unvisited) > 8:
                lines.append(f"  * ... and {len(unvisited) - 8} more routes in frontier")

        return "\n".join(lines)
