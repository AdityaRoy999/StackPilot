import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from repository_plan import normalize
from planner import prepare


class RepositoryPlanTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        for name in ('api','web'):
            (self.root/name).mkdir()
            (self.root/name/'Dockerfile').write_text('FROM python:3.12-slim\nEXPOSE 3000\nCMD ["python", "-m", "http.server", "3000"]\n')
        self.config={'version':2,'primary_component':'web','components':[
            {'id':'web','root':'web','workload':'web','port':3000,'depends_on':['api']},
            {'id':'api','root':'api','workload':'api','port':3000}]}

    def test_topological_order_and_primary_contract(self):
        config,graph=normalize(self.root,self.config)
        self.assertEqual(graph['execution_order'],['api','web'])
        self.assertEqual(config['primary_service'],'web')

    def test_cycle_and_missing_dependency_rejected(self):
        self.config['components'][1]['depends_on']=['web']
        with self.assertRaisesRegex(ValueError,'cycle'):normalize(self.root,self.config)
        self.config['components'][1]['depends_on']=['missing']
        with self.assertRaisesRegex(ValueError,'Missing dependency'):normalize(self.root,self.config)

    def test_component_path_escape_rejected(self):
        self.config['components'][0]['root']='../other'
        with self.assertRaises(ValueError):normalize(self.root,self.config)

    def test_stateful_swap_is_not_silently_approved(self):
        self.config['components'][1]['state']={'database':'postgres','migration':['python','migrate.py']}
        with self.assertRaisesRegex(ValueError,'migration/backup'):normalize(self.root,self.config)

    def test_prepares_real_component_build_contexts(self):
        (self.root/'stackpilot.json').write_text(json.dumps(self.config))
        contract=prepare(self.root,'standard_web')
        model=json.loads((self.root/'compose.yaml').read_text())
        self.assertEqual(set(model['services']),{'api','web'})
        self.assertEqual(model['services']['web']['build']['context'],'web')
        self.assertEqual(contract['repository_plan']['execution_order'],['api','web'])
        self.assertTrue((self.root/'api/.stackpilot-runtime/repository_tests.py').is_file())

    def test_version_one_remains_compatible(self):
        config={'version':1,'workload':'api','port':3000}
        self.assertEqual(normalize(self.root,config),(config,None))

    def test_retry_preserves_graph_and_component_tests(self):
        self.config['components'][1].update(tests=[['python','test_api.py']],tests_required=True)
        (self.root/'stackpilot.json').write_text(json.dumps(self.config))
        prepare(self.root,'standard_web')
        retried=prepare(self.root,'standard_web')
        self.assertEqual(retried['repository_plan']['execution_order'],['api','web'])
        self.assertEqual(retried['test_services'],['api'])
        self.assertEqual(json.loads((self.root/'stackpilot.json').read_text())['version'],2)

    def test_single_nested_component_infers_its_port(self):
        config={'version':2,'components':[{'id':'web','root':'web','workload':'web'}]}
        (self.root/'stackpilot.json').write_text(json.dumps(config))
        self.assertEqual(prepare(self.root,'standard_web')['port'],3000)

    def test_secondary_assertions_survive_and_unavailable_capabilities_are_precise(self):
        self.config['components'][1]['checks']=[{'path':'/health'}]
        config,graph=normalize(self.root,self.config)
        self.assertEqual(graph['components'][0]['checks'],[{'path':'/health'}])
        self.config['components'][1]['capabilities']=['gpu']
        with self.assertRaisesRegex(ValueError,'unmet sandbox capabilities: gpu'):normalize(self.root,self.config)

    def test_mixed_finite_and_worker_components_preserve_adapters(self):
        self.config['components'][1].update(workload='job',entrypoint=['python','batch.py'])
        config,graph=normalize(self.root,self.config)
        self.assertEqual(graph['components'][0]['workload'],'job')
        self.assertEqual(config['primary_service'],'web')

    def test_worker_process_checks_are_bounded_and_not_host_commands(self):
        self.config['components'][1].update(workload='worker',process_checks=[{'argv':['python','-c','print("ready")'],'output_contains':'ready'}])
        config,graph=normalize(self.root,self.config)
        self.assertEqual(graph['components'][0]['process_checks'][0]['argv'][0],'python')
        self.config['components'][1]['process_checks'][0]['timeout_seconds']=61
        with self.assertRaisesRegex(ValueError,'1–60'):normalize(self.root,self.config)

    def test_all_network_components_have_isolated_mappings(self):
        (self.root/'stackpilot.json').write_text(json.dumps(self.config))
        prepare(self.root,'standard_web')
        model=json.loads((self.root/'compose.yaml').read_text())
        self.assertEqual(model['services']['api']['ports'],['3000'])
        self.assertEqual(model['services']['web']['ports'],['3000'])

    def test_single_root_worker_assertions_use_component_executor(self):
        (self.root/'Dockerfile').write_text('FROM python:3.12-slim\nCMD ["python","worker.py"]\n')
        config={'version':2,'components':[{'id':'worker','root':'.','workload':'worker',
            'process_checks':[{'argv':['python','-c','print("ready")'],'output_contains':'ready'}]}]}
        (self.root/'stackpilot.json').write_text(json.dumps(config))
        contract=prepare(self.root,'standard_web')
        model=json.loads((self.root/'compose.yaml').read_text())
        self.assertIn('worker',model['services']);self.assertNotIn('ports',model['services']['worker'])
        self.assertEqual(contract['component_contracts']['worker']['process_checks'][0]['argv'][0],'python')

    def test_original_child_health_and_worker_assertions_are_not_dropped(self):
        (self.root/'api/stackpilot.json').write_text(json.dumps({'workload':'api','health':{'path':'/original','statuses':[204]}}))
        self.config['components'][1]['health']={'path':'/ready'}
        (self.root/'stackpilot.json').write_text(json.dumps(self.config))
        contract=prepare(self.root,'standard_web')
        self.assertIn({'path':'/original','statuses':[204]},contract['component_contracts']['api']['checks'])

    def test_worker_http_assertions_do_not_become_unverified_process_success(self):
        self.config['components'][1].update(workload='worker',checks=[{'path':'/ready'}])
        (self.root/'stackpilot.json').write_text(json.dumps(self.config))
        with self.assertRaisesRegex(ValueError,'HTTP assertions require an HTTP adapter'):prepare(self.root,'standard_web')

    def test_manually_changed_generated_topology_is_preserved(self):
        (self.root/'stackpilot.json').write_text(json.dumps(self.config))
        prepare(self.root,'standard_web')
        target=self.root/'compose.yaml'
        target.write_text('services: {}')
        with self.assertRaisesRegex(ValueError,'authoritative topology'):prepare(self.root,'standard_web')
        self.assertEqual(target.read_text(),'services: {}')
