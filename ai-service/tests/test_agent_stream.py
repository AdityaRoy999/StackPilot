import asyncio
import json
import unittest
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from app.main import _cancelable_aiter_lines, _cancelable_stream_enter, StopAgentRequest, stop_chat_agent, active_stream_cancellations
from app.main import AgentRequest, stream_agent_reply
from app.browser_driver import BrowserManager
from app.browser_driver import browser_manager


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.enterContext(patch.dict('os.environ',{'STACKPILOT_AGENT_RUN_DB':str(Path(directory.name)/'runs.sqlite3')}))

    @contextmanager
    def signed_fixture_approvals(self):
        from app.agent_runtime.approval import issue, validate
        issued, consumed = [], set()
        def create(request, tool, arguments):
            token = issue(request, tool, arguments)
            issued.append(token)
            return token
        def consume(token, request, tool, arguments):
            payload = validate(token or '', request, tool, arguments)
            if not payload or payload['nonce'] in consumed:
                return False
            consumed.add(payload['nonce'])
            return True
        with patch.dict('os.environ',{'STACKPILOT_AI_SERVICE_TOKEN':'fixture-approval-signing-key'}), \
             patch('app.agent_runtime.approval.issue',side_effect=create), \
             patch('app.agent_runtime.approval.consume',side_effect=consume):
            yield issued
    async def run_scripted_browser(self, turns, execute, model="fixture-vision", mode="fast", message="test this website", on_event=None, session=None, approval_token=None, user_id='', cancel_event=None):
        requests = []
        def handler(request):
            requests.append(json.loads(request.content))
            calls = turns[len(requests)-1] if len(requests) <= len(turns) else []
            if isinstance(calls, str):
                # Deliberately split a long text tool call before valid JSON
                # exists, as a real streaming provider does.
                chunks = [calls[i:i+83] for i in range(0,len(calls),83)]
                data = ''.join('data: '+json.dumps({'choices':[{'delta':{'content':c}}]})+'\n\n' for c in chunks)+'data: [DONE]\n\n'
                return httpx.Response(200, content=data.encode(), headers={"content-type":"text/event-stream"})
            delta = {"tool_calls": [{"index": i, "id": f"call_{len(requests)}_{i}", "type": "function",
                     "function": {"name": name, "arguments": json.dumps(args)}} for i, (name,args) in enumerate(calls)]} if calls else {"content": "Outcome remains unverified."}
            data = "data: " + json.dumps({"choices": [{"delta": delta, "finish_reason": "tool_calls" if calls else "stop"}]}) + "\n\ndata: [DONE]\n\n"
            return httpx.Response(200, content=data.encode(), headers={"content-type":"text/event-stream"})
        session = session or SimpleNamespace(is_connected=True, current_url="https://fixture.invalid/", page_title="Fixture",
                                  session_id="scripted-browser", interactive_elements=[], console_logs=[])
        real_client = httpx.AsyncClient
        request = AgentRequest(message=message, custom_url=session.current_url,
                               session_id=session.session_id, model=model, model_mode=mode,approval_token=approval_token,user_id=user_id)
        with patch.dict(browser_manager.sessions, {session.session_id:session}), \
             patch("app.main.recover_session_context", AsyncMock()), \
             patch("app.main.provider_config", return_value=("nvidia_nim", "https://provider.invalid", "fixture-key", model)), \
             patch("app.main.execute_tool_call", side_effect=execute), \
             patch("app.main.httpx.AsyncClient", side_effect=lambda *a, **kw:real_client(*a, transport=httpx.MockTransport(handler), **kw)):
            events = []
            async for event in stream_agent_reply(request,cancel_event=cancel_event):
                events.append(event)
                if on_event:
                    on_event(event)
        return requests, events

    async def test_nested_step_reaches_viewer_before_outer_tool_finishes(self):
        from app.tool_progress import publish_step
        received = asyncio.Event()
        def on_event(raw):
            if '"type": "tool_step"' in raw:
                received.set()
        async def execute(name,args,user_id):
            await publish_step('browser_interact',{'action':'click'},
                {'status':'passed','frame':'data:image/jpeg;base64,/9j/'})
            # This would time out if events were held until the batch returned.
            await asyncio.wait_for(received.wait(),timeout=1)
            return {'status':'passed'}
        _, events = await self.run_scripted_browser([[('browser_interact_batch',{'actions':[{'action':'click','element_id':1}]})]],execute,on_event=on_event)
        step = next(i for i,e in enumerate(events) if '"type": "tool_step"' in e)
        result = next(i for i,e in enumerate(events) if '"type": "tool_result"' in e)
        self.assertLess(step,result)
        self.assertIn('"parent_id":',events[step])

    async def test_repeated_observations_remain_available_for_delayed_page(self):
        executed = []
        async def execute(name, args, user_id):
            executed.append(name)
            return {"status":"observed", "action":"observe", "interactive_elements":[]}
        await self.run_scripted_browser([[('browser_observe', {})]] * 4, execute)
        self.assertEqual(executed, ['browser_observe'] * 4)

    async def test_browser_planner_preserves_requested_thinking_mode(self):
        async def execute(name, args, user_id):
            return {"status":"observed", "action":"observe", "interactive_elements":[]}
        requests, _ = await self.run_scripted_browser([], execute, model="z-ai/glm-4.5", mode="thinking")
        self.assertTrue(requests[0]['chat_template_kwargs']['enable_thinking'])
        self.assertEqual(requests[0]['max_tokens'], 4096)

    async def test_gpt_oss_fast_lane_requests_low_reasoning_effort(self):
        async def execute(name, args, user_id):
            return {"status":"observed", "action":"observe", "interactive_elements":[]}
        requests, _ = await self.run_scripted_browser([], execute, model="openai/gpt-oss-20b")
        self.assertEqual(requests[0]['reasoning_effort'], 'low')
        self.assertEqual(requests[0]['tool_choice'], 'required')
        self.assertIs(requests[0]['parallel_tool_calls'],False)
        tools = requests[0]['tools']
        self.assertNotIn('browser_open_live_session',[t['function']['name'] for t in tools])
        self.assertTrue(all('session_id' not in t['function']['parameters'].get('properties',{}) for t in tools))

    async def test_long_text_tool_batch_executes_and_finishes_in_one_planner_turn(self):
        actions = [{'action':'type','element_id':1,'text':'x'*450},
                   {'action':'assert','purpose':'outcome','expectations':[{'kind':'value','element_id':1,'expected':'x'*450}]}]
        executed = []
        async def execute(name, args, user_id):
            executed.append((name,args))
            return {'status':'passed','action':'batch','completion_verified':True,'results':[
                {'status':'passed','action':'type','verification':{'verified':True,'effect_type':'value_change'}},
                {'status':'passed','action':'assert','purpose':'outcome','verification':{'verified':True,'effect_type':'assertion'},'assertions':[{'status':'passed','actual':'x'*450}]}]}
        payload = json.dumps({'name':'browser_interact_batch','arguments':{'actions':actions,'complete_task':True}})
        requests, events = await self.run_scripted_browser([payload], execute, message='Enter the provided text in the field and verify it.')
        self.assertEqual(len(requests),1)
        self.assertEqual(len(executed),1)
        self.assertEqual(executed[0][0],'browser_interact_batch')
        self.assertTrue(any('"status": "verified"' in event for event in events))

    async def test_incomplete_text_tool_call_does_not_execute(self):
        executed = []
        async def execute(name,args,user_id):
            executed.append(name)
            return {'status':'failed'}
        await self.run_scripted_browser(['{"name":"browser_interact_batch","arguments":{"actions":'], execute)
        self.assertEqual(executed,[])

    async def test_mutation_image_reaches_next_planner_without_extra_observe(self):
        async def execute(name, args, user_id):
            return {"status":"passed", "action":"click", "frame":"data:image/jpeg;base64,/9j/",
                    "verification":{"verified":True, "effect_type":"dom_change"}}
        requests, events = await self.run_scripted_browser([[('browser_interact', {'action':'click','element_id':1})]], execute)
        self.assertTrue(any(isinstance(m.get('content'),list) and any(b.get('type')=='image_url' for b in m['content']) for m in requests[1]['messages']))
        self.assertTrue(any('browser_timing' in event for event in events))

    async def test_failed_tool_skips_dependent_click_and_returns_to_planner(self):
        executed = []
        async def execute(name, args, user_id):
            executed.append((name,args))
            return {"status":"failed", "error":"Submit disabled", "recovery":{"reason":"disabled"}}
        requests, _ = await self.run_scripted_browser([[('browser_interact', {'action':'type','element_id':1,'text':'bad'}),
                                                      ('browser_interact', {'action':'click','element_id':2})]], execute)
        self.assertEqual(len(executed),1)
        results = [json.loads(m['content']) for m in requests[1]['messages'] if m['role']=='tool']
        self.assertEqual([r['status'] for r in results], ['failed','skipped'])

    async def test_model_cannot_redirect_browser_input_to_default_or_another_session(self):
        executed = []
        async def execute(name, args, user_id):
            executed.append(args['session_id'])
            return {"status":"failed", "error":"Fixture stop"}
        await self.run_scripted_browser([[('browser_interact', {'action':'click','element_id':1,'session_id':'default'})],
                                         [('browser_observe', {'session_id':'another-users-tab'})]], execute)
        self.assertEqual(executed, ['scripted-browser','scripted-browser'])

    async def test_unchanged_repetition_is_rejected_then_different_action_can_run(self):
        executed = []
        async def execute(name, args, user_id):
            executed.append(args.get('element_id'))
            return {"status":"failed", "error":"Covered", "recovery":{"reason":"occluded"}}
        same = [('browser_interact', {'action':'click','element_id':1})]
        requests, _ = await self.run_scripted_browser([same,same,same,[('browser_interact', {'action':'click','element_id':2})]], execute)
        self.assertEqual(executed, [1,1,2])
        self.assertTrue(any('Repeated tool call blocked' in m.get('content','') for m in requests[3]['messages'] if isinstance(m.get('content'),str)))

    async def test_unfamiliar_workflows_and_audits_execute_only_planned_actions(self):
        for goal, target in (("Move record Zeta to the archived state", "https://unfamiliar.invalid/records"),
                             ("test everything on this website", "https://unfamiliar.invalid/records"),
                             ("レコードを移動して確認", "http://localhost:3000")):
            with self.subTest(goal=goal):
                requests, executed = [], []
                session = SimpleNamespace(
                    is_connected=True, current_url=target,
                    page_title="Records", session_id="general-planner-fixture",
                    interactive_elements=[
                        {"id": 240, "tag": "button", "text": "移動", "is_in_viewport": True},
                        {"id": 241, "tag": "input", "name": "unrelated", "is_in_viewport": True},
                        {"id": 242, "tag": "button", "text": "Accept", "classes": "modal"}],
                    console_logs=[])
                async def execute(name, arguments, user_id):
                    executed.append((name, arguments))
                    if name == "browser_assert":
                        return {"status": "passed", "action": "assert", "purpose": "outcome",
                                "assertions": [{"status": "passed", "actual": "Archived: Zeta"}],
                                "verification": {"verified": True, "effect_type": "assertion"}}
                    return {"status": "passed", "action": "click", "target": "移動",
                            "verification": {"verified": True, "effect_type": "dom_change"}}
                def handler(request):
                    body = json.loads(request.content)
                    requests.append(body)
                    index = len(requests) - 1
                    steps = [("browser_interact", {"action": "click", "element_id": 240}),
                             ("browser_assert", {"purpose": "outcome", "expectations": [
                                 {"kind": "text", "selector": "#record-state", "expected": "Archived: Zeta"}]})]
                    if index < len(steps):
                        name, arguments = steps[index]
                        delta = {"tool_calls": [{"index": 0, "id": f"planned_{index}", "type": "function",
                                                 "function": {"name": name, "arguments": json.dumps(arguments)}}]}
                    else:
                        delta = {"content": "Checked the stated record expectation; other areas remain untested."}
                    return httpx.Response(200, content=("data: " + json.dumps({"choices": [
                        {"delta": delta, "finish_reason": "tool_calls" if index < 2 else "stop"}]})
                        + "\n\ndata: [DONE]\n\n").encode(), headers={"content-type": "text/event-stream"})
                real_client = httpx.AsyncClient
                request = AgentRequest(message=goal, custom_url=session.current_url, session_id=session.session_id,
                                       model="fixture-vision", runtime={"timezone": "UTC"})
                with patch.dict(browser_manager.sessions, {session.session_id: session}), \
                     patch("app.main.recover_session_context", AsyncMock()), \
                     patch("app.main.provider_config", return_value=("nvidia_nim", "https://provider.invalid", "fixture-key", "fixture-vision")), \
                     patch("app.main.execute_tool_call", side_effect=execute), \
                     patch("app.main.httpx.AsyncClient", side_effect=lambda *a, **kw: real_client(*a, transport=httpx.MockTransport(handler), **kw)):
                    events = [event async for event in stream_agent_reply(request)]
                if 'everything' in goal:
                    # Unfamiliar mutating semantics must request a scoped step,
                    # even when a broad test request is authorized.
                    self.assertEqual(executed, [])
                    self.assertTrue(any('"type": "permission_request"' in event for event in events))
                else:
                    self.assertEqual([name for name, _ in executed], ["browser_interact", "browser_assert"])
                    self.assertEqual(executed[0][1]["element_id"], 240)
                self.assertNotIn("browser_fill_form", [t["function"]["name"] for t in requests[0]["tools"]])
                self.assertNotIn("fill ALL", requests[0]["messages"][0]["content"])
                self.assertTrue(any("done" in event for event in events))

    async def test_audit_discovery_continues_with_fresh_ids_and_explicit_scenario(self):
        executed=[]
        async def execute(name,args,user_id):
            executed.append(name)
            if name=='browser_audit_site':
                return {'status':'observed','action':'site_audit','cases':[],
                    'coverage':{'visited_pages':1,'discovered_pages':1,'routes':[],
                        'controls_requiring_review':[{'url':'https://fixture.invalid/','label':'Email','reason':'Validation untested'}]}}
            if name=='browser_assert':
                return {'status':'passed','action':'assert','purpose':'outcome',
                    'assertions':[{'status':'passed','actual':False}],
                    'verification':{'verified':True,'effect_type':'assertion'}}
            return {'status':'observed','interactive_elements':[{'id':500,'tag':'input','type':'email'}]}
        requests,_=await self.run_scripted_browser([
            [('browser_audit_site',{'ui_control_ids':[]})],
            [('browser_assert',{'purpose':'outcome','expectations':[{'kind':'validity','element_id':500,'expected':False}]})]],execute)
        self.assertEqual(executed[:3],['browser_audit_site','browser_observe','browser_assert'])
        audit_result=next(json.loads(m['content']) for m in requests[1]['messages'] if m.get('role')=='tool' and 'current_observation' in str(m.get('content')))
        self.assertEqual(audit_result['current_observation']['interactive_elements'][0]['id'],500)

    async def test_no_tool_finish_prepares_only_explicit_goal_bound_current_step_then_resumes_once(self):
        from app.browser_testing.permissions import authorized
        control={'id':31,'tag':'button','type':'submit','label':'Send','text':'Send','form':True,
            'native_validity':True,'url':'https://fixture.invalid/'}
        session=SimpleNamespace(is_connected=True,current_url=control['url'],session_id='obligation-fixture',
            page_title='Fixture',interactive_elements=[control],console_logs=[],
            extract_interactive_tree=AsyncMock(),evaluate=AsyncMock(return_value=control))
        coverage={'controls_requiring_review':[
            {'url':control['url'],'label':'email','tag':'input','native_validation_states':[False,True]},
            {'url':control['url'],'label':'Send','tag':'button','type':'submit','reason':'Review sending'},
            {'url':control['url'],'label':'Delete account','tag':'a','reason':'Review deletion'}]}
        executed=[]
        async def execute(name,args,user_id):
            executed.append(name)
            if name=='browser_audit_site':
                return {'status':'observed','action':'site_audit','cases':[],'coverage':coverage}
            if name=='browser_interact':
                self.assertTrue(authorized(args,control))
                return {'status':'passed','action':'click','verification':{'verified':True,'effect_type':'dom_change'}}
            return {'status':'observed','interactive_elements':[control]}
        goal='Test this website deeply. Complete safe checks before requesting a step-scoped permission to send the form. Do not actually submit.'
        with self.signed_fixture_approvals() as approvals:
            requests,events=await self.run_scripted_browser([[('browser_audit_site',{})],[]],execute,
                session=session,user_id='owner',message=goal)
            parsed=[json.loads(e[6:]) for e in events]
            permission=next(e for e in parsed if e['type']=='permission_request')
            self.assertEqual(permission['browser_step']['label'],'Send')
            matching=[e for e in parsed if e.get('id')==permission['id']]
            self.assertEqual([e['type'] for e in matching],['tool_call','tool_result','permission_request'])
            self.assertEqual(parsed[-1]['status'],'waiting_for_permission')
            self.assertNotIn('browser_interact',executed)
            self.assertEqual(len(requests),2)
            resumed_requests,resumed_events=await self.run_scripted_browser([],execute,session=session,user_id='owner',
                approval_token=approvals[0],message='Approve this browser step and continue the website test.')
        self.assertEqual(executed.count('browser_interact'),1)
        self.assertFalse(any('"type": "permission_request"' in e for e in resumed_events))
        self.assertIn('Original goal: '+goal,resumed_requests[0]['messages'][0]['content'])
        self.assertEqual(coverage['workflow_obligations'][1]['state'],'executed_pending_verification')

    async def test_controller_budget_or_stop_cannot_prepare_a_permission(self):
        coverage={'controls_requiring_review':[{'url':'https://fixture.invalid/','label':'Send','tag':'button','type':'submit'}]}
        async def execute(name,args,user_id):
            if name=='browser_audit_site':
                return {'status':'observed','action':'site_audit','coverage':coverage,'cases':[
                    {'action':'assert','result':{'status':'passed','action':'assert','assertions':[{'status':'passed'}],
                                               'verification':{'verified':True,'effect_type':'assertion'}}}]}
            return {'status':'observed','interactive_elements':[]}
        goal='Test this website and request permission to send the form.'
        with patch.dict('os.environ',{'STACKPILOT_AI_TEST_DEEP_MAX_ACTIONS':'1'}), \
             patch('app.browser_testing.obligations.prepare_explicit_workflow_review',AsyncMock()) as prepare:
            _,events=await self.run_scripted_browser([[('browser_audit_site',{})],[]],execute,message=goal)
            prepare.assert_not_awaited()
            self.assertFalse(any('"type": "permission_request"' in e for e in events))
        stopped=asyncio.Event()
        def on_event(raw):
            event=json.loads(raw[6:])
            if event.get('type')=='browser_timing' and event.get('phase')=='planner' and event.get('tool_count')==0:
                stopped.set()
        with patch('app.browser_testing.obligations.prepare_explicit_workflow_review',AsyncMock()) as prepare:
            _,events=await self.run_scripted_browser([[('browser_audit_site',{})],[]],execute,
                message=goal,on_event=on_event,cancel_event=stopped)
            prepare.assert_not_awaited()
            self.assertTrue(any('"stopped": true' in e for e in events))

    async def test_approved_browser_step_resumes_once_before_model_and_preserves_goal(self):
        from app.browser_testing.permissions import authorized
        control={'id':7,'tag':'button','type':'submit','label':'Send message','form':True,'url':'https://fixture.invalid/'}
        session=SimpleNamespace(is_connected=True,current_url=control['url'],page_title='Fixture',session_id='approval-fixture',
            interactive_elements=[control],console_logs=[],evaluate=AsyncMock(return_value=control))
        executed=[]
        async def execute(name,args,user_id):
            executed.append(name)
            if name=='browser_interact':
                self.assertTrue(authorized(args,control))
                return {'status':'passed','action':'click','verification':{'verified':True,'effect_type':'dom_change'}}
            return {'status':'observed','action':'observe','interactive_elements':[]}
        with self.signed_fixture_approvals() as approvals:
            _,events=await self.run_scripted_browser([[('browser_interact',{'action':'click','element_id':7})]],execute,session=session,user_id='owner')
            self.assertEqual(executed,[])
            self.assertTrue(any('"status": "waiting_for_permission"' in e for e in events))
            requests,events=await self.run_scripted_browser([],execute,session=session,user_id='owner',approval_token=approvals[0],
                message='Approve this browser step and continue the website test.')
        self.assertEqual(executed,['browser_interact'])
        self.assertTrue(any('"id": "approved_browser_' in e for e in events))
        self.assertIn('Original goal: test this website',requests[0]['messages'][0]['content'])
        self.assertIsNone(session.pending_browser_approval)

    async def test_approval_rejects_changed_page_without_action_or_model_call(self):
        control={'id':7,'tag':'button','type':'submit','label':'Send','form':True,'url':'https://fixture.invalid/'}
        session=SimpleNamespace(is_connected=True,current_url=control['url'],page_title='Fixture',session_id='stale-approval-fixture',
            interactive_elements=[control],console_logs=[],evaluate=AsyncMock(return_value=control))
        execute=AsyncMock(return_value={'status':'failed'})
        with self.signed_fixture_approvals() as approvals:
            await self.run_scripted_browser([[('browser_interact',{'action':'click','element_id':7})]],execute,session=session,user_id='owner')
            session.evaluate.return_value={**control,'url':'https://fixture.invalid/other'}
            requests,events=await self.run_scripted_browser([],execute,session=session,user_id='owner',approval_token=approvals[0],
                message='Approve this browser step and continue the website test.')
        self.assertEqual(requests,[])
        execute.assert_not_awaited()
        self.assertTrue(any('"status": "approval_stale"' in e for e in events))

    async def test_critical_batch_executes_safe_prefix_once_then_each_approved_step_once(self):
        control={'id':7,'tag':'button','type':'submit','label':'Send','form':True,'url':'https://fixture.invalid/'}
        session=SimpleNamespace(is_connected=True,current_url=control['url'],page_title='Fixture',session_id='serial-approval-fixture',
            interactive_elements=[control],console_logs=[],evaluate=AsyncMock(return_value=control))
        executed=[]
        async def execute(name,args,user_id):
            executed.append((name,args.get('element_id')))
            if name=='browser_interact_batch':
                self.assertEqual([a['action'] for a in args['actions']],['type'])
                return {'status':'passed','action':'batch','results':[{'action':'type','status':'passed',
                    'verification':{'verified':True,'effect_type':'value_change'}}]}
            return {'status':'passed','action':'click','verification':{'verified':True,'effect_type':'dom_change'}}
        with self.signed_fixture_approvals() as approvals:
            _,first=await self.run_scripted_browser([[('browser_interact_batch',{'actions':[
                {'action':'type','element_id':1,'text':'qa@example.test'},
                {'action':'click','element_id':7},{'action':'click','element_id':8}]})]],execute,session=session,user_id='owner')
            self.assertEqual(executed,[('browser_interact_batch',None)])
            self.assertEqual(len(approvals),1)
            requests,second=await self.run_scripted_browser([],execute,session=session,user_id='owner',approval_token=approvals[0],
                message='Approve this browser step and continue the website test.')
            self.assertEqual(requests,[])
            self.assertEqual(executed,[('browser_interact_batch',None),('browser_interact',7)])
            self.assertEqual(len(approvals),2)
            self.assertEqual(session.pending_browser_approval['arguments']['element_id'],8)
            await self.run_scripted_browser([],execute,session=session,user_id='owner',approval_token=approvals[1],
                message='Approve this browser step and continue the website test.')
        self.assertEqual(executed,[('browser_interact_batch',None),('browser_interact',7),('browser_interact',8)])

    async def test_stop_invalidates_only_the_matching_session_approval(self):
        one=SimpleNamespace(pending_browser_approval={'owner':'one'})
        two=SimpleNamespace(pending_browser_approval={'owner':'two'})
        with patch.dict(browser_manager.sessions,{'one':one,'two':two},clear=True), \
             patch.object(browser_manager,'stop_session',AsyncMock()):
            await stop_chat_agent(StopAgentRequest(session_id='one',user_id='one'))
        self.assertIsNone(one.pending_browser_approval)
        self.assertEqual(two.pending_browser_approval,{'owner':'two'})

    async def test_missing_outcome_gets_bounded_reminders_without_unplanned_input(self):
        requests, executed = [], []
        def handler(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, content=('data: {"choices":[{"delta":{"content":"Blocked; outcome remains unverified."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n').encode(), headers={"content-type": "text/event-stream"})
        real_client = httpx.AsyncClient
        session = SimpleNamespace(is_connected=True, current_url="https://blocked.invalid/", page_title="Blocked",
                                  session_id="blocked-fixture", interactive_elements=[], console_logs=[])
        request = AgentRequest(message="test everything on this website", custom_url=session.current_url,
                               session_id=session.session_id, model="fixture-vision")
        with patch.dict(browser_manager.sessions, {session.session_id: session}), \
             patch("app.main.recover_session_context", AsyncMock()), \
             patch("app.main.provider_config", return_value=("nvidia_nim", "https://provider.invalid", "fixture-key", "fixture-vision")), \
             patch("app.main.execute_tool_call", side_effect=lambda *args: executed.append(args)), \
             patch("app.main.httpx.AsyncClient", side_effect=lambda *a, **kw: real_client(*a, transport=httpx.MockTransport(handler), **kw)):
            events = [event async for event in stream_agent_reply(request)]
        self.assertEqual(executed, [])
        self.assertEqual(len([r for r in requests if r.get("tools")]), 3)
        self.assertLessEqual(len(requests), 4)  # A separate final summary may follow the bounded planner.
        self.assertTrue(any("unverified" in event.lower() for event in events))

    async def test_planner_receives_fresh_image_and_explicit_outcome_tool(self):
        requests = []
        observed = {"status": "observed", "action": "observe", "visual_captured": True,
                    "frame": "data:image/jpeg;base64,/9j/", "interactive_elements": [], "url": "https://fixture.invalid/"}
        assertion = {"status": "passed", "action": "assert", "purpose": "outcome",
                     "assertions": [{"status": "passed", "actual": "Fixture"}],
                     "verification": {"verified": True, "effect_type": "assertion"}}
        async def execute(name, arguments, user_id):
            if name == "browser_assert":
                return assertion
            return observed
        def handler(request):
            body = json.loads(request.content)
            requests.append(body)
            index = len(requests) - 1
            tool = "browser_observe" if index == 0 else "browser_assert"
            args = {} if index == 0 else {"expectations": [{"kind": "title", "expected": "Fixture"}], "purpose": "outcome"}
            delta = {"tool_calls": [{"index": 0, "id": f"call_{index}", "type": "function", "function": {"name": tool, "arguments": json.dumps(args)}}]} if index < 2 else {"content": "The explicit fixture outcome was checked."}
            data = "data: " + json.dumps({"choices": [{"delta": delta, "finish_reason": "tool_calls" if index < 2 else "stop"}]}) + "\n\ndata: [DONE]\n\n"
            return httpx.Response(200, content=data.encode(), headers={"content-type": "text/event-stream"})
        real_client = httpx.AsyncClient
        session = SimpleNamespace(is_connected=True, current_url="https://fixture.invalid/", page_title="Fixture",
                                  session_id="planner-fixture", interactive_elements=[], console_logs=[], last_alerts=[])
        request = AgentRequest(message="verify the page title is Fixture", custom_url="https://fixture.invalid/",
                               session_id=session.session_id, model="fixture-vision", runtime={"timezone": "Asia/Kolkata"})
        with patch.dict(browser_manager.sessions, {session.session_id: session}):
            with patch("app.main.recover_session_context", AsyncMock()), patch("app.main.provider_config", return_value=("nvidia_nim", "https://provider.invalid", "fixture-key", "fixture-vision")), \
                 patch("app.main.execute_tool_call", side_effect=execute), \
                 patch("app.main.httpx.AsyncClient", side_effect=lambda *a, **kw: real_client(*a, transport=httpx.MockTransport(handler), **kw)):
                events = [event async for event in stream_agent_reply(request)]
        self.assertTrue(events)
        self.assertGreaterEqual(len(requests), 2)
        self.assertIn("browser_assert", [t["function"]["name"] for t in requests[0]["tools"]])
        self.assertTrue(any(isinstance(m.get("content"), list) and any(b.get("type") == "image_url" for b in m["content"])
                            for m in requests[1]["messages"]))
        self.assertIn("Asia/Kolkata", requests[0]["messages"][0]["content"])
        self.assertTrue(any('"action": "assert"' in event for event in events))

    async def test_stopping_one_chat_does_not_stop_another(self):
        one, two = asyncio.Event(), asyncio.Event()
        with patch.dict(active_stream_cancellations, {"chat": one, "chat-other": two}, clear=True):
            with patch("app.browser_driver.browser_manager.stop_session", AsyncMock()):
                await stop_chat_agent(StopAgentRequest(session_id="chat"))
                self.assertTrue(one.is_set())
                self.assertFalse(two.is_set())

    async def test_idle_provider_can_be_cancelled(self):
        cancel = asyncio.Event()
        released = asyncio.Event()
        async def lines():
            try:
                await asyncio.Event().wait()
                yield "unreachable"
            finally:
                released.set()
        async def cancelled():
            return cancel.is_set()
        response = SimpleNamespace(aiter_lines=lines)
        async def consume():
            return [line async for line in _cancelable_aiter_lines(response, cancelled)]
        task = asyncio.create_task(consume())
        await asyncio.sleep(0.02)
        cancel.set()
        self.assertEqual(await asyncio.wait_for(task, timeout=0.5), [""])
        self.assertTrue(released.is_set())

    async def test_provider_header_deadline_reaps_pending_request(self):
        released = asyncio.Event()
        async def enter():
            try:
                await asyncio.Event().wait()
            finally:
                released.set()
        with self.assertRaises(httpx.ReadTimeout):
            await _cancelable_stream_enter(SimpleNamespace(__aenter__=enter), AsyncMock(return_value=False), .03)
        self.assertTrue(released.is_set())

    async def test_caller_cancellation_reaps_pending_header_request(self):
        released = asyncio.Event()
        async def enter():
            try:
                await asyncio.Event().wait()
            finally:
                released.set()
        with self.assertRaises(TimeoutError):
            async with asyncio.timeout(.03):
                await _cancelable_stream_enter(SimpleNamespace(__aenter__=enter), AsyncMock(return_value=False), 5)
        self.assertTrue(released.is_set())

    async def test_transport_failure_does_not_start_second_synthesis_request(self):
        with patch('app.main._cancelable_stream_enter', AsyncMock(side_effect=httpx.ReadTimeout('no headers'))):
            requests, events = await self.run_scripted_browser([], AsyncMock())
        self.assertEqual(requests, [])
        done = [json.loads(e[6:]) for e in events if '"type": "done"' in e]
        self.assertEqual(done[-1]['status'], 'unverified')
        self.assertIn('timed out', done[-1]['content'])

    async def test_provider_transport_error_is_not_silently_successful(self):
        async def lines():
            yield "data: first"
            raise httpx.ReadError("provider disconnected")
        with self.assertRaises(httpx.ReadError):
            async for _ in _cancelable_aiter_lines(SimpleNamespace(aiter_lines=lines), AsyncMock(return_value=False)):
                pass

    async def test_sessions_do_not_alias_another_chat(self):
        manager = BrowserManager()
        original = SimpleNamespace(is_connected=True, current_url="https://one.example/", cancel_actions=AsyncMock(),
                                   listeners=set(), last_used=time.monotonic())
        manager.sessions["one"] = original
        with patch("app.browser_driver.BrowserSession.connect", AsyncMock()):
            with patch("app.browser_driver.BrowserSession.navigate", AsyncMock()):
                created = await manager.get_or_create_session("two", "https://two.example/")
                self.assertIsNot(created, original)
                self.assertEqual(created.session_id, "two")
        await manager.stop_session("missing")
        original.cancel_actions.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
