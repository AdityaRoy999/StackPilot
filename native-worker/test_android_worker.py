import hashlib
import hmac
import json
import time
import tempfile
import uuid
from pathlib import Path
import unittest
from unittest.mock import patch
import android_worker as worker

class AndroidBoundary(unittest.TestCase):
    def token(self,**values):
        payload=json.dumps({'kind':'native','session_id':'deployment','control':False,'expires':int(time.time())+200,**values}).encode()
        return payload.hex()+'.'+hmac.new(b'fixture-key',payload,hashlib.sha256).hexdigest()
    def test_preview_capabilities_are_deployment_scoped_and_expire(self):
        with patch.object(worker,'TOKEN','fixture-key'):
            self.assertIsNotNone(worker.ticket(self.token(),'deployment'))
            for value,identity in [(self.token(),'other'),(self.token(expires=0),'deployment'),(self.token(kind='browser'),'deployment'),(self.token()+'0','deployment')]:self.assertIsNone(worker.ticket(value,identity))
    def test_ambiguous_disabled_or_invisible_targets_are_rejected(self):
        node={'text':'Continue','bounds':'[0,0][100,100]','enabled':'true'}
        self.assertEqual(worker.target([node],{'text':'Continue'}),(50,50))
        for nodes in ([node,node],[{**node,'enabled':'false'}],[{**node,'bounds':'[0,0][0,0]'}],[]):
            with self.assertRaises(ValueError):worker.target(nodes,{'text':'Continue'})
    def test_native_workflows_require_assertions_and_bound_actions(self):
        for scenario in ([{'steps':[{'action':'tap'}]}],[{'steps':[{'action':'assert','expectations':[]}]}],[{'steps':['malformed']}],['malformed']):
            with self.assertRaises(ValueError):worker.validate_scenarios(scenario)

    def test_ticket_rejects_non_boolean_control_and_non_integer_expiry(self):
        with patch.object(worker,'TOKEN','fixture-key'):
            for values in ({'control':'false'},{'control':1},{'expires':str(int(time.time())+20)}):
                self.assertIsNone(worker.ticket(self.token(**values),'deployment'))

    def test_restart_recovers_only_owned_integrity_checked_foreground_release(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(worker,'ROOT',Path(directory)),patch.object(worker,'foreground',return_value=True) as foreground:
            identity=str(uuid.uuid4());package='dev.fixture.app';apk=Path(directory)/identity/'application.apk'
            apk.parent.mkdir();apk.write_bytes(b'fixture-apk')
            record={'deployment_id':identity,'package':package,'artifact_digest':hashlib.sha256(apk.read_bytes()).hexdigest()}
            worker.remember_active(record)
            self.assertIsNone(worker.recover_active())
            (Path(directory)/'installed.json').write_text(json.dumps([package]))
            self.assertEqual(worker.recover_active(),record)
            foreground.return_value=False
            self.assertIsNone(worker.recover_active())
            foreground.return_value=True;apk.write_bytes(b'tampered')
            self.assertIsNone(worker.recover_active())
            worker.remember_active(None)
            self.assertIsNone(worker.recover_active())

    def test_device_observation_does_not_claim_release_workflow_correctness(self):
        from fastapi.testclient import TestClient
        record={'deployment_id':'fixture','package':'dev.fixture.app'}
        with patch.object(worker,'TOKEN','fixture-key'),patch.object(worker,'active',record),patch.object(worker,'foreground',return_value=True):
            with TestClient(worker.app) as client:
                self.assertEqual(client.get('/observe/fixture').status_code,401)
                headers={'x-stackpilot-service-token':'fixture-key'}
                observed=client.get('/observe/fixture',headers=headers).json()
                self.assertTrue(observed['verified']);self.assertFalse(observed['workflow_verified'])
                self.assertEqual(client.get('/observe/other',headers=headers).json()['status'],'unverified')

    def test_cleanup_revokes_only_matching_owned_native_release(self):
        from fastapi.testclient import TestClient
        identity=str(uuid.uuid4());record={'deployment_id':identity,'package':'dev.fixture.app'}
        with tempfile.TemporaryDirectory() as directory,patch.object(worker,'ROOT',Path(directory)),patch.object(worker,'TOKEN','fixture-key'),patch.object(worker,'active',record),patch.object(worker,'owned_packages',return_value={'dev.fixture.app'}),patch.object(worker,'adb',return_value='package:dev.fixture.app') as command:
            worker.remember_active(record)
            with TestClient(worker.app) as client:
                headers={'x-stackpilot-service-token':'fixture-key'}
                self.assertEqual(client.post('/release/'+identity).status_code,401)
                self.assertEqual(client.post('/release/'+str(uuid.uuid4()),headers=headers).json()['status'],'not_active')
                command.assert_not_called();self.assertEqual(worker.active,record)
                self.assertEqual(client.post('/release/'+identity,headers=headers).json()['status'],'released')
                command.assert_any_call('uninstall','dev.fixture.app',timeout=30)
                self.assertIsNone(worker.active)
                self.assertIsNone(json.loads((Path(directory)/'active.json').read_text()))

if __name__=='__main__':unittest.main()
