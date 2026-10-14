import json
import tempfile
import unittest
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch
from app.agent_runtime.execution_profiles import prepare, worker_arguments, validate_environment, repair_completion


class ExecutionProfilesTests(unittest.TestCase):
    def test_whole_script_setup_is_rejected_before_freezing_acceptance(self):
        with self.assertRaisesRegex(ValueError,'executable argv arrays'):
            validate_environment({'setup':[['mkdir -p build && cd build && cmake ..']],'network':True})
        validate_environment({'setup':[['sh','-ec','mkdir -p build && cd build && cmake ..']],'network':True})

    def test_redundantly_quoted_worker_script_executes_instead_of_becoming_a_command_name(self):
        import shlex
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            script='mkdir -p build && cd build && printf "compiled\\n"'
            arguments={'argv':['sh','-ec',shlex.quote(script)],'image':'python:3.12-slim'}
            result=worker_arguments(root,arguments)
            executed=subprocess.run(result['argv'],cwd=root,capture_output=True,text=True,check=True)
            self.assertEqual(executed.stdout,'compiled\n')
            self.assertTrue((root/'build').is_dir())
            self.assertEqual(arguments['argv'][2],shlex.quote(script))

    def test_shell_normalization_preserves_quoted_executable_paths_and_normal_scripts(self):
        for script in ("'./my cli'", "'my cli'", 'echo hello && printf done', '"echo hello"'):
            arguments={'argv':['sh','-ec',script],'image':'python:3.12-slim'}
            self.assertEqual(worker_arguments(Path('.'),arguments),arguments)

    def test_gui_configuration_repair_preserves_source_and_rejects_a_fake_launcher(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'requirements.txt').write_text('')
            (root/'main.py').write_text('from tkinter import Tk\nTk().mainloop()\n')
            original={'workload':'desktop','desktop_framework':'python-gui','entrypoint':['python','-u','missing.py']}
            config=root/'stackpilot.json';config.write_text(json.dumps(original))
            value=repair_completion(root);check=value['features'][0]['checks'][0]
            program=check['argv'][2]
            def run():return subprocess.run([sys.executable,'-c',program],cwd=root,capture_output=True).returncode
            self.assertNotEqual(run(),0)
            original['entrypoint']=['python','-u','main.py'];config.write_text(json.dumps(original))
            self.assertEqual(run(),0)
            (root/'main.py').write_text("print('placeholder')\n")
            self.assertNotEqual(run(),0)
            (root/'main.py').write_text('from tkinter import Tk\nTk().mainloop()\n')
            original['entrypoint']=['sh','-c','tail -f /dev/null'];config.write_text(json.dumps(original))
            self.assertNotEqual(run(),0)
    def test_pytest_inventory_path_is_relative_to_selected_component_and_preserves_selector(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); tests=root/'apps/api/tests'; tests.mkdir(parents=True)
            (tests/'test_added.py').write_text('def test_added(): pass\n')
            argv=['python','-m','pytest','apps/api/tests/test_added.py::test_added','tests/test_added.py','--cov=apps/api','-k','apps/api/tests/test_added.py','apps/api/unknown.py']
            result=worker_arguments(root,{'argv':argv,'root':'apps/api','image':'python:3.12-slim'})
            self.assertEqual(result['argv'],['python','-m','pytest','tests/test_added.py::test_added','tests/test_added.py','--cov=apps/api','-k','apps/api/tests/test_added.py','apps/api/unknown.py'])
            self.assertEqual(argv[3],'apps/api/tests/test_added.py::test_added')

    def test_pytest_path_normalization_does_not_admit_path_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'apps/api').mkdir(parents=True)
            with self.assertRaises(PermissionError):
                worker_arguments(root,{'argv':['pytest','apps/api/../../outside.py'],'root':'apps/api','image':'python:3.12-slim'})

    def test_repair_preserves_original_suite_for_explicit_fastapi_compose_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); api=root/'apps/api'; api.mkdir(parents=True); (api/'tests').mkdir()
            (api/'pyproject.toml').write_text('[project]\nname="api"\nversion="1"\ndependencies=["fastapi"]\n[project.optional-dependencies]\ndev=["pytest-cov"]\n')
            (root/'compose.yaml').write_text('services:\n  api:\n    build:\n      context: apps/api\n  postgres:\n    image: postgres:17\n')
            value=repair_completion(root)
            check=value['features'][0]['checks'][0]
            self.assertEqual(check['root'],'apps/api')
            self.assertEqual(check['argv'],['python','-m','pytest','-q'])
            self.assertTrue(check['network']); self.assertEqual(check['timeout_seconds'],300)
            self.assertIn('.[dev]',check['setup'][0])
            (root/'stackpilot.json').write_text('{"workload":"worker"}')
            self.assertIsNone(repair_completion(root), 'Explicit workloads must retain their own completion planner')

    def test_install_uses_component_sdk_and_requests_available_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'requirements.txt').write_text('')
            args={'argv':['python','-m','pip','install','pytest']}
            result=worker_arguments(root,args)
            self.assertTrue(result['image'].startswith('python:'))
            self.assertTrue(result['network']); self.assertNotIn('setup',result)
            self.assertFalse(worker_arguments(root,{**args,'network':False})['network'])

    def test_node_build_uses_declared_sdk_and_prepares_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'package.json').write_text('{"engines":{"node":"24.x"}}')
            result=worker_arguments(root,{'argv':['npm','run','build']})
            self.assertEqual(result['image'],'node:24-bookworm-slim')
            self.assertEqual(result['setup'],[['npm','install']])

    def test_impossible_acceptance_plan_is_rejected_before_freezing(self):
        for check in ({'setup':[['pip','install','.[dev]']],'network':False}, {'argv':['curl','-f','http://localhost:8000/health'],'setup':[],'network':True}):
            with self.assertRaises(ValueError):validate_environment(check)
        validate_environment({'setup':[['python','-m','pip','install','.[dev]']],'network':True,'argv':['python','-m','pytest']})
    def test_worker_prepares_declared_python_plugins_in_selected_component(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); api=root/'apps'/'api'; api.mkdir(parents=True)
            (api/'pyproject.toml').write_text('[project]\nname="api"\nversion="1.0"\nrequires-python="==3.12.*"\n[project.optional-dependencies]\ndev=["pytest-cov", "pytest-asyncio"]\n')
            (api/'tests').mkdir()
            args={'argv':['python','-m','pytest','tests'], 'root':'apps/api'}
            result=worker_arguments(root,args)
            self.assertIn(['python','-m','pip','install','--no-cache-dir','.[dev]'],result['setup'])
            self.assertTrue(result['network']); self.assertEqual(result['root'],'apps/api')
            self.assertEqual(result['timeout_seconds'],300)
            self.assertNotIn('setup',args)

    def test_worker_diagnostic_does_not_install_repository_dependencies(self):
        args={'argv':['python','--version']}
        self.assertEqual(worker_arguments(Path('.'),args),args)

    def test_worker_preserves_explicit_offline_sdk_and_setup(self):
        args={'argv':['pytest'], 'image':'python:3.12-slim','setup':[], 'network':False}
        self.assertEqual(worker_arguments(Path('.'),args),args)

    def test_worker_root_cannot_escape_and_argv_cannot_be_encoded_text(self):
        for args in ({'argv':'[pytest, tests]'}, {'argv':['pytest'],'root':'../outside'}):
            with self.assertRaises((ValueError, PermissionError)):worker_arguments(Path('.'),args)

    def test_distinct_component_toolchains_and_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'api').mkdir(); (root/'ui').mkdir()
            (root/'api'/'pyproject.toml').write_text('[project]\nname="api"\nversion="1.0"\nrequires-python="==3.11.*"\n')
            (root/'ui'/'package.json').write_text(json.dumps({'engines':{'node':'20.x'},'scripts':{'test':'node test.js'}}))
            (root/'ui'/'package-lock.json').write_text('{}')
            commands=[{'root':'api','argv':['python','test.py']},{'root':'ui','argv':['npm','test']}]
            result,requirements=prepare(root,commands,{})
            self.assertFalse(requirements)
            self.assertTrue(result[0]['image'].startswith('python:3.11'))
            self.assertTrue(result[1]['image'].startswith('node:20'))
            self.assertIn(['npm','ci'],result[1]['setup'])
            self.assertTrue(result[1]['network'])
            self.assertNotIn('image',commands[0])

    def test_frozen_feature_execution_environment_stays_exact(self):
        command={'root':'.','argv':['python','-c','assert True'],'image':'python:3.12-slim','setup':[],'network':False,'feature_id':'sum'}
        with patch('app.agent_runtime.execution_profiles.verification_profile',side_effect=AssertionError('Frozen contract was rediscovered')):
            self.assertEqual(prepare(Path('.'),[command],{'image':'node:22-bookworm-slim'}),([command],[]))

    def test_explicit_sdk_bypasses_ambiguous_detection(self):
        with patch('app.agent_runtime.execution_profiles.verification_profile',side_effect=AssertionError('Explicit SDK was rediscovered')):
            commands=[{'root':'.','argv':['check']}]
            self.assertEqual(prepare(Path('.'),commands,{'image':'sha256:'+'a'*64}),(commands,[]))

    def test_ambiguous_component_requires_sdk_instead_of_python_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'package.json').write_text('{}');(root/'requirements.txt').write_text('')
            _,requirements=prepare(root,[{'root':'.','argv':['check']}],{})
            self.assertEqual(requirements[0]['kind'],'toolchain')

    def test_explicit_network_and_setup_are_preserved(self):
        with patch('app.agent_runtime.execution_profiles.verification_profile',return_value={'image':'node:20-bookworm-slim','setup':[['npm','ci']],'network':True,'issues':[]}):
            result,_=prepare(Path('.'),[{'root':'.','argv':['node','test.js']}],{'setup':[],'network':False})
            self.assertEqual(result[0]['setup'],[])
            self.assertFalse(result[0]['network'])


if __name__=='__main__':unittest.main()
