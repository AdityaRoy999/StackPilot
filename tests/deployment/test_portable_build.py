import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from portable_build import build, dockerfile, recipe
from planner import prepare


class PortableBuild(unittest.TestCase):
    def config(self):
        return {'workload':'artifact','tests':[[sys.executable,'-c','assert 2+2==4']], 'tests_required':True,
            'build_recipe':{'image':'python:3.12-slim','commands':[[sys.executable,'-c',"from pathlib import Path; Path('output').mkdir(); Path('output/result.bin').write_bytes(b'actual build')"]], 'outputs':['output']}}

    def test_actual_commands_tests_and_outputs_create_artifact_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'source';root.mkdir();destination=Path(directory)/'export'
            (root/'stackpilot.json').write_text(json.dumps(self.config()))
            evidence=build(root,destination)
            self.assertEqual(evidence['status'],'passed')
            with zipfile.ZipFile(destination/'artifacts/application.zip') as archive:
                self.assertEqual(archive.read('output/result.bin'),b'actual build')
            self.assertEqual(json.loads((destination/'artifacts/manifest.json').read_text())['build'],'passed')

    def test_build_failure_never_creates_successful_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=self.config()
            config['build_recipe']['commands']=[[sys.executable,'-c','raise SystemExit(3)']]
            (root/'stackpilot.json').write_text(json.dumps(config))
            with self.assertRaises(subprocess.CalledProcessError):build(root,root/'export')
            self.assertFalse((root/'export').exists())

    def test_unsafe_outputs_and_image_injection_fail_before_build(self):
        for output in ('../secret','/etc/passwd','.'):
            config=self.config();config['build_recipe']['outputs']=[output]
            with self.assertRaises(ValueError):recipe(config,'artifact')
        config=self.config();config['build_recipe']['image']='python:3.12\nRUN injected'
        with self.assertRaises(ValueError):recipe(config,'artifact')

    def test_missing_outputs_cannot_claim_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=self.config();config['build_recipe']['outputs']=['not-built']
            (root/'stackpilot.json').write_text(json.dumps(config))
            with self.assertRaisesRegex(RuntimeError,'did not produce'):build(root,root/'export')

    def test_declared_workload_overrides_framework_guess(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'stackpilot.json').write_text(json.dumps(self.config()))
            plan=prepare(root,'native_android')
            self.assertEqual(plan['workload'],'artifact')
            generated=(root/'Dockerfile').read_text()
            self.assertIn('portable_build.py',generated)
            self.assertNotIn('sdkmanager',generated)

    def test_generic_desktop_command_uses_real_window_gate(self):
        config=self.config();config['workload']='desktop'
        config['build_recipe']['runtime_command']=['/app/output/application','--title','Preview']
        generated=dockerfile(config,'desktop')
        self.assertIn('desktop_entrypoint.py',generated)
        self.assertIn('STACKPILOT_APP_COMMAND=',generated)
        self.assertNotIn('application.jar',generated)

    def test_single_component_package_uses_normalized_recipe_and_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'source';root.mkdir();destination=Path(directory)/'export'
            component={**self.config(),'id':'package','root':'.','workload':'package'}
            (root/'stackpilot.json').write_text(json.dumps({'version':2,'primary_component':'package','components':[component]}))
            self.assertEqual(build(root,destination)['status'],'passed')
            with zipfile.ZipFile(destination/'artifacts/application.zip') as archive:
                self.assertEqual(archive.read('output/result.bin'),b'actual build')
