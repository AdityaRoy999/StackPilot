import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from app.agent_runtime.execution_profiles import prepare


class ExecutionProfilesTests(unittest.TestCase):
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
