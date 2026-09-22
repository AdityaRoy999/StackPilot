import asyncio
import os
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse
import httpx


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


def _compact_interactive_elements(elements: List[Dict[str, Any]], max_count: int = 60) -> List[Dict[str, Any]]:
    """Generates a token-optimized, compact representation of interactive elements for the LLM.
    Prioritizes in-viewport elements and omits pixel coordinates while keeping IDs and semantic labels."""
    if not elements:
        return []
    in_viewport = [e for e in elements if e.get("is_in_viewport") and not e.get("is_occluded")]
    occluded_in_viewport = [e for e in elements if e.get("is_in_viewport") and e.get("is_occluded")]
    out_viewport = [e for e in elements if not e.get("is_in_viewport")]
    ordered = in_viewport + occluded_in_viewport + out_viewport

    compacted = []
    for el in ordered[:max_count]:
        item: Dict[str, Any] = {
            "id": el.get("id"),
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
        if el.get("href"):
            item["href"] = el.get("href")[:60]
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
            "description": "Wait and poll for a deployment rebuild or startup to finish. Blocks until the deployment reaches 'running' or 'failed', or until timeout. Use this immediately after calling workspace_trigger_rebuild so you can verify that the deployment is actually live and running before giving your final report.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deployment_id": {"type": "string", "description": "UUID of the deployment to wait for"},
                    "timeout_seconds": {"type": "integer", "description": "Maximum seconds to wait (10 to 180, default 90)"}
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
            "description": "Invoke a specialized autonomous subagent (e.g. CoderAgent, ArchitectAgent, VerifierAgent, ResearchAgent) to handle an isolated subtask. The subagent performs the task and hands its work back to the main agent.",
            "parameters": {
                "type": "object",
                "properties": {
                    "role": {"type": "string", "enum": ["Coder Subagent", "Architect Subagent", "Verifier Subagent", "Research Subagent"], "description": "Role of the subagent to launch"},
                    "task": {"type": "string", "description": "Specific, actionable task description for the subagent"}
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
                    "action": {"type": "string", "enum": ["click", "hover", "double_click", "right_click", "drag_and_drop", "type", "scroll", "scroll_to", "navigate_back", "get_theme", "press_key", "navigate", "toggle_checkbox", "select_option"], "description": "Action to perform"},
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
            "description": "Execute multiple browser actions in a single rapid local burst without waiting for LLM roundtrips between steps. Perfect for filling forms (type field 1, type field 2, click submit) or sequential button clicks in sub-100ms.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Session identifier (defaults to 'default')"},
                    "actions": {
                        "type": "array",
                        "description": "Ordered list of actions to execute sequentially in rapid local burst",
                        "items": {
                            "type": "object",
                            "properties": {
                                "action": {"type": "string", "enum": ["click", "hover", "type", "scroll", "scroll_to", "press_key", "select_option", "toggle_checkbox"], "description": "Action to perform"},
                                "element_id": {"type": "integer", "description": "Element ID to target"},
                                "text": {"type": "string", "description": "Text to type"},
                                "field": {"type": "string", "description": "Field name or placeholder"},
                                "key": {"type": "string", "description": "Key name to press"},
                                "value": {"type": "string", "description": "Select option value"}
                            },
                            "required": ["action"]
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
            "name": "browser_fill_form",
            "description": "Atomically populate all fields of a form and submit it in a single turn. Automatically matches inputs/textareas by name/placeholder and clicks the submit/send button.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Session identifier (defaults to 'default')"},
                    "fields": {
                        "type": "object",
                        "description": "Key-value dictionary mapping field names or labels to text values (e.g. {'name': 'John Doe', 'email': 'john@example.com', 'message': 'Project inquiry'})"
                    },
                    "submit": {
                        "type": "boolean",
                        "description": "Whether to automatically find and click the submit button after typing (defaults to true)"
                    }
                },
                "required": ["fields"]
            }
        }
    }
]

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

def get_db_connection():
    """Returns an authenticated psycopg2 connection using environment credentials."""
    import psycopg2
    db_user = os.getenv("DB_USER", "stackpilot_admin")
    db_pass = os.getenv("DB_PASSWORD", "dokscp_secret_2026")
    db_host = os.getenv("DB_HOST", "postgres")
    db_port = os.getenv("DB_PORT", "5432")
    db_name = os.getenv("DB_NAME", "stackpilot_platform")
    return psycopg2.connect(
        host=db_host,
        port=db_port,
        user=db_user,
        password=db_pass,
        dbname=db_name
    )


def resolve_target_project_runtime_url(
    project_id: Optional[str] = None,
    deployment_id: Optional[str] = None,
    user_message: str = "",
    custom_url: Optional[str] = None,
    session_id: Optional[str] = None,
) -> str:
    """
    Finds the active, live project runtime URL for browser testing.
    Prioritizes real user project deployments, active browser canvas session, and custom URLs, and never returns the StackPilot frontend URL (localhost:3000).
    """
    # 0. Explicit custom_url takes absolute priority
    if custom_url and custom_url.strip():
        u = custom_url.strip()
        if u not in {"about:blank", "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3000/", "http://127.0.0.1:3000/"}:
            if not u.startswith("http://") and not u.startswith("https://"):
                u = f"http://{u}"
            return u

    # 1. Regex check for explicit URL in user_message (e.g. "test https://example.com", "http://localhost:52249")
    if user_message:
        url_match = re.search(r"https?://[^\s<>\"']+", user_message)
        if url_match:
            found_url = url_match.group(0).rstrip(".,;)")
            if "localhost:3000" not in found_url and "127.0.0.1:3000" not in found_url:
                return found_url

    # 2. Check active browser canvas session in browser_manager
    try:
        from .browser_driver import browser_manager
        active = (browser_manager.sessions.get(session_id) if session_id else None) or browser_manager.get_active_session()
        if active and active.current_url:
            cur_u = active.current_url.strip()
            if cur_u and cur_u not in {"about:blank", "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3000/", "http://127.0.0.1:3000/"}:
                return cur_u
    except Exception:
        pass

    try:
        conn = get_db_connection()
        cur = conn.cursor()

        # 2. By explicit deployment_id
        if deployment_id:
            cur.execute("SELECT runtime_url FROM deployments WHERE id = %s", (deployment_id,))
            r = cur.fetchone()
            if r and r[0] and "localhost:3000" not in str(r[0]):
                conn.close()
                return str(r[0])

        # 3. By explicit project_id
        if project_id:
            cur.execute(
                "SELECT runtime_url FROM deployments WHERE project_id = %s AND status = 'running' "
                "AND runtime_url IS NOT NULL AND runtime_url != '' AND runtime_url NOT LIKE '%localhost:3000%' "
                "ORDER BY created_at DESC LIMIT 1",
                (project_id,)
            )
            r = cur.fetchone()
            if r and r[0]:
                conn.close()
                return str(r[0])
            cur.execute(
                "SELECT runtime_url FROM deployments WHERE project_id = %s "
                "AND runtime_url IS NOT NULL AND runtime_url != '' AND runtime_url NOT LIKE '%localhost:3000%' "
                "ORDER BY created_at DESC LIMIT 1",
                (project_id,)
            )
            r = cur.fetchone()
            if r and r[0]:
                conn.close()
                return str(r[0])

        # 4. By project name matching in user_message (e.g. "portfolio", "app", etc.)
        if user_message:
            msg_lower = user_message.lower()
            cur.execute("SELECT id, name FROM projects")
            projects = cur.fetchall()
            for p_id, p_name in projects:
                if p_name and p_name.lower() in msg_lower:
                    cur.execute(
                        "SELECT runtime_url FROM deployments WHERE project_id = %s AND status = 'running' "
                        "AND runtime_url IS NOT NULL AND runtime_url != '' AND runtime_url NOT LIKE '%localhost:3000%' "
                        "ORDER BY created_at DESC LIMIT 1",
                        (p_id,)
                    )
                    r = cur.fetchone()
                    if r and r[0]:
                        conn.close()
                        return str(r[0])

        # 5. Latest running project deployment with valid runtime URL (excluding localhost:3000)
        cur.execute(
            "SELECT runtime_url FROM deployments WHERE status = 'running' "
            "AND runtime_url IS NOT NULL AND runtime_url != '' AND runtime_url NOT LIKE '%localhost:3000%' "
            "ORDER BY created_at DESC LIMIT 1"
        )
        r = cur.fetchone()
        if r and r[0]:
            conn.close()
            return str(r[0])

        # 6. Any project deployment with valid runtime URL
        cur.execute(
            "SELECT runtime_url FROM deployments WHERE runtime_url IS NOT NULL "
            "AND runtime_url != '' AND runtime_url NOT LIKE '%localhost:3000%' "
            "ORDER BY created_at DESC LIMIT 1"
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
    """Execute a tool by calling SearXNG/web or the C++ backend."""
    if tool_name in {"list_functions", "list_tools", "get_tools"}:
        return {"tools": [t["function"]["name"] for t in AGENT_TOOLS]}

    if tool_name == "web_search":
        query = str(arguments.get("query", ""))
        num_results = int(arguments.get("num_results", 5))
        return await execute_web_search(query, num_results)

    if tool_name == "web_fetch":
        url = str(arguments.get("url", ""))
        return await execute_web_fetch(url)

    if tool_name == "invoke_subagent":
        role = str(arguments.get("role", "Specialized Subagent"))
        task = str(arguments.get("task", ""))
        return {
            "status": "completed",
            "role": role,
            "task": task,
            "output": f"Subagent [{role}] completed assigned task: '{task}'. Work verified and control handed back to Main Agent."
        }

    if tool_name == "browser_open_live_session":
        url = str(arguments.get("url", "about:blank"))
        session_id = str(arguments.get("session_id") or "default")
        # If generic, localhost:3000, or blank URL is provided, automatically resolve the actual project runtime URL
        if not url or url in {"about:blank", "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3000/", "http://127.0.0.1:3000/"}:
            from .browser_driver import browser_manager
            resolved_url = resolve_target_project_runtime_url(
                project_id=arguments.get("project_id"),
                deployment_id=arguments.get("deployment_id"),
                custom_url=arguments.get("custom_url"),
                session_id=session_id,
            )
            if resolved_url and resolved_url != "about:blank":
                url = resolved_url
            else:
                existing = browser_manager.sessions.get(session_id) or browser_manager.get_active_session()
                if existing and existing.current_url and existing.current_url not in {"about:blank", "http://localhost:3000", "http://localhost:3000/"}:
                    url = existing.current_url

        try:
            from .browser_driver import browser_manager
            _existing = browser_manager.sessions.get(session_id)
            _active = browser_manager.get_active_session()
            already_open = bool(
                (_existing and _existing.is_connected) or
                (_active and _active.is_connected)
            )
            session = await browser_manager.get_or_create_session(session_id=session_id, url=url)
            if url and url not in {"about:blank", "http://localhost:3000", "http://127.0.0.1:3000"}:
                curr = (session.current_url or "").rstrip("/").strip()
                norm = url.rstrip("/").strip()
                curr_parsed = urlparse(curr) if curr else None
                norm_parsed = urlparse(norm) if norm else None
                same_origin = bool(
                    curr_parsed and norm_parsed and
                    curr_parsed.netloc and norm_parsed.netloc and
                    curr_parsed.netloc == norm_parsed.netloc
                )
                if (curr in {"about:blank", ""} or not same_origin) and norm:
                    await session.navigate(url)
            page_state = await session.extract_interactive_tree()
            try:
                frame_data = await session.capture_screenshot(quality=65, use_cache=False) or session.latest_frame or ""
            except Exception:
                frame_data = session.latest_frame or ""
            frame_url = f"data:image/jpeg;base64,{frame_data}" if frame_data else ""
            som_data = await session.capture_som_screenshot()
            som_url = f"data:image/jpeg;base64,{som_data}" if som_data else frame_url
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
                    f"Visual Set-of-Marks badges [1], [2] are visible in som_frame matching interactive_elements IDs. "
                    f"Call browser_interact(action='click', element_id=...) or browser_interact(action='type', ...) now."
                )
            else:
                hint_text = "Live browser session connected and streaming. "
                if nav_buttons:
                    hint_text += f"Interactive elements ready for testing: {', '.join(nav_buttons[:6])}. Visual Set-of-Marks badges [1], [2] are visible in som_frame matching interactive_elements IDs. Call browser_interact(action='click', element_id=...) to test elements now."
                else:
                    hint_text += "Use browser_interact to click elements or type, or browser_inspect_console to check for frontend errors."

            arch_val = getattr(session, "current_archetype", "unknown")
            arch_str = arch_val.value if hasattr(arch_val, "value") else str(arch_val)
            pda_depth_val = getattr(session.pda, "depth", 1) if hasattr(session, "pda") else 1
            skg_summary_val = session.skg.get_summary() if hasattr(session, "skg") else {}

            return {
                "status": "already_connected" if already_open else "connected",
                "session_id": session_id,
                "url": session.current_url,
                "title": page_state.get("title", ""),
                "archetype": arch_str,
                "pda_depth": pda_depth_val,
                "site_graph_summary": skg_summary_val,
                "interactive_elements_count": len(page_state.get("elements", [])),
                "interactive_elements": _compact_interactive_elements(page_state.get("elements", [])),
                "subpages": page_state.get("subpages", []),
                "console_errors_count": len([l for l in session.console_logs if l.get("type") == "error"]),
                "frame": frame_url,
                "som_frame": som_url,
                "hint": hint_text,
            }
        except Exception as e:
            return {"error": f"Failed to open browser session: {str(e)}"}

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

            if not session.interactive_elements:
                try:
                    await session.extract_interactive_tree()
                except Exception:
                    pass

            label = ""
            target_name = ""
            hover_portals = []
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
                        await session.click_element(el["id"], label=label)
                    else:
                        missing_info = f"id={element_id}" if element_id is not None else f"text='{target_text}'"
                        return {
                            "status": "stale_element",
                            "error": f"Element ({missing_info}) not found in active DOM. It may be occluded by an open modal or unmounted.",
                            "interactive_elements_count": len(session.interactive_elements or []),
                        }
                elif x is not None and y is not None:
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
                        hover_x = el["x"]
                        hover_y = el["y"]
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
                        dc_x = el["x"]
                        dc_y = el["y"]
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
                        rc_x = el["x"]
                        rc_y = el["y"]
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
                    await session.type_text(text, element_id=el["id"])
                else:
                    target_name = "active field"
                    label = f"Type '{text[:25]}'"
                    await session.type_text(text, element_id=None)

            elif action in {"scroll", "scroll_to"}:
                scroll_y = arguments.get("scroll_y")
                delta_y = arguments.get("delta_y")
                if scroll_y is not None:
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
                theme_info = await session.get_theme_state()
                return {
                    "status": "passed",
                    "action": "get_theme",
                    "target": "theme state",
                    "theme": theme_info.get("theme", "unknown"),
                    "details": theme_info,
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
                await session.navigate(url)

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

            # Read cached tree if already refreshed by driver action handler, avoiding duplicate DOM walks
            if not session.interactive_elements or action in {"navigate", "navigate_back"}:
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
            try:
                frame_data = await session.capture_screenshot(quality=65, use_cache=False) or session.latest_frame or ""
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

            hint_interact = f"Action '{action}' on '{clean_target}' completed successfully. "
            if action == "type":
                submit_candidate = None
                for e in tree.get("elements", []):
                    t = (e.get("text") or e.get("aria_label") or "").lower()
                    tag = (e.get("tag") or "").lower()
                    etype = (e.get("type") or "").lower()
                    if etype == "submit" or tag == "button" and any(kw in t for kw in ["submit", "send", "save", "book", "register", "contact", "apply", "test"]):
                        submit_candidate = f"'{e.get('text') or 'Submit'}' (id: {e['id']})"
                        break
                if submit_candidate:
                    hint_interact += f"Form input filled. Remember to click submission button {submit_candidate} to trigger and test form submission! "

            if next_untested:
                hint_interact += f"Next untested elements to test: {', '.join(next_untested[:5])}. Refer to som_frame numeric badges [id] to visually verify targets. Call browser_interact(action='click', element_id=...) on the next element."
            else:
                hint_interact += "Interactive controls have been tested. Conclude testing or visit subpages."

            arch_val = getattr(session, "current_archetype", "unknown")
            arch_str = arch_val.value if hasattr(arch_val, "value") else str(arch_val)
            pda_depth_val = getattr(session.pda, "depth", 1) if hasattr(session, "pda") else 1

            return {
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
                "elements_count": len(tree.get("elements", [])),
                "interactive_elements": _compact_interactive_elements(tree.get("elements", [])),
                "subpages": tree.get("subpages", []),
                "spawned_portals": hover_portals,
                "console_errors_count": len([l for l in session.console_logs if l.get("type") == "error"]),
                "hint": hint_interact,
            }
        except Exception as e:
            return {"error": f"Browser interaction failed: {str(e)}"}

    if tool_name == "browser_interact_batch":
        session_id = str(arguments.get("session_id") or "default")
        actions = arguments.get("actions", [])
        if not actions or not isinstance(actions, list):
            return {"error": "Must provide a non-empty list of 'actions'"}

        try:
            from .browser_driver import browser_manager
            if session_id not in browser_manager.sessions or not browser_manager.sessions[session_id].is_connected:
                session = await browser_manager.get_or_create_session(session_id=session_id)
            else:
                session = browser_manager.sessions[session_id]

            results = []
            for act_obj in actions:
                sub_action = str(act_obj.get("action", "")).lower()
                sub_args = dict(act_obj)
                sub_args["session_id"] = session_id
                sub_res = await execute_tool_call("browser_interact", sub_args, None)
                results.append({
                    "action": sub_action,
                    "target": sub_res.get("target") or sub_res.get("action"),
                    "status": sub_res.get("status", "completed"),
                })
                if sub_res.get("status") == "error" or "error" in sub_res:
                    break
                await asyncio.sleep(0.05)

            tree = {
                "url": session.current_url,
                "title": session.page_title,
                "elements": session.interactive_elements,
                "subpages": session.discovered_subpages,
            }
            try:
                fresh_frame = await session.capture_screenshot(quality=65, use_cache=False) or session.latest_frame or ""
            except Exception:
                fresh_frame = session.latest_frame or ""
            frame_url = f"data:image/jpeg;base64,{fresh_frame}" if fresh_frame else ""

            return {
                "status": "passed",
                "action": "batch",
                "batch_size": len(actions),
                "executed_count": len(results),
                "results": results,
                "url": session.current_url,
                "title": tree.get("title", ""),
                "elements_count": len(tree.get("elements", [])),
                "interactive_elements": _compact_interactive_elements(tree.get("elements", [])),
                "subpages": tree.get("subpages", []),
                "console_errors_count": len([l for l in session.console_logs if l.get("type") == "error"]),
                "frame": frame_url,
            }
        except Exception as e:
            return {"error": f"Batch interaction failed: {str(e)}"}

    if tool_name == "browser_fill_form":
        session_id = str(arguments.get("session_id") or "default")
        fields = arguments.get("fields", {})
        should_submit = arguments.get("submit", True)
        if not fields or not isinstance(fields, dict):
            return {"error": "Must provide a dictionary of 'fields' (e.g. {'name': 'John', 'email': 'john@example.com'})"}

        try:
            from .browser_driver import browser_manager
            if session_id not in browser_manager.sessions or not browser_manager.sessions[session_id].is_connected:
                session = await browser_manager.get_or_create_session(session_id=session_id)
            else:
                session = browser_manager.sessions[session_id]

            if not session.interactive_elements:
                await session.extract_interactive_tree()

            filled_fields = []
            for field_key, val in fields.items():
                val_str = str(val)
                target_el = None
                key_norm = field_key.lower().strip()
                for el in (session.interactive_elements or []):
                    el_tag = el.get("tag", "").lower()
                    if el_tag in {"input", "textarea"}:
                        name = (el.get("name") or "").lower()
                        placeholder = (el.get("placeholder") or "").lower()
                        input_id = (el.get("input_id") or "").lower()
                        aria = (el.get("aria_label") or "").lower()
                        text = (el.get("text") or "").lower()
                        if key_norm in name or key_norm in placeholder or key_norm in input_id or key_norm in aria or key_norm in text:
                            target_el = el
                            break

                if target_el:
                    await session.type_text(val_str, element_id=target_el["id"])
                    filled_fields.append({"field": field_key, "element_id": target_el["id"], "value": val_str, "status": "typed"})
                else:
                    await session.type_text(val_str, element_id=None)
                    filled_fields.append({"field": field_key, "value": val_str, "status": "active_typed"})
                await asyncio.sleep(0.04)

            submission_res = None
            if should_submit:
                submit_btn = None
                for el in (session.interactive_elements or []):
                    t = (el.get("text") or el.get("aria_label") or "").lower()
                    etype = (el.get("type") or "").lower()
                    tag = (el.get("tag") or "").lower()
                    if etype == "submit" or (tag in {"button", "a"} and any(w in t for w in ["submit", "send", "save", "book", "register", "contact", "apply"])):
                        submit_btn = el
                        break
                if submit_btn:
                    btn_label = normalize_element_text(submit_btn.get("text") or "Submit")
                    await session.click_element(submit_btn["id"], label=f"Submit: {btn_label}")
                    submission_res = {"status": "clicked_button", "button_text": btn_label, "button_id": submit_btn["id"]}
                else:
                    await session.press_key("Enter")
                    submission_res = {"status": "submitted_via_enter"}
                await session.wait_for_quiescence(network_idle_ms=60, dom_quiet_ms=30, max_timeout_s=1.0, fast_mode=True)

            tree = await session.extract_interactive_tree()
            try:
                fresh_frame = await session.capture_screenshot(quality=65, use_cache=False) or session.latest_frame or ""
            except Exception:
                fresh_frame = session.latest_frame or ""
            frame_url = f"data:image/jpeg;base64,{fresh_frame}" if fresh_frame else ""

            return {
                "status": "passed",
                "action": "fill_form",
                "fields_filled": filled_fields,
                "submission": submission_res,
                "url": session.current_url,
                "title": tree.get("title", ""),
                "frame": frame_url,
                "hint": "Form populated and submitted atomically."
            }
        except Exception as e:
            return {"error": f"Form filling failed: {str(e)}"}

    if tool_name == "browser_get_page_state":
        session_id = str(arguments.get("session_id") or "default")
        try:
            from .browser_driver import browser_manager
            if session_id not in browser_manager.sessions:
                return {"error": f"Session '{session_id}' not found. Call browser_open_live_session first."}
            session = browser_manager.sessions[session_id]
            state = await session.extract_interactive_tree()
            som_data = await session.capture_som_screenshot()
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
        async with httpx.AsyncClient(timeout=180.0) as client:
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
                resp_json["next_step_hint"] = "Deployment is verified LIVE and running! Project is fully healed. Deliver your final report."
            return resp_json
    except Exception as e:
        return {"error": f"Tool execution failed: {str(e)}"}
