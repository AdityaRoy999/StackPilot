import asyncio
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from app.agent_runtime.approval import issue, resolve, validate, queued_build
from app.main import AgentRequest, _stream_agent_reply_impl


class ExactToolApprovalTests(unittest.IsolatedAsyncioTestCase):
    def request(self, **extra):
        return AgentRequest(user_id='owned-user',session_id='owned-chat',message='Approve the rebuild',
            custom_url='https://fixture.invalid',deployment_id='owned-deployment',**extra)

    def test_signed_action_is_exact_and_scoped(self):
        with patch.dict(os.environ,{'STACKPILOT_AI_SERVICE_TOKEN':'owned-fixture-secret'}):
            req=self.request()
            token=issue(req,'workspace_trigger_rebuild',{'deployment_id':'owned-deployment'})
            self.assertEqual(resolve(token,req)['parameters'],{'deployment_id':'owned-deployment'})
            self.assertIsNone(validate(token,req,'workspace_trigger_rebuild',{'deployment_id':'other'}))
            self.assertIsNone(resolve(token,self.request(runtime={'agent_run_id':'other-run'})))
            self.assertIsNone(resolve(token,req.model_copy(update={'user_id':'other-user'})))
            self.assertIsNone(resolve(token+'changed',req))
            browser=issue(req,'browser_interact',{'text':'private-input'})
            self.assertIsNone(resolve(browser,req)['parameters'])

    def test_queue_evidence_requires_job_receipt(self):
        for result in ({'status':'blocked'},{'status':'requires_approval'}, {'message':'rebuild_queued'}, {'status':'rebuild_queued'}):
            self.assertFalse(queued_build(result))
        self.assertTrue(queued_build({'status':'rebuild_queued','job_id':'owned-job'}))

    async def test_exact_rebuild_runs_before_model_despite_active_browser_url(self):
        args={'deployment_id':'owned-deployment','project_id':'owned-project'}
        with patch.dict(os.environ,{'STACKPILOT_AI_SERVICE_TOKEN':'owned-fixture-secret'}):
            req=self.request()
            req.approval_token=issue(req,'workspace_trigger_rebuild',args)
            dispatch=AsyncMock(return_value={'status':'rebuild_queued','job_id':'owned-job','deployment_id':'owned-deployment'})
            with (patch('app.main.provider_config',return_value=('fixture','http://unused.invalid','fixture','fixture')),
                 patch('app.main.recover_session_context',AsyncMock()),
                 patch('app.main.resolve_target_project_runtime_url',return_value='https://fixture.invalid'),
                 patch('app.agent_runtime.approval.consume',return_value=True),
                 patch('app.main.execute_tool_call',dispatch)):
                stream=_stream_agent_reply_impl(req)
                events=[]
                try:
                    async for raw in stream:
                        event=json.loads(raw[6:]);events.append(event)
                        if event['type']=='content' and 'owned-job' in event.get('delta',''):break
                finally:await stream.aclose()
                dispatch.assert_awaited_once_with('workspace_trigger_rebuild',args,'owned-user')
                self.assertFalse(any('browser' in e.get('name','') for e in events))
                self.assertTrue(any(e.get('result',{}).get('job_id')=='owned-job' for e in events))

    async def test_consumed_approval_never_dispatches_again(self):
        with patch.dict(os.environ,{'STACKPILOT_AI_SERVICE_TOKEN':'owned-fixture-secret'}):
            req=self.request();req.approval_token=issue(req,'workspace_trigger_rebuild',{'deployment_id':'owned-deployment'})
            with (patch('app.main.provider_config',return_value=('fixture','http://unused.invalid','fixture','fixture')),
                 patch('app.main.recover_session_context',AsyncMock()),
                 patch('app.main.resolve_target_project_runtime_url',return_value='https://fixture.invalid'),
                 patch('app.agent_runtime.approval.consume',return_value=False),
                 patch('app.main.execute_tool_call',AsyncMock()) as dispatch):
                events=[json.loads(raw[6:]) async for raw in _stream_agent_reply_impl(req)]
                dispatch.assert_not_awaited()
                self.assertEqual(events[-1]['status'],'approval_stale')

    async def test_blocked_rebuild_reports_the_failed_prerequisite(self):
        with patch.dict(os.environ,{'STACKPILOT_AI_SERVICE_TOKEN':'owned-fixture-secret'}):
            req=self.request();req.approval_token=issue(req,'workspace_trigger_rebuild',{'deployment_id':'owned-deployment'})
            with (patch('app.main.provider_config',return_value=('fixture','http://unused.invalid','fixture','fixture')),
                 patch('app.main.recover_session_context',AsyncMock()),
                 patch('app.main.resolve_target_project_runtime_url',return_value='https://fixture.invalid'),
                 patch('app.agent_runtime.approval.consume',return_value=True),
                 patch('app.main.execute_tool_call',AsyncMock(return_value={'status':'blocked','error':'Current source has not passed verification.'})) as dispatch):
                stream=_stream_agent_reply_impl(req)
                try:
                    async for raw in stream:
                        event=json.loads(raw[6:])
                        if event['type']=='content':
                            self.assertIn('Rebuild was not queued',event['delta'])
                            self.assertIn('Current source has not passed verification',event['delta'])
                            break
                finally:await stream.aclose()
                dispatch.assert_awaited_once()

if __name__=='__main__':unittest.main()
