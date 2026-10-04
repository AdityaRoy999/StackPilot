import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from app.agent_runtime.context import Actor, actor_context
from app.agent_runtime.runtime import TeamRuntime
from app.agent_runtime.store import TeamStore
from app.agent_runtime.workspace import Workspaces, digest, scopes_overlap, safe_path, scope_contains


SCHEMA = Path(os.getenv('STACKPILOT_TEST_MIGRATIONS', str(Path(__file__).resolve().parents[2]/'sql/migrations')))/'062_agent_teams.sql'


class TeamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.source = root/'source'
        self.source.mkdir()
        (self.source/'a.py').write_text('value = 1\n')
        (self.source/'b.py').write_text('value = 1\n')
        self.store = TeamStore(str(root/'teams.sqlite'))
        self.store.initialize(SCHEMA.read_text())
        self.store.initialize((SCHEMA.parent/'065_agent_completion_plans.sql').read_text())
        self.workspaces = Workspaces(root/'workspaces')
        async def broker(name, args, user):
            if name == '_internal_agent_workspace':
                return {'project_id':'project-1','deployment_id':'deployment-1','source_root':str(self.source)}
            return {'authorized':True}
        self.runtime = TeamRuntime(self.store, self.workspaces, broker=broker)
        self.actor = await self.runtime.attach(SimpleNamespace(user_id='owner',session_id='session',project_id='project-1',
            deployment_id='deployment-1',provider='fixture',model='fixture',model_mode='fast',provider_overrides={}))
        self.run = self.store.run(self.actor.run_id)
        # These original regressions exercise pre-completion run compatibility.
        settings = json.loads(self.run['settings'])
        settings['completion_required'] = False
        with self.store.transaction() as tx:
            tx.execute('UPDATE agent_runs SET settings=%s WHERE id=%s', (json.dumps(settings), self.actor.run_id))

    async def asyncTearDown(self):
        await self.runtime.close()

    async def spawn(self, goal='Fix a', scope=None, dependencies=None):
        result = await self.runtime.handle(self.actor, 'spawn_agent', {'goal':goal,'role':'Freely selected specialist',
            'write_scope':scope if scope is not None else ['a.py'], 'depends_on':dependencies or []})
        return self.store.task(result['agent_id'], self.actor.run_id)

    async def test_roles_are_free_text_and_spawn_does_not_claim_completion(self):
        task = await self.spawn()
        self.assertEqual(task['state'],'queued')
        self.assertEqual(task['role'],'Freely selected specialist')
        self.assertFalse(self.store.events(self.actor.run_id)[0].get('verified',False))

    async def test_disjoint_tasks_claim_concurrently_overlapping_task_waits(self):
        first = await self.spawn(scope=['a.py'])
        second = await self.spawn(scope=['b.py'])
        third = await self.spawn(scope=['a.py'])
        self.assertEqual(self.store.claim('one')['id'], first['id'])
        self.assertEqual(self.store.claim('two')['id'], second['id'])
        self.assertIsNone(self.store.claim('three'))

    async def test_dependencies_wait_until_integrated_completion(self):
        first = await self.spawn(scope=['a.py'])
        second = await self.spawn(scope=['b.py'], dependencies=[first['id']])
        claimed = self.store.claim('worker')
        self.assertIsNone(self.store.claim('other'))
        self.store.finish(claimed,'worker','submitted',{'patch_id':'pending'})
        self.assertIsNone(self.store.claim('other'))
        with self.store.transaction() as tx:
            tx.execute("UPDATE agent_tasks SET state='completed' WHERE id=%s", (first['id'],))
        self.assertEqual(self.store.claim('other')['id'], second['id'])

    async def test_peer_messages_persist_and_cross_run_recipient_is_denied(self):
        first, second = await self.spawn(), await self.spawn(scope=['b.py'])
        self.store.message(self.actor.run_id, first['id'], second['id'], 'Contract revision 2')
        restarted = TeamStore(self.store.sqlite_path)
        self.assertEqual(restarted.inbox(self.actor.run_id, second['id'])[0]['content'],'Contract revision 2')
        with self.assertRaises(PermissionError):
            self.store.message(self.actor.run_id, first['id'], 'unknown-agent', 'no')

    async def test_stale_attempt_and_canceled_task_cannot_finish(self):
        task = await self.spawn()
        claimed = self.store.claim('worker')
        self.store.cancel(self.actor.run_id, task['id'])
        with self.assertRaises(PermissionError):
            self.store.finish(claimed,'worker','completed',{})
        self.assertEqual(self.store.task(task['id'], self.actor.run_id)['state'],'canceled')

    async def test_expired_lease_is_reclaimed_and_old_attempt_is_fenced(self):
        task = await self.spawn()
        old = self.store.claim('old')
        with self.store.transaction() as tx:
            tx.execute('UPDATE agent_tasks SET lease_until=0 WHERE id=%s', (task['id'],))
        new = self.store.claim('new')
        self.assertEqual(new['attempt'],old['attempt']+1)
        with self.assertRaises(PermissionError):
            self.store.fence(old['id'],'old',old['attempt'])

    async def test_workspace_edits_are_isolated_and_require_observed_revision(self):
        task = await self.spawn()
        self.workspaces.allocate(self.actor.run_id,task['id'])
        read = self.workspaces.read(self.actor.run_id,task['id'],'a.py')
        with self.assertRaises(ValueError):
            self.workspaces.write(self.actor.run_id,task['id'],'a.py','value = 2\n',['a.py'])
        self.workspaces.write(self.actor.run_id,task['id'],'a.py','value = 2\n',['a.py'],read['revision'])
        self.assertEqual((self.source/'a.py').read_text(),'value = 1\n')
        self.assertEqual(self.workspaces.read(self.actor.run_id,'lead','a.py')['content'],'value = 1\n')
        self.assertFalse((self.workspaces.directory(self.actor.run_id,task['id'])/'.git').exists())

    async def test_path_escape_and_scope_escape_are_denied(self):
        task = await self.spawn()
        self.workspaces.allocate(self.actor.run_id,task['id'])
        for path in ['../outside','/outside','.git/config','C:/outside']:
            with self.assertRaises((PermissionError,ValueError)):
                safe_path(self.workspaces.directory(self.actor.run_id,task['id']),path)
        with self.assertRaises(PermissionError):
            self.workspaces.write(self.actor.run_id,task['id'],'b.py','wrong',['a.py'],digest(self.source/'b.py'))

    async def test_conflict_does_not_overwrite_newer_integration_source(self):
        first, second = await self.spawn(), await self.spawn()
        for task, value in [(first,2),(second,3)]:
            self.workspaces.allocate(self.actor.run_id,task['id'])
            old = self.workspaces.read(self.actor.run_id,task['id'],'a.py')
            self.workspaces.write(self.actor.run_id,task['id'],'a.py',f'value = {value}\n',['a.py'],old['revision'])
        _, a = self.workspaces.changes(self.actor.run_id,first['id'],['a.py'])
        _, b = self.workspaces.changes(self.actor.run_id,second['id'],['a.py'])
        self.assertEqual(self.workspaces.integrate(self.actor.run_id,first['id'],a)['status'],'integrated')
        self.assertEqual(self.workspaces.integrate(self.actor.run_id,second['id'],b)['status'],'conflict')
        self.assertEqual(self.workspaces.read(self.actor.run_id,'lead','a.py')['content'],'value = 2\n')

    async def test_requirements_resume_only_their_blocked_task(self):
        task = await self.spawn()
        claimed = self.store.claim('worker')
        requirement = self.store.requirement(self.actor.run_id,task['id'],'capability','Need SDK worker')
        self.store.finish(claimed,'worker','blocked',{'requirement_id':requirement})
        self.store.resolve(self.actor.run_id,requirement,'worker registered')
        self.assertEqual(self.store.task(task['id'], self.actor.run_id)['state'],'queued')

    async def test_real_tool_loops_run_in_parallel_and_publish_distinct_patches(self):
        gate = asyncio.Event()
        entered = set()
        class Provider:
            def __init__(provider):
                provider.turns = {}
            async def complete(provider, run, messages, tools):
                actor = actor_context.get()
                turn = provider.turns.get(actor.agent_id,0)
                provider.turns[actor.agent_id] = turn+1
                path = 'a.py' if 'Fix a' in messages[1]['content'] else 'b.py'
                if turn == 0:
                    entered.add(actor.agent_id)
                    if len(entered) == 2:
                        gate.set()
                    await asyncio.wait_for(gate.wait(),5)
                    name,args = 'workspace_read_file',{'file_path':path}
                elif turn == 1:
                    read = json.loads(messages[-1]['content'])
                    name,args = 'workspace_write_file',{'file_path':path,'content':'value = 2\n','expected_revision':read['revision']}
                else:
                    return {'content':'Patch ready; product outcome still requires verification'},{}
                return {'tool_calls':[{'id':f'{actor.agent_id}-{turn}','type':'function','function':{'name':name,'arguments':json.dumps(args)}}]},{}
        self.runtime.provider = Provider()
        a,b = await self.spawn('Fix a',['a.py']), await self.spawn('Fix b',['b.py'])
        first, second = self.store.claim(self.runtime.owner), self.store.claim(self.runtime.owner)
        await asyncio.gather(self.runtime.run_task(first),self.runtime.run_task(second))
        self.assertEqual(len(entered),2)
        for task in [a,b]:
            finished = self.store.task(task['id'], self.actor.run_id)
            self.assertEqual(finished['state'],'submitted',finished['result'])
            result = json.loads(finished['result'])
            self.assertFalse(result['verified'])
            self.assertEqual(self.runtime.integrate(self.actor.run_id,result['patch_id'])['status'],'integrated')
        self.assertEqual(self.workspaces.read(self.actor.run_id,'lead','a.py')['content'],'value = 2\n')
        self.assertEqual(self.workspaces.read(self.actor.run_id,'lead','b.py')['content'],'value = 2\n')
        events = self.store.events(self.actor.run_id,limit=100)
        self.assertEqual(len({event['sequence'] for event in events}),len(events))
        self.assertTrue(any(event['type']=='tool_result' and event['agent_id']==a['id'] for event in events))

    async def test_interrupted_tool_is_not_blindly_replayed(self):
        task = await self.spawn()
        claimed = self.store.claim(self.runtime.owner)
        self.store.fence(claimed['id'],self.runtime.owner,claimed['attempt'],{'pending':{'name':'run_worker_command'}})
        await self.runtime.run_task(claimed)
        finished = self.store.task(task['id'], self.actor.run_id)
        self.assertEqual(finished['state'],'blocked')
        self.assertIn('pending',json.loads(finished['result']))

    async def test_single_lead_ownership_is_enforced(self):
        with self.assertRaises(PermissionError):
            self.store.acquire_lead(self.actor.run_id,'other-lead')
        self.store.release_lead(self.actor.run_id,self.actor.owner)
        self.store.acquire_lead(self.actor.run_id,'other-lead')
        with self.assertRaises(PermissionError):
            self.store.fence_lead(self.actor.run_id,self.actor.owner)

    async def test_file_scope_cannot_be_expanded_to_directory(self):
        self.assertFalse(scope_contains(['src'], 'src/**'))
        self.assertFalse(scope_contains(['src/**'], 'src-other/**'))
        self.assertTrue(scope_contains(['src/**'], 'src/nested/**'))

    async def test_original_regression_is_protected_at_release(self):
        from app.agent_runtime.acceptance import capture, validate
        (self.source/'test_original.py').write_text('assert 1 == 2\n')
        (self.source/'stackpilot.json').write_text(json.dumps({'version':1,'tests_required':True,'tests':[['python','test_original.py']]}))
        acceptance = capture(self.source)
        (self.source/'test_original.py').write_text('assert True\n')
        with self.assertRaisesRegex(ValueError,'regression'):
            validate(self.source,acceptance)
        (self.source/'test_original.py').write_text('assert 1 == 2\n')
        (self.source/'stackpilot.json').write_text(json.dumps({'version':1,'tests_required':False,'tests':[]}))
        with self.assertRaisesRegex(ValueError,'weakened'):
            validate(self.source,acceptance)

    async def test_conflicted_task_is_replaced_and_dependencies_follow(self):
        task=await self.spawn()
        dependent=await self.spawn(scope=['b.py'],dependencies=[task['id']])
        claimed=self.store.claim('worker')
        self.store.finish(claimed,'worker','blocked',{'reason':'conflict'})
        replacement=self.store.revise(self.actor.run_id,task['id'],'Reconcile and retest')
        self.assertEqual(self.store.task(task['id'],self.actor.run_id)['state'],'canceled')
        self.assertEqual(json.loads(self.store.task(dependent['id'],self.actor.run_id)['spec'])['depends_on'],[replacement['id']])
        self.assertEqual(self.store.claim('replacement-worker')['id'],replacement['id'])

    async def test_signed_approval_is_bound_to_user_session_action_and_arguments(self):
        import os
        from unittest.mock import patch
        from app.agent_runtime.approval import issue, validate
        request=SimpleNamespace(user_id='owner',session_id='session',runtime={'agent_run_id':self.actor.run_id})
        with patch.dict(os.environ,{'STACKPILOT_AI_SERVICE_TOKEN':'test-only-signing-key'}):
            token=issue(request,'workspace_trigger_rebuild',{'deployment_id':'d1'})
            self.assertIsNotNone(validate(token,request,'workspace_trigger_rebuild',{'deployment_id':'d1'}))
            self.assertIsNone(validate(token,request,'workspace_trigger_rebuild',{'deployment_id':'d2'}))
            self.assertIsNone(validate('forged',request,'workspace_trigger_rebuild',{'deployment_id':'d1'}))
            request.user_id='another-owner'
            self.assertIsNone(validate(token,request,'workspace_trigger_rebuild',{'deployment_id':'d1'}))

    async def test_canceled_submitted_patch_cannot_be_integrated(self):
        import uuid
        task=await self.spawn()
        claimed=self.store.claim('worker')
        self.workspaces.allocate(self.actor.run_id,task['id'])
        original=self.workspaces.read(self.actor.run_id,task['id'],'a.py')
        self.workspaces.write(self.actor.run_id,task['id'],'a.py','value = 2\n',['a.py'],original['revision'])
        allocation,changes=self.workspaces.changes(self.actor.run_id,task['id'],['a.py'])
        patch_id=str(uuid.uuid4())
        with self.store.transaction() as tx:
            tx.execute('INSERT INTO agent_patches VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(patch_id,self.actor.run_id,task['id'],allocation['base_revision'],'','submitted',json.dumps({'changes':changes}),time.time()))
        self.store.finish(claimed,'worker','submitted',{'patch_id':patch_id})
        self.store.cancel(self.actor.run_id,task['id'])
        with self.assertRaises(PermissionError):self.runtime.integrate(self.actor.run_id,patch_id)

    async def test_executor_verification_is_required_and_invalidated_by_source_edit(self):
        config=json.dumps({'version':1,'tests_required':True,'tests':[['python','-m','unittest']]})
        self.runtime.write_lead(self.actor,'stackpilot.json',config,None,False)
        released=[]
        async def execute(name,args,user):
            released.append(args)
            return {'status':'rebuild_queued'}
        self.runtime.execute=execute
        self.assertEqual((await self.runtime.handle(self.actor,'workspace_trigger_rebuild',{}))['status'],'blocked')
        original_broker=self.runtime.broker
        async def broker(name,args,user):
            if name=='_internal_agent_process':return {'status':'completed','exit_code':0,'changes':[]}
            return await original_broker(name,args,user)
        self.runtime.broker=broker
        queued=await self.runtime.handle(self.actor,'verify_agent_source',{})
        task=self.store.claim(self.runtime.owner)
        await self.runtime.run_task(task)
        report=json.loads(self.store.task(queued['agent_id'],self.actor.run_id)['result'])
        self.assertTrue(report['verified'])
        self.assertEqual((await self.runtime.handle(self.actor,'workspace_trigger_rebuild',{}))['status'],'rebuild_queued')
        self.assertEqual(released[-1]['agent_source_revision'],report['revision'])
        old=self.workspaces.read(self.actor.run_id,'lead','a.py')
        self.runtime.write_lead(self.actor,'a.py','value = 99\n',old['revision'],False)
        self.assertEqual((await self.runtime.handle(self.actor,'workspace_trigger_rebuild',{}))['status'],'blocked')
        self.assertEqual(len(released),1)

    async def test_failed_acceptance_cannot_be_overridden_by_a_success_claim(self):
        self.runtime.write_lead(self.actor,'stackpilot.json',json.dumps({'tests':[['python','test.py']]}),None,False)
        original_broker=self.runtime.broker
        async def broker(name,args,user):
            if name=='_internal_agent_process':return {'status':'completed','exit_code':1,'verified':True,'output':'All tests passed','changes':[]}
            return await original_broker(name,args,user)
        self.runtime.broker=broker
        await self.runtime.handle(self.actor,'verify_agent_source',{})
        await self.runtime.run_task(self.store.claim(self.runtime.owner))
        self.assertEqual(self.store.tasks(self.actor.run_id)[0]['state'],'failed')
        self.assertEqual((await self.runtime.handle(self.actor,'workspace_trigger_rebuild',{}))['status'],'blocked')

    async def test_tool_discovery_is_capability_scoped(self):
        browser=await self.runtime.handle(self.actor,'discover_agent_tools',{'group':'browser'})
        self.assertIn('browser_assert',browser['tools'])
        with self.assertRaises(PermissionError):
            await self.runtime.handle(self.actor,'discover_agent_tools',{'names':['_internal_agent_process']})

    async def test_repository_discovery_does_not_offer_the_disabled_control_plane_terminal(self):
        from app.agent_runtime.tools import child_schemas
        from app.tools import AGENT_TOOLS
        repository=await self.runtime.handle(self.actor,'discover_agent_tools',{'group':'repository'})
        self.assertIn('workspace_read_file',repository['tools'])
        self.assertNotIn('terminal_run_command',repository['tools'])
        self.assertNotIn('terminal_run_command',{item['function']['name'] for item in child_schemas(AGENT_TOOLS)})
        with self.assertRaises(PermissionError):
            await self.runtime.handle(self.actor,'discover_agent_tools',{'names':['terminal_run_command']})
        # Replayed calls still fail closed; removing discovery cannot grant a
        # worker access to the backend shell.
        blocked=await self.runtime.handle(self.actor,'terminal_run_command',{'command':'ls -la'})
        self.assertEqual(blocked['status'],'blocked')

    async def test_bound_schemas_do_not_require_invented_targets_and_preserve_legacy_registry(self):
        from app.agent_runtime.tools import lead_schemas, child_schemas, LEAD_INITIAL_TOOLS
        from app.tools import AGENT_TOOLS
        legacy=next(item for item in AGENT_TOOLS if item['function']['name']=='workspace_trigger_rebuild')
        self.assertIn('deployment_id',legacy['function']['parameters']['required'])
        scoped=lead_schemas(AGENT_TOOLS,LEAD_INITIAL_TOOLS)
        build=next(item for item in scoped if item['function']['name']=='workspace_trigger_rebuild')
        self.assertNotIn('deployment_id',build['function']['parameters']['required'])
        for item in scoped+child_schemas(AGENT_TOOLS):
            self.assertFalse({'project_id','deployment_id','user_id','session_id'} & set(item['function']['parameters']['properties']))
        team=await self.runtime.handle(self.actor,'discover_agent_tools',{'group':'team'})
        self.assertNotIn('run_worker_command',team['tools'])
        self.assertNotIn('submit_agent_patch',team['tools'])
        self.assertIn('verify_agent_source',team['tools'])
        self.assertIn('deployment_id',legacy['function']['parameters']['required'])

    async def test_empty_lead_responses_fail_unverified_after_bounded_same_model_retries(self):
        import httpx
        from unittest.mock import AsyncMock, patch
        from app import main
        calls=[]
        def respond(request):
            calls.append(json.loads(request.content))
            return httpx.Response(200,text='data: '+json.dumps({'choices':[{'delta':{},'finish_reason':'stop'}]})+'\n\ndata: [DONE]\n\n')
        self.runtime.provider.client=httpx.AsyncClient(transport=httpx.MockTransport(respond))
        request=main.AgentRequest(message='Inspect source',user_id='owner',project_id='project-1',session_id='session',model='fixture-selected')
        token=actor_context.set(self.actor)
        try:
            with patch.object(main,'provider_config',return_value=('fixture','https://provider.example/v1','fixture-key','fixture-selected')), \
                 patch.object(main,'recover_session_context',new=AsyncMock()), \
                 patch.object(main,'resolve_target_project_runtime_url',return_value=''), \
                 patch.object(main.asyncio,'sleep',new=AsyncMock()), \
                 patch.dict('os.environ',{'STACKPILOT_TEAM_PROVIDER_RETRIES':'2'}):
                events=[json.loads(raw[6:]) async for raw in main._stream_agent_reply_impl(request)]
        finally:actor_context.reset(token)
        self.assertEqual(len(calls),3)
        self.assertTrue(all(value['model']=='fixture-selected' for value in calls))
        self.assertEqual([value['reason'] for value in events if value['type']=='provider_retry'],['EmptyAssistantResponse']*2)
        self.assertEqual(events[-1]['status'],'unverified')
        self.assertTrue(any(value['type']=='error' for value in events))
        self.assertFalse(any(value['type']=='tool_call' for value in events))

    async def test_in_stream_provider_failure_retries_generation_without_dispatching_partial_mutation(self):
        import httpx
        from unittest.mock import AsyncMock, patch
        from app import main
        payloads=[]
        def respond(request):
            payloads.append(json.loads(request.content))
            if len(payloads)==1:
                chunks=[{'choices':[{'delta':{'tool_calls':[{'index':0,'id':'observed','type':'function',
                    'function':{'name':'workspace_read_file','arguments':json.dumps({'file_path':'a.py'})}}]}}]}]
            elif len(payloads)==2:
                chunks=[{'choices':[{'delta':{'tool_calls':[{'index':0,'id':'incomplete','type':'function',
                    'function':{'name':'workspace_write_file','arguments':'{"file_path":"a.py"'}}]}}]},
                    {'error':{'code':500,'message':'Hosted provider failure'}}]
            else:chunks=[{'choices':[{'delta':{'content':'Source inspected.'},'finish_reason':'stop'}]}]
            return httpx.Response(200,text=''.join('data: '+json.dumps(v)+'\n\n' for v in chunks)+'data: [DONE]\n\n')
        self.runtime.provider.client=httpx.AsyncClient(transport=httpx.MockTransport(respond))
        request=main.AgentRequest(message='Inspect source',user_id='owner',project_id='project-1',session_id='session',model='fixture-selected')
        token=actor_context.set(self.actor)
        try:
            with patch.object(main,'provider_config',return_value=('fixture','https://provider.example/v1','fixture-key','fixture-selected')), \
                 patch.object(main,'recover_session_context',new=AsyncMock()), \
                 patch.object(main,'resolve_target_project_runtime_url',return_value=''), \
                 patch.object(main.asyncio,'sleep',new=AsyncMock()):
                events=[json.loads(raw[6:]) async for raw in main._stream_agent_reply_impl(request)]
        finally:actor_context.reset(token)
        self.assertEqual(len(payloads),3)
        self.assertEqual(payloads[1]['messages'],payloads[2]['messages'])
        self.assertEqual([v['name'] for v in events if v['type']=='tool_call'],['workspace_read_file'])
        self.assertEqual(self.workspaces.read(self.actor.run_id,'lead','a.py')['content'],'value = 1\n')
        self.assertTrue(any(v['type']=='provider_error' and v['status_code']==500 for v in events))
        self.assertTrue(any(v['type']=='provider_retry' and v['reason']=='ProviderStreamError' for v in events))


    async def test_lead_discovers_schemas_and_transient_retry_preserves_selected_model(self):
        import httpx
        from unittest.mock import AsyncMock, patch
        from app import main
        observed=[]
        def respond(request):
            payload=json.loads(request.content)
            observed.append(payload)
            if len(observed)==1:raise httpx.ConnectError('Transient fixture DNS outage',request=request)
            if len(observed)==2:return httpx.Response(503,json={'error':'Transient fixture outage'})
            if len(observed)==3:
                delta={'tool_calls':[{'index':0,'id':'discovery','type':'function','function':{
                    'name':'discover_agent_tools','arguments':json.dumps({'group':'browser'})}}]}
            elif len(observed) in {4,5,6}:
                delta={'tool_calls':[{'index':0,'id':'observation-'+str(len(observed)),'type':'function','function':{
                    'name':'list_agents','arguments':'{}'}}]}
            else:delta={'content':'Tool schemas inspected.'}
            return httpx.Response(200,text='data: '+json.dumps({'choices':[{'delta':delta,'finish_reason':'stop'}]})+'\n\ndata: [DONE]\n\n')
        self.runtime.provider.client=httpx.AsyncClient(transport=httpx.MockTransport(respond))
        request=main.AgentRequest(message='Inspect tool capabilities',user_id='owner',project_id='project-1',
            deployment_id='deployment-1',session_id='session',model='fixture-selected')
        token=actor_context.set(self.actor)
        try:
            with patch.object(main,'provider_config',return_value=('fixture','https://provider.example/v1','fixture-key','fixture-selected')), \
                 patch.object(main,'recover_session_context',new=AsyncMock()), \
                 patch.object(main,'resolve_target_project_runtime_url',return_value=''), \
                 patch.object(main.asyncio,'sleep',new=AsyncMock()):
                events=[json.loads(raw[6:]) async for raw in main._stream_agent_reply_impl(request) if raw.startswith('data: ')]
        finally:actor_context.reset(token)
        self.assertEqual(len(observed),7)
        self.assertEqual({payload['model'] for payload in observed},{'fixture-selected'})
        initial={item['function']['name'] for item in observed[2]['tools']}
        final={item['function']['name'] for item in observed[3]['tools']}
        self.assertNotIn('browser_assert',initial)
        self.assertIn('browser_assert',final)
        self.assertIn('verify_agent_source',initial)
        self.assertEqual(sum(event.get('type')=='provider_retry' for event in events),2)
        self.assertEqual(sum(event.get('type')=='tool_result' and event.get('name')=='discover_agent_tools' for event in events),1)
        self.assertEqual(sum(event.get('type')=='tool_result' and event.get('name')=='list_agents' for event in events),3)

    async def test_resolution_preserves_context_and_reconciles_interrupted_invocation(self):
        task=await self.spawn()
        claimed=self.store.claim('worker')
        self.store.fence(task['id'],'worker',claimed['attempt'],{'messages':[
            {'role':'system','content':'Task rules'}, {'role':'user','content':'Fix a'},
            {'role':'assistant','content':None,'tool_calls':[{'id':'call-1','type':'function','function':{'name':'run_worker_command','arguments':'{}'}}]}],
            'pending':{'id':'call-1','name':'run_worker_command'}})
        requirement=self.store.requirement(self.actor.run_id,task['id'],'interrupted_action','Observe prior command before retry')
        self.store.finish(claimed,'worker','blocked',{})
        self.store.resolve(self.actor.run_id,requirement,{'observation':'No worker is running; no changes occurred'})
        saved=json.loads(self.store.task(task['id'],self.actor.run_id)['checkpoint'])
        self.assertNotIn('pending',saved)
        self.assertEqual(saved['messages'][3]['tool_call_id'],'call-1')
        self.assertIn('No worker is running',saved['messages'][-1]['content'])

    async def test_lead_and_workers_share_one_root_model_budget(self):
        task=await self.spawn()
        claimed=self.store.claim('worker')
        with self.store.transaction() as tx:tx.execute('UPDATE agent_runs SET max_turns=1 WHERE id=%s',(self.actor.run_id,))
        self.store.charge_lead(self.actor.run_id,self.actor.owner)
        with self.assertRaisesRegex(RuntimeError,'budget'):self.store.turn(task['id'],'worker',claimed['attempt'])

    async def test_idle_runs_do_not_starve_eligible_tasks(self):
        for index in range(33):
            self.store.create_run('other','idle-'+str(index),'other-project','','unused',{})
        task=await self.spawn()
        with self.store.transaction() as tx:tx.execute('UPDATE agent_runs SET updated_at=%s WHERE id=%s',(time.time()+1,self.actor.run_id))
        self.assertEqual(self.store.claim('worker')['id'],task['id'])

    async def test_explicit_submission_fences_further_edits_and_is_not_verification(self):
        task=await self.spawn()
        claimed=self.store.claim('worker')
        worker=Actor(self.runtime,self.actor.run_id,task['id'],'owner',claimed['attempt'],'worker')
        old=await self.runtime.handle(worker,'workspace_read_file',{'file_path':'a.py'})
        await self.runtime.handle(worker,'workspace_write_file',{'file_path':'a.py','content':'value = 2\n','expected_revision':old['revision']})
        submitted=await self.runtime.handle(worker,'submit_agent_patch',{'summary':'Assigned edit complete; combined checks belong to the lead'})
        self.assertEqual(submitted['status'],'submitted')
        self.assertFalse(submitted['verified'])
        self.assertEqual(self.workspaces.read(self.actor.run_id,'lead','a.py')['content'],'value = 1\n')
        with self.assertRaises(PermissionError):await self.runtime.handle(worker,'workspace_write_file',{'file_path':'a.py','content':'value = 3\n'})

    async def test_legacy_build_alias_uses_sealed_source_and_cannot_bypass_acceptance(self):
        calls=[]
        async def execute(name,args,user):calls.append((name,args));return {'status':'rebuild_queued'}
        self.runtime.execute=execute
        result=await self.runtime.handle(self.actor,'trigger_build',{'project_id':'project-1'})
        self.assertEqual(result['status'],'rebuild_queued')
        self.assertEqual(calls[0][0],'workspace_trigger_rebuild')
        self.assertEqual(calls[0][1]['agent_run_id'],self.actor.run_id)
        self.runtime.write_lead(self.actor,'stackpilot.json',json.dumps({'tests_required':True,'tests':[['python','test.py']]}),None,False)
        self.assertEqual((await self.runtime.handle(self.actor,'trigger_build',{}))['status'],'blocked')
        self.assertEqual(len(calls),1)

    async def test_lead_cannot_redirect_a_scoped_run_to_another_project(self):
        with self.assertRaises(PermissionError):
            await self.runtime.handle(self.actor,'get_deployment_logs',{'deployment_id':'another-deployment'})
        with self.assertRaises(ValueError):await self.runtime.handle(self.actor,'workspace_list_files',[])

    async def test_repair_cannot_release_without_independent_behavior_tests(self):
        with self.store.transaction() as tx:
            tx.execute('UPDATE agent_runs SET settings=%s WHERE id=%s',
                       (json.dumps({'deployment_repair':True}),self.actor.run_id))
        calls=[]
        async def execute(name,args,user):calls.append(name);return {'status':'rebuild_queued'}
        self.runtime.execute=execute
        value=await self.runtime.handle(self.actor,'workspace_trigger_rebuild',{})
        self.assertEqual(value['status'],'blocked');self.assertFalse(calls)
        self.runtime.write_lead(self.actor,'stackpilot.json',json.dumps({'workload':'cli','entrypoint':['python','a.py'],
            'tests':[['python','test_behavior.py']]}),None,False)
        value=await self.runtime.handle(self.actor,'workspace_trigger_rebuild',{})
        self.assertEqual(value['status'],'blocked');self.assertIn('console_scenarios',value['error'])

    async def test_repository_analysis_is_scoped_and_does_not_execute_source(self):
        self.runtime.write_lead(self.actor,'calculator.py',"print(input('Number: '))\n",None,False)
        value=await self.runtime.handle(self.actor,'analyze_repository',{})
        self.assertEqual(value['workload'],'cli');self.assertEqual(value['run_id'],self.actor.run_id)
        self.assertFalse(value['verified'])

    async def test_existing_package_tests_are_discovered_for_independent_acceptance(self):
        self.runtime.write_lead(self.actor,'package.json',json.dumps({'scripts':{'test':'node test.cjs'},'packageManager':'pnpm@10.0.0'}),None,False)
        required,commands=self.runtime.acceptance_commands(self.actor.run_id)
        self.assertEqual(commands,[{'root':'.','argv':['pnpm','run','test']}])
        value=await self.runtime.handle(self.actor,'workspace_trigger_rebuild',{})
        self.assertEqual(value['status'],'blocked');self.assertIn('verify_agent_source',value['error'])

    def test_original_package_tests_cannot_be_replaced_by_success_script(self):
        from app.agent_runtime.acceptance import capture,validate
        package=self.source/'package.json'
        package.write_text(json.dumps({'scripts':{'test':'node regression.cjs','build':'node broken.cjs'}}))
        baseline=capture(self.source)
        package.write_text(json.dumps({'scripts':{'test':'node regression.cjs','build':'node fixed.cjs'}}))
        validate(self.source,baseline)
        package.write_text(json.dumps({'scripts':{'test':'node -e "process.exit(0)"','build':'node fixed.cjs'}}))
        with self.assertRaisesRegex(ValueError,'Original package test script'):validate(self.source,baseline)
