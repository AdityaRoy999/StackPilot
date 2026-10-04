import hashlib
import json
import time
import unittest
from unittest.mock import patch
import httpx
from app.runtime_verification import verify_runtime


class ComponentVerification(unittest.IsolatedAsyncioTestCase):
    def fixture(self):
        graph={'primary_component':'api','execution_order':['api','worker']}
        contracts={'api':{'protocol':'http','port':8080,'workload':'api','verification_scope':'http_contract',
                          'checks':[{'path':'/ready','json_contains':{'ready':True}}]},
                   'worker':{'protocol':'process','workload':'worker','verification_scope':'process',
                             'process_checks':[{'argv':['test','-f','/ready'],'timeout_seconds':10}]}}
        contract={'repository_plan':graph,'component_contracts':contracts}
        digest=hashlib.sha256(json.dumps(contract,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        row={'service':'api','container_id':'a'*64,'image_id':'sha256:'+'b'*64,'expected_image_id':'sha256:'+'b'*64,
             'status':'running','running':True,'restart_count':0,'started_at':'2026-10-01T00:00:00Z','url':'http://localhost:53001'}
        worker={**row,'service':'worker','container_id':'c'*64,'url':None,'process_checks':[
            {'argv':['test','-f','/ready'],'exit_code':0,'timed_out':False,'truncated':False,'passed':True}]}
        contract['component_runtime']={'version':1,'project':'stackpilot-fixture','generated_at':time.time(),
                                      'contract_digest':digest,'components':{'api':row,'worker':worker}}
        return contract
    async def verify(self,contract,ready=True):
        original=httpx.AsyncClient
        transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'ready':ready}))
        with patch('app.runtime_verification.httpx.AsyncClient',side_effect=lambda **kwargs:original(transport=transport,**kwargs)):
            return await verify_runtime('http://localhost:53001',contract)
    async def test_secondary_checks_and_identity_are_required_for_whole_release(self):
        contract=self.fixture();result=await self.verify(contract)
        self.assertTrue(result['verified'],result);self.assertEqual(set(result['identities']),{'api','worker'})
        contract['component_runtime']['components']['worker']['process_checks'][0]['exit_code']=19
        result=await self.verify(contract)
        self.assertFalse(result['verified']);self.assertEqual(result['status'],'failed')
    async def test_http_failure_cannot_be_hidden_by_running_worker(self):
        result=await self.verify(self.fixture(),False)
        self.assertFalse(result['verified']);self.assertEqual(result['components']['api']['status'],'failed')
    async def test_model_success_flags_do_not_replace_missing_checks(self):
        contract=self.fixture();contract['component_runtime']['components']['worker']['process_checks']=[]
        contract['verified']=True
        result=await self.verify(contract)
        self.assertFalse(result['verified']);self.assertIn('not executed',result['reason'])
    async def test_contract_tampering_and_stale_identity_are_unverified(self):
        for mutate in (lambda c:c['component_contracts']['api']['checks'].clear(),
                       lambda c:c['component_runtime'].update(generated_at=time.time()-181),
                       lambda c:c['component_runtime']['components']['api'].update(image_id='sha256:'+'d'*64),
                       lambda c:c['component_runtime']['components']['api'].update(url='http://localhost:53002')):
            contract=self.fixture();mutate(contract)
            result=await self.verify(contract);self.assertFalse(result['verified']);self.assertEqual(result['status'],'unverified')
    async def test_running_finite_component_keeps_graph_pending(self):
        contract=self.fixture();contract['component_contracts']['worker']={'workload':'job','protocol':'http','port':3000,'verification_scope':'job_completion'}
        contract['component_runtime']['components']['worker']['url']='http://localhost:53003'
        canonical={k:contract[k] for k in ('repository_plan','component_contracts')}
        contract['component_runtime']['contract_digest']=hashlib.sha256(json.dumps(canonical,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        deadline=time.time()+60
        with patch('app.job_verification.verify_job',return_value={'status':'running','verified':False,'scope':'job_completion','job_execution_id':'e'*32,'job':{'deadline_at':deadline}}):
            result=await self.verify(contract)
        self.assertFalse(result['verified']);self.assertEqual(result['status'],'running')
        self.assertTrue(result['pending']);self.assertEqual(result['job_execution_ids'],{'worker':'e'*32})
        self.assertEqual(result['deadline_at'],deadline)

    async def test_single_root_component_keeps_ordinary_immutable_image_lane(self):
        contract={'repository_plan':{'components':[{'id':'api','root':'.'}]},'component_contracts':{'api':{}},
                  'workload':'api','verification_scope':'http_contract','checks':[{'path':'/ready','json_contains':{'ready':True}}]}
        self.assertTrue((await self.verify(contract))['verified'])
        self.assertFalse((await self.verify(contract,False))['verified'])

    async def test_serving_monitor_rechecks_restart_without_weakening_candidate_gate(self):
        contract=self.fixture();contract['component_runtime']['components']['worker']['restart_count']=2
        self.assertFalse((await self.verify(contract))['verified'])
        contract['component_runtime']['observation_mode']='serving'
        self.assertTrue((await self.verify(contract))['verified'])


if __name__=='__main__':unittest.main()
