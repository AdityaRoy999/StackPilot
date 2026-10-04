import unittest
import hashlib
import httpx
from unittest.mock import patch
from app.runtime_verification import request_url,verify_contract


class RuntimeContracts(unittest.IsolatedAsyncioTestCase):
    async def test_agent_cannot_read_internal_provider_credentials(self):
        from app.tools import execute_tool_call
        result=await execute_tool_call('_internal_repair_settings',{},'fixture-user')
        self.assertIn('error',result);self.assertNotIn('provider_overrides',result)
    def test_check_cannot_escape_origin(self):
        for path in ('//other.test/','/\\other.test/','https://other.test/','/ok\r\nInjected: true'):
            with self.assertRaises(ValueError):request_url('http://localhost:8080',path)
        self.assertEqual(request_url('http://localhost:8080','/health?ready=1'),'http://host.docker.internal:8080/health?ready=1')
        self.assertEqual(request_url('http://portfolio.localhost:56653','/'),'http://host.docker.internal:56653/')
    async def test_api_assertions_are_checked(self):
        transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'ready':True,'service':'api'}))
        original=httpx.AsyncClient
        with patch('app.runtime_verification.httpx.AsyncClient',side_effect=lambda **kwargs:original(transport=transport,**kwargs)):
            passed=await verify_contract('http://api.test',{'checks':[{'path':'/ready','json_contains':{'ready':True}}]})
            failed=await verify_contract('http://api.test',{'checks':[{'path':'/ready','json_contains':{'ready':False}}]})
        self.assertTrue(passed['verified']);self.assertFalse(failed['verified']);self.assertEqual(failed['status'],'failed')
    async def test_healthy_artifact_portal_requires_actual_artifacts(self):
        transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'artifacts':[]}))
        original=httpx.AsyncClient
        with patch('app.runtime_verification.httpx.AsyncClient',side_effect=lambda **kwargs:original(transport=transport,**kwargs)):
            result=await verify_contract('http://artifact.test',{'workload':'android','health_path':'/healthz'})
        self.assertFalse(result['verified'])
    async def test_generic_artifact_preview_rejects_invalid_inventory(self):
        original=httpx.AsyncClient
        for artifact in ({'sha256':'invented','size':42}, {'sha256':'a'*64,'size':True}, 'not-an-artifact'):
            transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'artifacts':[artifact]}))
            with patch('app.runtime_verification.httpx.AsyncClient',side_effect=lambda **kwargs:original(transport=transport,**kwargs)):
                result=await verify_contract('http://artifact.test',{'workload':'artifact','verification_scope':'artifact_delivery','health_path':'/healthz'})
            self.assertEqual(result['status'],'failed');self.assertFalse(result['verified'])
    async def test_artifact_hash_is_verified_against_download(self):
        payload=b'real fixture binary'
        inventory={'artifacts':[{'name':'app.apk','size':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}]}
        original=httpx.AsyncClient
        contract={'workload':'artifact','verification_scope':'artifact_delivery','health_path':'/healthz'}
        for delivered in (payload,b'corrupt fixture binary'):
            def respond(request):
                return httpx.Response(200,json=inventory) if request.url.path=='/healthz' else httpx.Response(200,content=delivered)
            with patch('app.runtime_verification.httpx.AsyncClient',side_effect=lambda **kwargs:original(transport=httpx.MockTransport(respond),**kwargs)):
                result=await verify_contract('http://artifact.test',contract)
            self.assertEqual(result['verified'],delivered==payload)
        with patch('app.runtime_verification.httpx.AsyncClient',side_effect=lambda **kwargs:original(transport=httpx.MockTransport(lambda request:httpx.Response(200,json=inventory)),**kwargs)):
            observed=await verify_contract('http://artifact.test',contract,download_artifacts=False)
        self.assertEqual(observed['scope'],'artifact_inventory')
    async def test_endpoint_outage_is_not_a_healthy_process(self):
        def outage(request):raise httpx.ConnectError('fixture refusal',request=request)
        original=httpx.AsyncClient
        with patch('app.runtime_verification.httpx.AsyncClient',side_effect=lambda **kwargs:original(transport=httpx.MockTransport(outage),**kwargs)):
            result=await verify_contract('http://api.test',{})
        self.assertEqual(result['status'],'failed');self.assertFalse(result['verified'])
