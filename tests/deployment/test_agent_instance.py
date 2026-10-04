import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'deployment-runtime'))
import agent_instance
from agent_process import inventory


def request(**changes):
    result = {'run_id': str(uuid.uuid4()), 'user_id': str(uuid.uuid4()), 'task_id': str(uuid.uuid4()),
              'lease_owner': 'fixture-owner', 'attempt': 1, 'operation': 'provision'}
    result.update(changes)
    return result


class DockerFixture:
    """Docker boundary model; commands still use actual bounded child processes.

    Separate live qualification exercises Docker itself. This fixture exposes
    substitution, lease and revision races which ordinary happy-path Docker
    commands cannot reliably induce.
    """
    def __init__(self, root):
        self.root = root; self.calls = []; self.containers = {}; self.image_id = 'sha256:'+'a'*64
        self.daemon_id = 'fixture-daemon'; self.distribution = 'ubuntu'; self.clock = '2026-10-01T12:00:00Z'

    def call(self, args, env, **kwargs):
        self.calls.append(args)
        assert env['DOCKER_CONFIG'] and 'STACKPILOT_FIXTURE_CREDENTIAL' not in env
        if args[0] == 'info': return SimpleNamespace(returncode=0, stdout=json.dumps({'ID': self.daemon_id, 'OSType': 'linux', 'Architecture': 'x86_64'}), stderr='')
        if args[:2] == ['image', 'inspect']:
            return SimpleNamespace(returncode=0, stdout=json.dumps([{'Id': self.image_id, 'Config': {}, 'Os': 'linux', 'Architecture': 'amd64'}]), stderr='')
        if args[0] == 'create':
            container = uuid.uuid4().hex*2
            actual_labels = dict(args[i+1].split('=', 1) for i, value in enumerate(args) if value == '--label')
            self.containers[container] = {'Id': container, 'Image': self.image_id, 'Config': {'Labels': actual_labels},
                'State': {'Running': False, 'StartedAt': self.clock}, 'RestartCount': 0,
                'HostConfig': {'Binds': [], 'Privileged': False, 'Devices': []}, 'Mounts': []}
            return SimpleNamespace(returncode=0, stdout=container, stderr='')
        if args[0] == 'inspect':
            value = self.containers.get(args[1])
            return SimpleNamespace(returncode=0 if value else 1, stdout=json.dumps([value]) if value else '', stderr='' if value else 'No such object')
        if args[0] == 'cp':
            snapshot = Path(args[1][:-2]); sandbox = args[2].split(':', 1)[0]
            shutil.copytree(snapshot, self.root/sandbox)
            return SimpleNamespace(returncode=0, stdout='', stderr='')
        if args[0] == 'start': self.containers[args[1]]['State']['Running'] = True
        elif args[0] == 'kill': self.containers[args[1]]['State']['Running'] = False
        elif args[0] == 'rm': self.containers.pop(args[-1], None)
        elif args[0] == 'exec':
            return SimpleNamespace(returncode=0, stdout='ID='+self.distribution+'\n', stderr='')
        else: raise AssertionError('Unexpected fixture Docker call: '+str(args))
        return SimpleNamespace(returncode=0, stdout='', stderr='')

    def export(self, record, env, destination):
        shutil.copytree(self.root/record['container_id'], destination,
                        ignore=shutil.ignore_patterns(*agent_instance.SKIP))


class InstanceLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.source = self.root/'source'; self.source.mkdir(); (self.source/'main.py').write_text('print(1)\n')
        self.guest_root = self.root/'guests'; self.guest_root.mkdir(); self.docker = DockerFixture(self.guest_root)
        self.spec = request()
        self.patches = [patch.dict(os.environ, {'STACKPILOT_AGENT_INSTANCE_ROOT': str(self.root/'registry'),
            'STACKPILOT_AGENT_LOCAL_WORKERS': 'true', 'STACKPILOT_AGENT_WORKER_NETWORK': 'true',
            'STACKPILOT_AGENT_DOCKER_PROVISIONING': 'true', 'STACKPILOT_FIXTURE_CREDENTIAL': 'never-forward',
            'STACKPILOT_AGENT_INSTANCE_MAX_TOTAL': '8', 'STACKPILOT_AGENT_INSTANCE_MAX_PER_RUN': '3',
            'STACKPILOT_AGENT_INSTANCE_MAX_TTL_SECONDS': '3600', 'STACKPILOT_AGENT_INSTANCE_MAX_MEMORY_MB': '4096',
            'STACKPILOT_AGENT_INSTANCE_MAX_CPUS': '8', 'STACKPILOT_AGENT_INSTANCE_TOTAL_MEMORY_MB': '4096',
            'STACKPILOT_AGENT_INSTANCE_TOTAL_CPUS': '4'}),
            patch('agent_instance.call', side_effect=self.docker.call),
            patch('agent_instance.lease_valid', return_value=True),
            patch('agent_instance.select', return_value={'status': 'ready', 'image': 'ubuntu:24.04'}),
            patch('agent_instance.export_source', side_effect=self.docker.export)]
        for item in self.patches: item.start()
        self.actual_popen = subprocess.Popen

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.temp.cleanup()

    def provision(self, **changes):
        return agent_instance.provision(self.source, {**self.spec, **changes})

    def command(self, sandbox_id, **changes):
        return {**self.spec, 'operation': 'execute', 'sandbox_id': sandbox_id,
                'argv': ['python', 'main.py'], 'timeout_seconds': 10, 'write_scope': [], **changes}

    def child(self, program='print(42)'):
        def execute(args, **kwargs):
            self.docker.calls.append(args)
            return self.actual_popen([sys.executable, '-c', program], **kwargs)
        return patch('agent_instance.subprocess.Popen', side_effect=execute)

    def test_provision_pins_actual_identities_and_guest_resources(self):
        result = self.provision(network=True)
        self.assertEqual(result['status'], 'ready'); self.assertEqual(result['state'], 'ready')
        self.assertFalse(result['verified']); self.assertEqual(result['distribution'], 'ubuntu')
        self.assertEqual(result['image_id'], self.docker.image_id)
        create = next(args for args in self.docker.calls if args[0] == 'create')
        self.assertIn('--cap-drop', create); self.assertNotIn('--privileged', create)
        self.assertNotIn('--mount', create); self.assertNotIn('--volume', create)
        self.assertIn('no-new-privileges', create); self.assertIn('--memory-swap', create)
        self.assertEqual((self.guest_root/result['container_id']/'main.py').read_text(), 'print(1)\n')

    def test_git_and_local_dependencies_are_not_copied(self):
        (self.source/'.git').mkdir(); (self.source/'.git'/'config').write_text('host-secret')
        (self.source/'node_modules').mkdir(); (self.source/'node_modules'/'module').write_text('host dependency')
        result = self.provision(); guest = self.guest_root/result['container_id']
        self.assertFalse((guest/'.git').exists()); self.assertFalse((guest/'node_modules').exists())

    def test_actual_guest_distribution_must_match_requirement(self):
        self.docker.distribution = 'alpine'
        with self.assertRaisesRegex(ValueError, 'distribution'):
            self.provision(capabilities=['distro.ubuntu'])
        self.assertEqual(self.docker.containers, {})

    def test_foreign_task_user_run_and_attempt_cannot_access_instance(self):
        result = self.provision()
        for change in ({'run_id': str(uuid.uuid4())}, {'user_id': str(uuid.uuid4())},
                       {'task_id': str(uuid.uuid4())}, {'attempt': 2}, {'lease_owner': 'other-owner'}):
            with self.subTest(change=change), self.assertRaises(PermissionError):
                agent_instance.inspect(self.command(result['sandbox_id'], **change))

    def test_revoked_lease_prevents_provision_and_access(self):
        with patch('agent_instance.lease_valid', return_value=False), self.assertRaises(PermissionError): self.provision()
        result = self.provision()
        with patch('agent_instance.lease_valid', return_value=False), self.assertRaises(PermissionError):
            agent_instance.execute(self.source, self.command(result['sandbox_id']))

    def test_container_daemon_and_owner_substitutions_are_refused(self):
        result = self.provision(); cid = result['container_id']; saved = copy.deepcopy(self.docker.containers[cid])
        for mutate in (lambda row: row.update(Id='b'*64), lambda row: row.update(Image='sha256:'+'c'*64),
                       lambda row: row['Config']['Labels'].update({'stackpilot.agent-run': str(uuid.uuid4())}),
                       lambda row: row['HostConfig'].update(Binds=['/host:/workspace'])):
            mutate(self.docker.containers[cid])
            with self.assertRaises(PermissionError): agent_instance.inspect(self.command(result['sandbox_id']))
            self.docker.containers[cid] = copy.deepcopy(saved)
        self.docker.daemon_id = 'replacement-daemon'
        with self.assertRaises(PermissionError): agent_instance.inspect(self.command(result['sandbox_id']))

    def test_source_fencing_refuses_host_edit_without_running_command(self):
        result = self.provision(); (self.source/'main.py').write_text('host edit\n')
        with self.child(): outcome = agent_instance.execute(self.source, self.command(result['sandbox_id']))
        self.assertEqual(outcome['status'], 'blocked'); self.assertTrue(outcome['requires_fresh_instance'])
        self.assertFalse(any(args[:2] == ['docker', 'exec'] for args in self.docker.calls))

    def test_setup_workspace_survives_commands_and_scoped_patch_advances_revision(self):
        result = self.provision(); guest = self.guest_root/result['container_id']
        (guest/'node_modules').mkdir(); (guest/'node_modules'/'installed').write_text('dependency retained')
        with self.child(): first = agent_instance.execute(self.source, self.command(result['sandbox_id']))
        self.assertEqual(first['exit_code'], 0); self.assertEqual(first['changes'], [])
        self.assertEqual((guest/'node_modules'/'installed').read_text(), 'dependency retained')
        (guest/'main.py').write_text('print(42)\n')
        with self.child(): second = agent_instance.execute(self.source, self.command(result['sandbox_id'], write_scope=['main.py']))
        self.assertEqual(len(second['changes']), 1)
        (self.source/'main.py').write_bytes(base64.b64decode(second['changes'][0]['content_base64']))
        with self.child(): third = agent_instance.execute(self.source, self.command(result['sandbox_id']))
        self.assertEqual(third['changes'], []); self.assertEqual(third['status'], 'completed')
        self.assertEqual(first['container_id'], third['container_id']); self.assertNotEqual(first['last_execution_id'], third['last_execution_id'])

    def test_unimported_returned_patch_cannot_be_overwritten_by_next_command(self):
        result = self.provision(); (self.guest_root/result['container_id']/'main.py').write_text('print(2)\n')
        with self.child(): first = agent_instance.execute(self.source, self.command(result['sandbox_id'], write_scope=['main.py']))
        self.assertEqual(len(first['changes']), 1)
        with self.child(): second = agent_instance.execute(self.source, self.command(result['sandbox_id']))
        self.assertEqual(second['status'], 'blocked'); self.assertEqual((self.source/'main.py').read_text(), 'print(1)\n')

    def test_existing_source_outside_scope_is_never_returned_and_instance_is_stopped(self):
        result = self.provision(); (self.guest_root/result['container_id']/'main.py').write_text('unapproved edit\n')
        with self.child(), self.assertRaises(PermissionError):
            agent_instance.execute(self.source, self.command(result['sandbox_id']))
        self.assertEqual(agent_instance.read(result['sandbox_id'])['state'], 'uncertain')
        self.assertFalse(self.docker.containers[result['container_id']]['State']['Running'])
        self.assertEqual((self.source/'main.py').read_text(), 'print(1)\n')

    def test_non_scoped_generated_files_are_not_imported(self):
        result = self.provision(); (self.guest_root/result['container_id']/'build-output').write_text('build artifact')
        with self.child(): outcome = agent_instance.execute(self.source, self.command(result['sandbox_id']))
        self.assertEqual(outcome['changes'], []); self.assertNotIn('build-output', agent_instance.read(result['sandbox_id'])['source_baseline'])

    def test_restarted_instance_is_not_silently_resumed(self):
        result = self.provision(); self.docker.containers[result['container_id']]['RestartCount'] = 1
        with self.child(), self.assertRaisesRegex(ValueError, 'restarted'):
            agent_instance.execute(self.source, self.command(result['sandbox_id']))
        self.assertEqual(agent_instance.read(result['sandbox_id'])['state'], 'uncertain')

    def test_restart_during_command_rejects_output(self):
        result = self.provision()
        def restarted(args, **kwargs):
            self.docker.containers[result['container_id']]['State']['StartedAt'] = 'replacement-start'
            return self.actual_popen([sys.executable, '-c', 'print(42)'], **kwargs)
        with patch('agent_instance.subprocess.Popen', side_effect=restarted), self.assertRaisesRegex(ValueError, 'restart'):
            agent_instance.execute(self.source, self.command(result['sandbox_id']))

    def test_timeout_stops_entire_instance_without_importing_changes(self):
        result = self.provision()
        with self.child('import time; time.sleep(2)'):
            outcome = agent_instance.execute(self.source, self.command(result['sandbox_id'], timeout_seconds=1))
        self.assertEqual(outcome['exit_code'], 124); self.assertEqual(outcome['state'], 'uncertain')
        self.assertEqual(outcome['changes'], []); self.assertFalse(self.docker.containers[result['container_id']]['State']['Running'])

    def test_lease_revoked_during_command_stops_guest_and_rejects_result(self):
        result = self.provision()
        with self.child('import time; time.sleep(1)'), patch('agent_instance.lease_valid', side_effect=[True, True, False]), self.assertRaises(PermissionError):
            agent_instance.execute(self.source, self.command(result['sandbox_id']))
        self.assertFalse(self.docker.containers[result['container_id']]['State']['Running'])

    def test_host_edit_during_command_rejects_patch(self):
        result = self.provision()
        def edit(args, **kwargs):
            (self.source/'main.py').write_text('host racing edit')
            return self.actual_popen([sys.executable, '-c', 'print(42)'], **kwargs)
        with patch('agent_instance.subprocess.Popen', side_effect=edit), self.assertRaises(PermissionError):
            agent_instance.execute(self.source, self.command(result['sandbox_id']))
        self.assertEqual((self.source/'main.py').read_text(), 'host racing edit')

    def test_concurrent_execute_is_durably_locked(self):
        result = self.provision(); record = agent_instance.claim(result['sandbox_id'], self.spec, 'execute')
        with self.assertRaisesRegex(RuntimeError, 'concurrent'):
            agent_instance.claim(result['sandbox_id'], self.spec, 'execute')
        self.assertEqual(agent_instance.read(result['sandbox_id'])['operation_token'], record['operation_token'])

    def test_dead_helper_execution_is_quarantined_and_not_replayed(self):
        result = self.provision(); record = agent_instance.read(result['sandbox_id'])
        record.update(state='executing', operation_pid=99999999, operation_stamp='orphan', operation_token=str(uuid.uuid4()))
        agent_instance.save(record)
        recovered = agent_instance.inspect(self.command(result['sandbox_id']))
        self.assertEqual(recovered['state'], 'uncertain'); self.assertFalse(recovered['running'])
        self.assertIn('not be replayed', recovered['last_error'])
        with self.assertRaises(RuntimeError): agent_instance.claim(result['sandbox_id'], self.spec, 'execute')

    def test_expired_cleanup_leaves_unexpired_instances_and_other_run_untouched(self):
        expired = self.provision(); active = self.provision(); record = agent_instance.read(expired['sandbox_id'])
        record['expires_at'] = time.time()-1; agent_instance.save(record)
        foreign_spec = request(); foreign = agent_instance.provision(self.source, foreign_spec)
        result = agent_instance.cleanup({'run_id': self.spec['run_id'], 'user_id': self.spec['user_id'], 'expired_only': True})
        self.assertEqual(result['removed'], [expired['sandbox_id']]); self.assertIn(active['container_id'], self.docker.containers)
        self.assertIn(foreign['container_id'], self.docker.containers)

    def test_working_run_sweep_releases_only_exact_retired_task_attempt(self):
        first = self.provision(); second = self.provision(task_id=str(uuid.uuid4()))
        older = self.provision(attempt=2)
        result = agent_instance.cleanup({'run_id': self.spec['run_id'], 'user_id': self.spec['user_id'], 'expired_only': True,
            'retired_leases': [{'task_id': self.spec['task_id'], 'attempt': 1}]})
        self.assertEqual(result['removed'], [first['sandbox_id']])
        self.assertIn(second['container_id'], self.docker.containers); self.assertIn(older['container_id'], self.docker.containers)

    def test_working_sweep_rejects_unbounded_or_malformed_retired_leases(self):
        for retired in ([{}], [{'task_id': self.spec['task_id'], 'attempt': True}], [None]*129):
            with self.subTest(retired=retired), self.assertRaises(ValueError):
                agent_instance.cleanup({'run_id': self.spec['run_id'], 'user_id': self.spec['user_id'], 'expired_only': True, 'retired_leases': retired})

    def test_terminal_cleanup_checks_actual_labels_and_is_retryable(self):
        first = self.provision(); second = self.provision(); cid = second['container_id']
        self.docker.containers[cid]['Config']['Labels']['stackpilot.agent-run'] = str(uuid.uuid4())
        result = agent_instance.cleanup({'run_id': self.spec['run_id']})
        self.assertEqual(result['removed'], [first['sandbox_id']]); self.assertEqual(result['status'], 'partial')
        self.assertIn(cid, self.docker.containers)
        self.docker.containers[cid]['Config']['Labels']['stackpilot.agent-run'] = self.spec['run_id']
        retry = agent_instance.cleanup({'run_id': self.spec['run_id']})
        self.assertEqual(retry['removed'], [second['sandbox_id']]); self.assertEqual(retry['status'], 'completed')

    def test_release_is_idempotent_and_refuses_foreign_owner(self):
        result = self.provision(); spec = self.command(result['sandbox_id'])
        with self.assertRaises(PermissionError): agent_instance.release({**spec, 'user_id': str(uuid.uuid4())})
        self.assertEqual(agent_instance.release(spec)['state'], 'released')
        self.assertEqual(agent_instance.release(spec)['state'], 'released')

    def test_cleanup_fences_active_helper_output(self):
        result = self.provision(); record = agent_instance.claim(result['sandbox_id'], self.spec, 'execute')
        token = record['operation_token']; agent_instance.cleanup({'run_id': self.spec['run_id']})
        agent_instance.clear_operation(record, 'ready')
        with self.assertRaisesRegex(RuntimeError, 'ownership token'): agent_instance.save(record, token=token)
        self.assertEqual(agent_instance.read(result['sandbox_id'])['state'], 'released')

    def test_atomic_quota_reservation_prevents_parallel_overallocation(self):
        def attempt(index):
            try: return agent_instance.reserve(self.source.resolve(), {**self.spec, 'task_id': str(index)}, agent_instance.options(self.spec))['sandbox_id']
            except ValueError: return None
        with patch.dict(os.environ, {'STACKPILOT_AGENT_INSTANCE_MAX_PER_RUN': '2'}), ThreadPoolExecutor(max_workers=8) as pool:
            values = list(pool.map(attempt, range(8)))
        self.assertEqual(sum(value is not None for value in values), 2)

    def test_atomic_aggregate_memory_and_cpu_admission_prevents_overcommit(self):
        for name, value in (('TOTAL_MEMORY_MB', '512'), ('TOTAL_CPUS', '1')):
            with self.subTest(name=name), patch.dict(os.environ, {'STACKPILOT_AGENT_INSTANCE_'+name: value}):
                first = self.provision()
                with self.assertRaisesRegex(ValueError, 'aggregate'):
                    self.provision()
                agent_instance.release(self.command(first['sandbox_id']))

    def test_parallel_reservations_share_aggregate_budget(self):
        def attempt(index):
            try: return agent_instance.reserve(self.source.resolve(), {**self.spec, 'run_id': str(uuid.uuid4()), 'task_id': str(index)}, agent_instance.options(self.spec))['sandbox_id']
            except ValueError: return None
        with patch.dict(os.environ, {'STACKPILOT_AGENT_INSTANCE_TOTAL_CPUS': '2'}), ThreadPoolExecutor(max_workers=8) as pool:
            values = list(pool.map(attempt, range(8)))
        self.assertEqual(sum(value is not None for value in values), 2)

    def test_operator_limits_and_inputs_reject_invalid_requests(self):
        for change in ({'run_id': 'foreign'}, {'attempt': True}, {'ttl_seconds': 3601}, {'memory_mb': 4097},
                       {'network': 'true'}, {'cpus': 9}, {'pids_limit': 129}):
            with self.subTest(change=change), self.assertRaises(ValueError): agent_instance.options({**self.spec, **change})
        for change in ({'argv': []}, {'argv': ['bad\0arg']}, {'write_scope': ['../outside']},
                       {'write_scope': ['C:/outside']}, {'timeout_seconds': 301}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                agent_instance.command(self.command(str(uuid.uuid4()), **change))

    def test_expired_instance_cannot_execute(self):
        result = self.provision(); record = agent_instance.read(result['sandbox_id'])
        record['expires_at'] = time.time()-1; agent_instance.save(record)
        with self.assertRaisesRegex(PermissionError, 'expired'):
            agent_instance.execute(self.source, self.command(result['sandbox_id']))

    def test_explicit_execution_environment_changes_are_refused(self):
        result = self.provision()
        for change in ({'image': 'python:3.12-slim'}, {'network': True}, {'network': 'false'}, {'capabilities': ['distro.alpine']}):
            with self.subTest(change=change), self.assertRaises((ValueError, PermissionError)):
                agent_instance.execute(self.source, self.command(result['sandbox_id'], **change))
        with patch('agent_instance.select', return_value={'status': 'unavailable'}), self.assertRaises(PermissionError):
            agent_instance.execute(self.source, self.command(result['sandbox_id'], capabilities=['gpu']))
        with self.child(): outcome = agent_instance.execute(self.source, self.command(result['sandbox_id'], image=result['image_id'], network=False))
        self.assertEqual(outcome['status'], 'completed')

    def test_operator_network_revocation_prevents_online_execution(self):
        result = self.provision(network=True)
        with patch.dict(os.environ, {'STACKPILOT_AGENT_WORKER_NETWORK': 'false'}), self.assertRaises(PermissionError):
            agent_instance.execute(self.source, self.command(result['sandbox_id']))


class SourcePatchBudget(unittest.TestCase):
    def test_patch_budget_and_generated_outputs_are_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root/'huge').write_bytes(b'x'*(1024*1024+1))
            with self.assertRaisesRegex(ValueError, '1 MiB'):
                agent_instance.source_changes({}, inventory(root), root, ['**'])
            changes, baseline = agent_instance.source_changes({}, inventory(root), root, [])
            self.assertEqual(changes, []); self.assertEqual(baseline, {})


class SourceArchiveBoundary(unittest.TestCase):
    def archive(self, entries):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w') as archive:
            for name, kind in entries:
                member = tarfile.TarInfo(name); member.mode = 0o644
                if kind == 'link': member.type = tarfile.SYMTYPE; member.linkname = '/etc/passwd'; archive.addfile(member)
                else: member.size = 7; archive.addfile(member, io.BytesIO(b'source\n'))
        return output.getvalue()

    def export(self, data, destination):
        actual = subprocess.Popen
        program = 'import base64,sys;sys.stdout.buffer.write(base64.b64decode('+repr(base64.b64encode(data).decode())+'))'
        with patch('agent_instance.subprocess.Popen', side_effect=lambda argv, **kwargs: actual([sys.executable, '-c', program], **kwargs)):
            agent_instance.export_source({'container_id': 'a'*64}, {}, destination)

    def test_real_child_archive_accepts_regular_files_and_excludes_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)/'source'
            self.export(self.archive([('./nested/source.py', 'file'), ('./node_modules/package', 'file')]), root)
            self.assertEqual((root/'nested/source.py').read_bytes(), b'source\n')
            self.assertFalse((root/'node_modules').exists())

    def test_tar_traversal_drive_paths_symlinks_and_duplicates_are_refused(self):
        for entries in ([('../escape', 'file')], [('/absolute', 'file')], [('C:/escape', 'file')],
                        [('nested\\escape', 'file')], [('link', 'link')], [('same', 'file'), ('same', 'file')]):
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as temporary, self.assertRaises(ValueError):
                self.export(self.archive(entries), Path(temporary)/'source')

    def test_archive_byte_budget_stops_child_before_extraction(self):
        with tempfile.TemporaryDirectory() as temporary, patch('agent_instance.SOURCE_ARCHIVE_BUDGET', 128), self.assertRaisesRegex(ValueError, 'return budget'):
            self.export(self.archive([('source', 'file')]), Path(temporary)/'source')


if __name__ == '__main__': unittest.main()
