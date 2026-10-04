import json
from typing import Any, Dict, Generator, List, Optional
import requests
from ..config import load_config, get_auth_token

class AIClient:
    def __init__(self, base_url: Optional[str] = None, timeout: int = 60):
        cfg = load_config()
        self.base_url = (base_url or cfg.get("backend_url", "http://localhost:8090")).rstrip("/") + "/api/v1/ai"
        self.timeout = timeout

    def _headers(self, accept: str = "application/json") -> Dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": accept}
        token = get_auth_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def check_health(self) -> Dict[str, Any]:
        try:
            r = requests.get(f"{self.base_url}/health", headers=self._headers(), timeout=5)
            if r.status_code == 200:
                return {"status": "ok", "data": r.json()}
            return {"status": "error", "error": f"HTTP {r.status_code}"}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    def list_models(self) -> List[Dict[str, Any]]:
        try:
            r = requests.get(f"{self.base_url}/models", headers=self._headers(), timeout=10)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list):
                    return data
                return data.get("models", [])
            return []
        except Exception:
            return []

    def stop_agent(self, session_id: str = "default") -> bool:
        try:
            r = requests.post(f"{self.base_url}/chat/stop", json={"session_id": session_id}, headers=self._headers(), timeout=5)
            return r.status_code == 200
        except Exception:
            return False

    def stream_chat(
        self,
        message: str,
        custom_url: Optional[str] = None,
        history: Optional[List[Dict[str, str]]] = None,
        model: Optional[str] = None,
        session_id: Optional[str] = None,
        workflow_type: str = "agent_chat",
        approval_token: Optional[str] = None,
        sandbox_mode: str = "local",
        model_mode: str = "fast",
    ) -> Generator[Dict[str, Any], None, None]:
        payload = {
            "message": message,
            "custom_url": custom_url,
            "session_id": session_id,
            "history": history or [],
            "workflow_type": workflow_type,
            "model": model,
            "sandbox_mode": sandbox_mode,
            "model_mode": model_mode,
            "approval_token": approval_token,
        }

        try:
            with requests.post(
                f"{self.base_url}/chat/stream",
                json=payload,
                stream=True,
                headers=self._headers(accept="text/event-stream"),
                timeout=self.timeout
            ) as resp:
                if resp.status_code != 200:
                    yield {"type": "error", "error": f"AI service returned HTTP {resp.status_code}: {resp.text}"}
                    return

                for line in resp.iter_lines(decode_unicode=True):
                    if not line:
                        continue
                    if line.startswith("data:"):
                        raw_json = line[5:].strip()
                        if not raw_json:
                            continue
                        try:
                            ev = json.loads(raw_json)
                            yield ev
                        except Exception:
                            pass
        except Exception as e:
            yield {"type": "error", "error": str(e)}

    def create_session(self) -> str:
        response = requests.post(f"{self.base_url}/sessions", headers=self._headers(), json={}, timeout=15)
        if response.status_code == 401:
            raise RuntimeError("Run stackpilot auth login before using the AI agent")
        response.raise_for_status()
        return response.json()["session"]["id"]

    def reviewed_stream(self, *, confirm, **options):
        """Resume only the exact signed step accepted by the operator."""
        pending = dict(options)
        while True:
            permission = None
            completed = None
            failed = False
            for event in self.stream_chat(**pending):
                yield event
                if event.get("type") == "permission_request":
                    permission = event
                elif event.get("type") == "done":
                    completed = event
                elif event.get("type") == "error":
                    failed = True
            if not permission:
                return
            if failed or not completed or completed.get("status") != "waiting_for_permission":
                yield {"type": "error", "error": "Approval stream did not complete safely; review the step again. No action dispatched."}
                return
            token = permission.get("token") or permission.get("approval_token")
            if not token:
                yield {"type": "error", "error": "Permission is missing its signed approval; no action dispatched"}
                return
            if not confirm(permission):
                yield {"type": "done", "status": "permission_declined", "verified": False}
                return
            pending.update(message="Approve this exact step and continue the original task.", approval_token=token)
