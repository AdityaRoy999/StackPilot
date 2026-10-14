import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from app.agent_runtime.context import Actor
from app.agent_runtime.runtime import TeamRuntime, backend
from app.agent_runtime.store import TeamStore
from app.agent_runtime.tools import (TEAM_TOOLS, INSTANCE_NAMES, INITIAL_TOOLS,
                                     LEAD_INITIAL_TOOLS, active_schemas, lead_schemas)
from app.agent_runtime.workspace import Workspaces, digest


MIGRATIONS=Path(os.getenv('STACKPILOT_TEST_MIGRATIONS',str(Path(__file__).resolve().parents[2]/'sql/migrations')))


class InstanceRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_receives_actual_frozen_test_command_before_first_model_turn(self):
        run=self.create_run(); self.store.acquire_lead(run['id'],'fixture-lead')
        from app.agent_runtime.completion import normalize
        contract=normalize({'workload':'api','summary':'Preserve original API tests','features':[{'id':'api-tests','description':'Original suite','checks':[{
            'root':'.','argv':['python','-m','pytest','-q'],'image':'python:3.12-slim','network':True}]}]})
        self.store.freeze_completion(run['id'],'fixture-lead',contract,'repository_contract')
        actor=self.worker(run); task=self.store.task(actor.agent_id,actor.run_id)
        self.runtime.provider=SimpleNamespace(complete=AsyncMock(return_value=({'content':'No source changes needed'},{})))
        await self.runtime.agent_loop(actor,task)
        messages=self.runtime.provider.complete.call_args.args[1]
        context=next(message['content'] for message in messages if 'Frozen original acceptance checks' in str(message.get('content')))
        check=json.loads(context.partition(': ')[2].split('\n',1)[0])['checks'][0]
        self.assertEqual(check['argv'],['python','-m','pytest','-q'])
        self.assertEqual(check['image'],'python:3.12-slim')
        self.assertTrue(check['network'])
        self.assertIn('do not invent replacement tests or weaken coverage',context)

    async def test_existing_component_directory_scope_allows_only_that_component(self):
        component=self.source/'apps/api'; component.mkdir(parents=True); (component/'test.py').write_text('original\n')
        run=self.create_run(); self.store.acquire_lead(run['id'],'fixture-lead')
        actor=Actor(self.runtime,run['id'],'lead','fixture-owner',owner='fixture-lead')
        result=await self.runtime.handle(actor,'spawn_agent',{'goal':'Add meaningful API tests','write_scope':['apps/api']})
        task=self.store.task(result['agent_id'],run['id'])
        self.assertEqual(json.loads(task['spec'])['write_scope'],['apps/api/**'])
        from app.agent_runtime.workspace import allowed
        self.assertTrue(allowed('apps/api/tests/test_added.py',json.loads(task['spec'])['write_scope']))
        self.assertFalse(allowed('apps/web/test.py',json.loads(task['spec'])['write_scope']))

    async def test_directory_normalization_cannot_expand_parent_file_scope(self):
        component=self.source/'apps/api'; component.mkdir(parents=True); (component/'test.py').write_text('original\n')
        actor=self.worker(spec={'write_scope':['apps/api/test.py']})
        with self.assertRaisesRegex(PermissionError,'parent capability'):
            await self.runtime.handle(actor,'spawn_agent',{'goal':'Edit the whole API','write_scope':['apps/api']})

    async def test_failed_check_evidence_survives_submission_in_same_tool_batch(self):
        actor=self.worker(); task=self.store.task(actor.agent_id,actor.run_id)
        calls=[{'id':'run','function':{'name':'run_worker_command','arguments':'{"argv":["python","-m","pytest"]}'}},
               {'id':'submit','function':{'name':'submit_agent_patch','arguments':'{"summary":"Tests passed"}'}}]
        self.runtime.provider=SimpleNamespace(complete=AsyncMock(return_value=({'tool_calls':calls},{})))
        async def execute(name,args,user):
            if name=='run_worker_command':return {'status':'failed','exit_code':1,'output':'FAIL Required test coverage of 90% not reached'}
            return await self.runtime.handle(actor,name,args)
        with patch('app.tools.execute_tool_call',side_effect=execute):await self.runtime.agent_loop(actor,task)
        result=self.store.task(actor.agent_id,actor.run_id)
        self.assertEqual(result['state'],'failed')
        self.assertIn('coverage',json.loads(result['result'])['error'])
        self.assertEqual(self.runtime.provider.complete.await_count,1)

    async def test_source_fix_resets_unchanged_command_failure_budget(self):
        actor=self.worker(); task=self.store.task(actor.agent_id,actor.run_id)
        command={'id':'run','function':{'name':'run_worker_command','arguments':'{"argv":["python","-m","pytest"]}'}}
        observed=self.workspaces.read(actor.run_id,actor.agent_id,'allowed.txt')
        edit={'id':'edit','function':{'name':'workspace_write_file','arguments':json.dumps({'file_path':'allowed.txt','content':'fixed\n','expected_revision':observed['revision']})}}
        self.runtime.provider=SimpleNamespace(complete=AsyncMock(side_effect=[({'tool_calls':[call]}, {}) for call in [command,command,edit,command,command,command]]))
        async def execute(name,args,user):
            if name=='run_worker_command':return {'status':'failed','exit_code':1,'output':'test assertion failed'}
            return await self.runtime.handle(actor,name,args)
        with patch('app.tools.execute_tool_call',side_effect=execute):
            with self.assertRaisesRegex(RuntimeError,'Repeated tool failure'):await self.runtime.agent_loop(actor,task)
        self.assertEqual(self.runtime.provider.complete.await_count,6)
        self.assertEqual(self.workspaces.read(actor.run_id,actor.agent_id,'allowed.txt')['content'],'fixed\n')

    async def test_worker_summary_cannot_turn_a_failed_check_into_completed_task(self):
        actor=self.worker()
        commands=[{'status':'failed','exit_code':1,'reason':'Original test coverage requirement was not met'}]
        self.store.fence(actor.agent_id,actor.owner,actor.attempt,{'command_results':commands})
        state,result=self.runtime.finalize(actor,'All tests passed',{})
        self.assertEqual(state,'failed')
        self.assertFalse(result['verified'])
        self.assertEqual(result['command_results'],commands)
        self.assertIn('coverage',result['error'])

    async def test_nonzero_exit_without_error_exhausts_repeated_command_budget(self):
        actor=self.worker()
        task=self.store.task(actor.agent_id,actor.run_id)
        call={'id':'fixture','function':{'name':'run_worker_command','arguments':json.dumps({'argv':['python','-m','pytest']})}}
        self.runtime.provider=SimpleNamespace(complete=AsyncMock(return_value=({'tool_calls':[call]},{})))
        with patch('app.tools.execute_tool_call',new=AsyncMock(return_value={'status':'failed','exit_code':1,'output':'No module named pytest'})):
            with self.assertRaisesRegex(RuntimeError,'Repeated tool failure'):
                await self.runtime.agent_loop(actor,task)
        self.assertEqual(self.runtime.provider.complete.await_count,3)
        checkpoint=json.loads(self.store.task(actor.agent_id,actor.run_id)['checkpoint'])
        self.assertEqual(list(checkpoint['failures'].values()),[3])
        self.assertIn('Missing command/dependency',list(checkpoint['failures'])[0])

    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.source=self.root/'source';self.source.mkdir()
        (self.source/'allowed.txt').write_text('original\n')
        (self.source/'other.txt').write_text('protected\n')
        self.store=TeamStore(str(self.root/'teams.sqlite'))
        for name in ('062_agent_teams.sql','065_agent_completion_plans.sql'):
            self.store.initialize((MIGRATIONS/name).read_text())
        self.workspaces=Workspaces(self.root/'workspaces');self.calls=[];self.changes=[]
        async def broker(tool,args,user):
            self.calls.append((tool,dict(args),user))
            if tool=='_internal_agent_instance':return {'status':'completed','sandbox_id':'owned-fixture-instance'}
            if tool=='_internal_agent_process':
                return {'status':'completed','exit_code':0,'changes':list(self.changes)}
            if tool.endswith('_cleanup'):return {'status':'completed','removed':[],'retained':[]}
            return {'authorized':True}
        self.runtime=TeamRuntime(self.store,self.workspaces,provider=SimpleNamespace(),broker=broker)

    async def asyncTearDown(self):
        await self.runtime.close();self.temp.cleanup()

    def create_run(self,state='working'):
        run=self.store.create_run('fixture-owner',str(time.time_ns()),'fixture-project','',str(self.source),{})
        revision=self.workspaces.initialize(run['id'],str(self.source))
        self.store.revision(run['id'],revision,True)
        with self.store.transaction() as tx:tx.execute('UPDATE agent_runs SET state=%s WHERE id=%s',(state,run['id']))
        return self.store.run(run['id'])

    def worker(self,run=None,spec=None):
        run=run or self.create_run()
        task=self.store.spawn(run['id'],'lead','Fixture task','Inspect instance ownership',
                              spec or {'write_scope':['allowed.txt']})
        claimed=self.store.claim(self.runtime.owner)
        self.assertEqual(claimed['id'],task['id'])
        self.workspaces.allocate(run['id'],task['id'])
        return Actor(self.runtime,run['id'],task['id'],run['user_id'],claimed['attempt'],self.runtime.owner)

    def scoped_change(self,actor,path='allowed.txt'):
        data=b'changed by instance\n'
        return {'path':path,'before':digest(self.workspaces.directory(actor.run_id,actor.agent_id)/path),
                'after':hashlib.sha256(data).hexdigest(),'content_base64':base64.b64encode(data).decode()}

    def test_instance_schemas_are_worker_only_and_available_initially(self):
        names=lambda values:{item['function']['name'] for item in values}
        self.assertTrue(INSTANCE_NAMES<=INITIAL_TOOLS)
        self.assertTrue(INSTANCE_NAMES<=names(active_schemas(TEAM_TOOLS)))
        self.assertFalse(INSTANCE_NAMES & LEAD_INITIAL_TOOLS)
        self.assertFalse(INSTANCE_NAMES & names(lead_schemas(TEAM_TOOLS,names(TEAM_TOOLS))))
        command=next(item['function'] for item in TEAM_TOOLS if item['function']['name']=='run_worker_command')
        self.assertIn('sandbox_id',command['parameters']['properties'])
        provision=next(item['function'] for item in TEAM_TOOLS if item['function']['name']=='provision_worker_instance')
        resources=provision['parameters']['properties']
        self.assertEqual(resources['cpus']['type'],'number')
        self.assertTrue({'memory_mb','cpus','pids_limit','ttl_seconds'}<=set(resources))

    async def test_instance_dispatch_injects_actor_identity_and_operation(self):
        actor=self.worker()
        discovered=await self.runtime.handle(actor,'discover_agent_tools',{'group':'instances'})
        self.assertEqual(set(discovered['tools']),INSTANCE_NAMES)
        operations={'provision_worker_instance':'provision','inspect_worker_instance':'inspect','release_worker_instance':'release'}
        for name,operation in operations.items():
            result=await self.runtime.handle(actor,name,{'sandbox_id':'owned-fixture-instance','run_id':'foreign-run',
                'task_id':'foreign-task','lease_owner':'forged','attempt':999,'operation':'forged'})
            self.assertEqual(result['sandbox_id'],'owned-fixture-instance')
            call=next(value for value in reversed(self.calls) if value[0]=='_internal_agent_instance')
            self.assertEqual(call[1]['operation'],operation)
            self.assertEqual(call[1]['run_id'],actor.run_id);self.assertEqual(call[1]['task_id'],actor.agent_id)
            self.assertEqual(call[1]['lease_owner'],actor.owner);self.assertEqual(call[1]['attempt'],actor.attempt)
            self.assertEqual(call[2],actor.user_id)

    async def test_lead_cannot_provision_or_discover_instances(self):
        run=self.create_run();self.store.acquire_lead(run['id'],'lead-owner')
        actor=Actor(self.runtime,run['id'],'lead',run['user_id'],owner='lead-owner')
        for name in INSTANCE_NAMES:
            result=await self.runtime.handle(actor,name,{'sandbox_id':'owned-fixture-instance'})
            self.assertEqual(result['status'],'blocked')
        with self.assertRaises(PermissionError):
            await self.runtime.handle(actor,'discover_agent_tools',{'group':'instances'})
        self.assertFalse(any(tool=='_internal_agent_instance' for tool,_,_ in self.calls))

    async def test_revoked_task_and_foreign_actor_cannot_invoke_instance_broker(self):
        actor=self.worker()
        foreign=Actor(self.runtime,actor.run_id,actor.agent_id,'other-owner',actor.attempt,actor.owner)
        with self.assertRaises(PermissionError):await self.runtime.handle(foreign,'provision_worker_instance',{})
        self.store.cancel(actor.run_id,actor.agent_id)
        with self.assertRaises(PermissionError):await self.runtime.handle(actor,'provision_worker_instance',{})
        self.assertFalse(any(tool=='_internal_agent_instance' for tool,_,_ in self.calls))

    async def test_instance_commands_import_only_scoped_changes(self):
        actor=self.worker();self.changes=[self.scoped_change(actor)]
        result=await self.runtime.handle(actor,'run_worker_command',{'argv':['printf','fixture'],'sandbox_id':'owned-fixture-instance'})
        self.assertEqual(result['changed_paths'],['allowed.txt']);self.assertNotIn('changes',result)
        call=next(value for value in self.calls if value[0]=='_internal_agent_process')
        self.assertEqual(call[1]['sandbox_id'],'owned-fixture-instance')
        self.assertEqual(self.workspaces.read(actor.run_id,actor.agent_id,'allowed.txt')['content'],'changed by instance\n')
        self.assertEqual(self.workspaces.read(actor.run_id,'lead','allowed.txt')['content'],'original\n')
        self.changes=[self.scoped_change(actor,'other.txt')]
        with self.assertRaises(PermissionError):
            await self.runtime.handle(actor,'run_worker_command',{'argv':['true'],'sandbox_id':'owned-fixture-instance'})
        self.assertEqual(self.workspaces.read(actor.run_id,actor.agent_id,'other.txt')['content'],'protected\n')

    async def test_acceptance_rejects_mutable_instances_and_remains_disposable(self):
        spec={'write_scope':[],'execution_kind':'acceptance','commands':[{'root':'.','argv':['true']}],
              'setup':[],'image':'ubuntu:24.04','network':False,'timeout_seconds':10}
        actor=self.worker(spec=spec)
        for name in INSTANCE_NAMES:
            with self.assertRaises(PermissionError):await self.runtime.handle(actor,name,{'sandbox_id':'owned-fixture-instance'})
        with self.assertRaises(PermissionError):
            await self.runtime.handle(actor,'run_worker_command',{'argv':['true'],'sandbox_id':'owned-fixture-instance'})
        await self.runtime.acceptance_loop(actor,self.store.task(actor.agent_id,actor.run_id))
        process=[args for tool,args,_ in self.calls if tool=='_internal_agent_process']
        self.assertEqual(len(process),1);self.assertNotIn('sandbox_id',process[0])
        self.assertEqual(self.store.task(actor.agent_id,actor.run_id)['state'],'completed')

    async def test_backend_preserves_structured_instance_admission_blocks(self):
        result={'status':'blocked','scope':'sandbox_admission','verified':False,
                'error':'Missing capability','missing':['gpu'],'provisioning':{'implemented':False}}
        response=MagicMock();response.json.return_value=result
        client=AsyncMock();client.post.return_value=response
        with patch('httpx.AsyncClient') as factory:
            factory.return_value.__aenter__.return_value=client
            self.assertEqual(await backend('_internal_agent_instance',{},'fixture-owner'),result)

    async def test_cleanup_claims_survive_restart_and_rotate_bounded_batches(self):
        runs=[self.create_run('canceled') for _ in range(10)];now=time.time()
        first=self.store.claim_instance_cleanup('first',now=now)
        restarted=TeamStore(self.store.sqlite_path)
        second=restarted.claim_instance_cleanup('second',now=now+1)
        self.assertEqual(len(first),8);self.assertEqual(len(second),2)
        self.assertFalse({value['run_id'] for value in first}&{value['run_id'] for value in second})
        self.assertEqual(restarted.claim_instance_cleanup('second',now=now+2),[])
        self.assertEqual(len(restarted.claim_instance_cleanup('second',now=now+301)),8)
        self.assertEqual(len(runs),10)

    async def test_terminal_cleanup_stops_and_working_expiry_sweeps_recur(self):
        active=self.create_run();terminal=[self.create_run(state) for state in ('completed','failed','canceled')]
        await self.runtime.sweep_instance_cleanup();await self.runtime.sweep_instance_cleanup()
        calls=[args for tool,args,_ in self.calls if tool=='_internal_agent_instance_cleanup']
        self.assertEqual(len(calls),4)
        self.assertEqual(next(args for args in calls if args['run_id']==active['id'])['expired_only'],True)
        for run in terminal:
            self.assertFalse(next(args for args in calls if args['run_id']==run['id'])['expired_only'])
            self.assertTrue(json.loads(self.store.run(run['id'])['settings'])['instance_cleanup']['completed'])
        state=json.loads(self.store.run(active['id'])['settings'])['instance_cleanup']
        self.assertFalse(state['completed']);self.assertEqual(state['next_at']-state['observed_at'],30)

    async def test_retained_cleanup_retries_and_stale_claim_is_fenced(self):
        run=self.create_run('canceled');now=time.time()
        first=self.store.claim_instance_cleanup('first',now=now)[0]
        second=self.store.claim_instance_cleanup('second',now=now+301)[0]
        self.assertFalse(self.store.finish_instance_cleanup(run['id'],first['claim'],{'status':'completed'}))
        self.assertTrue(self.store.finish_instance_cleanup(run['id'],second['claim'],
            {'status':'partial','retained':[{'sandbox_id':'fixture','reason':'active command'}]},now=now+302))
        state=json.loads(self.store.run(run['id'])['settings'])['instance_cleanup']
        self.assertFalse(state['completed']);self.assertEqual(state['next_at'],now+602)

    async def test_sdk_cleanup_requires_matching_instance_completion_across_batches(self):
        terminal=[self.create_run('canceled') for _ in range(10)]
        async def broker(tool,args,user):
            self.calls.append((tool,dict(args),user))
            if tool=='_internal_agent_instance_cleanup' and args['run_id']==terminal[0]['id']:
                return {'status':'partial','removed':[],
                        'retained':[{'sandbox_id':'busy-fixture','reason':'active command'}]}
            return {'status':'completed','removed':[],'retained':[]}
        self.runtime.broker=broker
        await self.runtime.sweep_instance_cleanup()
        await self.runtime.sweep_sdk_cleanup(require_instance_cleanup=True)
        instance_runs={args['run_id'] for tool,args,_ in self.calls if tool=='_internal_agent_instance_cleanup'}
        sdk_runs={args['run_id'] for tool,args,_ in self.calls if tool=='_internal_agent_image_cleanup'}
        self.assertEqual(len(instance_runs),8);self.assertEqual(len(sdk_runs),7)
        self.assertTrue(sdk_runs<=instance_runs);self.assertNotIn(terminal[0]['id'],sdk_runs)
        self.assertNotIn(terminal[8]['id'],sdk_runs);self.assertNotIn(terminal[9]['id'],sdk_runs)

    async def test_expiry_sweep_racing_termination_queues_full_cleanup(self):
        run=self.create_run();claim=self.store.claim_instance_cleanup('first')[0]
        with self.store.transaction() as tx:tx.execute("UPDATE agent_runs SET state='canceled' WHERE id=%s",(run['id'],))
        self.assertTrue(self.store.finish_instance_cleanup(run['id'],claim['claim'],{'status':'completed'}))
        state=json.loads(self.store.run(run['id'])['settings'])['instance_cleanup']
        self.assertFalse(state['completed']);self.assertEqual(state['next_at'],0)
        next_claim=self.store.claim_instance_cleanup('second')[0]
        self.assertFalse(next_claim['expired_only'])

    async def test_cleanup_broker_errors_are_persisted_for_retry(self):
        run=self.create_run('failed')
        async def broker(*_):raise RuntimeError('fixture unavailable')
        self.runtime.broker=broker
        await self.runtime.sweep_instance_cleanup()
        state=json.loads(self.store.run(run['id'])['settings'])['instance_cleanup']
        self.assertEqual(state['status'],'failed');self.assertEqual(state['result']['error_type'],'RuntimeError')
        self.assertEqual(state['next_at']-state['observed_at'],300)

    async def test_idle_lifecycle_sweeps_instances_before_sdk_images(self):
        run=self.create_run('canceled');done=asyncio.Event()
        original=self.runtime.broker
        async def broker(tool,args,user):
            result=await original(tool,args,user)
            if tool=='_internal_agent_image_cleanup':done.set()
            return result
        self.runtime.broker=broker
        await self.runtime.initialize();await asyncio.wait_for(done.wait(),2)
        names=[tool for tool,_,_ in self.calls]
        self.assertLess(names.index('_internal_agent_instance_cleanup'),names.index('_internal_agent_image_cleanup'))
        await self.runtime.close()
        self.assertTrue(json.loads(self.store.run(run['id'])['settings'])['instance_cleanup']['completed'])


if __name__=='__main__':unittest.main()
