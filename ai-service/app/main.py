from __future__ import annotations

import json
import os
import re
import asyncio
import time
import uuid
from typing import Any, Dict, List, Literal, Optional, TypedDict

import httpx
from fastapi import FastAPI
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, ConfigDict, Field, model_validator


MAX_TEXT = int(os.getenv("AIDS_AI_MAX_TEXT_BYTES", "24000"))
DEFAULT_TIMEOUT = float(os.getenv("AIDS_AI_REQUEST_TIMEOUT_SECONDS", "45"))
MODEL_PROBE_TIMEOUT = float(os.getenv("NVIDIA_NIM_MODEL_PROBE_TIMEOUT_SECONDS", "20"))
MODEL_PROBE_LIMIT = int(os.getenv("NVIDIA_NIM_MODEL_PROBE_LIMIT", "100"))
MODEL_PROBE_CACHE_TTL = float(os.getenv("NVIDIA_NIM_MODEL_PROBE_CACHE_SECONDS", "3600"))
MODEL_PROBE_CACHE: Dict[str, Any] = {"expires_at": 0.0, "models": []}


class AgentRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    provider: Optional[str] = None
    model: Optional[str] = None
    workflow_type: Optional[str] = None
    action: Optional[str] = None
    project: Dict[str, Any] = Field(default_factory=dict)
    project_context: Dict[str, Any] = Field(default_factory=dict)
    deployment: Dict[str, Any] = Field(default_factory=dict)
    source: Dict[str, Any] = Field(default_factory=dict)
    logs: str = ""
    runtime: Dict[str, Any] = Field(default_factory=dict)
    message: str = ""
    command: str = ""
    model_mode: Literal["fast", "thinking"] = "fast"
    history: List[Dict[str, str]] = Field(default_factory=list)
    confidence_threshold: float = 0.72

    @model_validator(mode="after")
    def normalize_legacy_fields(self) -> "AgentRequest":
        if not self.workflow_type and self.action:
            self.workflow_type = self.action
        if not self.project and self.project_context:
            self.project = self.project_context
        return self


class AgentResponse(BaseModel):
    status: Literal["ok", "error"] = "ok"
    result_type: str
    confidence: float = 0.0
    summary: str = ""
    structured_output: Dict[str, Any] = Field(default_factory=dict)
    warnings: List[str] = Field(default_factory=list)
    requires_user_confirmation: bool = True
    trace_id: str
    provider: str
    model: str
    latency_ms: int = 0
    token_usage: Dict[str, Any] = Field(default_factory=dict)
    error: str = ""


class AgentState(TypedDict, total=False):
    request: AgentRequest
    workflow: str
    prompt: str
    response: Dict[str, Any]
    warnings: List[str]


app = FastAPI(title="AIDS AI Service", version="0.1.0")


SECRET_PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|token|secret|password|private[_-]?key)\s*[:=]\s*['\"]?[^'\"\s]+"),
    re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
]


def clip(value: str, limit: int = MAX_TEXT) -> str:
    value = value or ""
    if len(value.encode("utf-8", errors="ignore")) <= limit:
        return value
    return value[: limit // 2] + "\n...[clipped]...\n" + value[-limit // 2 :]


def redact_text(value: str) -> str:
    redacted = clip(value)
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub(lambda m: m.group(0).split("=")[0].split(":")[0] + "=[REDACTED]", redacted)
    return redacted


def safe_json(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [safe_json(item) for item in value[:200]]
    if isinstance(value, dict):
        result: Dict[str, Any] = {}
        for key, item in list(value.items())[:200]:
            if re.search(r"(?i)(secret|token|password|private|key|credential)", str(key)):
                result[key] = "[REDACTED]"
            else:
                result[key] = safe_json(item)
        return result
    return value


def provider_config(provider: Optional[str], model: Optional[str], model_mode: str = "fast") -> tuple[str, str, str, str]:
    selected = (provider or os.getenv("AIDS_AI_PROVIDER") or "nvidia_nim").strip()
    if selected == "openai_compatible":
        base_url = os.getenv("OPENAI_COMPATIBLE_BASE_URL", "").rstrip("/")
        api_key = os.getenv("OPENAI_COMPATIBLE_API_KEY", "")
        selected_model = (
            model
            or (os.getenv("OPENAI_COMPATIBLE_THINKING_MODEL") if model_mode == "thinking" else "")
            or os.getenv("OPENAI_COMPATIBLE_MODEL")
            or os.getenv("AIDS_AI_MODEL")
            or "gpt-4o-mini"
        )
    else:
        selected = "nvidia_nim"
        base_url = os.getenv("NVIDIA_NIM_BASE_URL", "https://integrate.api.nvidia.com/v1").rstrip("/")
        api_key = os.getenv("NVIDIA_NIM_API_KEY") or os.getenv("NVIDIA_API_KEY", "")
        selected_model = (
            model
            or (os.getenv("NVIDIA_NIM_THINKING_MODEL") if model_mode == "thinking" else "")
            or (os.getenv("NVIDIA_NIM_FAST_MODEL") if model_mode == "fast" else "")
            or os.getenv("AIDS_AI_MODEL")
            or os.getenv("NVIDIA_NIM_MODEL")
            or "meta/llama-3.1-70b-instruct"
        )
    return selected, base_url, api_key, selected_model


def model_extra_body(model: str, model_mode: str) -> Dict[str, Any]:
    lowered = (model or "").lower()
    if lowered.startswith("z-ai/") or "glm" in lowered:
        return {
            "chat_template_kwargs": {
                "enable_thinking": model_mode == "thinking",
                "clear_thinking": False,
            }
        }
    return {}


def chat_payload(
    model: str,
    prompt: str,
    *,
    json_mode: bool,
    temperature: float = 0.2,
    model_mode: str = "fast",
    stream: bool = False,
    max_tokens: int = 2048,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "model": model,
        "temperature": temperature,
        "top_p": 1,
        "max_tokens": max_tokens,
        "stream": stream,
        "messages": [
            {
                "role": "system",
                "content": "You are a secure DevOps assistant. You never execute commands and never reveal secrets.",
            },
            {"role": "user", "content": prompt},
        ],
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    extra_body = model_extra_body(model, model_mode)
    payload.update(extra_body)
    return payload


def parse_model_json(content: str) -> Dict[str, Any]:
    text = (content or "{}").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.S)
        if match:
            return json.loads(match.group(0))
        raise


def plain_text_response(content: str, result_type: str) -> Dict[str, Any]:
    summary = (content or "").strip()
    if not summary:
        summary = "The model returned an empty response."
    is_chat = result_type in {"agent_chat", "chat_project"}
    return {
        "status": "ok",
        "result_type": result_type,
        "confidence": 0.85 if is_chat else 0.62,
        "summary": summary,
        "structured_output": {},
        "warnings": [] if is_chat else ["Provider returned plain text; treated it as a chat answer."],
        "requires_user_confirmation": False if is_chat else True,
    }


def looks_like_web_project(project: Dict[str, Any], output: Dict[str, Any]) -> bool:
    haystack = json.dumps({"project": project, "output": output}, ensure_ascii=False).lower()
    web_markers = [
        "fastapi",
        "flask",
        "django",
        "streamlit",
        "gradio",
        "uvicorn",
        "gunicorn",
        "express",
        "next",
        "vite",
        "react-scripts",
        "http.server",
        "listen(",
        "app.run",
        "server.js",
    ]
    return any(marker in haystack for marker in web_markers)


def normalize_ai_output(workflow: str, project: Dict[str, Any], parsed: Dict[str, Any]) -> Dict[str, Any]:
    if workflow != "generate_dockerfile":
        return parsed

    structured = parsed.get("structured_output")
    if not isinstance(structured, dict):
        return parsed

    dockerfile = structured.get("dockerfile")
    if isinstance(dockerfile, str) and not looks_like_web_project(project, structured):
        exposed_port = structured.get("exposed_port")
        has_expose = bool(re.search(r"(?im)^\s*EXPOSE\s+\d+\s*$", dockerfile))
        if exposed_port or has_expose:
            structured["exposed_port"] = None
            structured["dockerfile"] = re.sub(r"(?im)^\s*EXPOSE\s+\d+\s*\n?", "", dockerfile).strip() + "\n"
            warnings = parsed.setdefault("warnings", [])
            if isinstance(warnings, list):
                warnings.append("Removed exposed_port/EXPOSE because the project looks like a CLI or one-shot script.")
    return parsed


async def post_chat_completion(
    client: httpx.AsyncClient,
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    *,
    temperature: float = 0.2,
    model_mode: str = "fast",
    prefer_json: bool = True,
    max_tokens: int = 2048,
    force_stream: bool = False,
) -> Dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    use_stream = force_stream or bool(model_extra_body(model, model_mode)) or env_flag("NVIDIA_NIM_STREAM_ALL", False)
    if use_stream:
        return await post_chat_completion_stream(
            client,
            base_url,
            headers,
            model,
            prompt,
            temperature=temperature,
            model_mode=model_mode,
            max_tokens=max_tokens,
        )

    response = await client.post(
        f"{base_url}/chat/completions",
        headers=headers,
        json=chat_payload(
            model,
            prompt,
            json_mode=prefer_json,
            temperature=temperature,
            model_mode=model_mode,
            max_tokens=max_tokens,
        ),
    )
    if response.status_code in {400, 404, 422} and (prefer_json or "response_format" in response.text.lower()):
        response = await client.post(
            f"{base_url}/chat/completions",
            headers=headers,
            json=chat_payload(
                model,
                prompt,
                json_mode=False,
                temperature=temperature,
                model_mode=model_mode,
                max_tokens=max_tokens,
            ),
        )
    response.raise_for_status()
    return response.json()


async def post_chat_completion_stream(
    client: httpx.AsyncClient,
    base_url: str,
    headers: Dict[str, str],
    model: str,
    prompt: str,
    *,
    temperature: float,
    model_mode: str,
    max_tokens: int,
) -> Dict[str, Any]:
    content_parts: List[str] = []
    reasoning_parts: List[str] = []
    usage: Dict[str, Any] = {}
    payload = chat_payload(
        model,
        prompt,
        json_mode=False,
        temperature=temperature,
        model_mode=model_mode,
        stream=True,
        max_tokens=max_tokens,
    )
    async with client.stream(
        "POST",
        f"{base_url}/chat/completions",
        headers=headers,
        json=payload,
    ) as response:
        response.raise_for_status()
        async for line in response.aiter_lines():
            line = line.strip()
            if not line or line.startswith(":"):
                continue
            if line.startswith("data:"):
                line = line[5:].strip()
            if line == "[DONE]":
                break
            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(chunk.get("usage"), dict):
                usage = chunk["usage"]
            choices = chunk.get("choices") if isinstance(chunk, dict) else None
            if not isinstance(choices, list) or not choices:
                continue
            delta = choices[0].get("delta") if isinstance(choices[0], dict) else {}
            if not isinstance(delta, dict):
                continue
            reasoning = delta.get("reasoning_content")
            if isinstance(reasoning, str):
                reasoning_parts.append(reasoning)
            content = delta.get("content")
            if isinstance(content, str):
                content_parts.append(content)

    content = "".join(content_parts).strip()
    if not content and reasoning_parts:
        content = "".join(reasoning_parts).strip()
    return {"choices": [{"message": {"content": content}}], "usage": usage}


def schema_instruction(result_type: str) -> str:
    if result_type == "generate_dockerfile":
        return """
Return only JSON with this schema:
{
  "status": "ok",
  "result_type": "generate_dockerfile",
  "confidence": 0.75,
  "summary": "what project type was detected and why this Dockerfile was chosen",
  "structured_output": {
    "dockerfile": "complete Dockerfile text",
    "exposed_port": null,
    "start_command": "command the container runs",
    "entrypoint_file": "file used as the entrypoint",
    "detected_project_type": "python-script|python-web|node|go|rust|java|unknown",
    "reasoning": "brief explanation of file-tree evidence used"
  },
  "warnings": [],
  "requires_user_confirmation": true
}
Do not include markdown outside JSON.
The Dockerfile must be complete and buildable.
Do not copy secrets explicitly. Do not install unnecessary global tools.
Only set exposed_port or add EXPOSE when the project starts an HTTP server.
For single-file or multi-file scripts, do not add EXPOSE and run the inferred entrypoint file.
If there are multiple Python files, infer the entrypoint from app.py/main.py/README/imports/__main__ patterns; otherwise choose the most likely top-level script and explain uncertainty in warnings.
"""
    summary_hint = (
        "helpful markdown answer with context, cause, and next steps"
        if result_type in {"agent_chat", "chat_project"}
        else "short human-readable summary"
    )
    return f"""
Return only JSON with this schema:
{{
  "status": "ok",
  "result_type": "{result_type}",
  "confidence": 0.75,
  "summary": "{summary_hint}",
  "structured_output": {{}},
  "warnings": [],
  "requires_user_confirmation": true
}}
Do not include markdown. Do not suggest executing destructive commands automatically.
Generated Dockerfiles must be deterministic, minimal, and avoid copying secrets.
Only set exposed_port or add EXPOSE when the project starts an HTTP server.
For one-shot scripts or CLI programs, use exposed_port null and do not add EXPOSE.
"""


def build_prompt(workflow: str, req: AgentRequest) -> str:
    payload = {
        "workflow": workflow,
        "project": safe_json(req.project),
        "deployment": safe_json(req.deployment),
        "source": safe_json(req.source),
        "runtime": safe_json(req.runtime),
        "logs": redact_text(req.logs),
        "message": redact_text(req.message),
        "command": redact_text(req.command),
        "model_mode": req.model_mode,
        "history": safe_json(req.history[-12:]),
        "confidence_threshold": req.confidence_threshold,
    }
    base = {
        "analyze_project": (
            "You are the AIDS build intelligence agent. Classify the project, infer runtime, "
            "entrypoint, framework, exposed port, confidence, and whether deterministic support already applies."
        ),
        "generate_dockerfile": (
            "You are generating a Dockerfile from an actual source tree scan. Read the file list and excerpts before choosing a runtime. "
            "For Python projects, distinguish web apps from one-shot scripts. If there are multiple Python files, identify the best entrypoint "
            "from filenames, README, imports, framework usage, and __main__ guards. Include exposed_port only for HTTP servers."
        ),
        "analyze_build_failure": (
            "Analyze the failed deployment/build logs. Identify root cause, safe fix steps, likely files to inspect, "
            "and whether user confirmation is required."
        ),
        "analyze_runtime_failure": (
            "Analyze runtime health, Kubernetes events, logs, and metrics. Explain likely runtime failure causes and safe remediations."
        ),
        "chat_project": (
            "Answer the user's project question using only the supplied context. Be concise, practical, and flag uncertainty."
        ),
        "agent_chat": (
            "You are the AIDS platform agent, a production DevOps copilot. Interpret slash commands and natural language. "
            "You may recommend builds, deployments, Dockerfile changes, and diagnosis steps, but you do not claim to have "
            "executed platform actions unless the caller says an action result is present in runtime. Explain the why, what it means, "
            "and the next safe action. For errors, include likely cause, evidence from context, and concrete fixes. Do not give a one-line answer unless the user asks for one. "
            "When permissions indicate full access, describe the exact platform actions you would execute or have been asked to execute; otherwise ask for confirmation before destructive or remote-terminal actions."
        ),
    }.get(workflow, "Analyze this deployment context safely.")
    if workflow in {"agent_chat", "chat_project"}:
        return (
            base
            + "\nReturn a clear markdown answer for the user. Use short paragraphs and numbered steps when helpful. "
            + "Do not wrap the answer in JSON."
            + "\nContext:\n"
            + json.dumps(payload, ensure_ascii=False)
        )
    return base + "\n" + schema_instruction(workflow) + "\nContext:\n" + json.dumps(payload, ensure_ascii=False)


async def call_model(req: AgentRequest, prompt: str) -> AgentResponse:
    trace_id = str(uuid.uuid4())
    provider, base_url, api_key, model = provider_config(req.provider, req.model, req.model_mode)
    start = time.perf_counter()

    if req.model_mode == "fast" and (req.workflow_type or "") == "agent_chat":
        simple = (req.message or "").strip().lower()
        if simple in {"hi", "hello", "hey", "yo", "sup"}:
            return AgentResponse(
                status="ok",
                result_type="agent_chat",
                confidence=1.0,
                summary="Hi. I am ready to help with deployments, builds, Dockerfile planning, or diagnosis.",
                structured_output={},
                warnings=[],
                requires_user_confirmation=False,
                trace_id=trace_id,
                provider=provider,
                model="instant-fast-path",
                latency_ms=int((time.perf_counter() - start) * 1000),
                token_usage={},
            )

    if not base_url or not api_key:
        return AgentResponse(
            status="error",
            result_type=req.workflow_type or "unknown",
            summary="AI provider is not configured. Deterministic deployment remains available.",
            warnings=["Missing AI provider base URL or API key."],
            requires_user_confirmation=True,
            trace_id=trace_id,
            provider=provider,
            model=model,
            latency_ms=0,
            error="provider_not_configured",
        )

    try:
        timeout = httpx.Timeout(DEFAULT_TIMEOUT, connect=10.0, read=DEFAULT_TIMEOUT, write=10.0, pool=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            payload = await post_chat_completion(
                client,
                base_url,
                api_key,
                model,
                prompt,
                temperature=0.1 if req.model_mode == "thinking" else 0.25,
                model_mode=req.model_mode,
                prefer_json=req.workflow_type not in {"agent_chat", "chat_project"},
                max_tokens=4096 if req.model_mode == "thinking" else 1536,
            )
        content = payload.get("choices", [{}])[0].get("message", {}).get("content", "{}")
        try:
            parsed = parse_model_json(content)
        except json.JSONDecodeError:
            parsed = plain_text_response(content, req.workflow_type or "unknown")
        parsed = normalize_ai_output(req.workflow_type or "unknown", req.project, parsed)
        usage = payload.get("usage", {}) or {}
        latency_ms = int((time.perf_counter() - start) * 1000)
        return AgentResponse(
            status=parsed.get("status", "ok"),
            result_type=parsed.get("result_type", req.workflow_type or "unknown"),
            confidence=float(parsed.get("confidence", 0.0) or 0.0),
            summary=str(parsed.get("summary", "")),
            structured_output=parsed.get("structured_output", {}) or {},
            warnings=parsed.get("warnings", []) or [],
            requires_user_confirmation=bool(parsed.get("requires_user_confirmation", True)),
            trace_id=trace_id,
            provider=provider,
            model=model,
            latency_ms=latency_ms,
            token_usage=usage,
        )
    except httpx.HTTPStatusError as exc:
        status_code = exc.response.status_code
        detail = redact_text((exc.response.text or "")[:800])
        fallback_provider, fallback_base_url, fallback_api_key, fallback_model = provider_config(
            req.provider,
            None,
            req.model_mode,
        )
        if req.model and fallback_model and fallback_model != model and fallback_base_url and fallback_api_key:
            try:
                timeout = httpx.Timeout(DEFAULT_TIMEOUT, connect=10.0, read=DEFAULT_TIMEOUT, write=10.0, pool=10.0)
                async with httpx.AsyncClient(timeout=timeout) as client:
                    payload = await post_chat_completion(
                        client,
                        fallback_base_url,
                        fallback_api_key,
                        fallback_model,
                        prompt,
                        temperature=0.1 if req.model_mode == "thinking" else 0.25,
                        model_mode=req.model_mode,
                        prefer_json=req.workflow_type not in {"agent_chat", "chat_project"},
                        max_tokens=4096 if req.model_mode == "thinking" else 1536,
                    )
                content = payload.get("choices", [{}])[0].get("message", {}).get("content", "{}")
                try:
                    parsed = parse_model_json(content)
                except json.JSONDecodeError:
                    parsed = plain_text_response(content, req.workflow_type or "unknown")
                parsed = normalize_ai_output(req.workflow_type or "unknown", req.project, parsed)
                usage = payload.get("usage", {}) or {}
                latency_ms = int((time.perf_counter() - start) * 1000)
                warnings = parsed.get("warnings", []) or []
                warnings = [
                    f"Selected model {model} failed with provider HTTP {status_code}; retried with {fallback_model}.",
                    *warnings,
                ]
                if detail:
                    warnings.append(detail)
                return AgentResponse(
                    status=parsed.get("status", "ok"),
                    result_type=parsed.get("result_type", req.workflow_type or "unknown"),
                    confidence=float(parsed.get("confidence", 0.0) or 0.0),
                    summary=str(parsed.get("summary", "")),
                    structured_output=parsed.get("structured_output", {}) or {},
                    warnings=warnings,
                    requires_user_confirmation=bool(parsed.get("requires_user_confirmation", True)),
                    trace_id=trace_id,
                    provider=fallback_provider,
                    model=fallback_model,
                    latency_ms=latency_ms,
                    token_usage=usage,
                )
            except Exception as retry_exc:
                retry_detail = redact_text(str(retry_exc)[:800])
                detail = f"{detail}\nFallback retry failed: {retry_detail}" if detail else f"Fallback retry failed: {retry_detail}"
        return AgentResponse(
            status="error",
            result_type=req.workflow_type or "unknown",
            confidence=0.0,
            summary=f"AI provider returned HTTP {status_code}. Deterministic deployment remains available.",
            warnings=["Provider request failed.", detail] if detail else ["Provider request failed."],
            requires_user_confirmation=True,
            trace_id=trace_id,
            provider=provider,
            model=model,
            latency_ms=int((time.perf_counter() - start) * 1000),
            error=f"provider_http_{status_code}",
        )
    except json.JSONDecodeError as exc:
        return AgentResponse(
            status="error",
            result_type=req.workflow_type or "unknown",
            confidence=0.0,
            summary="AI provider returned a non-JSON response. Deterministic deployment remains available.",
            warnings=["Provider response could not be parsed as structured JSON."],
            requires_user_confirmation=True,
            trace_id=trace_id,
            provider=provider,
            model=model,
            latency_ms=int((time.perf_counter() - start) * 1000),
            error=f"invalid_provider_json:{exc}",
        )
    except Exception as exc:
        detail = redact_text(str(exc)[:800])
        if not detail:
            detail = exc.__class__.__name__
        return AgentResponse(
            status="error",
            result_type=req.workflow_type or "unknown",
            confidence=0.0,
            summary="AI analysis failed. Deterministic deployment remains available.",
            warnings=["Provider request failed.", detail],
            requires_user_confirmation=True,
            trace_id=trace_id,
            provider=provider,
            model=model,
            latency_ms=int((time.perf_counter() - start) * 1000),
            error=str(exc),
        )


def make_graph(workflow: str):
    async def inspect_context(state: AgentState) -> AgentState:
        req = state["request"]
        warnings = []
        if len(req.logs or "") > MAX_TEXT:
            warnings.append("Logs were clipped before model analysis.")
        return {"request": req, "workflow": workflow, "warnings": warnings}

    async def prompt_node(state: AgentState) -> AgentState:
        return {**state, "prompt": build_prompt(workflow, state["request"])}

    async def model_node(state: AgentState) -> AgentState:
        response = await call_model(state["request"], state["prompt"])
        merged = response.model_dump()
        merged["warnings"] = list(dict.fromkeys((state.get("warnings") or []) + (merged.get("warnings") or [])))
        return {**state, "response": merged}

    graph = StateGraph(AgentState)
    graph.add_node("inspect_context", inspect_context)
    graph.add_node("build_prompt", prompt_node)
    graph.add_node("call_provider", model_node)
    graph.set_entry_point("inspect_context")
    graph.add_edge("inspect_context", "build_prompt")
    graph.add_edge("build_prompt", "call_provider")
    graph.add_edge("call_provider", END)
    return graph.compile()


async def run_workflow(workflow: str, request: AgentRequest) -> AgentResponse:
    request.workflow_type = workflow
    graph = make_graph(workflow)
    state = await graph.ainvoke({"request": request})
    return AgentResponse(**state["response"])


@app.get("/health")
async def health() -> Dict[str, Any]:
    provider, base_url, api_key, model = provider_config(None, None)
    return {
        "status": "ok",
        "service": "aids-ai-service",
        "provider": provider,
        "model": model,
        "configured": bool(base_url and api_key),
    }


def fallback_models(provider: str) -> List[Dict[str, Any]]:
    if provider == "openai_compatible":
        return [
            {"id": os.getenv("OPENAI_COMPATIBLE_MODEL") or "gpt-4o-mini", "label": "Compatible fast", "mode": "fast"},
            {
                "id": os.getenv("OPENAI_COMPATIBLE_THINKING_MODEL") or os.getenv("OPENAI_COMPATIBLE_MODEL") or "gpt-4o",
                "label": "Compatible thinking",
                "mode": "thinking",
            },
        ]
    fast_model = os.getenv("NVIDIA_NIM_FAST_MODEL") or os.getenv("AIDS_AI_MODEL") or os.getenv("NVIDIA_NIM_MODEL") or "meta/llama-3.1-70b-instruct"
    thinking_model = os.getenv("NVIDIA_NIM_THINKING_MODEL") or os.getenv("NVIDIA_NIM_MODEL") or fast_model
    allowed_raw = os.getenv("NVIDIA_NIM_ALLOWED_MODELS", "")
    allowed = [item.strip() for item in allowed_raw.split(",") if item.strip()]
    models: List[Dict[str, Any]] = []
    for model_id in allowed or [fast_model, thinking_model]:
        if not any(item["id"] == model_id and item["mode"] == "fast" for item in models):
            models.append({"id": model_id, "label": model_id, "mode": "fast"})
        if model_id == thinking_model and not any(item["id"] == model_id and item["mode"] == "thinking" for item in models):
            models.append({"id": model_id, "label": model_id, "mode": "thinking"})
    return models


def is_chat_model(model_id: str) -> bool:
    lowered = model_id.lower()
    blocked = [
        "embed",
        "embedding",
        "bge",
        "rerank",
        "whisper",
        "tts",
        "guard",
        "moderation",
        "vision",
        "diffusion",
        "audio",
        "reward",
        "safety",
        "translate",
        "parse",
        "-vl",
    ]
    if any(token in lowered for token in blocked):
        return False
    return any(
        token in lowered
        for token in [
            "instruct",
            "chat",
            "llama",
            "nemotron",
            "deepseek",
            "qwen",
            "mixtral",
            "mistral",
            "yi-",
            "jamba",
            "glm",
            "coder",
            "starcoder",
        ]
    )


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def model_mode_for(model_id: str) -> str:
    lowered = (model_id or "").lower()
    if any(token in lowered for token in ["70b", "405b", "nemotron", "reason", "thinking", "glm"]):
        return "thinking"
    return "fast"


async def probe_model(
    client: httpx.AsyncClient,
    base_url: str,
    api_key: str,
    model_id: str,
    mode: str,
) -> bool:
    try:
        payload = await post_chat_completion(
            client,
            base_url,
            api_key,
            model_id,
            "Reply with OK only.",
            temperature=0.0,
            model_mode=mode,
            prefer_json=False,
            max_tokens=32,
            force_stream=True,
        )
        content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
        return bool(str(content).strip())
    except Exception:
        return False


async def filter_working_models(
    base_url: str,
    api_key: str,
    candidates: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    if not env_flag("NVIDIA_NIM_PROBE_MODELS", True):
        return candidates[:MODEL_PROBE_LIMIT]

    now = time.time()
    if MODEL_PROBE_CACHE["expires_at"] > now and MODEL_PROBE_CACHE["models"]:
        return MODEL_PROBE_CACHE["models"]

    unique: List[Dict[str, Any]] = []
    seen = set()
    for item in candidates:
        model_id = item.get("id")
        if not isinstance(model_id, str) or model_id in seen:
            continue
        seen.add(model_id)
        unique.append(item)
        if len(unique) >= MODEL_PROBE_LIMIT:
            break

    timeout = httpx.Timeout(MODEL_PROBE_TIMEOUT, connect=8.0, read=MODEL_PROBE_TIMEOUT, write=8.0, pool=8.0)
    semaphore = asyncio.Semaphore(int(os.getenv("NVIDIA_NIM_MODEL_PROBE_CONCURRENCY", "6")))
    async with httpx.AsyncClient(timeout=timeout) as client:
        async def run(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            async with semaphore:
                model_id = item["id"]
                mode = item.get("mode") or model_mode_for(model_id)
                if await probe_model(client, base_url, api_key, model_id, mode):
                    return item
                return None

        results = await asyncio.gather(*(run(item) for item in unique))

    working = [item for item in results if item is not None]
    if working:
        MODEL_PROBE_CACHE["models"] = working
        MODEL_PROBE_CACHE["expires_at"] = now + MODEL_PROBE_CACHE_TTL
    return working


@app.get("/models")
async def models() -> Dict[str, Any]:
    provider, base_url, api_key, selected_model = provider_config(None, None)
    models_out = fallback_models(provider)
    source = "fallback"

    if provider == "nvidia_nim" and base_url and api_key and env_flag("NVIDIA_NIM_DISCOVER_MODELS", True):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(f"{base_url}/models", headers={"Authorization": f"Bearer {api_key}"})
            response.raise_for_status()
            payload = response.json()
            data = payload.get("data", []) if isinstance(payload, dict) else []
            discovered = []
            for item in data:
                model_id = item.get("id") if isinstance(item, dict) else None
                if isinstance(model_id, str) and model_id and is_chat_model(model_id):
                    discovered.append(
                        {
                            "id": model_id,
                            "label": model_id,
                            "mode": model_mode_for(model_id),
                        }
                    )
            if discovered:
                preferred = {
                    os.getenv("NVIDIA_NIM_FAST_MODEL") or "meta/llama-3.1-8b-instruct": 0,
                    os.getenv("NVIDIA_NIM_MODEL") or "meta/llama-3.1-70b-instruct": 1,
                    os.getenv("AIDS_AI_MODEL") or "": 2,
                }
                discovered.sort(key=lambda item: (preferred.get(item["id"], 50), item["mode"] != "fast", item["id"]))
                working = await filter_working_models(base_url, api_key, discovered)
                if working:
                    models_out = working
                    source = "provider_verified"
                else:
                    source = "fallback_probe_failed"
        except Exception as exc:
            models_out = fallback_models(provider)
            source = "fallback"

    return {
        "status": "ok",
        "provider": provider,
        "selected_model": selected_model,
        "source": source,
        "models": models_out,
        "modes": [
            {"id": "fast", "label": "Fast", "description": "Lower latency chat and simple commands."},
            {"id": "thinking", "label": "Thinking", "description": "Deeper diagnosis and deployment planning."},
        ],
    }


@app.post("/analyze/project", response_model=AgentResponse)
async def analyze_project(request: AgentRequest) -> AgentResponse:
    return await run_workflow("analyze_project", request)


@app.post("/generate/dockerfile", response_model=AgentResponse)
async def generate_dockerfile(request: AgentRequest) -> AgentResponse:
    return await run_workflow("generate_dockerfile", request)


@app.post("/analyze/build-failure", response_model=AgentResponse)
async def analyze_build_failure(request: AgentRequest) -> AgentResponse:
    return await run_workflow("analyze_build_failure", request)


@app.post("/analyze/runtime-failure", response_model=AgentResponse)
async def analyze_runtime_failure(request: AgentRequest) -> AgentResponse:
    return await run_workflow("analyze_runtime_failure", request)


@app.post("/chat/project", response_model=AgentResponse)
async def chat_project(request: AgentRequest) -> AgentResponse:
    return await run_workflow("chat_project", request)


@app.post("/chat/agent", response_model=AgentResponse)
async def chat_agent(request: AgentRequest) -> AgentResponse:
    return await run_workflow("agent_chat", request)
