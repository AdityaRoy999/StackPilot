import asyncio
import hashlib
import hmac
import json
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch
from app import runtime_verification as verifier
from app.browser_ticket import verify


class ReleaseVerification(unittest.IsolatedAsyncioTestCase):
    async def test_failed_declared_endpoint_blocks_render_gate(self):
        with patch.object(verifier,'verify_contract',AsyncMock(return_value={'verified':False,'status':'failed','checks':[{'passed':False}]})):
            result=await verifier.verify_runtime('https://fixture.invalid',{'health_path':'/ready'})
        self.assertFalse(result['verified']);self.assertEqual(result['stage'],'http_contract')

    async def render(self,errors=(),assertions=None):
        state={'ready':'complete','text':'Application','response_status':200}
        session=types.SimpleNamespace(evaluate=AsyncMock(return_value=state),console_logs=list(errors))
        manager=types.SimpleNamespace(get_or_create_session=AsyncMock(return_value=session),close_session=AsyncMock())
        checks=[{'kind':'visible','selector':'#ready','expected':True}] if assertions is not None else []
        contract=AsyncMock(return_value={'verified':True,'checks':[{'path':'/ready','passed':True}]})
        with patch.dict(sys.modules,{'app.browser_driver':types.SimpleNamespace(browser_manager=manager)}),patch.object(verifier,'verify_contract',contract),patch('app.browser_testing.assertions.assert_browser_state',AsyncMock(return_value={'verification':{'verified':assertions}})):
            result=await verifier.verify_runtime('https://fixture.invalid',{'health_path':'/ready','browser_checks':checks})
        manager.close_session.assert_awaited_once();contract.assert_awaited_once()
        return result

    async def test_console_failure_does_not_become_green(self):
        self.assertFalse((await self.render([{'type':'error','message':'Uncaught error'}]))['verified'])

    async def test_failed_browser_readiness_blocks_promotion(self):
        self.assertFalse((await self.render(assertions=False))['verified'])

    async def test_passing_release_keeps_http_and_browser_evidence(self):
        result=await self.render(assertions=True)
        self.assertTrue(result['verified']);self.assertTrue(result['workflow_verified']);self.assertEqual(result['checks'][0]['path'],'/ready')

    def test_busy_application_is_not_ready(self):
        self.assertFalse(verifier.judge_render({'ready':'complete','text':'Loading','visible_busy':True})[0])


class BrowserCapabilities(unittest.TestCase):
    key='throwaway-test-key'
    def token(self,**values):
        claims={'session_id':'one','user_id':'fixture-user','control':False,'expires':200,**values}
        payload=json.dumps(claims).encode()
        return payload.hex()+'.'+hmac.new(self.key.encode(),payload,hashlib.sha256).hexdigest()
    def test_view_capability_preserves_permissions(self):
        self.assertFalse(verify(self.token(),'one',self.key,100)['control'])
    def test_expired_forged_cross_session_and_missing_key_are_rejected(self):
        for ticket,session,key,now in ((self.token(),'two',self.key,100),(self.token(),'one',self.key,201),(self.token()+'0','one',self.key,100),(self.token(),'one','',100),(self.token(control='true'),'one',self.key,100)):
            with self.subTest(session=session,now=now),self.assertRaises(ValueError):verify(ticket,session,key,now)


class RecurringMonitoring(unittest.TestCase):
    def test_release_submissions_are_not_replayed_without_monitoring_opt_in(self):
        from app.deployment_incidents import monitoring_contract
        release={'scenarios':[{'name':'Create order','steps':[{'action':'click','selector':'#submit'}]}],'browser_checks':[{'kind':'visible','selector':'#ready'}]}
        periodic=monitoring_contract(release)
        self.assertEqual(periodic['scenarios'],[])
        self.assertEqual(periodic['browser_checks'],release['browser_checks'])
        self.assertEqual(len(release['scenarios']),1)

    def test_explicit_monitoring_workflow_preserves_release_acceptance(self):
        from app.deployment_incidents import monitoring_contract
        release={'scenarios':[{'name':'Create order'}],'monitor_scenarios':[{'name':'Read order status'}]}
        self.assertEqual(monitoring_contract(release)['scenarios'],[{'name':'Read order status'}])
        self.assertEqual(release['scenarios'],[{'name':'Create order'}])
