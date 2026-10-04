"""Use existing selected-provider semantics; persist no provider credentials."""
import asyncio
import json
import os
import httpx


class ProviderStreamError(RuntimeError):
    """Some compatible providers return errors inside HTTP 200 responses."""
    def __init__(self, error):
        from app.main import redact_text
        if not isinstance(error,dict):error={'message':str(error)}
        code=error.get('status_code',error.get('code'))
        try:self.status_code=int(code)
        except (TypeError,ValueError):self.status_code=None
        self.detail=redact_text(str(error.get('message') or error.get('type') or 'Provider stream error'))[:700]
        super().__init__(self.detail)


def reconcile_unanswered_calls(messages):
    """Close undelivered calls after a recovered turn without replaying them.

    A dispatched ambiguous call retains a pending checkpoint and is blocked by
    the runner until reconciliation. Missing replies here are undispatched
    siblings in an interrupted multi-call response.
    """
    result=[]
    index=0
    while index<len(messages):
        message=messages[index]
        result.append(message)
        index+=1
        calls=message.get('tool_calls') if message.get('role')=='assistant' else None
        if not calls:continue
        answered=set()
        while index<len(messages) and messages[index].get('role')=='tool':
            answered.add(messages[index].get('tool_call_id'))
            result.append(messages[index])
            index+=1
        for call in calls:
            if call.get('id') not in answered:
                result.append({'role':'tool','tool_call_id':call['id'],'content':json.dumps({
                    'status':'not_executed','error':'Interrupted before dispatch. Observe current state and choose the next action again.'})})
    return result


def bounded_context(messages, max_bytes=96000):
    """Retain whole tool exchanges and immutable instructions, not half a call."""
    if len(json.dumps(messages).encode()) <= max_bytes:
        return messages
    fixed = messages[:2]
    starts = [index for index,message in enumerate(messages[2:],2) if message.get('role')=='assistant']
    for start in starts:
        retained=fixed+[{'role':'user','content':'Earlier tool exchanges were compacted. Read files and teammate results to recover evidence; never assume unrecorded work passed.'}]+messages[start:]
        if len(json.dumps(retained).encode())<=max_bytes:
            return retained
    raise RuntimeError('Latest tool exchange exceeds model context budget; use smaller reads/tasks')


class ChatProvider:
    def __init__(self, broker):
        self.broker = broker
        self.live_overrides = {}
        self.client = None

    async def close(self):
        if self.client is not None:
            await self.client.aclose()
            self.client=None
        self.live_overrides.clear()

    def get_client(self):
        if self.client is None or self.client.is_closed:
            timeout=max(15,min(300,float(os.getenv('STACKPILOT_TEAM_PROVIDER_TIMEOUT_SECONDS','120'))))
            self.client=httpx.AsyncClient(timeout=httpx.Timeout(timeout,connect=15),trust_env=False,
                limits=httpx.Limits(max_connections=16,max_keepalive_connections=8,keepalive_expiry=60))
        return self.client

    async def request(self,base,key,payload):
        client=self.get_client()
        retries=max(0,min(3,int(os.getenv('STACKPILOT_TEAM_PROVIDER_RETRIES','2'))))
        for attempt in range(retries+1):
            try:
                response=await client.post(base.rstrip('/')+'/chat/completions',json=payload,
                    headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
                response.raise_for_status()
                result=response.json()
                if isinstance(result,dict) and result.get('error'):raise ProviderStreamError(result['error'])
                return result
            except (httpx.TransportError,httpx.HTTPStatusError,ProviderStreamError) as exc:
                code=exc.status_code if isinstance(exc,ProviderStreamError) else (exc.response.status_code if isinstance(exc,httpx.HTTPStatusError) else None)
                retryable=isinstance(exc,httpx.TransportError) or code in {429,500,502,503,504}
                from .context import actor_context
                actor=actor_context.get()
                if actor is not None:
                    if code is not None:
                        await actor.runtime.emit(actor,{'type':'provider_error','status_code':code,
                            'message':exc.detail if isinstance(exc,ProviderStreamError) else 'Provider request failed (HTTP '+str(code)+')'})
                if not retryable or attempt==retries:raise
                if actor is not None:
                    await actor.runtime.emit(actor,{'type':'provider_retry','retry':attempt+1,'reason':type(exc).__name__})
                await asyncio.sleep(min(4,.5*2**attempt))

    async def complete(self, run, messages, tools):
        from app.main import provider_config, chat_payload
        settings = json.loads(run['settings'])
        # Recover credentials from authenticated backend settings after restart.
        configured = await self.broker('_internal_repair_settings', {}, run['user_id'])
        overrides = self.live_overrides.get(run['id']) or configured.get('provider_overrides') or {}
        provider, base, key, model = provider_config(settings.get('provider') or configured.get('provider'),
            settings.get('model') or configured.get('model'), settings.get('model_mode', 'fast'), overrides)
        if not key:
            raise RuntimeError('Selected model provider has no configured credential')
        payload = chat_payload(model, messages=bounded_context(messages), model_mode=settings.get('model_mode', 'fast'), tools=tools,
                               max_tokens=4096, stream=False)
        result=await self.request(base,key,payload)
        choices = result.get('choices') or []
        if not choices or not isinstance(choices[0].get('message'), dict):
            raise RuntimeError('Selected provider returned no assistant message')
        return choices[0]['message'], result.get('usage') or {}
