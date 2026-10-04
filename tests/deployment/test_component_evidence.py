import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'deployment-runtime'))
from compose_runtime_evidence import collect,identity


class ComponentEvidence(unittest.TestCase):
    def setUp(self):
        self.project='stackpilot-component-fixture'
        self.image='sha256:'+'a'*64
        self.row={'Id':'b'*64,'Image':self.image,'RestartCount':0,
            'Config':{'Labels':{'com.docker.compose.project':self.project,'com.docker.compose.service':'api'}},
            'State':{'Running':True,'Status':'running','StartedAt':'2026-10-01T00:00:00Z'},
            'NetworkSettings':{'Ports':{'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':'52001'}]}}}
        self.model={'services':{'api':{'image':'fixture:1'}}}
        self.plan={'repository_plan':{'execution_order':['api']},'component_contracts':{'api':{'protocol':'http','port':8080}}}
    def run_command(self,argv,**kwargs):
        if argv[1]=='ps':value=self.row['Id']
        elif argv[1]=='inspect':value=json.dumps([self.row])
        elif argv[1:3]==['image','inspect']:value=self.image
        else:self.fail('Unexpected daemon command '+repr(argv))
        return subprocess.CompletedProcess(argv,0,value,'')
    def test_actual_inspect_identity_binds_endpoint_and_image(self):
        value=collect(self.project,self.model,self.plan,runner=self.run_command)
        self.assertEqual(value['components']['api']['url'],'http://localhost:52001')
        self.assertEqual(identity(value)['api']['container_id'],self.row['Id'])
        self.assertEqual(value['components']['api']['expected_image_id'],self.image)
    def test_changed_image_and_restarted_container_are_not_accepted(self):
        self.row['Image']='sha256:'+'c'*64
        with self.assertRaisesRegex(RuntimeError,'changed after build'):collect(self.project,self.model,self.plan,runner=self.run_command)
        self.row['Image']=self.image;self.row['RestartCount']=1
        with self.assertRaisesRegex(RuntimeError,'stable running'):collect(self.project,self.model,self.plan,runner=self.run_command)
    def test_nonloopback_or_missing_endpoint_cannot_borrow_another_port(self):
        self.row['NetworkSettings']['Ports']['8080/tcp'][0]['HostIp']='0.0.0.0'
        with self.assertRaisesRegex(RuntimeError,'isolated loopback'):collect(self.project,self.model,self.plan,runner=self.run_command)
        self.row['NetworkSettings']['Ports']={'8081/tcp':[{'HostIp':'127.0.0.1','HostPort':'52001'}]}
        with self.assertRaisesRegex(RuntimeError,'isolated loopback'):collect(self.project,self.model,self.plan,runner=self.run_command)
    def test_worker_checks_run_against_exact_id_and_identity_only_does_not_replay(self):
        self.plan['component_contracts']['api']={'protocol':'process','process_checks':[{'argv':['test','-f','/ready']}]}
        calls=[]
        def checker(container,check):calls.append(container);return {'passed':True}
        first=collect(self.project,self.model,self.plan,runner=self.run_command,checker=checker)
        after=collect(self.project,self.model,self.plan,runner=self.run_command,checker=checker,execute_checks=False)
        self.assertEqual(calls,[self.row['Id']]);self.assertEqual(identity(first),identity(after))
        self.assertEqual(after['components']['api']['process_checks'],[])
    def test_unknown_or_missing_compiled_service_fails_closed(self):
        self.plan['component_contracts']['worker']={'protocol':'process'}
        with self.assertRaises(ValueError):collect(self.project,self.model,self.plan,runner=self.run_command)

    def test_serving_monitor_explicitly_rechecks_restarted_container(self):
        self.row['RestartCount']=2
        with self.assertRaisesRegex(RuntimeError,'stable running'):collect(self.project,self.model,self.plan,runner=self.run_command)
        current=collect(self.project,self.model,self.plan,runner=self.run_command,allow_restarts=True)
        self.assertEqual(current['observation_mode'],'serving')
        self.assertEqual(current['components']['api']['restart_count'],2)


if __name__=='__main__':unittest.main()
