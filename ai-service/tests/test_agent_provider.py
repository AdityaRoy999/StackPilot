import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

from app.agent_runtime.providers import ChatProvider, reconcile_unanswered_calls


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    def test_sse_errors_have_the_dashboard_error_field_without_mutating_the_producer(self):
        import json
        from app.main import _sse
        original={'type':'error','message':'Selected provider is overloaded.'}
        emitted=json.loads(_sse(original)[6:])
        self.assertEqual(emitted['error'],original['message'])
        self.assertNotIn('error',original)
        existing=json.loads(_sse({'type':'error','error':'Actual executor failure','message':'Other text'})[6:])
        self.assertEqual(existing['error'],'Actual executor failure')

    def test_selected_nemotron_uses_coding_agent_effort_profile_without_rerouting(self):
        from app.main import chat_payload, provider_config
        model='nvidia/nemotron-3-super-120b-a12b'
        for mode in ('fast','thinking'):
            payload=chat_payload(model,prompt='Deploy this repository',model_mode=mode)
            self.assertEqual(payload['model'],model)
            self.assertTrue(payload['chat_template_kwargs']['enable_thinking'])
            self.assertTrue(payload['chat_template_kwargs']['force_nonempty_content'])
            self.assertEqual(payload['chat_template_kwargs']['low_effort'],mode=='fast')
            self.assertEqual(payload['temperature'],1.0)
            self.assertEqual(payload['top_p'],0.95)
        self.assertEqual(provider_config('nvidia_nim',model,'fast',{})[3],model)
        # Model-specific template flags must not leak to unrelated providers.
        self.assertNotIn('chat_template_kwargs',chat_payload('fixture-model',prompt='Inspect'))

    def test_glm_53_fast_mode_uses_supported_reasoning_budget(self):
        from app.main import chat_payload
        fast=chat_payload('z-ai/glm-5.3-flash',prompt='Inspect source',model_mode='fast')
        thinking=chat_payload('z-ai/glm-5.3-flash',prompt='Inspect source',model_mode='thinking')
        self.assertEqual(fast['reasoning_effort'],'low')
        self.assertEqual(thinking['reasoning_effort'],'high')
        self.assertNotIn('enable_thinking',fast['chat_template_kwargs'])

    async def test_streaming_lead_reuses_pool_without_closing_teammate_client(self):
        from app.main import _agent_model_client
        provider=ChatProvider(None)
        provider.client=httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request:httpx.Response(200,text='data: [DONE]\n\n')))
        actor=SimpleNamespace(runtime=SimpleNamespace(provider=provider))
        observed=[]
        for _ in range(2):
            async with _agent_model_client(actor,httpx.Timeout(5)) as client:
                observed.append(client)
                async with client.stream('POST','https://provider.example/v1') as response:
                    self.assertEqual(await response.aread(),b'data: [DONE]\n\n')
            self.assertFalse(provider.client.is_closed)
        self.assertIs(observed[0],observed[1])
        await provider.close()
        self.assertTrue(observed[0].is_closed)

    def test_explicit_model_selection_is_preserved_even_when_defaults_change(self):
        from app.main import provider_config
        with patch.dict('os.environ',{'NVIDIA_NIM_FAST_MODEL':'z-ai/glm-5.3-flash'}):
            self.assertEqual(provider_config('nvidia_nim','meta/llama-3.1-70b-instruct','fast',{})[3],'meta/llama-3.1-70b-instruct')
            self.assertEqual(provider_config('nvidia_nim',None,'fast',{})[3],'z-ai/glm-5.3-flash')
    def test_undispatched_sibling_is_closed_without_repeating_the_completed_tool(self):
        original=[{'role':'assistant','tool_calls':[{'id':'a'},{'id':'b'}]},
            {'role':'tool','tool_call_id':'a','content':'Actual completed result'},
            {'role':'user','content':'Resume after inspection'}]
        recovered=reconcile_unanswered_calls(original)
        self.assertEqual([m.get('tool_call_id') for m in recovered if m['role']=='tool'],['a','b'])
        self.assertIn('not_executed',recovered[2]['content'])
        self.assertEqual(reconcile_unanswered_calls(recovered),recovered)

    async def test_transient_provider_failure_retries_only_the_model_request(self):
        calls=[]
        def respond(request):
            calls.append(request)
            if len(calls)==1:raise httpx.ConnectTimeout('Fixture timeout',request=request)
            if len(calls)==2:return httpx.Response(503,json={'error':'Busy'})
            return httpx.Response(200,json={'choices':[{'message':{'content':'Recovered'}}]})
        provider=ChatProvider(None)
        provider.client=httpx.AsyncClient(transport=httpx.MockTransport(respond))
        with patch('app.agent_runtime.providers.asyncio.sleep',new=AsyncMock()):
            result=await provider.request('https://provider.example/v1','fixture-key',{'model':'fixture'})
        self.assertEqual(result['choices'][0]['message']['content'],'Recovered')
        self.assertEqual(len(calls),3)
        await provider.close()

    async def test_authentication_error_is_not_retried_or_silently_rerouted(self):
        calls=[]
        def respond(request):
            calls.append(request)
            return httpx.Response(401,json={'error':'Invalid fixture credential'})
        provider=ChatProvider(None)
        provider.client=httpx.AsyncClient(transport=httpx.MockTransport(respond))
        with self.assertRaises(httpx.HTTPStatusError):
            await provider.request('https://provider.example/v1','fixture-key',{'model':'user-selected'})
        self.assertEqual(len(calls),1)
        await provider.close()

    async def test_worker_retries_500_and_overload_envelopes_preserving_the_selected_model(self):
        payloads=[]
        def respond(request):
            import json
            payloads.append(json.loads(request.content))
            if len(payloads)==1:return httpx.Response(500,json={'error':'Hosted provider failure'})
            if len(payloads)==2:return httpx.Response(200,json={'error':{'code':503,'message':'Service temporarily overloaded'}})
            return httpx.Response(200,json={'choices':[{'message':{'content':'Recovered'}}]})
        provider=ChatProvider(None)
        provider.client=httpx.AsyncClient(transport=httpx.MockTransport(respond))
        payload={'model':'nvidia/nemotron-3-super-120b-a12b','messages':[{'role':'user','content':'Repair source'}]}
        with patch('app.agent_runtime.providers.asyncio.sleep',new=AsyncMock()):
            result=await provider.request('https://provider.example/v1','fixture-key',payload)
        self.assertEqual(result['choices'][0]['message']['content'],'Recovered')
        self.assertEqual(payloads,[payload]*3)
        await provider.close()
