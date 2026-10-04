import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import time
import unittest

from app.agent_runtime.runtime import TeamRuntime
from app.agent_runtime.store import TeamStore
from app.agent_runtime.workspace import Workspaces

MIGRATIONS=Path(os.getenv('STACKPILOT_TEST_MIGRATIONS',str(Path(__file__).resolve().parents[2]/'sql/migrations')))


class SDKCleanup(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.store=TeamStore(str(self.root/'teams.sqlite'))
        self.store.initialize((MIGRATIONS/'062_agent_teams.sql').read_text())
        self.store.initialize((MIGRATIONS/'065_agent_completion_plans.sql').read_text())
        self.calls=[]
        async def broker(tool,args,user):
            self.calls.append((tool,args,user));return {'status':'completed','removed':[],'retained':[]}
        self.runtime=TeamRuntime(self.store,Workspaces(self.root/'workspaces'),provider=SimpleNamespace(),broker=broker)
    async def asyncTearDown(self):await self.runtime.close();self.temp.cleanup()
    def create_run(self,state='canceled'):
        result=self.store.create_run('fixture-owner',str(time.time_ns()),'fixture-project','',self.root,{})
        with self.store.transaction() as tx:tx.execute('UPDATE agent_runs SET state=%s WHERE id=%s',(state,result['id']))
        return self.store.run(result['id'])
    async def test_sweep_only_terminal_runs_and_stops_completed_reconciliation(self):
        active=self.create_run('working');terminal=self.create_run()
        await self.runtime.sweep_sdk_cleanup();await self.runtime.sweep_sdk_cleanup()
        self.assertEqual(len(self.calls),1);self.assertEqual(self.calls[0][1]['run_id'],terminal['id'])
        self.assertNotIn('sdk_cleanup',json.loads(self.store.run(active['id'])['settings']))
        self.assertTrue(json.loads(self.store.run(terminal['id'])['settings'])['sdk_cleanup']['completed'])
    async def test_persisted_due_times_rotate_batches_and_survive_restart(self):
        runs=[self.create_run() for _ in range(10)];now=time.time()
        first=self.store.claim_sdk_cleanup('instance-one',now=now)
        restarted=TeamStore(self.store.sqlite_path)
        second=restarted.claim_sdk_cleanup('instance-two',now=now+1)
        self.assertEqual(len(first),8);self.assertEqual(len(second),2)
        self.assertFalse({value['run_id'] for value in first}&{value['run_id'] for value in second})
        self.assertEqual(restarted.claim_sdk_cleanup('instance-two',now=now+2),[])
        retry=restarted.claim_sdk_cleanup('instance-two',now=now+301)
        self.assertEqual(len(retry),8)
    async def test_retained_and_failed_cleanup_retry_within_five_minutes(self):
        terminal=self.create_run();calls=0
        async def broker(*_):
            nonlocal calls
            calls+=1
            if calls==1:return {'status':'partial','removed':[],'retained':[{'image_id':'sha256:'+'a'*64,'reason':'container referenced'}]}
            raise RuntimeError('Fixture endpoint unavailable')
        self.runtime.broker=broker
        await self.runtime.sweep_sdk_cleanup()
        current=json.loads(self.store.run(terminal['id'])['settings'])['sdk_cleanup']
        self.assertFalse(current['completed']);self.assertLessEqual(current['next_at']-current['observed_at'],300)
        settings=json.loads(self.store.run(terminal['id'])['settings'])
        with self.store.transaction() as tx:
            settings['sdk_cleanup']['next_at']=0
            tx.execute('UPDATE agent_runs SET settings=%s WHERE id=%s',(json.dumps(settings),terminal['id']))
        await self.runtime.sweep_sdk_cleanup()
        failed=json.loads(self.store.run(terminal['id'])['settings'])['sdk_cleanup']
        self.assertEqual(failed['status'],'failed');self.assertFalse(failed['completed'])
        self.assertEqual(failed['result']['error_type'],'RuntimeError')
    async def test_stale_cleanup_result_cannot_overwrite_a_new_claim(self):
        terminal=self.create_run();now=time.time()
        first=self.store.claim_sdk_cleanup('one',now=now)[0]
        second=self.store.claim_sdk_cleanup('two',now=now+301)[0]
        self.assertFalse(self.store.finish_sdk_cleanup(terminal['id'],first['claim'],{'status':'completed'}))
        self.assertTrue(self.store.finish_sdk_cleanup(terminal['id'],second['claim'],{'status':'partial','retained':[{'reason':'in use'}]}))
    async def test_working_run_transition_blocks_cleanup_result(self):
        terminal=self.create_run();claimed=self.store.claim_sdk_cleanup('one')[0]
        with self.store.transaction() as tx:tx.execute("UPDATE agent_runs SET state='working' WHERE id=%s",(terminal['id'],))
        self.assertFalse(self.store.finish_sdk_cleanup(terminal['id'],claimed['claim'],{'status':'completed'}))
    async def test_cleanup_does_not_block_task_claims_and_close_cancels_sweep(self):
        self.create_run();active=self.create_run('working')
        self.store.spawn(active['id'],'lead','Fixture worker','Observe scheduler independence',{'write_scope':[]})
        cleanup_started=asyncio.Event();worker_started=asyncio.Event();never=asyncio.Event()
        async def broker(*_):cleanup_started.set();await never.wait()
        async def worker(task):worker_started.set();await never.wait()
        self.runtime.broker=broker;self.runtime.run_task=worker
        await self.runtime.initialize()
        await asyncio.wait_for(cleanup_started.wait(),2)
        await asyncio.wait_for(worker_started.wait(),2)
        cleanup=self.runtime.sdk_cleanup_scheduler;task_scheduler=self.runtime.scheduler
        await self.runtime.close()
        self.assertTrue(cleanup.done());self.assertTrue(task_scheduler.done())
        self.assertIsNone(self.runtime.sdk_cleanup_scheduler);self.assertEqual(self.runtime.workers,set())


if __name__=='__main__':unittest.main()
