import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'deployment-runtime'))
import agent_image
from agent_process import inventory


def spec(**changes):
    result={'run_id':str(uuid.uuid4()),'task_id':str(uuid.uuid4()),'user_id':str(uuid.uuid4()),
            'lease_owner':'fixture-owner','attempt':1,'dockerfile':'Dockerfile','timeout_seconds':10}
    result.update(changes);return result


class SDKInputs(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def test_paths_identity_and_deadlines_are_bounded(self):
        for changes in ({'dockerfile':'../Dockerfile'},{'dockerfile':'/root/Dockerfile'},
                        {'dockerfile':'dir\\Dockerfile'},{'dockerfile':'C:/Dockerfile'},
                        {'timeout_seconds':901},{'timeout_seconds':True},{'attempt':0},{'run_id':'other'},
                        {'network':'true'}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):agent_image.request(spec(**changes))
    def test_network_requires_server_capability(self):
        with patch.dict(os.environ,{'STACKPILOT_AGENT_WORKER_NETWORK':'false'}):
            with self.assertRaises(ValueError):agent_image.request(spec(network=True))
    def test_snapshot_does_not_include_git_or_follow_symlinks(self):
        (self.root/'Dockerfile').write_text('FROM scratch\n')
        (self.root/'.git').mkdir();(self.root/'.git'/'config').write_text('fixture credential')
        (self.root/'run.sh').write_text('#!/bin/sh\nexit 0\n');(self.root/'run.sh').chmod(0o755)
        manifest=inventory(self.root);target=self.root/'staged'
        agent_image.stage(self.root,target,manifest)
        self.assertFalse((target/'.git').exists());self.assertEqual((target/'run.sh').read_text(),(self.root/'run.sh').read_text())
        if os.name!='nt':self.assertTrue((target/'run.sh').stat().st_mode & 0o111)
    @unittest.skipIf(os.name=='nt','Native Windows symlink privileges vary')
    def test_source_symlink_and_changed_source_are_refused(self):
        (self.root/'Dockerfile').write_text('FROM scratch\n')
        manifest=inventory(self.root);(self.root/'Dockerfile').write_text('changed')
        with self.assertRaises(ValueError):agent_image.stage(self.root,self.root/'stage',manifest)
        (self.root/'link').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):inventory(self.root)
    def test_offline_recipe_rejects_implicit_remote_inputs(self):
        for text in ('# syntax=repository/frontend:1\nFROM scratch',
                     '# escape=`\nFROM scratch',
                     'FROM ${BASE}\n','FROM scratch\nADD https://example.test/data /data',
                     'FROM scratch\nRUN --network=host command'):
            with self.subTest(text=text),self.assertRaises(ValueError):agent_image.offline_recipe(text,'docker',{})
    def test_cleanup_never_force_removes_live_or_foreign_images(self):
        from types import SimpleNamespace
        run=str(uuid.uuid4());owned='sha256:'+'a'*64;foreign='sha256:'+'b'*64;calls=[]
        def execute(argv,**kwargs):
            calls.append(argv)
            if argv[1:3]==['image','ls']:return SimpleNamespace(returncode=0,stdout=owned+'\n'+foreign+'\n')
            if argv[1:3]==['image','inspect']:
                return SimpleNamespace(returncode=0,stdout=json.dumps([{'Id':argv[3],
                    'Config':{'Labels':{'stackpilot.agent-run':run if argv[3]==owned else str(uuid.uuid4()),'stackpilot.agent-sdk':'true'}}}]))
            if argv[1]=='ps':return SimpleNamespace(returncode=0,stdout='running-container\n')
            self.fail('Live/foreign image removal was attempted: '+str(argv))
        with patch('agent_image.shutil.which',return_value='docker'),patch('agent_image.subprocess.run',side_effect=execute):
            result=agent_image.cleanup(run)
        self.assertEqual(result['removed'],[]);self.assertEqual(len(result['retained']),2)
        self.assertFalse(any(call[1:3]==['image','rm'] for call in calls))


@unittest.skipIf(os.name=='nt','SDK build helper targets the Linux broker')
class SDKLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.source=self.root/'source';self.source.mkdir()
        (self.source/'Dockerfile').write_text('FROM scratch\n')
        self.record=self.root/'record.json';self.record.write_text('{}')
        self.cli=self.root/'docker'
        # A real child process records whether the helper supplied credentials
        # and stages source correctly. Docker itself is qualified separately.
        program='''import json,os,pathlib,sys,time
args=sys.argv[1:];record=pathlib.Path(RECORD);value=json.loads(record.read_text())
if args[:1]==['build']:
 assert 'STACKPILOT_FIXTURE_CREDENTIAL' not in os.environ
 assert json.loads((pathlib.Path(os.environ['DOCKER_CONFIG'])/'config.json').read_text())=={}
 context=pathlib.Path(args[-1]);assert not (context/'.git').exists()
 text=pathlib.Path(args[args.index('--file')+1]).read_text()
 value['labels']=dict(args[i+1].split('=',1) for i,a in enumerate(args) if a=='--label')
 value['context_files']=[p.relative_to(context).as_posix() for p in context.rglob('*') if p.is_file()]
 value['built']=True;record.write_text(json.dumps(value))
 if 'fixture delay' in text:time.sleep(10)
 if 'fixture failed' in text:sys.exit(7)
 pathlib.Path(args[args.index('--iidfile')+1]).write_text('sha256:'+'a'*64)
elif args[:2]==['image','inspect']:
 print(json.dumps([{'Id':'sha256:'+'a'*64,'Config':{'Labels':value.get('labels',{})}}]))
elif args[:2]==['image','rm']:
 value['removed']=True;record.write_text(json.dumps(value))
'''
        self.cli.write_text('#!'+sys.executable+'\n'+program.replace('RECORD',repr(str(self.record))))
        self.cli.chmod(0o755)
        self.patches=[patch('agent_image.shutil.which',return_value=str(self.cli)),
                      patch('agent_image.select',return_value={'status':'ready'}),
                      patch.dict(os.environ,{'STACKPILOT_FIXTURE_CREDENTIAL':'must-not-be-forwarded'})]
        for item in self.patches:item.start()
    def tearDown(self):
        for item in self.patches:item.stop()
        self.temp.cleanup()
    def test_real_child_observes_filtered_context_environment_and_image_labels(self):
        (self.source/'.git').mkdir();(self.source/'.git'/'config').write_text('private fixture')
        with patch('agent_image.lease_valid',return_value=True):result=agent_image.execute(self.source,spec())
        self.assertEqual(result['status'],'completed',result);self.assertFalse(result['verified'])
        self.assertEqual(result['image_id'],'sha256:'+'a'*64)
        self.assertEqual(result['labels']['stackpilot.agent-sdk'],'true')
        recorded=json.loads(self.record.read_text());self.assertNotIn('.git/config',recorded['context_files'])
        self.assertNotIn('removed',recorded)
    def test_failed_build_does_not_supply_an_sdk_image(self):
        (self.source/'Dockerfile').write_text('FROM scratch\n# fixture failed\n')
        with patch('agent_image.lease_valid',return_value=True):result=agent_image.execute(self.source,spec())
        self.assertEqual(result['exit_code'],7);self.assertFalse(result['verified'])
        self.assertNotIn('image_id',result);self.assertTrue(json.loads(self.record.read_text())['removed'])
    def test_build_timeout_cancels_child_and_cleans_its_tag(self):
        (self.source/'Dockerfile').write_text('FROM scratch\n# fixture delay\n')
        with patch('agent_image.lease_valid',return_value=True):result=agent_image.execute(self.source,spec(timeout_seconds=1))
        self.assertEqual(result['exit_code'],124);self.assertTrue(result['timed_out'])
        self.assertTrue(json.loads(self.record.read_text())['removed'])
    def test_revoked_task_cannot_accept_an_sdk_image(self):
        (self.source/'Dockerfile').write_text('FROM scratch\n# fixture delay\n')
        with patch('agent_image.lease_valid',side_effect=[True,True,False]):
            with self.assertRaises(PermissionError):agent_image.execute(self.source,spec())
        self.assertTrue(json.loads(self.record.read_text())['removed'])


if __name__=='__main__':unittest.main()
