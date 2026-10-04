import json
import time
import unittest

import httpx

from app.job_verification import observe,verify_job
from unittest.mock import patch


def state(**changes):
    now=time.time()
    result={'workload':'job','execution_id':'a'*32,'state':'running','started_at':now-2,
            'finished_at':None,'deadline_at':now+3598,'timeout_seconds':3600,'command_sha256':'b'*64,
            'exit_code':None,'timed_out':False,'truncated':False,'output':'progress 1/3\n','offset':13}
    result.update(changes)
    return result


class JobEvidence(unittest.TestCase):
    def test_running_job_never_counts_as_completed(self):
        result=observe(state(),{})
        self.assertEqual(result['status'],'running');self.assertFalse(result['verified'])
        self.assertTrue(result['pending']);self.assertEqual(result['job_execution_id'],'a'*32)

    def test_process_exit_and_matching_identity_required(self):
        current=state(state='completed',exit_code=0,finished_at=time.time())
        self.assertTrue(observe(current,{'job_execution_id':'a'*32})['verified'])
        restarted=observe(current,{'job_execution_id':'c'*32})
        self.assertEqual(restarted['status'],'failed');self.assertFalse(restarted['verified'])
        self.assertIn('restarted',restarted['reason'])

    def test_terminal_errors_and_timeout_do_not_pass(self):
        for changes in ({'state':'failed','exit_code':7,'finished_at':time.time()},
                        {'state':'timed_out','timed_out':True},
                        {'state':'cancelled'},
                        {'state':'completed','exit_code':7,'finished_at':time.time()},
                        {'state':'completed','exit_code':0,'finished_at':time.time(),'timed_out':True}):
            with self.subTest(changes=changes):self.assertFalse(observe(state(**changes),{})['verified'])

    def test_malformed_or_contradictory_observation_is_unverified(self):
        for changes in ({'execution_id':None},{'started_at':True},{'timeout_seconds':86401},
                        {'state':'running','exit_code':0},{'state':'completed','exit_code':0},
                        {'command_sha256':'invalid'},{'deadline_at':float('nan')},
                        {'started_at':time.time()+3600},{'timed_out':1},{'exit_code':True}):
            with self.subTest(changes=changes):
                result=observe(state(**changes),{});self.assertFalse(result['verified'])
                self.assertEqual(result['status'],'unverified')

    def test_deadline_cannot_silently_change(self):
        self.assertFalse(observe(state(),{'job_timeout_seconds':7200})['verified'])
        expired=state(started_at=time.time()-4000,deadline_at=time.time()-400)
        self.assertEqual(observe(expired,{})['status'],'failed')


class JobRequests(unittest.IsolatedAsyncioTestCase):
    async def test_pending_probe_returns_without_waiting_for_execution(self):
        paths=[]
        def request(req):
            paths.append(req.url.path);return httpx.Response(200,json=state())
        original=httpx.AsyncClient
        with patch('app.job_verification.httpx.AsyncClient',side_effect=lambda **kwargs:original(transport=httpx.MockTransport(request),**kwargs)):
            result=await verify_job('http://job',{'checks':[{'path':'/results'}]},request_url=lambda base,path:base+path)
        self.assertEqual(result['status'],'running');self.assertEqual(paths,['/job/status'])

    async def test_outcome_assertions_run_after_actual_completion(self):
        paths=[]
        def request(req):
            paths.append(req.url.path)
            return httpx.Response(200,json=state(state='completed',exit_code=0,finished_at=time.time()))
        original=httpx.AsyncClient
        with patch('app.job_verification.httpx.AsyncClient',side_effect=lambda **kwargs:original(transport=httpx.MockTransport(request),**kwargs)):
            result=await verify_job('http://job',{'checks':[{'path':'/healthz','json_contains':{'output':'wrong'}}]},request_url=lambda base,path:base+path)
        self.assertFalse(result['verified']);self.assertEqual(result['status'],'failed')
        self.assertEqual(paths,['/job/status','/healthz','/healthz'])
    async def test_restart_during_outcome_checks_invalidates_completion(self):
        observations=0
        def request(req):
            nonlocal observations
            if req.url.path=='/job/status':observations+=1
            return httpx.Response(200,json=state(state='completed',exit_code=0,finished_at=time.time(),
                execution_id='a'*32 if observations<2 else 'c'*32))
        original=httpx.AsyncClient
        with patch('app.job_verification.httpx.AsyncClient',side_effect=lambda **kwargs:original(transport=httpx.MockTransport(request),**kwargs)):
            result=await verify_job('http://job',{},request_url=lambda base,path:base+path)
        self.assertFalse(result['verified']);self.assertEqual(result['status'],'failed')


if __name__=='__main__':unittest.main()
