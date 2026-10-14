import json
from pathlib import Path
import tempfile
import unittest
import uuid

from app.agent_runtime.project_context import clean, env_observation, repository_env_keys
from app.agent_runtime.workspace import Workspaces, digest, source_files


class ProjectContextTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)

    def test_inventory_returns_all_names_not_values_and_skips_build_dependencies(self):
        (self.root/'api').mkdir()
        (self.root/'.env').write_text('DATABASE_URL=private-one\nexport TOKEN="private-two"\n# COMMENT=private-three\n')
        (self.root/'api/development.env').write_text('API_URL=private-four\n')
        (self.root/'node_modules').mkdir()
        (self.root/'node_modules/.env').write_text('DEPENDENCY_ONLY=private-five\n')
        files=repository_env_keys(self.root)
        self.assertEqual(files,[{'path':'.env','keys':['DATABASE_URL','TOKEN']},
                                {'path':'api/development.env','keys':['API_URL']}])
        self.assertNotIn('private-',json.dumps(files))
        self.assertEqual(env_observation('A=private\nA=duplicate\n'),
            '# Variable names only. Values stay with the deployment executor.\nA=[VALUE_HIDDEN]\n')

    def test_metadata_allowlist_discards_values_and_credentials(self):
        context=clean({'project':{'name':'fixture','password':'private'},
            'deployment':{'environment_id':'prod','branch':'main','env':{'VALUE':'private'}},
            'environments':[{'id':'prod','name':'production','branch':'main','value':'private'}],
            'env_keys':[{'key':'DATABASE_URL','scope':'project','value':'private','value_encrypted':'private'}],
            'effective_env_keys':[{'key':'DATABASE_URL','environment_id':'prod','scope':'environment','value':'private'}],
            'configured_branches':['main','dev'],'dotenv_files':[{'values':{'private':'private'}}]})
        self.assertNotIn('private',json.dumps(context))
        self.assertEqual(context['configured_branches'],['main','dev'])
        self.assertTrue(context['environment_selected'])
        self.assertFalse(context['values_visible'])
        self.assertEqual(context['effective_env_keys'][0]['environment_id'],'prod')
        self.assertEqual(clean({'environments':None,'env_keys':None,'configured_branches':'main'})['configured_branches'],[])

    def test_isolated_source_excludes_real_env_and_executor_context_and_masks_samples(self):
        (self.root/'.env').write_text('DATABASE_URL=private-live-value\n')
        (self.root/'production.env').write_text('TOKEN=private-live-value\n')
        (self.root/'.env.example').write_text('DATABASE_URL=private-sample-value\n')
        (self.root/'.stackpilot-context.json').write_text('{"forged":true}')
        self.assertEqual(list(source_files(self.root)),['.env.example'])
        workspaces=Workspaces(self.root.parent/(self.root.name+'-workspaces'))
        self.addCleanup(__import__('shutil').rmtree,workspaces.root)
        run=str(uuid.uuid4())
        workspaces.initialize(run,self.root)
        observed=workspaces.read(run,'lead','.env.example')
        self.assertNotIn('private-',observed['content'])
        self.assertEqual(observed['revision'],digest(workspaces.directory(run)/'.env.example'))
        with self.assertRaises(PermissionError):
            workspaces.write(run,'lead','.stackpilot-context.json','{}',['**'])

    def test_inventory_does_not_follow_symlinks(self):
        outside=self.root/'outside'
        outside.mkdir();(outside/'.env').write_text('OUTSIDE=private\n')
        source=self.root/'source';source.mkdir()
        try:(source/'linked').symlink_to(outside,target_is_directory=True)
        except OSError:self.skipTest('Symlinks unavailable')
        self.assertEqual(repository_env_keys(source),[])
