"""A single bounded model request: no tools, retries, fallback catalog, or raw errors."""
import asyncio
import time
import httpx


async def test_provider(provider, base_url, api_key, model, payload):
    if not base_url or not model or (provider != "openai_compatible" and not api_key):
        return {"ok": False, "error": "Save a provider connection and enter a model identifier first."}
    started = time.monotonic()
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        # Outer deadline includes body parsing; redirects never carry a saved key elsewhere.
        async with asyncio.timeout(20):
            async with httpx.AsyncClient(timeout=httpx.Timeout(18, connect=5), follow_redirects=False) as client:
                async with client.stream("POST", f"{base_url}/chat/completions", headers=headers, json=payload) as response:
                    if response.status_code != 200:
                        errors = {401: "Provider rejected the API key.", 403: "This key cannot access the selected model.",
                                  404: "Model or compatible API endpoint was not found.", 429: "Provider rate limit or quota reached."}
                        return {"ok": False, "error": errors.get(response.status_code, f"Provider returned HTTP {response.status_code}. Check model support and endpoint.")}
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > 65536:
                            return {"ok": False, "error": "Provider response exceeded the connection-test size limit."}
                    import json
                    result = json.loads(data)
        choices = result.get("choices", []) if isinstance(result, dict) else []
        message = choices[0].get("message", {}) if choices and isinstance(choices[0], dict) else {}
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            return {"ok": False, "error": "Provider did not return a text completion. Check that this is a chat model."}
        return {"ok": True, "model": model, "latency_ms": round((time.monotonic() - started) * 1000)}
    except (httpx.HTTPError, TimeoutError):
        return {"ok": False, "error": "Provider connection failed or timed out. Check network access and retry."}
    except (ValueError, TypeError, KeyError, IndexError):
        return {"ok": False, "error": "Provider returned an invalid chat response."}
