"""
StackPilot System 1 Fast Decision Engine
Inspired by TypeSafe AI's Jev Model Architecture (Diogo Almeida, Sept 2026).
Executes typed, probabilistic micro-decisions over web program state in 15-200ms,
bypassing the slow autoregressive token generation tax of traditional LLMs.

Universal, domain-agnostic design: operates across ANY website (e-commerce, SaaS,
travel, forms, documentation, workflow portals) using perceptual and structural DOM primitives.
"""

from __future__ import annotations
import os
import re
import time
import logging
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
import httpx

logger = logging.getLogger("stackpilot.system1_engine")

TYPESAFE_API_KEY = os.getenv("TYPESAFE_API_KEY", "")
TYPESAFE_API_URL = os.getenv("TYPESAFE_API_URL", "https://api.typesafe.ai/v1/systemone")


@dataclass
class MicroDecision:
    action_type: str  # "click", "type", "select_option", "submit", "dismiss", "press_enter", "press_escape", "escalate", "noop"
    target_element_id: Optional[int]
    input_text: str = ""
    confidence: float = 1.0
    reason: str = ""
    subtask: str = ""
    is_terminal: bool = False


def extract_goal_intent(prompt: str) -> Dict[str, Any]:
    """
    Universal Goal & Entity Intent Extractor.
    Extracts structured entities, key-value parameters, and goal classifications
    from natural language user prompts for ANY website (e-commerce, SaaS, travel, forms, docs).
    """
    p_lower = prompt.lower().strip()
    intent: Dict[str, Any] = {
        "raw_goal": prompt,
        "goal_type": "general",
        "search_query": None,
        "parameters": {},
        "form_fields": {},
        "origin": None,
        "destination": None,
        "date": None,
        "date_alt": None,
        "date_natural": None,
        "category": "generic",
    }

    # 1. Temporal entity extraction (today, tomorrow, relative dates, MM/DD/YYYY)
    now = datetime.now()
    if any(k in p_lower for k in ["tomm", "tomorrow", "tmrw"]):
        target_date = now + timedelta(days=1)
        intent["date"] = target_date.strftime("%d/%m/%Y")
        intent["date_alt"] = target_date.strftime("%Y-%m-%d")
        intent["date_natural"] = target_date.strftime("%d %b %Y")
        intent["parameters"]["date"] = intent["date"]
    elif "day after tomorrow" in p_lower:
        target_date = now + timedelta(days=2)
        intent["date"] = target_date.strftime("%d/%m/%Y")
        intent["date_alt"] = target_date.strftime("%Y-%m-%d")
        intent["date_natural"] = target_date.strftime("%d %b %Y")
        intent["parameters"]["date"] = intent["date"]
    elif "today" in p_lower:
        intent["date"] = now.strftime("%d/%m/%Y")
        intent["date_alt"] = now.strftime("%Y-%m-%d")
        intent["date_natural"] = now.strftime("%d %b %Y")
        intent["parameters"]["date"] = intent["date"]
    else:
        dm_match = re.search(r"\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b", p_lower)
        if dm_match:
            d, m, y = dm_match.group(1), dm_match.group(2), dm_match.group(3)
            if len(y) == 2:
                y = "20" + y
            intent["date"] = f"{int(d):02d}/{int(m):02d}/{y}"
            intent["date_alt"] = f"{y}-{int(m):02d}-{int(d):02d}"
            intent["parameters"]["date"] = intent["date"]

    # 2. Universal Contact & Form Entity Extraction
    email_match = re.search(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+", prompt)
    if email_match:
        intent["form_fields"]["email"] = email_match.group(0)
        intent["parameters"]["email"] = email_match.group(0)
        intent["goal_type"] = "form_submission"

    phone_match = re.search(r"\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b", prompt)
    if phone_match:
        intent["form_fields"]["phone"] = phone_match.group(0)
        intent["parameters"]["phone"] = phone_match.group(0)
        intent["goal_type"] = "form_submission"

    name_match = re.search(r"\b(?:name(?:\s+is)?|named)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b", prompt)
    if name_match:
        intent["form_fields"]["name"] = name_match.group(1)
        intent["parameters"]["name"] = name_match.group(1)

    message_match = re.search(r"\b(?:message|comment|inquiry)(?:\s+is)?\s+['\"]?([^'\"]+)['\"]?", prompt, re.IGNORECASE)
    if message_match:
        intent["form_fields"]["message"] = message_match.group(1)
        intent["parameters"]["message"] = message_match.group(1)

    # 3. Universal Directional Entity Extraction ("from X to Y")
    def _clean_location(name: str) -> str:
        words = name.strip().split()
        stop_words = {
            "for", "on", "in", "at", "tomorrow", "tomm", "tmrw", "today", "train", "trains",
            "flight", "flights", "bus", "buses", "first", "ac", "second", "third", "ticket",
            "tickets", "any", "av", "available", "please", "me", "is", "there", "show", "find", "get", "check"
        }
        clean = [w for w in words if w.lower() not in stop_words]
        return " ".join(clean).strip().title()

    from_to = re.search(r"\bfrom\s+([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)(?:\s+(?:for\b|on\b|tomm|tomorrow|tmrw|today|\d|in\b)|$)", p_lower)
    if from_to:
        loc_from = _clean_location(from_to.group(1))
        loc_to = _clean_location(from_to.group(2))
        intent["origin"] = loc_from
        intent["destination"] = loc_to
        intent["parameters"]["from"] = loc_from
        intent["parameters"]["to"] = loc_to
        intent["category"] = "travel_search"
        intent["goal_type"] = "search"
    else:
        simple_to = re.search(r"\b([a-zA-Z]{2,})\s+to\s+([a-zA-Z]{2,})(?:\s+(?:for\b|on\b|tomm|tomorrow|tmrw|today|\d)|$)", p_lower)
        if simple_to and not any(skip in simple_to.group(1) for skip in ["how", "want", "like", "need", "go", "navigate"]):
            loc_from = _clean_location(simple_to.group(1))
            loc_to = _clean_location(simple_to.group(2))
            intent["origin"] = loc_from
            intent["destination"] = loc_to
            intent["parameters"]["from"] = loc_from
            intent["parameters"]["to"] = loc_to
            intent["category"] = "travel_search"
            intent["goal_type"] = "search"

    # Support Interactive Question reply messages:
    # Format: Selection for "Select Origin station for your journey:": Origin Station: MUMBAI CENTRAL - MMCT
    reply_match = re.search(r'Selection for ".*?(?:Origin|From|Destination|To|Station)":\s*(?:.*?:)?\s*([^\n;]+)', prompt, re.IGNORECASE)
    if reply_match:
        selected_val = reply_match.group(1).strip()
        p_low = prompt.lower()
        if any(k in p_low for k in ["origin", "from", "source", "departure"]):
            intent["origin"] = selected_val
            intent["parameters"]["from"] = selected_val
            intent["category"] = "travel_search"
            intent["goal_type"] = "search"
        elif any(k in p_low for k in ["destination", "to", "arrival"]):
            intent["destination"] = selected_val
            intent["parameters"]["to"] = selected_val
            intent["category"] = "travel_search"
            intent["goal_type"] = "search"

    # Default Date for Travel Searches if omitted:
    # Travel searches (trains, flights, buses) require a travel date; default to tomorrow
    if intent["category"] == "travel_search" and not intent["date"]:
        target_date = now + timedelta(days=1)
        intent["date"] = target_date.strftime("%d/%m/%Y")
        intent["date_alt"] = target_date.strftime("%Y-%m-%d")
        intent["date_natural"] = target_date.strftime("%d %b %Y")
        intent["parameters"]["date"] = intent["date"]

    # 4. Universal Search Query Extraction
    search_match = re.search(r"\b(?:search|find|query|lookup|look up|show me|filter|browse)(?:\s+for)?\s+[\"']?([^\"'.,]+)[\"']?", p_lower)
    if search_match:
        query_val = search_match.group(1).strip()
        if not (intent["origin"] and intent["origin"].lower() in query_val.lower() and intent["destination"]):
            intent["search_query"] = query_val
            intent["parameters"]["query"] = query_val
            intent["goal_type"] = "search"
            if intent["category"] == "generic":
                intent["category"] = "generic_search"

    return intent


def find_overlay_action(elements: List[Dict[str, Any]]) -> Optional[MicroDecision]:
    """
    Visual and semantic overlay / modal resolution engine.
    Calculates how to dismiss or satisfy overlays, cookie notices, language prompts,
    and promotional popups without assuming only an 'x' mark exists.
    Operates universally across all web frameworks.
    """
    dialog_elements = []
    has_active_overlay = False

    for el in elements:
        classes = (el.get("classes") or "").lower()
        role = (el.get("role") or "").lower()
        is_modal = "modal" in classes or "dialog" in classes or "popup" in classes or role in {"dialog", "alertdialog"} or "overlay" in classes
        if is_modal or any(m in classes for m in ["advisory", "notice", "alert-dismissible", "cookie", "custom-blur-mask", "ui-widget-overlay"]):
            has_active_overlay = True
            dialog_elements.append(el)

    if not has_active_overlay and not any("dialog" in (e.get("classes") or "").lower() for e in elements):
        return None

    candidate_pool = dialog_elements if len(dialog_elements) > 1 else elements

    clickable_candidates = [
        e for e in candidate_pool
        if (e.get("tag") in {"button", "a", "span", "div", "input"} or e.get("role") in {"button", "link"})
        and (e.get("type") or "").lower() not in {"checkbox", "radio", "hidden"}
    ]

    # Tier 1: Explicit close icon or close button
    for e in clickable_candidates:
        t = (e.get("text") or e.get("aria_label") or "").strip().lower()
        c = (e.get("classes") or "").lower()
        if t in {"×", "✕", "x", "close", "dismiss", "cancel", "exit"} or "close-btn" in c or "dialog-titlebar-close" in c:
            return MicroDecision(
                action_type="click",
                target_element_id=e["id"],
                confidence=0.99,
                reason=f"Closing overlay via close button '{t or 'close'}'",
                subtask="dismiss_overlay",
            )

    # Tier 2: Language Selection Dialog (e.g. portals with language prompt on entry)
    for e in clickable_candidates:
        t = (e.get("text") or "").strip().lower()
        if t in {"english", "en", "continue in english"}:
            return MicroDecision(
                action_type="click",
                target_element_id=e["id"],
                confidence=0.98,
                reason="Satisfying language overlay selection by choosing 'English'",
                subtask="dismiss_overlay",
            )

    # Tier 3: Affirmative / Acknowledgement / Consent CTAs
    for e in clickable_candidates:
        t = (e.get("text") or "").strip().lower()
        if t in {"ok", "got it", "i agree", "agree", "accept", "accept all", "allow all", "i understand", "continue", "proceed", "confirm", "acknowledge", "ok, i understand"}:
            return MicroDecision(
                action_type="click",
                target_element_id=e["id"],
                confidence=0.97,
                reason=f"Acknowledging overlay notice via '{t}' button",
                subtask="dismiss_overlay",
            )

    # Tier 4: Deferral / Opt-out CTAs
    for e in clickable_candidates:
        t = (e.get("text") or "").strip().lower()
        if t in {"skip", "later", "not now", "remind me later", "maybe later", "no thanks", "close notice"}:
            return MicroDecision(
                action_type="click",
                target_element_id=e["id"],
                confidence=0.96,
                reason=f"Bypassing overlay via '{t}' button",
                subtask="dismiss_overlay",
            )

    # Tier 5: Backdrop click
    for e in clickable_candidates:
        c = (e.get("classes") or "").lower()
        if any(m in c for m in ["ui-widget-overlay", "modal-backdrop", "dialog-mask", "custom-blur-mask"]):
            return MicroDecision(
                action_type="click",
                target_element_id=e["id"],
                confidence=0.92,
                reason="Dismissing overlay by clicking backdrop mask",
                subtask="dismiss_overlay",
            )

    # Tier 6: Keyboard Escape
    if has_active_overlay:
        return MicroDecision(
            action_type="press_escape",
            target_element_id=None,
            confidence=0.90,
            reason="Dismissing active overlay dialog via Escape key",
            subtask="dismiss_overlay",
        )

    return None


class System1DecisionEngine:
    """
    Non-autoregressive decision layer for high-frequency bounded state transitions.
    Universal, domain-agnostic web testing engine.
    """

    PARAM_SYNONYMS = {
        "from": ["from", "origin", "source", "departure", "departing", "start", "where from", "pickup", "leaving from"],
        "to": ["to", "destination", "arrival", "arriving", "dest", "where to", "dropoff", "going to", "flying to"],
        "date": ["date", "journey date", "departure date", "travel date", "when", "depart", "check-in", "check in", "start date"],
        "query": ["search", "query", "find", "keyword", "q", "filter", "what are you looking for", "search term", "search products"],
        "email": ["email", "e-mail", "mail", "user email", "email address"],
        "phone": ["phone", "mobile", "tel", "cell", "telephone", "phone number"],
        "name": ["name", "full name", "first name", "your name", "contact name"],
        "message": ["message", "comments", "description", "details", "feedback", "inquiry"],
    }

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or TYPESAFE_API_KEY
        self.client = httpx.AsyncClient(timeout=2.0)

    async def decide_next_transition(
        self,
        goal_intent: Dict[str, Any],
        page_state: Dict[str, Any],
        recent_actions: List[Dict[str, Any]],
    ) -> MicroDecision:
        """
        Takes current goal intent, page interactive tree, and recent micro-actions,
        and returns the next atomic state transition in 15-200ms.
        """
        # If TypeSafe API key is available, evaluate via remote Jev System One model
        if self.api_key:
            try:
                jev_res = await self._call_jev_model(goal_intent, page_state, recent_actions)
                if jev_res and jev_res.confidence >= 0.80:
                    return jev_res
            except Exception as e:
                logger.warning(f"Jev System 1 API call failed: {e}. Falling back to local fast-path.")

        # Local Zero-Latency Evaluator (Runs in <15ms)
        return self._local_fast_path_evaluator(goal_intent, page_state, recent_actions)

    async def _call_jev_model(
        self,
        goal_intent: Dict[str, Any],
        page_state: Dict[str, Any],
        recent_actions: List[Dict[str, Any]],
    ) -> Optional[MicroDecision]:
        elements = page_state.get("interactive_elements", [])
        candidate_ids = [str(e.get("id")) for e in elements[:40]]

        payload = {
            "model": "jev-latest",
            "state": {
                "goal": goal_intent,
                "current_url": page_state.get("url"),
                "elements": [
                    {
                        "id": e.get("id"),
                        "tag": e.get("tag"),
                        "text": e.get("text") or e.get("aria_label") or e.get("placeholder"),
                        "role": e.get("role"),
                    }
                    for e in elements
                ],
                "recent_actions": recent_actions[-4:],
            },
            "questions": {
                "subtask": {
                    "type": "choice",
                    "choices": [
                        "dismiss_overlay",
                        "fill_parameter",
                        "select_dropdown_option",
                        "submit_primary_action",
                        "goal_achieved",
                        "escalate",
                    ],
                },
                "target_id": {
                    "type": "choice",
                    "choices": candidate_ids + ["none"],
                },
                "action_type": {
                    "type": "choice",
                    "choices": ["click", "type", "press_enter", "press_escape", "noop"],
                },
            },
        }

        t0 = time.perf_counter()
        resp = await self.client.post(
            TYPESAFE_API_URL,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            json=payload,
        )
        latency = (time.perf_counter() - t0) * 1000
        if resp.status_code == 200:
            data = resp.json().get("answers", {})
            subtask_ans = data.get("subtask", {})
            target_ans = data.get("target_id", {})
            action_ans = data.get("action_type", {})
            
            subtask = subtask_ans.get("value", "escalate")
            target_id_str = target_ans.get("value")
            target_id = int(target_id_str) if target_id_str and target_id_str != "none" else None
            conf = min(subtask_ans.get("confidence", 0.5), target_ans.get("confidence", 0.5))

            return MicroDecision(
                action_type=action_ans.get("value", "click"),
                target_element_id=target_id,
                input_text="",
                confidence=conf,
                reason=f"Jev System 1 decision in {int(latency)}ms",
                subtask=subtask,
                is_terminal=(subtask == "goal_achieved"),
            )
        return None

    def _local_fast_path_evaluator(
        self,
        goal_intent: Dict[str, Any],
        page_state: Dict[str, Any],
        recent_actions: List[Dict[str, Any]],
    ) -> MicroDecision:
        """
        Universal domain-agnostic calibrated heuristic state machine.
        Sub-15ms execution time. Works across all web frameworks and domains.
        """
        elements = page_state.get("interactive_elements", [])
        curr_url = (page_state.get("url") or "").lower()
        page_title = (page_state.get("title") or "").lower()

        # Step 1: Universal Visual & Semantic Overlay Resolution
        overlay_decision = find_overlay_action(elements)
        if overlay_decision:
            return overlay_decision

        # Collect target parameters to fulfill from universal intent
        target_params: Dict[str, str] = dict(goal_intent.get("parameters", {}))
        if goal_intent.get("origin") and "from" not in target_params:
            target_params["from"] = goal_intent["origin"]
        if goal_intent.get("destination") and "to" not in target_params:
            target_params["to"] = goal_intent["destination"]
        if goal_intent.get("date") and "date" not in target_params:
            target_params["date"] = goal_intent["date"]
        if goal_intent.get("search_query") and "query" not in target_params:
            target_params["query"] = goal_intent["search_query"]
        for k, v in goal_intent.get("form_fields", {}).items():
            if k not in target_params:
                target_params[k] = v

        # Check what parameters have already been fulfilled
        completed_subtasks = {a.get("subtask", "") for a in recent_actions}
        fulfilled_params = {
            a.get("subtask", "").replace("fill_", "")
            for a in recent_actions
            if a.get("subtask", "").startswith("fill_") or a.get("subtask") in {"select_origin_suggestion", "select_destination_suggestion", "set_date"}
        }

        # Step 2: Post-Action Verification if Submit/Search was already clicked
        clicked_primary = any(a.get("subtask") in {"click_search", "submit_primary_action"} for a in recent_actions)
        # If previous validation error recovery is in progress (markers set in target_params), force re-submission path
        has_validation_recovery = any(k.endswith("_invalid") for k in target_params)
        if has_validation_recovery:
            clicked_primary = False
        if clicked_primary:
            # Check 1: Error page detection
            if "/error" in curr_url or "please try again" in page_title:
                return MicroDecision(
                    action_type="escalate",
                    target_element_id=None,
                    confidence=0.99,
                    reason="Server returned error page ('Please try again'). Escalating for error handling.",
                    subtask="escalate",
                )

            # Check 2: Live status alert detection
            status_msg = extract_page_status_message(elements, alerts=page_state.get("alerts", []))
            # Check 2a: Form validation failure (e.g. "Enter From station. Input is Mandatory.", "Please select", "Required")
            # If form validation failed, the primary click was rejected! We must unmark the failed field and re-fill/select it.
            if status_msg and any(vkw in status_msg.lower() for vkw in ["mandatory", "required", "enter from", "enter to", "invalid station", "please select", "input is mandatory"]):
                logger.warning(f"Form submission validation error detected: '{status_msg}'. Recovering missing parameters.")
                clicked_primary = False  # Reset clicked_primary so we do NOT falsely declare goal_achieved!
                if any(k in status_msg.lower() for k in ["from", "origin", "source"]):
                    fulfilled_params.discard("from")
                    completed_subtasks.discard("fill_origin")
                    completed_subtasks.discard("select_origin_suggestion")
                    target_params["from_invalid"] = "true"
                if any(k in status_msg.lower() for k in ["to", "destination"]):
                    fulfilled_params.discard("to")
                    completed_subtasks.discard("fill_destination")
                    completed_subtasks.discard("select_destination_suggestion")
                    target_params["to_invalid"] = "true"
                if any(k in status_msg.lower() for k in ["date", "journey"]):
                    fulfilled_params.discard("date")
                    completed_subtasks.discard("set_date")
                    target_params["date_invalid"] = "true"
                # Do NOT mark goal_achieved! Fall through to Step 4 to re-fill and correct the invalid field!
            elif status_msg and any(kw in status_msg.lower() for kw in ["downtime", "maintenance", "not available", "no results", "no trains", "quota full"]):
                return MicroDecision(
                    action_type="escalate",
                    target_element_id=None,
                    confidence=0.99,
                    reason=f"Page notice detected: {status_msg}. Escalating for handling.",
                    subtask="escalate",
                )

            # Check 3: Structured listing entities rendered on page
            listing_items = extract_listing_entities(elements)
            has_modify = any("modify search" in (e.get("text") or "").lower() for e in elements)
            # URL changed away from initial form page
            is_results_url = any(p in curr_url for p in ["/results", "/search", "/list", "/booking", "/checkout", "/catalog", "/products"]) and not curr_url.endswith("-search")

            # Require BOTH listing items AND a results URL to prevent pre-existing page cards from false-triggering
            if is_results_url and (len(listing_items) > 0 or has_modify):
                return MicroDecision(
                    action_type="noop",
                    target_element_id=None,
                    confidence=0.98,
                    reason=f"Action verified: {len(listing_items)} result entities loaded on page at {curr_url}",
                    subtask="goal_achieved",
                    is_terminal=True,
                )

            # Check 4: Await transition settling (up to 4 cycles)
            if clicked_primary:
                search_waits = sum(1 for a in recent_actions if a.get("subtask") in {"click_search", "submit_primary_action", "await_results"})
                if search_waits < 4:
                    return MicroDecision(
                        action_type="noop",
                        target_element_id=None,
                        confidence=0.90,
                        reason=f"Action dispatched; awaiting server response and DOM rendering (cycle {search_waits+1}/4)...",
                        subtask="await_results",
                        is_terminal=False,
                    )
                else:
                    if not listing_items and not is_results_url:
                        return MicroDecision(
                            action_type="escalate",
                            target_element_id=None,
                            confidence=0.5,
                            reason=f"Form submission did not produce search results: '{status_msg or 'Search did not navigate'}'. Escalating to LLM planner.",
                            subtask="escalate",
                        )
                    return MicroDecision(
                        action_type="noop",
                        target_element_id=None,
                        confidence=0.92,
                        reason="Action response processed; reviewing final DOM state",
                        subtask="goal_achieved",
                        is_terminal=True,
                    )

        # Step 3: Active Combobox / Autocomplete Dropdown Selection & Interactive Questions
        # Note: type_text() with auto_select_suggestion may have already clicked the suggestion.
        # Only attempt selection if dropdown options are STILL visible in the DOM.
        dropdown_options = [
            e for e in elements
            if e.get("role") in {"option", "menuitem"}
            or any(c in (e.get("classes") or "").lower() for c in [
                "autocomplete", "dropdown-item", "suggestion", "listbox-option", "ui-autocomplete-item",
                "ui-autocomplete-list-item", "p-autocomplete-item", "ng-star-inserted", "ui-menuitem"
            ])
        ]
        dropdown_options = [
            opt for opt in dropdown_options
            if (opt.get("text") or "").strip() and not any(skip in (opt.get("text") or "").lower() for skip in ["loading", "search", "enter station", "no results", "---", "-----"])
        ]

        # Also check harvested suggestions from browser driver (passed via page_state)
        driver_suggestions = page_state.get("autocomplete_suggestions", []) or []

        last_action = recent_actions[-1] if recent_actions else {}
        last_subtask = last_action.get("subtask", "")
        if last_subtask.startswith("fill_") and (dropdown_options or driver_suggestions):
            last_param = last_subtask.replace("fill_", "")
            if last_param == "origin":
                last_param = "from"
            elif last_param == "destination":
                last_param = "to"
            
            # Interactive Question Branch: If user permissions allow questions and multiple options exist
            allow_questions = page_state.get("allow_agent_questions", True)
            opt_count = max(len(dropdown_options), len(driver_suggestions))
            if allow_questions and opt_count >= 2:
                return MicroDecision(
                    action_type="ask_question",
                    target_element_id=None,
                    input_text=last_param,
                    confidence=0.98,
                    reason=f"Multiple options available for {last_param}. Prompting user to select desired station.",
                    subtask=f"ask_choice_{last_param}",
                )

            # Autonomous Selection Branch: Auto-select best matching option
            expected_val = (target_params.get(last_param) or "").lower()
            combined_opts = dropdown_options or driver_suggestions or []
            matched_opt = self._match_best_option(combined_opts, expected_val) if expected_val and combined_opts else (combined_opts[0] if combined_opts else None)
            if matched_opt:
                subtask_name = "select_origin_suggestion" if last_param in {"from", "origin"} else ("select_destination_suggestion" if last_param in {"to", "destination"} else "select_dropdown_option")
                return MicroDecision(
                    action_type="click",
                    target_element_id=matched_opt["id"],
                    confidence=0.96,
                    reason=f"Selected matching option '{matched_opt.get('text')}' for {last_param}",
                    subtask=subtask_name,
                )

        # Step 4: Universal Form Field Matching & Fulfillment
        # Sort candidates by DOM appearance order to ensure natural top-to-bottom form filling
        param_candidates = []
        for p_name, p_val in target_params.items():
            if not p_val or p_name in fulfilled_params:
                continue
            subtask_key = f"fill_{p_name}"
            if p_name == "from" and "fill_origin" in completed_subtasks:
                continue
            if p_name == "to" and "fill_destination" in completed_subtasks:
                continue
            if p_name == "date" and "set_date" in completed_subtasks:
                continue
            if subtask_key in completed_subtasks:
                continue

            inp_field = self._find_input_for_param(elements, p_name, p_val)
            if inp_field:
                existing_val = str(inp_field.get("value") or "").strip()
                is_invalid = target_params.get(f"{p_name}_invalid")
                if not is_invalid and existing_val and (p_val in existing_val or (goal_intent.get("date_alt") and goal_intent["date_alt"] in existing_val)):
                    fulfilled_params.add(p_name)
                    continue

                dom_idx = elements.index(inp_field) if inp_field in elements else 9999
                param_candidates.append((dom_idx, p_name, p_val, inp_field))

        if param_candidates:
            param_candidates.sort(key=lambda x: x[0])
            _, p_name, p_val, inp_field = param_candidates[0]

            subtask_id = f"fill_{p_name}"
            if p_name == "from": subtask_id = "fill_origin"
            elif p_name == "to": subtask_id = "fill_destination"
            elif p_name == "date": subtask_id = "set_date"

            return MicroDecision(
                action_type="type",
                target_element_id=inp_field["id"],
                input_text=p_val,
                confidence=0.95,
                reason=f"Entering {p_name} '{p_val}'",
                subtask=subtask_id,
            )

        # Step 5: Primary Action Submission (Submit, Search, Filter, Continue, Go)
        if not clicked_primary and target_params:
            action_btn = self._find_button_by_keywords(elements, [
                "search", "find", "submit", "continue", "proceed", "go", "apply",
                "book", "save", "next", "confirm", "send", "filter", "sign in", "login"
            ])
            if action_btn:
                return MicroDecision(
                    action_type="click",
                    target_element_id=action_btn["id"],
                    confidence=0.97,
                    reason=f"Clicking primary action button '{action_btn.get('text')}' to execute request",
                    subtask="click_search",
                )

        # Fallback: Escalate to System 2 Macro-Reasoning Planner
        return MicroDecision(
            action_type="escalate",
            target_element_id=None,
            confidence=0.5,
            reason="Complex or ambiguous UI state; escalating to System 2 macro-reasoner",
            subtask="escalate",
        )

    def _match_best_option(self, options: List[Dict[str, Any]], query: str) -> Dict[str, Any]:
        """Ranks autocomplete options by semantic substring and keyword match."""
        query_clean = query.strip().lower()
        for opt in options:
            t = (opt.get("text") or "").strip().lower()
            if query_clean in t:
                return opt
        q_words = set(query_clean.split())
        best_opt = options[0]
        max_overlap = -1
        for opt in options:
            t_words = set((opt.get("text") or "").strip().lower().split())
            overlap = len(q_words & t_words)
            if overlap > max_overlap:
                max_overlap = overlap
                best_opt = opt
        return best_opt

    def _find_input_for_param(self, elements: List[Dict[str, Any]], param_name: str, param_val: str) -> Optional[Dict[str, Any]]:
        """
        Universal semantic field matching across arbitrary websites.
        Matches an entity parameter to its corresponding DOM input field.
        """
        keywords = self.PARAM_SYNONYMS.get(param_name, [param_name])
        return self._find_input_by_keywords(elements, keywords)

    def _find_input_by_keywords(self, elements: List[Dict[str, Any]], keywords: List[str]) -> Optional[Dict[str, Any]]:
        for el in elements:
            tag = (el.get("tag") or "").lower()
            etype = (el.get("type") or "").lower()
            if etype in {"checkbox", "radio", "submit", "button", "hidden"}:
                continue
            is_date_field = any(k in ["date", "journey date", "departure date", "travel date", "when", "depart", "check-in", "check in", "start date"] for k in keywords)
            if tag not in {"input", "textarea"} and el.get("role") not in {"textbox", "combobox", "searchbox", "input"}:
                if not (is_date_field and (tag in {"p-calendar", "span"} or el.get("role") in {"datepicker", "calendar"} or any(c in (el.get("classes") or "").lower() for c in ["calendar", "datepicker", "date-input"]))):
                    continue

            # Special date detection: if looking for date, inspect value, classes, card_context, aria-label, name
            if is_date_field:
                val_text = str(el.get("value") or el.get("text") or "").strip()
                if re.search(r"\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b", val_text):
                    return el
                classes = str(el.get("classes") or "").lower()
                if any(c in classes for c in ["calendar", "datepicker", "ui-calendar", "p-calendar", "date-input", "daterangepicker", "flatpickr"]):
                    return el
                card_ctx = str(el.get("card_context") or "").lower()
                if "date" in card_ctx or "dd/mm" in card_ctx or "journey" in card_ctx or "travel" in card_ctx:
                    return el
                # Check aria-label, placeholder, name, id for date-related terms
                aria = str(el.get("aria_label") or "").lower()
                placeholder = str(el.get("placeholder") or "").lower()
                name = str(el.get("name") or "").lower()
                input_id = str(el.get("input_id") or el.get("id") or "").lower() if isinstance(el.get("input_id") or el.get("id"), str) else ""
                for date_kw in ["date", "journey", "travel", "check-in", "checkin", "dd/mm", "dd-mm"]:
                    if date_kw in aria or date_kw in placeholder or date_kw in name or date_kw in input_id:
                        return el
                # Match readonly inputs that look like date fields (common for p-calendar)
                if el.get("readonly") or "readonly" in (el.get("attributes") or ""):
                    if any(dkw in (aria + " " + placeholder + " " + card_ctx) for dkw in ["date", "dd/mm", "journey"]):
                        return el

            text = " ".join([
                str(el.get("placeholder") or ""),
                str(el.get("aria_label") or ""),
                str(el.get("text") or ""),
                str(el.get("name") or ""),
                str(el.get("id") or ""),
                str(el.get("card_context") or ""),
            ]).lower()

            for kw in keywords:
                if kw in ["to", "from"]:
                    # Strict matching for prepositions to avoid matching random text like "where do you want TO go"
                    for attr in [str(el.get("placeholder") or ""), str(el.get("aria_label") or ""), str(el.get("name") or ""), str(el.get("id") or ""), str(el.get("text") or "")]:
                        attr_clean = attr.lower().strip()
                        if attr_clean == kw or attr_clean.startswith(f"{kw} ") or f" {kw} " in attr_clean:
                            # Verify it's not a generic sentence containing "to" or "from"
                            if len(attr_clean.split()) <= 4 or any(x in attr_clean for x in ["station", "airport", "city", "location", "destination", "origin", "where"]):
                                return el
                elif len(kw) <= 3:
                    if re.search(rf"\b{re.escape(kw)}\b", text):
                        return el
                else:
                    if kw in text:
                        return el
        return None

    def _find_button_by_keywords(self, elements: List[Dict[str, Any]], keywords: List[str]) -> Optional[Dict[str, Any]]:
        best_match = None
        best_score = -1

        for kw in keywords:
            for el in elements:
                tag = (el.get("tag") or "").lower()
                role = (el.get("role") or "").lower()
                text = (el.get("text") or el.get("aria_label") or el.get("value") or "").strip().lower()
                classes = (el.get("classes") or "").lower()
                etype = (el.get("type") or "").lower()

                if etype in {"checkbox", "radio", "hidden"}:
                    continue
                if any(skip in text for skip in ["check to", "check for", "explore", "help", "support", "advisory", "notice", "skip", "close", "feedback", "cancel", "blog"]):
                    continue

                is_clickable = tag in {"button", "a"} or role in {"button", "link"} or "btn" in classes or (tag == "input" and etype in {"submit", "button"})
                if not is_clickable:
                    continue

                if re.search(rf"\b{re.escape(kw)}\b", text, re.IGNORECASE) or (len(kw) > 6 and kw in text):
                    score = 0
                    if tag == "button" or (tag == "input" and etype == "submit"):
                        score += 10
                    if "primary" in classes or "submit" in classes:
                        score += 5
                    if tag == "a" or role == "link":
                        # Penalize generic header navigation links
                        if "nav" in classes or "menu" in classes or "header" in classes:
                            score -= 10
                        else:
                            score -= 5
                    
                    if score > best_score:
                        best_score = score
                        best_match = el

            # If we found a good match for this keyword (score >= 0), return it without checking lower-priority keywords
            if best_match and best_score >= 0:
                return best_match

        return best_match


def extract_listing_entities(elements: List[Dict[str, Any]], body_text: str = "") -> List[Dict[str, Any]]:
    """
    Universal DOM Entity Extractor.
    Extracts structured repeating entities (products, travel options, jobs, articles, search results)
    across ANY arbitrary website using DOM hierarchy, card context, and repeating structural patterns.
    """
    results = []
    seen_keys = set()

    # Strategy 1: Group interactive elements by their parent card / container context
    card_groups: Dict[str, List[Dict[str, Any]]] = {}
    for el in elements:
        ctx = (el.get("card_context") or "").strip()
        if ctx and len(ctx) >= 3:
            card_groups.setdefault(ctx, []).append(el)

    for ctx_title, items in card_groups.items():
        clean_k = ctx_title.lower()
        if clean_k in seen_keys:
            continue
        seen_keys.add(clean_k)
        item_texts = [i.get("text", "") for i in items if i.get("text")]
        all_text = " | ".join(filter(None, [ctx_title] + item_texts[:4]))
        action_btns = [i.get("text") for i in items if i.get("tag") in {"button", "a"} and i.get("text")]
        results.append({
            "title": ctx_title,
            "raw_text": all_text[:200],
            "actions": action_btns[:3],
        })

    # Strategy 2: Structured repeating entity pattern detection
    if len(results) < 2:
        for el in elements:
            text = (el.get("text") or "").strip()
            if len(text) < 15 or len(text) > 300:
                continue

            has_price = bool(re.search(r"[\$€£₹]\s*\d+|\b\d+\s*(?:USD|EUR|GBP|INR)\b", text))
            has_time = bool(re.search(r"\b\d{1,2}:\d{2}\s*(?:AM|PM|am|pm|hrs)?\b", text))
            has_code = bool(re.search(r"\b\d{4,6}\b|[A-Z]{2,4}\s*-\s*[A-Z]{2,4}", text))
            has_listing_kw = any(k in text.lower() for k in [
                "exp", "express", "flight", "hotel", "room", "departure", "arrival", "add to cart",
                "in stock", "rating", "reviews", "apply", "book", "available", "schedule", "view details"
            ])

            if (has_price and has_time) or (has_time and has_code) or (has_price and has_listing_kw) or (has_code and has_listing_kw):
                clean_k = text[:40].lower()
                if clean_k not in seen_keys:
                    seen_keys.add(clean_k)
                    first_line = text.split("\n")[0].split("|")[0].strip()[:60]
                    results.append({
                        "title": first_line or text[:50],
                        "raw_text": text.replace("\n", " ")[:200],
                    })

    return results


# Backwards compatibility alias
extract_travel_results = extract_listing_entities


def extract_page_status_message(elements: List[Dict[str, Any]], body_text: str = "", alerts: Optional[List[str]] = None) -> Optional[str]:
    """
    Universal Page Status & Alert Extractor.
    Detects critical live DOM banners, maintenance notices, warnings, validation failures, and error toasts across ANY website.
    """
    # 1. Check explicit APV perception alerts first
    if alerts:
        for a in alerts:
            t = (a or "").strip()
            if any(k in t.lower() for k in ["mandatory", "required", "enter from", "enter to", "invalid", "error", "select station"]):
                return t[:180]

    # 2. Check full body text regex
    if body_text:
        m = re.search(r"(Currently services are not available[^\n\.\!]+[\n\.\!]?|services will resume at [^\n\.\!]+|maintenance downtime[^\n\.\!]+|temporarily unavailable[^\n\.\!]+)", body_text, re.IGNORECASE)
        if m:
            return m.group(0).strip()
        m_err = re.search(r"\b(no (?:results|trains|flights|items|matches) found[^\n\.\!]*|service unavailable[^\n\.\!]*|session expired[^\n\.\!]*|please try again[^\n\.\!]*|quota full[^\n\.\!]*)\b", body_text, re.IGNORECASE)
        if m_err:
            return m_err.group(0).strip()

    # 3. Check interactive & alert elements
    for el in elements:
        t = (el.get("text") or el.get("aria_label") or "").strip()
        classes = (el.get("classes") or "").lower()
        role = (el.get("role") or "").lower()
        is_alert_carrier = role in {"alert", "alertdialog", "status"} or any(c in classes for c in ["alert", "toast", "message", "error", "growl", "notice", "banner", "invalid", "ui-message"])
        if is_alert_carrier or any(k in t.lower() for k in ["input is mandatory", "enter from station", "enter to station", "invalid station"]):
            if any(k in t.lower() for k in ["maintenance", "downtime", "not available", "error", "warning", "resume at", "invalid", "required", "expired", "failed", "mandatory", "please select", "input is mandatory"]):
                return t[:180]
    return None
