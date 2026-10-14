import asyncio
import os
import re
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse
import httpx
from .apv_engine import ActionPerceptionVerification
from .testing_runtime import action_status


def normalize_element_text(raw_text: str) -> str:
    """Collapses spaced letters (A D I T Y A -> ADITYA) and deduplicates hover repeats (ABOUT ABOUT -> ABOUT)."""
    if not raw_text:
        return ""
    segments = [s.strip() for s in re.split(r'\s{2,}', raw_text) if s.strip()]
    norm_segments = []
    for seg in segments:
        words = seg.split()
        if len(words) > 1 and all(len(w) == 1 for w in words):
            seg = "".join(words)
        else:
            seg = re.sub(r'(?<=\b[A-Za-z0-9])\s+(?=[A-Za-z0-9]\b)', '', seg)
        norm_segments.append(seg)
    cleaned = " ".join(norm_segments)
    words = cleaned.split()
    if len(words) % 2 == 0 and len(words) >= 2:
        half = len(words) // 2
        if [w.lower() for w in words[:half]] == [w.lower() for w in words[half:]]:
            cleaned = " ".join(words[:half])
    elif len(words) == 1:
        s = words[0]
        if len(s) >= 4 and len(s) % 2 == 0 and s[:len(s)//2].lower() == s[len(s)//2:].lower():
            cleaned = s[:len(s)//2]
    return cleaned.strip()


def _compact_interactive_elements(elements: List[Dict[str, Any]], max_count: int = 80, offset: int = 0) -> List[Dict[str, Any]]:
    """Bound controls by viewport availability, preserving DOM order within each group.

    Names, language and numeric labels do not determine action priority.
    """
    ordered = sorted(elements or [], key=lambda el: (
        not bool(el.get('is_inside_modal')), not bool(el.get("is_in_viewport")), bool(el.get("is_occluded"))))

    compacted = []
    for el in ordered[offset:offset + max_count]:
        item: Dict[str, Any] = {
            "id": el.get("id"),
            "element_id": el.get("id"),
            "tag": el.get("tag"),
            "text": el.get("text", "")[:60],
        }
        role = el.get("role")
        tag = el.get("tag")
        if role and role != tag:
            item["role"] = role
        if el.get("type"):
            item["type"] = el.get("type")
        if el.get("placeholder"):
            item["placeholder"] = el.get("placeholder")[:40]
        if el.get("value") is not None and str(el.get("value")).strip():
            item["value"] = "[redacted]" if el.get("type") == "password" else str(el.get("value"))[:40]
        if el.get("checked") is not None:
            item["checked"] = bool(el.get("checked"))
        if el.get("disabled"):
            item["disabled"] = True
        for key in ("editor_kind", "required", "invalid", "expanded", "selected", "pressed", "options", "aria_controls", "min", "max", "readonly", "has_popup", "is_inside_modal", "card_context", "form_id"):
            if el.get(key) is not None:
                item[key] = el[key]
        if el.get("href"):
            item["href"] = el.get("href")
        if el.get("download"):
            item["download"] = True
        if el.get("box"):
            item["box"] = el.get("box")
        if el.get("is_external"):
            item["is_external"] = True
        if el.get("card_context"):
            item["card"] = el.get("card_context")
        if el.get("form_id"):
            item["form"] = el.get("form_id")
        if el.get("is_occluded"):
            item["occluded"] = True
        if not el.get("is_in_viewport"):
            item["below_fold"] = True
        compacted.append(item)
    return compacted


AGENT_TOOLS = [
    {'type':'function','function':{
        'name':'browser_start_campaign',
        'description':'Start durable background website testing for large sites or multi-hour runs. Queues discovery and bounded workflow scenarios, saves coverage/evidence and resumes after safe interruptions. The chat returns immediately; monitor its campaign card. Completion is not exhaustive coverage.',
        'parameters':{'type':'object','properties':{
            'session_id':{'type':'string'},'max_pages':{'type':'integer','minimum':1,'maximum':10000},
            'max_seconds':{'type':'integer','minimum':60,'maximum':86400},'max_actions':{'type':'integer','minimum':1,'maximum':100000},
            'max_tokens':{'type':'integer','minimum':100,'maximum':10000000}},'additionalProperties':False}}},
    {'type':'function','function':{
        'name':'browser_campaign_status','description':'Read saved progress and scope of this chat\'s background campaign.',
        'parameters':{'type':'object','properties':{'session_id':{'type':'string'},'campaign_id':{'type':'string'}},'required':['campaign_id'],'additionalProperties':False}}},
    {'type':'function','function':{
        'name':'browser_campaign_control','description':'Pause, resume, cancel or reconcile a campaign. Reconcile inspects an interrupted workflow before further input; it does not authorize replay of a submission.',
        'parameters':{'type':'object','properties':{'session_id':{'type':'string'},'campaign_id':{'type':'string'},'action':{'type':'string','enum':['pause','resume','cancel','reconcile']}},'required':['campaign_id','action'],'additionalProperties':False}}},
    {
        'type':'function','function':{
            'name':'browser_read_editor',
            'description':'Read the document of one observed source editor (Ace, CodeMirror, Monaco or native/contenteditable), preserving code whitespace. Use after typing failures before any retry. Does not execute code; verify compiler output separately.',
            'parameters':{'type':'object','properties':{'session_id':{'type':'string'},'element_id':{'type':'integer','minimum':0}},'required':['element_id'],'additionalProperties':False}
        }
    },
    {
        "type":"function",
        "function":{
            "name":"browser_audit_site",
            "description":"Run a bounded same-origin navigation/section/hover audit with an explicit queue and coverage ledger. Uses observed links, never site-specific scripts. Provide current element IDs ONLY for harmless UI state controls (tabs, theme/menu toggles, accordions, copy or back-to-top) whose meaning you understand. Form submission and business workflows need separate explicit scenarios. Results distinguish visited, failed, pending and untested areas; do not claim exhaustive website coverage.",
            "parameters":{"type":"object","properties":{
                "session_id":{"type":"string"},
                "ui_control_ids":{"type":"array","items":{"type":"integer","minimum":0},"maxItems":32},
                "max_pages":{"type":"integer","minimum":1,"maximum":100},
                "max_actions":{"type":"integer","minimum":1,"maximum":1000},
                "max_seconds":{"type":"number","minimum":5,"maximum":180},
                "include_hover":{"type":"boolean"}},"additionalProperties":False}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_observe",
            "description": "Refresh semantic controls and capture a fresh screenshot without changing the page. For a specific workflow, query observed names with scope=viewport or overlay instead of scanning unrelated footer links. Controls are paginated: use next_offset while has_more is true to inspect remaining controls once; preserve all controls in each page. Image reasoning requires a configured vision model lane.",
            "parameters": {"type": "object", "properties": {"session_id": {"type": "string"}, "offset": {"type": "integer", "minimum": 0}, "query":{"type":"string","minLength":1,"maxLength":120,"description":"Literal case-insensitive search across current control names, placeholders, roles and context; no invented selector."}, "scope":{"type":"string","enum":["page","viewport","overlay"],"description":"page includes all discovered controls; viewport excludes off-screen controls; overlay includes only active dialog controls."}, "include_frame":{"type":"boolean","description":"Request a fresh visual observation when DOM evidence is insufficient; requires an image-capable lane."}}, "additionalProperties": False}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_assert",
            "description": "Check explicit expected outcomes against the live page. Page title/url take no target. visible/in_viewport take a target but no expected field. Use accessible_name for icon buttons with aria-label; text checks visible text. Use validity with expected=false/true for native validation. Does not mutate or navigate.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string"},
                    "timeout_seconds": {"type": "number", "minimum": 0, "maximum": 30},
                    "purpose": {"type": "string", "enum": ["checkpoint", "outcome"], "description": "checkpoint checks intermediate state; outcome checks the user's requested terminal result"},
                    "expectations": {
                        "type": "array", "minItems": 1, "maxItems": 20,
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": ["text", "accessible_name", "value", "editor_value", "visible", "in_viewport", "absent", "checked", "validity", "expanded", "selected", "pressed", "focused", "url", "title"]},
                                "selector": {"type": "string", "description": "Only an actual observed CSS selector, never a number from the control list. Prefer element_id. Must resolve uniquely except absent checks."},
                                "element_id": {"type": "integer", "description": "Copy the control's observed element_id integer here. It is an opaque tool reference, NOT a DOM id or CSS selector. Required for asserting observed controls unless an actual unique CSS selector is known."},
                                "expected": {"anyOf": [{"type": "string"}, {"type": "boolean"}]},
                                "match": {"type": "string", "enum": ["exact", "contains"]}
                            },
                            "required": ["kind"], "additionalProperties": False
                        }
                    }
                },
                "required": ["expectations"], "additionalProperties": False
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_deployment_status",
            "description": "Get the current status, runtime URL, image, and health of a deployment",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"}
                },
                "required": ["deployment_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_deployment_logs",
            "description": "Retrieve build or runtime logs for a deployment",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"},
                    "log_type": {"type": "string", "enum": ["build", "runtime"], "description": "Type of logs"}
                },
                "required": ["deployment_id", "log_type"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "trigger_build",
            "description": "Queue a new build for a deployment",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"}
                },
                "required": ["deployment_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "repair_deployment",
            "description": "Analyze and auto-fix a deployment's build or runtime issues. Use this when the user asks to fix an issue.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"},
                    "problem_description": {"type": "string", "description": "User's description of what's wrong"}
                },
                "required": ["deployment_id", "problem_description"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_deployments",
            "description": "List all deployments with their current status and runtime URLs",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_projects",
            "description": "List all projects the user owns",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_deployment_metrics",
            "description": "Get CPU, memory, and network metrics for a deployment",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"}
                },
                "required": ["deployment_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "scale_deployment",
            "description": "Scale a deployment to a specified number of replicas",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"},
                    "replicas": {"type": "integer", "description": "Target replica count (0-50)"}
                },
                "required": ["deployment_id", "replicas"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_kubernetes_events",
            "description": "Get Kubernetes events for a deployment to diagnose crash loops",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"}
                },
                "required": ["deployment_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_list_files",
            "description": "List files and directories in a project or deployment source workspace. Use this to explore the project structure, locate configs, and inspect codebase layout before answering questions or making edits.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment (optional if project_id is provided)"},
                    "project_id": {"type": "string", "description": "UUID of the project (optional if deployment_id is provided)"},
                    "path": {"type": "string", "description": "Relative subdirectory path to list (default: root)"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_read_file",
            "description": "Read the contents of a file in a project or deployment source workspace. Use this to inspect code, package.json, Dockerfile, configs, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment (optional if project_id is provided)"},
                    "project_id": {"type": "string", "description": "UUID of the project (optional if deployment_id is provided)"},
                    "file_path": {"type": "string", "description": "Relative path to the file within the source directory"}
                },
                "required": ["file_path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_write_file",
            "description": "Create or overwrite a file in a project or deployment source workspace. Use this for creating new files or complete rewrites.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment (optional if project_id is provided)"},
                    "project_id": {"type": "string", "description": "UUID of the project (optional if deployment_id is provided)"},
                    "file_path": {"type": "string", "description": "Relative path for the file within the source directory"},
                    "content": {"type": "string", "description": "The full content to write to the file"}
                },
                "required": ["file_path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_edit_file",
            "description": "Perform a surgical find-and-replace edit in a project or deployment source file. Use this for targeted code fixes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment (optional if project_id is provided)"},
                    "project_id": {"type": "string", "description": "UUID of the project (optional if deployment_id is provided)"},
                    "file_path": {"type": "string", "description": "Relative path to the file within the source directory"},
                    "target": {"type": "string", "description": "The exact text to find in the file"},
                    "replacement": {"type": "string", "description": "The text to replace the target with"}
                },
                "required": ["file_path", "target", "replacement"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "workspace_trigger_rebuild",
            "description": "Trigger a rebuild of a deployment from its modified source files without re-cloning from git. Use this after making file edits to apply fixes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment"}
                },
                "required": ["deployment_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "wait_for_deployment",
            "description": "Wait for the exact rebuild job to complete and its browser render smoke check to pass, or return failure/timeout. Supply the job_id returned by the build tool. Only verified=true with job_status=completed proves a render smoke pass; running alone does not prove a repaired website or business correctness.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment to wait for"},
                    "job_id": {"type": "string", "description": "Exact job_id returned by the rebuild/build tool. Prevents accepting an older or superseding build."},
                    "timeout_seconds": {"type": "integer", "description": "Maximum seconds to wait (10 to 600, default 180)"}
                },
                "required": ["deployment_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_session_context",
            "description": "Retrieve project_id, deployment_id, session_type, status, and failure logs associated with an active AI session.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "UUID of the AI session"}
                },
                "required": ["session_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "terminal_run_command",
            "description": "Execute a terminal inspection or utility command directly in the project workspace (PowerShell/bash). Use for inspecting files and workspace state (e.g. 'cat package.json', 'ls -la', 'Get-ChildItem', 'git status', 'node -v'). DO NOT run system package managers ('apt-get', 'sudo', 'apk', 'yum') or attempt heavy project compilation directly in the terminal — the backend container is an unprivileged environment without compilers. To compile or install packages, configure the Dockerfile with workspace_write_file and invoke workspace_trigger_rebuild.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The PowerShell/terminal command to execute in the workspace"},
                    "deployment_id": {"type": "string", "description": "UUID of the deployment (optional if project_id is provided)"},
                    "project_id": {"type": "string", "description": "UUID of the project (optional if deployment_id is provided)"}
                },
                "required": ["command"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the live web using SearXNG for up-to-date documentation, API references, library versions, install guides, error solutions, and dependencies.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The search query to look up on the web"},
                    "num_results": {"type": "integer", "description": "Number of results to retrieve (default 5)"}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "Fetch and read the text/markdown content of a documentation or web page URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The full HTTP/HTTPS URL to fetch"}
                },
                "required": ["url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "invoke_subagent",
            "description": "Create a real asynchronous teammate for an isolated task. Role is free text; no fixed team lineup. Returns queued, not completion. Prefer spawn_agent with explicit disjoint write scopes for parallel editing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "role": {"type": "string", "description": "Free-form purpose of this teammate"},
                    "task": {"type": "string", "description": "Specific, actionable task description for the subagent"},
                    "write_scope": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["role", "task"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_open_live_session",
            "description": "Open or navigate a live real-time browser session to inspect or test an application URL. Streams real-time visual frames directly to the user's dashboard and returns visible interactive elements (buttons, inputs, links) with IDs and coordinates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to navigate to (e.g. 'http://localhost:3000' or deployment runtime URL)"},
                    "session_id": {"type": "string", "description": "Optional session identifier (defaults to 'default')"}
                },
                "required": ["url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_interact",
            "description": "Interact with the live application in the browser session. Supports clicking elements by ID or coordinates, hovering to reveal tooltips/flyout menus, double-clicking, right-clicking (context menu), dragging and dropping, typing text, scrolling, navigating, checking theme, or pressing shortcut keys. Glides the AI cursor on screen in real time and returns captured frame snapshot.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Session identifier (defaults to 'default')"},
                    "action": {"type": "string", "enum": ["click", "hover", "double_click", "right_click", "drag_and_drop", "type", "scroll", "scroll_to", "navigate_back", "navigate_forward", "return_to_parent", "get_theme", "press_key", "navigate", "toggle_checkbox", "set_checked", "select_option", "choose_option", "choose_date", "handle_dialog", "switch_tab", "switch_frame"], "description": "Use navigate_back/navigate_forward for actual history and return_to_parent for detail/modal recovery; observe fresh targets afterwards. Use choose_option for a whole autocomplete transaction, choose_date for a verified calendar date, handle_dialog for a currently observed native dialog, and switch_tab/switch_frame for an observed session-owned surface."},
                    "option_text":{"type":"string","description":"Exact observed autocomplete label; ambiguous partial names produce a question."},
                    "format":{"type":"string","enum":["YYYY-MM-DD","DD/MM/YYYY","MM/DD/YYYY"]},
                    "dialog_id":{"type":"string"}, "accept":{"type":"boolean"},
                    "target_id":{"type":"string"}, "frame_id":{"type":"string"},
                    "checked": {"type":"boolean", "description":"Desired state for set_checked; idempotent, never blindly toggles"},
                    "element_id": {"type": "integer", "description": "Element ID [1], [2] from the page element list (for click, hover, type, or scroll_to)"},
                    "field": {"type": "string", "description": "Name, placeholder, or ID of form field to type into (e.g. 'name', 'email', 'message')"},
                    "x": {"type": "integer", "description": "X coordinate in pixels (optional for click/hover if element_id is provided)"},
                    "y": {"type": "integer", "description": "Y coordinate in pixels (optional for click/hover if element_id is provided)"},
                    "start_x": {"type": "integer", "description": "Start X coordinate for drag_and_drop"},
                    "start_y": {"type": "integer", "description": "Start Y coordinate for drag_and_drop"},
                    "end_x": {"type": "integer", "description": "End X coordinate for drag_and_drop"},
                    "end_y": {"type": "integer", "description": "End Y coordinate for drag_and_drop"},
                    "duration": {"type": "number", "description": "Hover dwell duration in seconds (default 0.35)"},
                    "text": {"type": "string", "description": "Text to type when action is 'type'"},
                    "auto_select_suggestion": {"type": "string", "description": "Optional explicit autocomplete option text. Only a uniquely matching visible option is committed; ambiguous choices require a fresh observation and explicit click."},
                    "scroll_y": {"type": "integer", "description": "Pixels to scroll down/up (action='scroll') or absolute Y position to scroll to (action='scroll_to')"},
                    "delta_y": {"type": "integer", "description": "Relative pixels to scroll up or down (action='scroll')"},
                    "key": {"type": "string", "description": "Key name to press (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown')"},
                    "modifiers": {"type": "array", "items": {"type": "string"}, "description": "Modifier keys e.g. ['Control'], ['Alt'], ['Shift']"},
                    "url": {"type": "string", "description": "URL when action is 'navigate'"},
                    "value": {"type": "string", "description": "Option value when action is 'select_option'"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_interact_batch",
            "description": "Execute up to 8 observed actions and explicit assertions in ONE local call. Set complete_task=true only when the final purpose=outcome assertion covers the entire user request. On verified completion the harness reports evidence immediately, without another model call. Stops on failure; never guesses unknown dropdown choices.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Session identifier (defaults to 'default')"},
                    "complete_task": {"type":"boolean", "description":"All requested work is included and the final assert step verifies it; false for intermediate batches or broad audits"},
                    "actions": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 8,
                        "description": "Ordered list of 1–8 actions, including assertions. Split longer workflows into multiple batches.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "action": {"type": "string", "enum": ["click", "hover", "type", "scroll", "scroll_to", "press_key", "navigate", "navigate_back", "navigate_forward", "return_to_parent", "select_option", "choose_option", "choose_date", "toggle_checkbox", "set_checked", "get_theme", "assert", "switch_tab", "switch_frame", "handle_dialog"], "description": "Use assert for explicit outcomes. Navigation/tab/frame changes invalidate controls: observe fresh element IDs before further input. Tab IDs are target_id strings, never element IDs."},
                                "target_id":{"type":"string"},
                                "frame_id":{"type":"string"},
                                "dialog_id":{"type":"string"},
                                "accept":{"type":"boolean"},
                                "url": {"type":"string", "description":"Explicit same-origin destination for navigate"},
                                "checked": {"type":"boolean"},
                                "expectations": {"type": "array", "items": {"type": "object"}, "description": "Explicit browser_assert expectations for action=assert"},
                                "timeout_seconds": {"type": "number", "minimum": 0, "maximum": 30},
                                "purpose": {"type": "string", "enum": ["checkpoint", "outcome"]},
                                "element_id": {"type": "integer", "description": "Copy the current observed integer tool reference, never a DOM id string or CSS selector"},
                                "text": {"type": "string", "description": "Text to type"},
                                "auto_select_suggestion": {"type": "string", "description": "Explicit autocomplete option text; must match uniquely"},
                                "option_text": {"type":"string"},
                                "format": {"type":"string","enum":["YYYY-MM-DD","DD/MM/YYYY","MM/DD/YYYY"]},
                                "scroll_y": {"type": "integer"},
                                "delta_y": {"type": "integer"},
                                "field": {"type": "string", "description": "Field name or placeholder"},
                                "key": {"type": "string", "description": "Key name to press"},
                                "value": {"type": "string", "description": "Select option value"}
                            },
                            "required": ["action"], "additionalProperties": False
                        }
                    }
                },
                "required": ["actions"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_get_page_state",
            "description": "Retrieve the current page URL, document title, and visible interactive elements with their IDs and coordinates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Session identifier (defaults to 'default')"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_inspect_console",
            "description": "Retrieve real-time browser console logs (log, warn, error, unhandled exceptions) from the active live session.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Session identifier (defaults to 'default')"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_close_session",
            "description": "Close the active live browser session and release resources.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Session identifier (defaults to 'default')"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "ask_user_question",
            "description": "Prompt the user with an interactive question card directly in the chat with dropdown selectors, radio choices, or fill-in-the-blank inputs. Use when the observed options or required inputs are ambiguous for the user's requested goal. Only ask when clarification is genuinely required. If the user's prompt was already specific, proceed autonomously without asking.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The focused question needed to resolve a missing or ambiguous input"
                    },
                    "fields": {
                        "type": "array",
                        "description": "Form fields for the user to answer with",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "description": "Stable identifier for the requested answer"},
                                "label": {"type": "string", "description": "Label displayed above dropdown/input"},
                                "type": {"type": "string", "enum": ["dropdown", "text", "radio"], "description": "Field type"},
                                "options": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "Available choices supported by observed page evidence"
                                },
                                "placeholder": {"type": "string", "description": "Placeholder text"},
                                "default_value": {"type": "string", "description": "Default selected option"}
                            },
                            "required": ["id", "label", "type"]
                        }
                    }
                },
                "required": ["question", "fields"]
            }
        }
    }
]

# Share the same typed expectation schema in ordinary and batched assertions.
# An opaque object schema previously made the planner invent invalid kinds/IDs.
_expectation_schema = next(tool for tool in AGENT_TOOLS if tool['function']['name']=='browser_assert')['function']['parameters']['properties']['expectations']['items']
for _tool in AGENT_TOOLS:
    if _tool['function']['name'] == 'browser_interact_batch':
        _tool['function']['parameters']['properties']['actions']['items']['properties']['expectations']['items'] = _expectation_schema
    if _tool['function']['name'] in {'browser_observe', 'browser_interact', 'browser_interact_batch'}:
        _tool['function']['parameters']['properties']['include_frame'] = {
            'type': 'boolean',
            'description': 'Set false for structured DOM observations and ordinary controls. Capture an image only when a visual decision requires it.'}

async def execute_web_search(query: str, num_results: int = 5) -> Dict[str, Any]:
    """Search the web using local SearXNG (or fallback to public SearXNG/DuckDuckGo)."""
    if not query.strip():
        return {"error": "Search query cannot be empty", "results": []}

    searxng_url = os.getenv("SEARXNG_URL", "http://searxng:8080").rstrip("/")

    # 1. Try local SearXNG container first
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(
                f"{searxng_url}/search",
                params={"q": query, "format": "json", "categories": "general"},
            )
            if resp.status_code == 200:
                data = resp.json()
                raw_results = data.get("results", [])
                results = []
                for item in raw_results[:num_results]:
                    url = item.get("url", "")
                    domain = url.split("//")[-1].split("/")[0] if "//" in url else ""
                    results.append({
                        "title": item.get("title", ""),
                        "url": url,
                        "content": item.get("content", ""),
                        "domain": domain,
                    })
                return {
                    "query": query,
                    "count": len(results),
                    "results": results,
                    "engine": "searxng",
                }
    except Exception:
        pass

    # 2. Fallback to public SearXNG instances
    fallback_instances = [
        "https://search.ononoki.org",
        "https://searx.be",
        "https://priv.au",
    ]
    for inst in fallback_instances:
        try:
            async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
                resp = await client.get(
                    f"{inst}/search",
                    params={"q": query, "format": "json"},
                    headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    raw_results = data.get("results", [])
                    results = []
                    for item in raw_results[:num_results]:
                        url = item.get("url", "")
                        domain = url.split("//")[-1].split("/")[0] if "//" in url else ""
                        results.append({
                            "title": item.get("title", ""),
                            "url": url,
                            "content": item.get("content", ""),
                            "domain": domain,
                        })
                    if results:
                        return {
                            "query": query,
                            "count": len(results),
                            "results": results,
                            "engine": "searxng_public",
                        }
        except Exception:
            continue

    # 3. Fallback to DuckDuckGo HTML
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            resp = await client.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query},
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
            )
            if resp.status_code == 200:
                import re
                links = re.findall(r'<a class="result__url" href="([^"]+)">(.*?)</a>', resp.text)
                snippets = re.findall(r'<a class="result__snippet[^>]*>(.*?)</a>', resp.text)
                results = []
                for i, (href, raw_domain) in enumerate(links[:num_results]):
                    snippet = snippets[i] if i < len(snippets) else ""
                    clean_snippet = re.sub(r'<[^>]+>', '', snippet).strip()
                    clean_domain = re.sub(r'<[^>]+>', '', raw_domain).strip()
                    results.append({
                        "title": clean_snippet[:60] if clean_snippet else clean_domain,
                        "url": href,
                        "content": clean_snippet,
                        "domain": clean_domain,
                    })
                return {
                    "query": query,
                    "count": len(results),
                    "results": results,
                    "engine": "duckduckgo",
                }
    except Exception as e:
        return {"error": f"Web search failed: {str(e)}", "results": []}

    return {"query": query, "count": 0, "results": []}

async def execute_web_fetch(url: str) -> Dict[str, Any]:
    """Fetch content of a web page and strip HTML into readable text."""
    if not url.strip():
        return {"error": "URL cannot be empty"}
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
            )
            resp.raise_for_status()
            text = resp.text
            import re
            text = re.sub(r'<(script|style)[^>]*>[\s\S]*?</\1>', '', text, flags=re.IGNORECASE)
            text = re.sub(r'</?(p|div|h[1-6]|li|tr|br)[^>]*>', '\n', text, flags=re.IGNORECASE)
            text = re.sub(r'<[^>]+>', ' ', text)
            lines = [re.sub(r'\s+', ' ', line).strip() for line in text.split('\n')]
            clean_text = '\n'.join(line for line in lines if line)
            if len(clean_text) > 8000:
                clean_text = clean_text[:8000] + "\n\n...(content truncated to 8000 characters)"
            return {
                "url": url,
                "status_code": resp.status_code,
                "content": clean_text,
                "length": len(clean_text),
            }
    except Exception as e:
        return {"error": f"Failed to fetch URL {url}: {str(e)}"}

from .agent_runtime.tools import TEAM_TOOLS
AGENT_TOOLS.extend(TEAM_TOOLS)
for _schema in AGENT_TOOLS:
    _function = _schema['function']
    if _function['name'] in {'workspace_write_file', 'workspace_edit_file'}:
        _function['parameters']['properties']['expected_revision'] = {'type': 'string', 'description': 'File revision returned by workspace_read_file. Required for overwriting an existing isolated source file.'}
    if _function['name'] == 'workspace_list_files':
        _function['parameters']['properties']['offset'] = {'type': 'integer', 'minimum': 0}


def get_db_connection():
    """Returns an authenticated psycopg2 connection using environment credentials."""
    import psycopg2
    db_user = os.getenv("DB_USER", "")
    db_pass = os.getenv("DB_PASSWORD", "")
    db_host = os.getenv("DB_HOST", "postgres")
    db_port = os.getenv("DB_PORT", "5432")
    db_name = os.getenv("DB_NAME", "")
    if not all((db_user,db_pass,db_name)):raise RuntimeError('AI database configuration is incomplete')
    return psycopg2.connect(
        host=db_host,
        port=db_port,
        user=db_user,
        password=db_pass,
        dbname=db_name,
        connect_timeout=5
    )


def resolve_target_project_runtime_url(
    project_id: Optional[str] = None,
    deployment_id: Optional[str] = None,
    user_message: str = "",
    custom_url: Optional[str] = None,
    session_id: Optional[str] = None,
    user_id: Optional[str] = None,
) -> str:
    """
    Finds the active, live project runtime URL for browser testing.
    Explicit user URLs take priority, including local applications. Implicit deployment discovery avoids the platform frontend.
    """
    # 0. Explicit custom_url takes absolute priority
    if custom_url and custom_url.strip():
        u = custom_url.strip()
        if u != "about:blank":
            if not u.startswith("http://") and not u.startswith("https://"):
                u = f"https://{u}"
            return u

    # 1. Regex check for explicit URL in user_message (e.g. "test https://example.com", "http://localhost:52249")
    if user_message:
        url_match = re.search(r"https?://[^\s<>\"']+", user_message)
        if url_match:
            found_url = url_match.group(0).rstrip(".,;)")
            return found_url

        # Universal domain name detection for web queries (e.g. "on example.com", "open amazon.in", "test myapp.vercel.app")
        domain_match = re.search(r"\b([a-zA-Z0-9-]+\.(?:com|org|in|io|co|net|dev|ai|app|gov|edu|me)(?:/[^\s]*)?)\b", user_message)
        if domain_match:
            d = domain_match.group(1).rstrip(".,;)")
            if not d.startswith("localhost") and not d.startswith("127.0.0.1"):
                return f"https://{d}"

    # 2. Check active browser canvas session in browser_manager
    try:
        from .browser_driver import browser_manager
        active = browser_manager.sessions.get(session_id) if session_id else None
        if active and active.current_url:
            cur_u = active.current_url.strip()
            if cur_u and cur_u not in {"about:blank", "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3000/", "http://127.0.0.1:3000/"}:
                return cur_u
    except Exception:
        pass

    try:
        conn = get_db_connection()
        cur = conn.cursor()

        if not user_id and session_id:
            cur.execute("SELECT user_id::text FROM ai_sessions WHERE id::text=%s",(session_id,))
            owner=cur.fetchone();user_id=owner[0] if owner else None
        if not user_id:
            conn.close();return "about:blank"

        # 2. By explicit deployment_id
        if deployment_id:
            cur.execute("SELECT runtime_url FROM deployments WHERE id = %s AND has_project_access(project_id,%s,'viewer')", (deployment_id,user_id))
            r = cur.fetchone()
            if r and r[0] and "localhost:3000" not in str(r[0]):
                conn.close()
                return str(r[0])

        # 3. By explicit project_id
        if project_id:
            cur.execute(
                "SELECT runtime_url FROM deployments WHERE project_id = %s AND has_project_access(project_id,%s,'viewer') AND status = 'running' "
                "AND runtime_url IS NOT NULL AND runtime_url != '' AND runtime_url NOT LIKE '%localhost:3000%' "
                "ORDER BY created_at DESC LIMIT 1",
                (project_id,user_id)
            )
            r = cur.fetchone()
            if r and r[0]:
                conn.close()
                return str(r[0])
            cur.execute(
                "SELECT runtime_url FROM deployments WHERE project_id = %s AND has_project_access(project_id,%s,'viewer') "
                "AND runtime_url IS NOT NULL AND runtime_url != '' AND runtime_url NOT LIKE '%localhost:3000%' "
                "ORDER BY created_at DESC LIMIT 1",
                (project_id,user_id)
            )
            r = cur.fetchone()
            if r and r[0]:
                conn.close()
                return str(r[0])

        # 4. By project name matching in user_message (e.g. "portfolio", "app", etc.)
        if user_message:
            msg_lower = user_message.lower()
            cur.execute("SELECT id, name FROM projects WHERE has_project_access(id,%s,'viewer')",(user_id,))
            projects = cur.fetchall()
            for p_id, p_name in projects:
                if p_name and p_name.lower() in msg_lower:
                    cur.execute(
                        "SELECT runtime_url FROM deployments WHERE project_id = %s AND has_project_access(project_id,%s,'viewer') AND status = 'running' "
                        "AND runtime_url IS NOT NULL AND runtime_url != '' AND runtime_url NOT LIKE '%localhost:3000%' "
                        "ORDER BY created_at DESC LIMIT 1",
                        (p_id,user_id)
                    )
                    r = cur.fetchone()
                    if r and r[0]:
                        conn.close()
                        return str(r[0])

        # 5. Latest running project deployment with valid runtime URL (excluding localhost:3000)
        cur.execute(
            "SELECT runtime_url FROM deployments WHERE status = 'running' AND has_project_access(project_id,%s,'viewer') "
            "AND runtime_url IS NOT NULL AND runtime_url != '' AND runtime_url NOT LIKE '%localhost:3000%' "
            "ORDER BY created_at DESC LIMIT 1",(user_id,)
        )
        r = cur.fetchone()
        if r and r[0]:
            conn.close()
            return str(r[0])

        # 6. Any project deployment with valid runtime URL
        cur.execute(
            "SELECT runtime_url FROM deployments WHERE has_project_access(project_id,%s,'viewer') AND runtime_url IS NOT NULL "
            "AND runtime_url != '' AND runtime_url NOT LIKE '%localhost:3000%' "
            "ORDER BY created_at DESC LIMIT 1",(user_id,)
        )
        r = cur.fetchone()
        if r and r[0]:
            conn.close()
            return str(r[0])

        conn.close()
    except Exception:
        pass

    return "about:blank"


async def execute_tool_call(tool_name: str, arguments: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    if tool_name.startswith('_internal_'):
        return {'error':'Internal service operations are not agent tools'}
    from .agent_runtime.context import actor_context
    from .agent_runtime.tools import TEAM_NAMES
    actor = actor_context.get()
    if actor is not None:
        if actor.user_id != user_id:
            return {'status': 'denied', 'error': 'Agent actor ownership mismatch'}
        try:
            return await actor.runtime.handle(actor, tool_name, arguments)
        except (ValueError, RuntimeError, PermissionError, KeyError) as exc:
            return {'status': 'failed', 'error': str(exc), 'verified': False}
    if tool_name in TEAM_NAMES:
        return {'status': 'blocked', 'error': 'Real teammates require an authorized project agent run; select a project with source first', 'verified': False}
    return await _execute_legacy_tool(tool_name, arguments, user_id)


async def _execute_legacy_tool(tool_name: str, arguments: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    if not tool_name.startswith('browser_'):
        return await _execute_tool_call(tool_name, arguments, user_id)
    from .browser_driver import browser_manager
    from .tool_progress import leased_session
    from .browser_testing.campaigns import campaign_scope, active_campaign_session
    session_id = str(arguments.get('session_id') or 'default')
    scope=campaign_scope.get()
    active=active_campaign_session(session_id)
    if active and (not scope or scope[1]!=active) and tool_name not in {'browser_campaign_status','browser_campaign_control','browser_start_campaign','browser_observe','browser_inspect_console','browser_read_editor'}:
        return {'status':'failed','error':'A background campaign owns this browser. Pause it before sending another action.'}
    async def execute():
        active_session = browser_manager.sessions.get(session_id)
        before_inputs = getattr(active_session, 'dispatched_inputs', 0)
        if active_session and tool_name == 'browser_interact':
            active_session._pending_consequential_dispatch = None
        result = None
        dispatched = False
        try:
            if scope:
                result=await scope[0].record_tool(tool_name,arguments,lambda:_execute_tool_call(tool_name,arguments,user_id))
            else:
                result=await _execute_tool_call(tool_name,arguments,user_id)
        finally:
            # Cancellation or transport failure after input is an uncertain
            # outcome, never permission to replay the same consequential step.
            session=browser_manager.sessions.get(session_id)
            pending = getattr(session, '_pending_consequential_dispatch', None)
            dispatched = tool_name == 'browser_interact' and pending and getattr(session, 'dispatched_inputs', 0) > before_inputs
            if dispatched:
                recorded = getattr(session, 'completed_consequential_inputs', None)
                if recorded is None:
                    recorded = session.completed_consequential_inputs = {}
                if len(recorded) >= 256:
                    recorded.pop(next(iter(recorded)))
                recorded[pending] = True
        if dispatched:
            result['consequential_dispatch'] = 'dispatched_once'
            result['hint'] = result.get('hint','') + ' Verify observed confirmation or rejection. Do not repeat this operation after a failed check.'
        tracker=getattr(session,'operation_recovery',None)
        if tracker and tool_name=='browser_interact': tracker.record(session,arguments,result)
        return result
    if leased_session.get() == session_id:
        return await execute()
    lock = browser_manager.operation_locks.setdefault(session_id, asyncio.Lock())
    async with lock:
        browser_manager.busy_sessions.add(session_id)
        token = leased_session.set(session_id)
        try:
            session = browser_manager.sessions.get(session_id)
            if session:
                session.last_used = time.monotonic()
            return await execute()
        finally:
            session = browser_manager.sessions.get(session_id)
            if session:
                session.last_used = time.monotonic()
            leased_session.reset(token)
            browser_manager.busy_sessions.discard(session_id)


async def _execute_tool_call(tool_name: str, arguments: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Execute a tool by calling SearXNG/web or the C++ backend."""
    if tool_name in {'browser_start_campaign','browser_campaign_status','browser_campaign_control'}:
        from .browser_testing.campaigns import get_campaign_runtime
        from .browser_driver import browser_manager
        runtime=get_campaign_runtime();sid=str(arguments.get('session_id') or 'default')
        try:
            if tool_name=='browser_start_campaign':
                session=browser_manager.sessions.get(sid)
                request=getattr(session,'campaign_request',None)
                if not request or request.user_id!=user_id:
                    return {'status':'failed','error':'Start the campaign from an authorized browser chat with a website target.'}
                return await runtime.start(request,{k:v for k,v in arguments.items() if k.startswith('max_')})
            if tool_name=='browser_campaign_control':
                return await runtime.control(arguments.get('campaign_id',''),user_id,arguments.get('action'),sid)
            return await asyncio.to_thread(runtime.store.status,arguments.get('campaign_id',''),user_id,sid)
        except (ValueError,PermissionError) as exc: return {'status':'failed','error':str(exc)}
    if tool_name in {"list_functions", "list_tools", "get_tools"}:
        return {"tools": [t["function"]["name"] for t in AGENT_TOOLS]}

    if tool_name == "web_search":
        query = str(arguments.get("query", ""))
        num_results = int(arguments.get("num_results", 5))
        return await execute_web_search(query, num_results)

    if tool_name == "web_fetch":
        url = str(arguments.get("url", ""))
        return await execute_web_fetch(url)

    if tool_name == "browser_open_live_session":
        url = str(arguments.get("url", "about:blank")).strip()
        if url and not url.startswith(("http://", "https://", "about:", "data:", "chrome:")):
            url = f"https://{url}"
        session_id = str(arguments.get("session_id") or "default")
        # Resolve only a missing target; explicit local and remote URLs are authoritative.
        if not url or url == "about:blank":
            from .browser_driver import browser_manager
            resolved_url = resolve_target_project_runtime_url(
                project_id=arguments.get("project_id"),
                deployment_id=arguments.get("deployment_id"),
                custom_url=arguments.get("custom_url"),
                session_id=session_id,
                user_id=user_id,
            )
            if resolved_url and resolved_url != "about:blank":
                url = resolved_url
            else:
                existing = browser_manager.sessions.get(session_id)
                if existing and existing.current_url and existing.current_url not in {"about:blank", "http://localhost:3000", "http://localhost:3000/"}:
                    url = existing.current_url

        try:
            from .browser_driver import browser_manager
            _existing = browser_manager.sessions.get(session_id)
            already_open = bool(_existing and _existing.is_connected)
            session = await browser_manager.get_or_create_session(session_id=session_id, url=url)
            page_state = await session.extract_interactive_tree()
            try:
                frame_data = await session.capture_screenshot(quality=65, use_cache=False) or session.latest_frame or ""
            except Exception:
                frame_data = session.latest_frame or ""
            frame_url = f"data:image/jpeg;base64,{frame_data}" if frame_data else ""
            som_url = frame_url
            nav_buttons = []
            for el in page_state.get("elements", []):
                norm = normalize_element_text(el.get("text") or el.get("aria_label") or "")
                href = (el.get("href") or "").strip()
                if norm and len(norm) > 1 and (href not in {"/", "#", ""} or el.get("tag") in {"button", "input"} or el.get("role") in {"button", "tab"}) and not norm.lower().startswith("skip"):
                    nav_buttons.append(f"'{norm}' (id: {el['id']})")

            if already_open:
                hint_text = (
                    f"Live browser session is connected at '{session.current_url}' (Title: '{page_state.get('title', '')}'). "
                    f"Available elements to interact with: {', '.join(nav_buttons[:6])}. "
                    f"Use the DOM element IDs listed in interactive_elements; the screenshot has no numbered overlays. "
                    f"Call browser_interact(action='click', element_id=...) or browser_interact(action='type', ...) now."
                )
            else:
                hint_text = "Live browser session connected and streaming. "
                if nav_buttons:
                    hint_text += f"Interactive elements ready for testing: {', '.join(nav_buttons[:6])}. Use the listed DOM IDs or current screenshot coordinates. Call browser_interact(action='click', element_id=...) to test elements now."
                else:
                    hint_text += "Use browser_interact to click elements or type, or browser_inspect_console to check for frontend errors."

            arch_val = getattr(session, "current_archetype", "unknown")
            arch_str = arch_val.value if hasattr(arch_val, "value") else str(arch_val)
            pda_depth_val = getattr(session.pda, "depth", 1) if hasattr(session, "pda") else 1
            skg_summary_val = session.skg.get_summary() if hasattr(session, "skg") else {}
            from .browser_testing.widgets import observe_widgets
            return {
                "status": "already_connected" if already_open else "connected",
                "session_id": session_id,
                "storage_isolation": "browser_context" if getattr(session,'browser_context_id',None) else "legacy_shared_context",
                "url": session.current_url,
                "title": page_state.get("title", ""),
                "archetype": arch_str,
                "pda_depth": pda_depth_val,
                "site_graph_summary": skg_summary_val,
                "interactive_elements_count": len(page_state.get("elements", [])),
                "interactive_elements": _compact_interactive_elements(page_state.get("elements", [])),
                "widget_state": await observe_widgets(session),
                "subpages": page_state.get("subpages", []),
                "console_errors_count": len([l for l in session.console_logs if l.get("type") == "error"]),
                "frame": frame_url,
                "som_frame": som_url,
                "hint": hint_text,
            }
        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            print(f"[Tools] Failed to open browser session: {e}\n{tb}", flush=True)
            return {"error": f"Failed to open browser session: {type(e).__name__}: {str(e)}", "traceback": tb}

    if tool_name == 'browser_audit_site':
        from .browser_driver import browser_manager
        from .browser_testing.site_audit import SiteAuditor
        session = browser_manager.sessions.get(str(arguments.get('session_id') or 'default'))
        if not session or not session.is_connected:
            return {'status':'failed','action':'site_audit','error':'Open the requested browser session before auditing.'}
        if getattr(session,'last_site_audit',None):
            return {**session.last_site_audit,'cached':True,'hint':'Already audited in this run. Use explicit scenarios for remaining controls instead of restarting the audit.'}
        for key,default,low,high in [('max_pages',25,1,100),('max_actions',120,1,1000),('max_seconds',120,5,180)]:
            value = arguments.get(key,default)
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not low<=value<=high or (key!='max_seconds' and type(value) is not int):
                return {'status':'failed','action':'site_audit','error':'Invalid bounded audit budget; no input executed.'}
        ids = arguments.get('ui_control_ids',[])
        if not isinstance(ids,list) or len(ids)>32 or any(type(i) is not int or i<0 for i in ids) or type(arguments.get('include_hover',True)) is not bool:
            return {'status':'failed','action':'site_audit','error':'Invalid UI controls/hover contract; no input executed.'}
        auditor = SiteAuditor(session,execute_tool_call,user_id,
            arguments.get('max_pages',25),arguments.get('max_actions',120),arguments.get('max_seconds',120),arguments.get('include_hover',True),
            include_frame=arguments.get('include_frame',True) is not False,
            autonomous=(arguments.get('autonomous',False) is True
                        and getattr(session,'agent_access_mode',None) == 'full_access'
                        and getattr(session,'allow_agent_questions',True) is False))
        return await auditor.run(ids)

    if tool_name == 'browser_read_editor':
        from .browser_driver import browser_manager
        from .browser_testing.editors import read_editor
        session=browser_manager.sessions.get(str(arguments.get('session_id') or 'default'))
        ref=arguments.get('element_id')
        if not session or not session.is_connected or type(ref) is not int or not any(e.get('id')==ref for e in session.interactive_elements):
            return {'status':'failed','error':'Select one current observed editor element_id.'}
        if any(e.get('id')==ref and e.get('type')=='password' for e in session.interactive_elements):
            return {'status':'failed','error':'Password documents are not exposed.'}
        document=await read_editor(session,ref)
        if not document or document.get('value') is None:
            return {'status':'failed','error':'The target does not expose an editor document. Observe the source editor, not the output pane.'}
        tracker=getattr(session,'operation_recovery',None)
        if tracker: tracker.editor_readback(session,ref)
        return {'status':'observed','editor_kind':document['kind'],'readonly':document['readonly'],
                'text':document['value'][:32000],'truncated':len(document['value'])>32000}

    if tool_name == "browser_observe":
        from .browser_driver import browser_manager
        offset = arguments.get("offset", 0)
        if type(offset) is not int or offset < 0:
            return {"status": "failed", "action": "observe", "error": "offset must be a nonnegative integer."}
        query = arguments.get('query')
        scope = arguments.get('scope', 'page')
        if query is not None and (not isinstance(query, str) or not query.strip() or len(query) > 120):
            return {'status':'failed','action':'observe','error':'query must be a nonempty string of at most 120 characters.'}
        if scope not in ('page', 'viewport', 'overlay'):
            return {'status':'failed','action':'observe','error':'scope must be page, viewport or overlay.'}
        session = browser_manager.sessions.get(str(arguments.get("session_id") or "default"))
        if not session or not session.is_connected:
            return {"status": "unverified", "action": "observe", "reason": "No connected browser session."}
        if getattr(session,'native_dialog',None):
            return {'status':'observed','action':'observe','widget_state':{'native_dialog':session.native_dialog},
                    'interactive_elements':[],'total_controls':0,'has_more':False,'visual_captured':False}
        try:
            observation = await session.extract_interactive_tree()
            if isinstance(observation, dict) and observation.get('fresh') is False:
                return {'status':'unverified','action':'observe',
                        'reason':'A fresh page observation was unavailable. Cached controls are not current evidence.',
                        'interactive_elements':[], 'visual_captured':False}
            frame = await session.capture_screenshot(quality=60, use_cache=False) if arguments.get('include_frame',True) else None
            from .browser_testing.widgets import observe_widgets
            widgets=await observe_widgets(session)
            matches = session.interactive_elements or []
            if scope == 'viewport':
                matches = [e for e in matches if e.get('is_in_viewport')]
            elif scope == 'overlay':
                matches = [e for e in matches if e.get('is_inside_modal')]
            if query is not None:
                search = query.strip().casefold()
                fields = ('text', 'aria_label', 'name', 'placeholder', 'role', 'type', 'form_id', 'card_context')
                matches = [e for e in matches if any(search in str(e.get(key) or '').casefold() for key in fields)]
            controls = _compact_interactive_elements(matches, offset=offset)
            total = len(matches)
            has_more = offset + len(controls) < total
            return {"status": "observed", "action": "observe", "url": session.current_url,
                    "title": session.page_title, "interactive_elements": controls, "widget_state":widgets,
                    "downloads": list(getattr(session, 'download_events', {}).values())[-5:],
                    "total_controls": total, "page_total_controls": len(session.interactive_elements or []),
                    "query":query, "scope":scope, "offset": offset, "has_more": has_more,
                    "next_offset": offset + len(controls) if has_more else None,
                    "visual_captured": bool(frame), "frame": f"data:image/jpeg;base64,{frame}" if frame else ""}
        except Exception:
            return {"status": "unverified", "action": "observe", "reason": "Current page observation unavailable."}

    if tool_name == "browser_assert":
        from .browser_driver import browser_manager
        from .browser_testing.assertions import assert_browser_state
        session = browser_manager.sessions.get(str(arguments.get("session_id") or "default"))
        if not session or not session.is_connected:
            return {"status": "unverified", "action": "assert", "reason": "No connected browser session to assert against."}
        expectations = arguments.get("expectations")
        purpose = arguments.get("purpose")
        if purpose is None and isinstance(expectations, list):
            nested = {item.get("purpose") for item in expectations if isinstance(item, dict) and item.get("purpose")}
            if len(nested) == 1:
                purpose = nested.pop()
        return await assert_browser_state(session, expectations, arguments.get("timeout_seconds", 5), purpose or "checkpoint")

    if tool_name == "browser_interact":
        session_id = str(arguments.get("session_id") or "default")
        action = str(arguments.get("action", "")).lower()
        try:
            from .browser_driver import browser_manager
            if session_id not in browser_manager.sessions or not browser_manager.sessions[session_id].is_connected:
                url = str(arguments.get("url") or "about:blank")
                session = await browser_manager.get_or_create_session(session_id=session_id, url=url)
            else:
                session = browser_manager.sessions[session_id]

            if getattr(session,'native_dialog',None) and action!='handle_dialog':
                return {'status':'failed','action':action,'error':'Resolve the observed native dialog before page input.',
                        'widget_state':{'native_dialog':session.native_dialog}}
            if not session.interactive_elements and action!='handle_dialog':
                try:
                    await session.extract_interactive_tree()
                except Exception:
                    pass
            from .browser_testing.outcomes import outcome_guard_for
            guard = outcome_guard_for(session)
            if guard:
                guard.observe(session.interactive_elements, session.current_url, session.page_title)
            session.last_target_resolution_ms = 0
            ref = arguments.get('element_id')
            targeted_actions = {'click','hover','double_click','right_click','type','scroll_to','select_option','toggle_checkbox','set_checked','choose_option','choose_date','press_key'}
            if action in targeted_actions and type(ref) is int:
                from .browser_testing.targets import resolve_target_reference
                resolve_started = time.monotonic()
                resolution = await resolve_target_reference(session, ref)
                session.last_target_resolution_ms = round((time.monotonic()-resolve_started)*1000,1)
                if resolution['status'] != 'ready':
                    from .browser_testing.widgets import observe_widgets
                    try:
                        observation = await session.extract_interactive_tree()
                        if isinstance(observation, dict) and observation.get('fresh') is False:
                            raise RuntimeError('Fresh observation unavailable')
                        widgets = await observe_widgets(session)
                        controls = _compact_interactive_elements(session.interactive_elements)
                    except Exception:
                        widgets, controls = {'status':'unverified'}, []
                    prior = getattr(session, 'overlay_target_history', {}).get(ref)
                    overlay = widgets.get('active_overlay')
                    dismissed = bool(prior and 'active_overlay' in widgets and
                                     (not overlay or overlay.get('id') != prior.get('overlay_id')))
                    return {**resolution, 'action':action,
                            'target':(prior or {}).get('target', {}).get('text') or
                                     getattr(session,'observed_targets',{}).get(ref,(None,{}))[1].get('text'),
                            'widget_state':widgets,
                            'interactive_elements':controls,
                            'recovery':{'reason':'dismissed_overlay' if dismissed else 'stale_target',
                                **({'previous_overlay':prior} if prior else {}),
                                'hint':('The target belonged to a dismissed or replaced workflow. Restore that workflow '
                                        'through a current observed launcher before filling its field.' if dismissed else
                                        'Use only these current control references. Search a specific workflow with '
                                        'browser_observe query and scope=viewport or overlay; do not reuse historical IDs.')},
                            'timing':{'target_resolve_ms':session.last_target_resolution_ms}}
                if resolution['element_id'] != ref:
                    arguments = {**arguments, 'element_id':resolution['element_id']}
                    ref = resolution['element_id']
            elif action in targeted_actions and ref is not None and not any(str(e.get('id')) == str(ref) for e in session.interactive_elements):
                return {'status':'stale_element','action':action,'error':'Observed element reference is no longer current. Observe and select the current target; no input was dispatched.'}
            if action in targeted_actions and ref is None:
                fields = ('name','placeholder','input_id') if action == 'type' else ('text','href','aria_label')
                query = str(arguments.get('field') or arguments.get('target') or (arguments.get('text') if action != 'type' else '') or '').strip().casefold()
                if query:
                    candidates = [e for e in session.interactive_elements if any(query in str(e.get(k) or '').strip().casefold() for k in fields)]
                    exact = [e for e in candidates if any(query == str(e.get(k) or '').strip().casefold() for k in fields)]
                    candidates = exact or candidates
                    if len(candidates) > 1:
                        return {'status':'failed','action':action,'error':'Target label matches multiple controls. Use the intended observed element_id; no input was dispatched.',
                                'candidates':_compact_interactive_elements(candidates)}
                    if candidates:
                        arguments = {**arguments,'element_id':candidates[0]['id']}
                        ref = candidates[0]['id']
            tracker=getattr(session,'operation_recovery',None)
            if tracker:
                blocked=tracker.blocked(session,arguments)
                if blocked: return blocked
            pointer_target = None
            from .browser_testing.widgets import focus_target, choose_option, choose_date, observe_widgets
            if action == 'press_key' and ref is not None:
                # Approval and dispatch must describe the same focused control.
                await focus_target(session,ref)
            # Enforce approval below the planner, including nested batches,
            # coordinate clicks and Enter. Chat text/authorize-all cannot grant it.
            from .browser_testing.permissions import observe_step, permission_reason, authorized
            control = await observe_step(session, arguments)
            from .browser_testing.campaigns import campaign_scope
            scope=campaign_scope.get()
            if scope and control and action in {'click','double_click','press_key'}:
                from .browser_testing.site_audit import canonical_url
                campaign_job=await asyncio.to_thread(scope[0].store.job,scope[1],user_id)
                root=campaign_job['payload']['custom_url']
                destinations=[control.get('href')]
                if (action=='press_key' and str(arguments.get('key','')).lower()=='enter') or control.get('type')=='submit':
                    destinations.append(control.get('form_action'))
                if any(value and (not canonical_url(value,session.current_url) or not canonical_url(value,root)) for value in destinations):
                    return {'status':'blocked','action':action,'error':'This control leaves the authorized campaign origin; no input dispatched.'}
            if control and control.get('disabled') and action in {'click','double_click','right_click','press_key'} and ref is not None:
                from .browser_testing.actionability import prepare_pointer_target
                recovery = await prepare_pointer_target(session,int(ref))
                if recovery.get('disabled'):
                    return {'status':'failed','action':action,'error':'Target is disabled; no input was dispatched.',
                            'recovery':recovery,'hint':'Resolve the observed prerequisites and observe again. Never force-enable this control.'}
            if (control and control.get('form') and control.get('native_validity') is False
                    and control.get('type') in {'submit','image'}
                    and not re.search(r'\b(?:negative|invalid|validation|rejection)\b',
                                      (getattr(session,'task_context',None) or {}).get('goal',''), re.I)):
                from .browser_testing.actionability import inspect_actionability
                recovery = await inspect_actionability(session,int(ref)) if ref is not None else {}
                return {'status':'failed','action':action,
                        'error':'The observed form has invalid required fields. No input was dispatched.',
                        'recovery':recovery,
                        'hint':'Fill each required field from the task facts. Ask for a missing real-world fact when questions are enabled; in autonomous mode record the prerequisite and continue independent tests.'}
            from .browser_testing.permissions import reconciliation_reason
            from .browser_testing.submissions import preflight_submission
            blocked_submission, submission_key = preflight_submission(session, arguments, control)
            if blocked_submission:
                return blocked_submission
            recovering=getattr(session,'campaign_recovery',False)
            reason = (reconciliation_reason(arguments,control) if recovering else '') or permission_reason(arguments, control, getattr(session, 'audit_read_only', False))
            # Full access is an explicit user setting. Keep stale-target and
            # action identity checks, but do not emit a second permission gate
            # for a step the user has already authorized at the agent level.
            access_granted = getattr(session, 'agent_access_mode', None) == 'full_access' and not recovering
            if reason and not authorized(arguments, control) and not access_granted:
                return {'status':'requires_approval','action':action,
                        'error':reason+' No input was dispatched.', 'approval_required':True,
                        'target':(control or {}).get('label','Current control')}
            if reason and hasattr(session,'consequential_dispatches'):
                from .browser_testing.permissions import fingerprint
                key=(getattr(session,'target_id',''),getattr(session,'_selected_frame',None),action,fingerprint(control))
                prior=session.consequential_dispatches.get(key)
                if prior is not None and session.dispatched_inputs>prior and not authorized(arguments,control):
                    return {'status':'blocked','action':action,
                            'error':'This consequential step was already dispatched on the same observed state. Verify its result before any retry; no input was dispatched.',
                            'verification':{'verified':False,'effect_type':'replay_prevented'}}
                if len(session.consequential_dispatches)>=256:session.consequential_dispatches.pop(next(iter(session.consequential_dispatches)))
                session.consequential_dispatches[key]=session.dispatched_inputs
            if action in {'click','double_click','right_click'} and control is None:
                return {'status':'stale_element','action':action,'error':'No unique current target could be observed. Use an observed element_id or explicit x/y coordinates; no input was dispatched.',
                        'interactive_elements':_compact_interactive_elements(session.interactive_elements)}
            if getattr(session,'audit_read_only',False) and action == 'press_key' and control is None:
                return {'status':'blocked','action':action,'error':'Current target semantics could not be observed. No input dispatched; observe the page before selecting this action.'}
            session._pending_consequential_dispatch = submission_key
            if action in {'hover','double_click','right_click'} and ref is not None:
                from .browser_testing.actionability import inspect_actionability
                await session.scroll_to_element(int(ref))
                pointer_target = await inspect_actionability(session,int(ref))
                if (not pointer_target.get('is_in_viewport') or pointer_target.get('is_occluded')
                    or (action != 'hover' and pointer_target.get('disabled'))):
                    return {'status':'failed','action':action,'error':'Target is not currently actionable; no input was dispatched.','recovery':pointer_target}

            if action in {'choose_option','choose_date','handle_dialog','switch_tab','switch_frame'}:
                if action=='choose_option': result=await choose_option(session,arguments)
                elif action=='choose_date':
                    async def widget_dispatch(step):
                        await session.extract_interactive_tree()
                        return await execute_tool_call('browser_interact',{**step,'session_id':session_id,'include_frame':False},user_id)
                    result=await choose_date(session,arguments,widget_dispatch)
                elif action=='handle_dialog': result=await session.handle_native_dialog(arguments)
                elif action=='switch_frame': result=await session.switch_frame(arguments.get('frame_id'))
                else: result=await session.switch_tab(arguments.get('target_id'))
                if not getattr(session,'native_dialog',None):await session.extract_interactive_tree()
                return {**result,'action':action,'widget_state':await observe_widgets(session),
                        'interactive_elements':_compact_interactive_elements(session.interactive_elements)}
            label = ""
            target_name = ""
            hover_portals = []
            session.last_action_verification = None
            if action in {'navigate_back', 'navigate_forward', 'return_to_parent'}:
                result = await getattr(session, action)()
                return {**result, 'interactive_elements': _compact_interactive_elements(session.interactive_elements),
                        'widget_state': await observe_widgets(session),
                        'hint': 'Navigation invalidates prior controls. Use these fresh references; a history boundary needs a different recovery action.'}
            pre_snapshot = await ActionPerceptionVerification.capture_snapshot(session) if action not in {"click", "set_checked"} else None
            pre_action_url = (session.current_url or "").rstrip("/")
            x = arguments.get("x")
            y = arguments.get("y")

            if action == "click":
                element_id = arguments.get("element_id")
                target_text = str(arguments.get("text") or arguments.get("target") or "").strip().lower()
                el = None
                if element_id is not None:
                    el = next((e for e in session.interactive_elements if str(e.get("id")) == str(element_id)), None)
                if not el and target_text:
                    el = next((e for e in session.interactive_elements if target_text in normalize_element_text(e.get("text", "")).lower() or target_text in (e.get("href", "")).lower()), None)

                if element_id is not None or target_text:
                    if el:
                        if el.get("is_external") or (el.get("href") and not session.is_url_in_target_domain(el.get("href"))):
                            return {
                                "status": "blocked",
                                "action": "click",
                                "target": el.get("text", "") or el.get("href", ""),
                                "error": f"Target element #{el.get('id')} links to external website '{el.get('href', '')}'. External navigation is blocked; testing is strictly restricted to the target application domain.",
                            }
                        norm_text = normalize_element_text(el.get("text") or el.get("aria_label") or el.get("placeholder") or "")
                        target_name = norm_text if norm_text else f"Element #{el['id']}"
                        label = f"Click: {target_name}"
                        if not await session.click_element(el["id"], label=label):
                            await session.extract_interactive_tree()
                            return {"status": "failed", "action": action, "target": target_name,
                                    "error": "Click target could not be dispatched.",
                                    "recovery": getattr(session, "last_actionability", {}),
                                    "interactive_elements": _compact_interactive_elements(session.interactive_elements),
                                    "widget_state": await observe_widgets(session),
                                    "hint": "Read recovery.reason, blocker and invalid_fields. Resolve that observed state and retry; no input was dispatched. Never force-enable or remove a dialog.",
                                    "verification": session.last_action_verification}
                    else:
                        missing_info = f"id={element_id}" if element_id is not None else f"text='{target_text}'"
                        return {
                            "status": "stale_element",
                            "error": f"Element ({missing_info}) not found in active DOM. It may be occluded by an open modal or unmounted.",
                            "interactive_elements_count": len(session.interactive_elements or []),
                        }
                elif x is not None and y is not None:
                    pre_snapshot = await ActionPerceptionVerification.capture_snapshot(session)
                    target_name = f"({x}, {y})"
                    label = f"Click: ({x}, {y})"
                    await session.click(int(x), int(y), label=label)
                else:
                    return {"error": "Must provide element_id, text target, or both x and y coordinates to click."}

            elif action == "hover":
                element_id = arguments.get("element_id")
                target_text = str(arguments.get("text") or arguments.get("target") or "").strip().lower()
                el = None
                if element_id is not None:
                    el = next((e for e in session.interactive_elements if str(e.get("id")) == str(element_id)), None)
                if not el and target_text:
                    el = next((e for e in session.interactive_elements if target_text in normalize_element_text(e.get("text", "")).lower() or target_text in (e.get("href", "")).lower()), None)
                
                hover_x = None
                hover_y = None
                if element_id is not None or target_text:
                    if el:
                        norm_text = normalize_element_text(el.get("text") or el.get("aria_label") or el.get("placeholder") or "")
                        target_name = norm_text if norm_text else f"Element #{el['id']}"
                        label = f"Hover: {target_name}"
                        hover_x = pointer_target['x']
                        hover_y = pointer_target['y']
                    else:
                        missing_info = f"id={element_id}" if element_id is not None else f"text='{target_text}'"
                        return {
                            "status": "stale_element",
                            "error": f"Element ({missing_info}) not found in active DOM for hover.",
                            "interactive_elements_count": len(session.interactive_elements or []),
                        }
                elif x is not None and y is not None:
                    target_name = f"({x}, {y})"
                    label = f"Hover: ({x}, {y})"
                    hover_x = int(x)
                    hover_y = int(y)
                else:
                    return {"error": "Must provide element_id, text target, or coordinates (x, y) to hover."}

                duration = float(arguments.get("duration") or 0.2)
                hover_res = await session.hover(hover_x, hover_y, duration=duration, label=label)
                hover_portals = hover_res.get("portals", [])

            elif action == "double_click":
                element_id = arguments.get("element_id")
                target_text = str(arguments.get("text") or arguments.get("target") or "").strip().lower()
                el = None
                if element_id is not None:
                    el = next((e for e in session.interactive_elements if str(e.get("id")) == str(element_id)), None)
                if not el and target_text:
                    el = next((e for e in session.interactive_elements if target_text in normalize_element_text(e.get("text", "")).lower() or target_text in (e.get("href", "")).lower()), None)
                
                dc_x = None
                dc_y = None
                if element_id is not None or target_text:
                    if el:
                        norm_text = normalize_element_text(el.get("text") or el.get("aria_label") or el.get("placeholder") or "")
                        target_name = norm_text if norm_text else f"Element #{el['id']}"
                        label = f"Double-click: {target_name}"
                        dc_x = pointer_target['x']
                        dc_y = pointer_target['y']
                    else:
                        missing_info = f"id={element_id}" if element_id is not None else f"text='{target_text}'"
                        return {"status": "stale_element", "error": f"Element ({missing_info}) not found in active DOM for double-click."}
                elif x is not None and y is not None:
                    target_name = f"({x}, {y})"
                    label = f"Double-click: ({x}, {y})"
                    dc_x = int(x)
                    dc_y = int(y)
                else:
                    return {"error": "Must provide element_id, text target, or coordinates (x, y) to double-click."}

                await session.double_click(dc_x, dc_y, label=label)

            elif action == "right_click":
                element_id = arguments.get("element_id")
                target_text = str(arguments.get("text") or arguments.get("target") or "").strip().lower()
                el = None
                if element_id is not None:
                    el = next((e for e in session.interactive_elements if str(e.get("id")) == str(element_id)), None)
                if not el and target_text:
                    el = next((e for e in session.interactive_elements if target_text in normalize_element_text(e.get("text", "")).lower() or target_text in (e.get("href", "")).lower()), None)
                
                rc_x = None
                rc_y = None
                if element_id is not None or target_text:
                    if el:
                        norm_text = normalize_element_text(el.get("text") or el.get("aria_label") or el.get("placeholder") or "")
                        target_name = norm_text if norm_text else f"Element #{el['id']}"
                        label = f"Right-click: {target_name}"
                        rc_x = pointer_target['x']
                        rc_y = pointer_target['y']
                    else:
                        missing_info = f"id={element_id}" if element_id is not None else f"text='{target_text}'"
                        return {"status": "stale_element", "error": f"Element ({missing_info}) not found in active DOM for right-click."}
                elif x is not None and y is not None:
                    target_name = f"({x}, {y})"
                    label = f"Right-click: ({x}, {y})"
                    rc_x = int(x)
                    rc_y = int(y)
                else:
                    return {"error": "Must provide element_id, text target, or coordinates (x, y) to right-click."}

                await session.right_click(rc_x, rc_y, label=label)

            elif action == "drag_and_drop":
                start_x = int(arguments.get("start_x") or arguments.get("x") or 0)
                start_y = int(arguments.get("start_y") or arguments.get("y") or 0)
                end_x = int(arguments.get("end_x") or 0)
                end_y = int(arguments.get("end_y") or 0)
                target_name = f"({start_x}, {start_y}) -> ({end_x}, {end_y})"
                label = f"Drag & Drop: {target_name}"
                await session.drag_and_drop(start_x, start_y, end_x, end_y, label=label)

            elif action == "type":
                text = str(arguments.get("text", ""))
                element_id = arguments.get("element_id")
                auto_select = arguments.get("auto_select_suggestion")
                el = None
                if element_id is not None:
                    el = next((e for e in session.interactive_elements if str(e.get("id")) == str(element_id)), None)
                if not el:
                    target_field = str(arguments.get("field") or arguments.get("target") or "").lower()
                    if target_field:
                        el = next((e for e in session.interactive_elements if target_field in e.get("name", "").lower() or target_field in e.get("placeholder", "").lower() or target_field in e.get("input_id", "").lower()), None)
                if el:
                    norm_text = normalize_element_text(el.get("text") or el.get("placeholder") or el.get("name") or "")
                    target_name = norm_text[:30] if norm_text else f"Input #{el['id']}"
                    label = f"Type '{text[:25]}' into {target_name}"
                    await session.type_text(text, element_id=el["id"], auto_select_suggestion=auto_select)
                else:
                    if element_id is not None or arguments.get("field") or arguments.get("target"):
                        return {"status": "stale_element", "error": "Requested input is missing; refresh the page state."}
                    target_name = "active field"
                    label = f"Type '{text[:25]}'"
                    await session.type_text(text, element_id=None, auto_select_suggestion=auto_select)

            elif action in {"scroll", "scroll_to"}:
                scroll_y = arguments.get("scroll_y")
                delta_y = arguments.get("delta_y")
                if action == "scroll_to" and arguments.get("element_id") is not None:
                    element_id = int(arguments["element_id"])
                    target_name = f"Element #{element_id}"
                    if not await session.scroll_to_element(element_id):
                        return {"status": "stale_element", "action": action, "error": "Scroll target is missing; observe current controls."}
                    await session.extract_interactive_tree()
                elif scroll_y is not None:
                    target_name = f"to {scroll_y}px"
                    label = f"Scroll to {scroll_y}px"
                    await session.scroll_to(int(scroll_y))
                else:
                    d_y = int(delta_y or 350)
                    target_name = f"{d_y}px"
                    label = f"Scroll {d_y}px"
                    await session.scroll(delta_y=d_y)

            elif action == "navigate_back":
                target_name = "history back"
                label = "Navigate back"
                await session.navigate_back()

            elif action == "get_theme":
                target_name = "theme"
                label = "Check theme"
                theme_info = await session.get_theme()
                return {
                    "status": "passed",
                    "action": "get_theme",
                    "target": "theme state",
                    "theme": theme_info.get("theme", "unknown"),
                    "details": theme_info,
                    "verification": {"verified":False,"effect_type":"observation",
                        "description":"Read-only theme observation: "+str(theme_info.get('theme','unknown'))+". No expected theme postcondition was supplied."},
                }

            elif action == "press_key":
                key = str(arguments.get("key", "Enter"))
                modifiers = arguments.get("modifiers")
                mod_str = f"{'+'.join(modifiers)}+" if modifiers else ""
                target_name = f"{mod_str}{key}"
                label = f"Press {target_name}"
                await session.press_key(key, modifiers=modifiers)

            elif action == "navigate":
                url = str(arguments.get("url", ""))
                if not url:
                    return {"error": "Must provide url to navigate."}
                if not session.is_url_in_target_domain(url):
                    return {
                        "status": "blocked",
                        "action": "navigate",
                        "target": url,
                        "error": f"Navigation to external URL '{url}' is forbidden. Autonomous testing is strictly restricted to the target application domain.",
                    }
                target_name = url
                label = f"Navigate to {url}"
                try:
                    await session.navigate(url)
                except RuntimeError as exc:
                    return {'status':'failed','action':'navigate','target':url,
                            'error':str(exc),'verified':False}

            elif action == "set_checked":
                from .browser_testing.assertions import assert_browser_state
                element_id = arguments.get('element_id')
                desired = arguments.get('checked')
                if type(element_id) is not int or type(desired) is not bool:
                    return {'status':'failed','error':'set_checked requires a current element_id and a boolean checked state.'}
                result = await session.set_checked(element_id, desired)
                if not result:
                    return {'status':'failed','action':action,'recovery':getattr(session,'last_actionability',{}),'error':'Checked state could not be set; inspect current target and blocker.'}
                await session.extract_interactive_tree()
                checked_result = await assert_browser_state(session, [{'kind':'checked','element_id':element_id,'expected':desired}], 1)
                return {**checked_result, 'action':action, 'target':f'Element #{element_id}',
                        'interactive_elements':_compact_interactive_elements(session.interactive_elements)}

            elif action == "toggle_checkbox":
                element_id = arguments.get("element_id")
                el = None
                if element_id is not None:
                    el = next((e for e in session.interactive_elements if str(e.get("id")) == str(element_id)), None)
                target_name = f"Checkbox #{element_id}" if element_id else "checkbox"
                label = f"Toggle {target_name}"
                if el:
                    await session.toggle_checkbox(el["id"])
                elif element_id is not None:
                    await session.toggle_checkbox(int(element_id))

            elif action == "select_option":
                element_id = arguments.get("element_id")
                value = str(arguments.get("value") or arguments.get("text") or "")
                target_name = f"Select #{element_id} -> '{value}'"
                label = f"Choose option '{value}'"
                if element_id is not None:
                    await session.select_option(int(element_id), value=value)

            else:
                return {"error": f"Unknown action '{action}'. Supported: click, hover, double_click, right_click, drag_and_drop, type, scroll, scroll_to, navigate_back, get_theme, press_key, navigate, toggle_checkbox, select_option."}

            # Ensure fresh interactive tree on mutation actions so subsequent agent decisions reflect live DOM changes
            if getattr(session,'native_dialog',None):
                return {'status':'observed','action':action,'verification':session.last_action_verification,
                        'widget_state':await observe_widgets(session),'interactive_elements':[],
                        'hint':'Resolve this observed native dialog before any further page operation.'}
            mutation_actions = {"type", "click", "hover", "double_click", "right_click", "drag_and_drop", "scroll", "scroll_to", "select_option", "toggle_checkbox", "press_key", "navigate", "navigate_back"}
            if (action in mutation_actions and not session.last_action_verification) or not session.interactive_elements:
                try:
                    tree = await session.extract_interactive_tree()
                except Exception:
                    tree = {"url": session.current_url, "title": session.page_title, "elements": session.interactive_elements}
            else:
                tree = {
                    "url": session.current_url,
                    "title": session.page_title,
                    "elements": session.interactive_elements,
                    "subpages": session.discovered_subpages,
                }
            if getattr(session,'native_dialog',None):
                return {'status':'observed','action':action,'verification':session.last_action_verification,
                        'widget_state':await observe_widgets(session),'interactive_elements':[],
                        'hint':'Resolve this observed native dialog before any further page operation.'}
            if pre_snapshot is not None:
                post_snapshot = await ActionPerceptionVerification.capture_snapshot(session)
                session.last_action_verification = ActionPerceptionVerification.verify_action_outcome(
                    pre_snapshot, post_snapshot, action=action, target=target_name or label).to_dict()
            try:
                if arguments.get("include_frame", True) is False:
                    frame_data = ""
                elif action in mutation_actions:
                    frame_data = await session.capture_screenshot(quality=60, use_cache=False) or ""
                else:
                    frame_data = session.latest_frame or await session.capture_screenshot(quality=60, use_cache=True) or ""
            except Exception:
                frame_data = session.latest_frame or ""
            frame_url = f"data:image/jpeg;base64,{frame_data}" if frame_data else ""
            # Default to skipping expensive SOM overlay injection (saves 300-400ms per step)
            # Only compute SOM if explicitly requested by vision caller
            if arguments.get("enable_som"):
                som_data = await session.capture_som_screenshot()
                som_url = f"data:image/jpeg;base64,{som_data}" if som_data else frame_url
            else:
                som_url = frame_url

            widgets = await observe_widgets(session)
            focused_id = widgets.get('focused_id')
            if (action == 'click' and widgets.get('popup_options') and
                focused_id and not any(item.get('id') == focused_id for item in tree.get('elements', []))):
                # A React picker can mount after click_element's first DOM
                # scan. Return its newly focused input in this same tool
                # result so the next action has an observed target ID.
                tree = {**tree, 'elements': session.interactive_elements,
                        'subpages': session.discovered_subpages}

            clean_target = target_name or label or action

            next_untested = []
            for e in tree.get("elements", []):
                norm = normalize_element_text(e.get("text") or e.get("aria_label") or "")
                href = (e.get("href") or "").strip()
                tag = (e.get("tag") or "").lower()
                role = (e.get("role") or "").lower()
                if norm and len(norm) > 1 and norm.lower() != clean_target.lower() and not norm.lower().startswith("skip"):
                    if href not in {"/", "#", ""} or tag in {"button", "a"} or role in {"button", "link", "tab"}:
                        next_untested.append(f"'{norm}' (id: {e['id']})")

            verif = getattr(session, "last_action_verification", {}) or {}
            effect_type = verif.get("effect_type", "")
            post_action_url = (session.current_url or "").rstrip("/")
            route_changed = (effect_type == "route_change") or (pre_action_url and pre_action_url != post_action_url)
            hint_interact = (
                f"Action {action!r} on {clean_target!r} executed. "
                "Choose any remaining steps from the user's goal and current observations. "
                "Verify the requested result explicitly; an action effect does not prove completion."
            )
            if route_changed:
                hint_interact += " The route changed; reacquire controls before the next action."
            if verif.get("new_alerts"):
                hint_interact += f" Observed feedback: {verif['new_alerts']!r}."

            arch_val = getattr(session, "current_archetype", "unknown")
            arch_str = arch_val.value if hasattr(arch_val, "value") else str(arch_val)
            pda_depth_val = getattr(session.pda, "depth", 1) if hasattr(session, "pda") else 1

            ret_payload = {
                "frame": frame_url,
                "som_frame": som_url,
                "status": "passed",
                "action": action,
                "target": clean_target,
                "url": session.current_url,
                "title": tree.get("title", ""),
                "archetype": arch_str,
                "pda_depth": pda_depth_val,
                "verification": getattr(session, "last_action_verification", None),
                "download": getattr(session, "last_download", None) if action == "click" else None,
                "timing": ({'target_resolve_ms':getattr(session,'last_target_resolution_ms',0)} |
                           (getattr(session,'last_action_timing',{}) if action == 'click' else {})),
                "elements_count": len(tree.get("elements", [])),
                "interactive_elements": _compact_interactive_elements(tree.get("elements", [])),
                "widget_state": widgets,
                "subpages": tree.get("subpages", []),
                "spawned_portals": hover_portals,
                "console_errors_count": len([l for l in session.console_logs if l.get("type") == "error"]),
                "hint": hint_interact,
            }
            if action in {'click','press_key'} and control and control.get('form') and (
                control.get('type') in {'submit','image'} or
                str(control.get('label') or '').lower().startswith(('send','submit','pay','book','purchase'))
            ):
                ret_payload['requires_outcome'] = True
                ret_payload['hint'] += ' This form action is dispatched but remains unverified until its actual response is asserted.'
            ret_payload["status"] = action_status(ret_payload)
            if effect_type == 'download_inprogress':
                ret_payload['hint'] += ' The download has started. Observe its completion state; do not click the control again.'
            if action == "type":
                ret_payload["autocomplete_suggestions"] = getattr(session, "last_autocomplete_suggestions", [])[:15]
                ret_payload["hint"] += " Typing is not a committed autocomplete selection. If options remain, choose a current option ID and assert the committed value before submitting."
            return ret_payload
        except Exception as e:
            result={"status":"failed","action":action,"error": f"Browser interaction failed: {str(e)}"}
            return result

    if tool_name == "browser_interact_batch":
        session_id = str(arguments.get("session_id") or "default")
        actions = arguments.get("actions", [])
        from .browser_driver import browser_manager
        from .browser_testing.transactions import (validate_batch, completion_evidence,
            continue_batch_after, compile_batch, scene_changed, page_assertion)
        existing = browser_manager.sessions.get(session_id)
        original_count = len(actions) if isinstance(actions, list) else 0
        actions = compile_batch(actions, getattr(existing, 'interactive_elements', ()))
        problem = validate_batch(actions, arguments.get('complete_task', False), max_actions=32)
        if problem:
            return {'status':'failed','action':'batch','executed_count':0,'error':problem}

        try:
            if session_id not in browser_manager.sessions or not browser_manager.sessions[session_id].is_connected:
                session = await browser_manager.get_or_create_session(session_id=session_id)
            else:
                session = browser_manager.sessions[session_id]

            from .browser_testing.outcomes import outcome_guard_for
            guard = outcome_guard_for(session)
            if guard:
                guard.observe(session.interactive_elements, session.current_url, session.page_title)
            results = []
            boundary = False
            for step_index, act_obj in enumerate(actions):
                if boundary and not page_assertion(act_obj):
                    break
                if not isinstance(act_obj, dict):
                    return {"status": "failed", "error": "Each batch action must be an object."}
                sub_action = str(act_obj.get("action", "")).lower()
                sub_args = dict(act_obj)
                sub_args["session_id"] = session_id
                sub_args["include_frame"] = False
                sub_res = await execute_tool_call("browser_assert" if sub_action == "assert" else "browser_interact", sub_args, user_id)
                results.append({
                    "action": sub_action,
                    "target": sub_res.get("target") or sub_res.get("action"),
                    "status": action_status(sub_res),
                    "verification": sub_res.get("verification"),
                    "timing": sub_res.get("timing"),
                    "assertions": sub_res.get("assertions", []),
                    "purpose": sub_res.get("purpose"),
                    **({key: sub_res[key] for key in ('requested_purpose', 'completion_reason') if key in sub_res}),
                    "error": sub_res.get("error"),
                    "recovery": sub_res.get("recovery"),
                    "hint": sub_res.get("hint"),
                    "autocomplete_suggestions": sub_res.get("autocomplete_suggestions", []),
                    **({'theme':sub_res.get('theme'),'details':sub_res.get('details')} if sub_action=='get_theme' else {}),
                })
                from .tool_progress import snapshot_step
                await snapshot_step(session, "browser_assert" if sub_action == "assert" else "browser_interact", sub_args, sub_res,
                                    include_frame=arguments.get('include_frame',True) is not False)
                if sub_res.get('approval_required') or not continue_batch_after(results[-1]):
                    break
                boundary = boundary or scene_changed(sub_res)

            tree = {
                "url": session.current_url,
                "title": session.page_title,
                "elements": session.interactive_elements,
                "subpages": session.discovered_subpages,
            }
            try:
                fresh_frame = (await session.capture_screenshot(quality=65, use_cache=False) or session.latest_frame or "") if arguments.get('include_frame',True) else ""
            except Exception:
                fresh_frame = session.latest_frame or ""
            frame_url = f"data:image/jpeg;base64,{fresh_frame}" if fresh_frame else ""

            payload = {
                "status": "failed" if any(r["status"] == "failed" for r in results) else (
                    "passed" if len(results) == len(actions) and all(r["status"] == "passed" for r in results) else "unverified"),
                "action": "batch",
                "batch_size": len(actions),
                "planned_count": original_count,
                "compiled_count": len(actions),
                "executed_count": len(results),
                "remaining_count": len(actions) - len(results),
                "results": results,
                "url": session.current_url,
                "title": tree.get("title", ""),
                "elements_count": len(tree.get("elements", [])),
                "interactive_elements": _compact_interactive_elements(tree.get("elements", [])),
                "subpages": tree.get("subpages", []),
                "console_errors_count": len([l for l in session.console_logs if l.get("type") == "error"]),
                "frame": frame_url,
            }
            payload['completion_verified'] = completion_evidence(actions, results, arguments.get('complete_task', False))
            if guard:
                payload = guard.tool_result('browser_interact_batch', {**arguments, 'actions': actions}, payload)
            if len(results) < len(actions):
                payload['hint'] = ('The batch stopped at a changed scene or an unverified step. Use the returned current controls '
                    'to continue the remaining workflow; do not replay executed steps.')
            if payload['completion_verified']:
                payload['status'] = 'passed'
            return payload
        except Exception as e:
            return {"error": f"Batch interaction failed: {str(e)}"}

    if tool_name == "browser_fill_form":
        return {"status": "failed", "action": "fill_form",
                "error": "Implicit field matching and submission are retired. Use browser_interact_batch with explicit observed element IDs."}

    if tool_name == "browser_get_page_state":
        session_id = str(arguments.get("session_id") or "default")
        try:
            from .browser_driver import browser_manager
            if session_id not in browser_manager.sessions:
                return {"error": f"Session '{session_id}' not found. Call browser_open_live_session first."}
            session = browser_manager.sessions[session_id]
            state = await session.extract_interactive_tree()
            som_data = None
            try:
                frame_data = await session.capture_screenshot(quality=65, use_cache=False) or session.latest_frame or ""
            except Exception:
                frame_data = session.latest_frame or ""
            arch_val = getattr(session, "current_archetype", "unknown")
            arch_str = arch_val.value if hasattr(arch_val, "value") else str(arch_val)
            pda_depth_val = getattr(session.pda, "depth", 1) if hasattr(session, "pda") else 1
            skg_summary_val = session.skg.get_summary() if hasattr(session, "skg") else {}

            return {
                "session_id": session_id,
                "url": session.current_url,
                "title": state.get("title", ""),
                "archetype": arch_str,
                "pda_depth": pda_depth_val,
                "site_graph_summary": skg_summary_val,
                "elements_count": len(state.get("elements", [])),
                "interactive_elements": _compact_interactive_elements(state.get("elements", [])),
                "frame": f"data:image/jpeg;base64,{frame_data}" if frame_data else "",
                "som_frame": f"data:image/jpeg;base64,{som_data}" if som_data else "",
            }
        except Exception as e:
            return {"error": f"Failed to get page state: {str(e)}"}

    if tool_name == "browser_inspect_console":
        session_id = str(arguments.get("session_id") or "default")
        try:
            from .browser_driver import browser_manager
            if session_id not in browser_manager.sessions:
                return {"error": f"Session '{session_id}' not found."}
            session = browser_manager.sessions[session_id]
            return {
                "session_id": session_id,
                "log_count": len(session.console_logs),
                "recent_logs": session.console_logs[-30:],
            }
        except Exception as e:
            return {"error": f"Failed to inspect console: {str(e)}"}

    if tool_name == "browser_close_session":
        session_id = str(arguments.get("session_id") or "default")
        try:
            from .browser_driver import browser_manager
            await browser_manager.close_session(session_id)
            return {"status": "closed", "session_id": session_id}
        except Exception as e:
            return {"error": f"Failed to close session: {str(e)}"}

    if tool_name == "ask_user_question":
        question = str(arguments.get("question") or "Please select an option:")
        fields = arguments.get("fields") or []
        return {
            "status": "question_asked",
            "question": question,
            "fields": fields
        }

    backend_url = (os.getenv("BACKEND_INTERNAL_URL") or os.getenv("STACKPILOT_INTERNAL_API", "http://backend:8090")).rstrip("/")
    token = os.getenv("STACKPILOT_AI_SERVICE_TOKEN", "").strip()
    
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-StackPilot-Service-Token"] = token
        
    payload = {
        "tool_name": tool_name,
        "arguments": arguments,
        "user_id": user_id
    }
    
    try:
        wait_timeout = min(600, max(10, int(arguments.get('timeout_seconds', 180)))) + 15 if tool_name == 'wait_for_deployment' else 180
        async with httpx.AsyncClient(timeout=wait_timeout) as client:
            resp = await client.post(f"{backend_url}/api/v1/ai/tools/execute", json=payload, headers=headers)
            resp.raise_for_status()
            resp_json = resp.json()
            if isinstance(resp_json, dict) and resp_json.get("status") in {"written", "edited"}:
                resp_json["next_step_hint"] = "File changes applied to workspace. You can now call workspace_trigger_rebuild with deployment_id to rebuild, or continue modifying files."
            elif isinstance(resp_json, dict) and resp_json.get("status") == "rebuild_queued":
                resp_json["next_step_hint"] = "Rebuild has been queued. You MUST now call wait_for_deployment with deployment_id to monitor the build until completion."
            elif isinstance(resp_json, dict) and resp_json.get("status") in {"failed", "error", "crash_loop_backoff"}:
                resp_json["next_step_hint"] = "Deployment failed. Do NOT stop. Read the error in 'recent_logs', apply the next targeted fix using workspace_write_file or workspace_edit_file, and trigger rebuild again. Iterate until status is 'running'."
            elif isinstance(resp_json, dict) and resp_json.get("status") in {"running", "ready"}:
                resp_json["next_step_hint"] = ("This build passed the render smoke check; report its scope and remaining business tests."
                    if resp_json.get('verified') is True else "Running status alone is not proof of a successful repair. Runtime verification is still required.")
            return resp_json
    except Exception as e:
        return {"error": f"Tool execution failed: {str(e)}"}
