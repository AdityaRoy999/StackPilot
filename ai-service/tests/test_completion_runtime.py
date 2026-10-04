import asyncio
import copy
import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from app.agent_runtime.completion import normalize, digest, check_passed
from app.agent_runtime.context import Actor
from app.agent_runtime.runtime import TeamRuntime
from app.agent_runtime.store import TeamStore
from app.agent_runtime.workspace import Workspaces

MIGRATIONS = Path(os.getenv('STACKPILOT_TEST_MIGRATIONS', str(Path(__file__).resolve().parents[2]/'sql/migrations')))


def contract():
    return {'version': 1, 'workload': 'cli', 'summary': 'Finish the arithmetic command line application', 'features': [
        {'id': 'addition', 'description': 'Add two numbers', 'checks': [
            {'argv': ['python', '-c', 'from calculator import calculate; assert calculate("add", 12, 3) == 15; print("addition passed")'], 'output_contains': ['addition passed']}]},
        {'id': 'division', 'description': 'Divide and reject division by zero', 'checks': [
            {'argv': ['python', '-c', 'from calculator import calculate; assert calculate("divide", 12, 3) == 4\ntry: calculate("divide", 1, 0)\nexcept ValueError: print("zero rejected")\nelse: raise AssertionError("zero accepted")'], 'output_contains': ['zero rejected']}]}]}


class ContractTests(unittest.TestCase):
    def test_normalization_is_deterministic_and_retains_every_feature(self):
        value = normalize(contract())
        self.assertEqual(value, normalize(value))
        self.assertEqual(digest(value), digest(normalize(contract())))
        self.assertEqual(len(value['features']), 2)

    def test_provider_encoded_object_preserves_the_same_frozen_contract(self):
        self.assertEqual(normalize(json.dumps(contract())), normalize(contract()))
        for value in ['not json', '[]', 'null', json.dumps({'version': True})]:
            with self.assertRaises(ValueError): normalize(value)

    def test_missing_acceptance_and_unsafe_roots_are_rejected(self):
        for edit in [lambda c: c.update(features=[]),
                     lambda c: c['features'][0].update(checks=[]),
                     lambda c: c['features'][1].update(id='addition'),
                     lambda c: c['features'][0]['checks'][0].update(root='../outside'),
                     lambda c: c['features'][0]['checks'][0].update(timeout_seconds=True),
                     lambda c: c['features'][0]['checks'][0].update(verified=True)]:
            value = contract(); edit(value)
            with self.assertRaises(ValueError): normalize(value)

    def test_exit_code_and_output_assertions_override_success_claims(self):
        check = {'output_contains': ['actual outcome']}
        self.assertFalse(check_passed(check, {'status': 'completed', 'exit_code': 1, 'verified': True, 'output': 'actual outcome'}))
        self.assertFalse(check_passed(check, {'status': 'completed', 'exit_code': 0, 'verified': True, 'output': 'All tests passed'}))
        self.assertFalse(check_passed(check, {'status': 'completed', 'exit_code': 0, 'timed_out': True, 'output': 'actual outcome'}))
        self.assertTrue(check_passed(check, {'status': 'completed', 'exit_code': 0, 'output': 'actual outcome'}))


class CompletionRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source = root/'source'; self.source.mkdir()
        (self.source/'calculator.py').write_text('def calculate(operation, a, b):\n    raise NotImplementedError("unfinished")\n')
        (self.source/'README.md').write_text('Arithmetic CLI: add numbers, divide numbers, reject division by zero.\n')
        self.store = TeamStore(str(root/'store.sqlite'))
        self.store.initialize((MIGRATIONS/'062_agent_teams.sql').read_text())
        self.store.initialize((MIGRATIONS/'065_agent_completion_plans.sql').read_text())
        self.workspaces = Workspaces(root/'workspaces')
        self.commands = []
        async def broker(name, args, user):
            if name == '_internal_agent_workspace':
                return {'project_id': 'project', 'deployment_id': '', 'source_root': str(self.source)}
            if name == '_internal_agent_process':
                # Trusted fixture-only adapter executes real Python assertions.
                # Docker isolation and delivery are exercised by the integration smoke.
                tokens = shlex.split(args['argv'][2])
                self.assertEqual(tokens[:4],['export','COREPACK_ENABLE_AUTO_PIN=0','COREPACK_ENABLE_DOWNLOAD_PROMPT=0;','cd'])
                tokens = tokens[3:]
                self.assertEqual(tokens[:3], ['cd', '.', '&&'])
                self.assertEqual(tokens[3], 'python')
                argv = [sys.executable]+tokens[4:]
                self.commands.append(argv)
                result = await asyncio.to_thread(subprocess.run, argv,
                    cwd=self.workspaces.directory(args['run_id'], args['task_id']), capture_output=True, text=True, timeout=10)
                return {'status': 'completed' if result.returncode == 0 else 'failed', 'exit_code': result.returncode,
                        'output': result.stdout+result.stderr, 'changes': []}
            return {'authorized': True}
        self.releases = []
        async def release(name, args, user):
            self.releases.append(args)
            return {'status': 'rebuild_queued', 'job_id': 'fixture-job'}
        self.runtime = TeamRuntime(self.store, self.workspaces, broker=broker, execute=release)
        self.request = SimpleNamespace(user_id='owner', session_id='chat', project_id='project', deployment_id='',
            provider='fixture', model='fixture', model_mode='fast', provider_overrides={}, message='Finish this arithmetic CLI and deploy it')
        self.actor = await self.runtime.attach(self.request)

    async def asyncTearDown(self):
        await self.runtime.close()

    async def verify(self):
        queued = await self.runtime.handle(self.actor, 'verify_agent_source', {})
        task = self.store.claim(self.runtime.owner)
        self.assertEqual(task['id'], queued['agent_id'])
        await self.runtime.run_task(task)
        return json.loads(self.store.task(task['id'], self.actor.run_id)['result'])

    async def test_empty_application_cannot_release_without_defined_features(self):
        status = await self.runtime.handle(self.actor, 'get_completion_status', {})
        self.assertEqual(status['state'], 'needs_plan')
        for tool in ['workspace_trigger_rebuild', 'trigger_build', 'verify_agent_source']:
            self.assertEqual((await self.runtime.handle(self.actor, tool, {}))['status'], 'blocked')
        self.assertEqual(self.releases, [])

    async def test_real_failure_repair_verify_release_and_stale_source_fence(self):
        await self.runtime.handle(self.actor, 'define_completion_plan', {'contract': contract()})
        first = await self.verify()
        self.assertFalse(first['verified'])
        status = await self.runtime.handle(self.actor, 'get_completion_status', {})
        self.assertEqual([item['status'] for item in status['features']], ['failed', 'unverified'])
        self.assertEqual((await self.runtime.handle(self.actor, 'workspace_trigger_rebuild', {}))['status'], 'blocked')
        read = self.workspaces.read(self.actor.run_id, 'lead', 'calculator.py')
        implementation = 'def calculate(operation, a, b):\n    if operation == "add": return a + b\n    if operation == "divide":\n        if b == 0: raise ValueError("division by zero")\n        return a / b\n    raise ValueError("unknown operation")\n'
        await self.runtime.handle(self.actor, 'workspace_write_file', {'file_path': 'calculator.py', 'expected_revision': read['revision'], 'content': implementation})
        second = await self.verify()
        self.assertTrue(second['verified'], second)
        self.assertEqual([item['status'] for item in second['features']], ['passed', 'passed'])
        self.assertEqual((await self.runtime.handle(self.actor, 'get_completion_status', {}))['features_passed'], 2)
        self.assertEqual((await self.runtime.handle(self.actor, 'workspace_trigger_rebuild', {}))['status'], 'rebuild_queued')
        self.assertEqual(self.releases[0]['agent_source_revision'], second['revision'])
        read = self.workspaces.read(self.actor.run_id, 'lead', 'calculator.py')
        await self.runtime.handle(self.actor, 'workspace_write_file', {'file_path': 'calculator.py', 'expected_revision': read['revision'], 'content': implementation+'# later edit\n'})
        self.assertEqual((await self.runtime.handle(self.actor, 'get_completion_status', {}))['state'], 'unverified')
        self.assertEqual((await self.runtime.handle(self.actor, 'workspace_trigger_rebuild', {}))['status'], 'blocked')

    async def test_contract_is_frozen_idempotent_and_persists_across_resume(self):
        await self.runtime.handle(self.actor, 'define_completion_plan', {'contract': contract()})
        await self.runtime.handle(self.actor, 'define_completion_plan', {'contract': contract()})
        weaker = contract(); weaker['features'].pop()
        with self.assertRaises(ValueError):
            await self.runtime.handle(self.actor, 'define_completion_plan', {'contract': weaker})
        self.store.release_lead(self.actor.run_id, self.actor.owner)
        resumed = await self.runtime.attach(self.request)
        self.assertEqual(resumed.run_id, self.actor.run_id)
        self.actor = resumed
        self.assertEqual((await self.runtime.handle(self.actor, 'get_completion_status', {}))['features_total'], 2)

    async def test_worker_cannot_redefine_the_completion_contract(self):
        task = self.store.spawn(self.actor.run_id, 'lead', 'Implementer', 'Finish arithmetic', {'write_scope': ['calculator.py']})
        task = self.store.claim('worker')
        worker = Actor(self.runtime, self.actor.run_id, task['id'], 'owner', task['attempt'], 'worker')
        with self.assertRaises(PermissionError):
            await self.runtime.handle(worker, 'define_completion_plan', {'contract': contract()})

    async def test_original_contract_is_imported_and_cannot_be_removed(self):
        self.store.release_lead(self.actor.run_id, self.actor.owner)
        (self.source/'stackpilot.completion.json').write_text(json.dumps(contract()))
        request = copy.copy(self.request); request.session_id = 'new-chat'
        actor = await self.runtime.attach(request)
        status = await self.runtime.handle(actor, 'get_completion_status', {})
        self.assertEqual(status['intent_source'], 'repository_contract')
        weaker = contract(); weaker['features'].pop()
        with self.assertRaises(ValueError):
            await self.runtime.handle(actor, 'define_completion_plan', {'contract': weaker})
        read = self.workspaces.read(actor.run_id, 'lead', 'stackpilot.completion.json')
        await self.runtime.handle(actor, 'workspace_delete_file', {'file_path': 'stackpilot.completion.json', 'expected_revision': read['revision']})
        with self.assertRaises(ValueError):
            await self.runtime.handle(actor, 'verify_agent_source', {})


if __name__ == '__main__': unittest.main()
