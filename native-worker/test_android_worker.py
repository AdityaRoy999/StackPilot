import hashlib
import hmac
import json
import time
import tempfile
import uuid
import subprocess
from pathlib import Path
import unittest
from unittest.mock import patch,AsyncMock
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

    def test_package_identity_comes_from_apk_manifest_before_installation(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(worker,'SDK',Path(directory)):
            tool=Path(directory)/'build-tools'/'36.0.0'/('aapt.exe' if worker.os.name=='nt' else 'aapt')
            tool.parent.mkdir(parents=True);tool.touch()
            with patch.object(worker.subprocess,'run',return_value=subprocess.CompletedProcess([],0,b"package: name='dev.fixture.app' versionCode='1'\n",b'')):
                self.assertEqual(worker.apk_package(Path(directory)/'app.apk'),'dev.fixture.app')
            with patch.object(worker.subprocess,'run',return_value=subprocess.CompletedProcess([],0,b'no package manifest',b'')):
                with self.assertRaisesRegex(RuntimeError,'application ID'):worker.apk_package(Path(directory)/'app.apk')


class AndroidStartup(unittest.IsolatedAsyncioTestCase):
    dialog={'resource-id':'android:id/aerr_close','bounds':'[0,0][100,100]','enabled':'true','package':'android'}
    async def test_waits_for_real_foreground_app_ui(self):
        with patch.object(worker,'nodes',side_effect=[[],[{'package':'dev.fixture.app'}]]),patch.object(worker,'foreground',return_value=True),patch.object(worker.asyncio,'sleep',new_callable=AsyncMock):
            self.assertEqual(await worker.application_ui('dev.fixture.app'),[])

    async def test_recovers_known_system_dialogs_once_on_owned_emulator(self):
        launcher='com.google.android.apps.nexuslauncher';systemui='com.android.systemui'
        with patch.object(worker,'SERIAL','emulator-5580'),patch.object(worker,'nodes',side_effect=[[self.dialog],[self.dialog],[{'package':'dev.fixture.app'}]]),patch.object(worker,'foreground',return_value=True),patch.object(worker.asyncio,'sleep',new_callable=AsyncMock),patch.object(worker,'adb',side_effect=[f'mCurrentFocus=Window{{1 u0 Application Not Responding: {launcher}}}',None,f'mCurrentFocus=Window{{2 u0 Application Not Responding: {systemui}}}',None]) as command:
            self.assertEqual(await worker.application_ui('dev.fixture.app'),[launcher,systemui])
            self.assertEqual(sum(call.args[:3]==('shell','input','tap') for call in command.call_args_list),2)

    async def test_application_anr_is_not_treated_as_system_recovery(self):
        with patch.object(worker,'nodes',return_value=[self.dialog]),patch.object(worker,'adb',return_value='mCurrentFocus=Window{1 u0 Application Not Responding: dev.fixture.app}') as command:
            with self.assertRaisesRegex(RuntimeError,'application is not responding'):await worker.application_ui('dev.fixture.app')
            self.assertEqual(command.call_count,1)

    async def test_stale_dialog_tree_waits_for_fresh_ui_without_dismissing_current_window(self):
        with patch.object(worker,'nodes',side_effect=[[self.dialog],[{'package':'dev.fixture.app'}]]),patch.object(worker,'foreground',return_value=True),patch.object(worker.asyncio,'sleep',new_callable=AsyncMock),patch.object(worker,'adb',return_value='mCurrentFocus=Window{1 u0 dev.fixture.app/MainActivity}') as command:
            self.assertEqual(await worker.application_ui('dev.fixture.app'),[])
            self.assertEqual(command.call_count,1)

    async def test_repeated_system_error_is_bounded(self):
        launcher='com.google.android.apps.nexuslauncher'
        with patch.object(worker,'SERIAL','emulator-5580'),patch.object(worker,'nodes',return_value=[self.dialog]),patch.object(worker.asyncio,'sleep',new_callable=AsyncMock),patch.object(worker,'adb',side_effect=[f'mCurrentFocus=Window{{1 u0 Application Not Responding: {launcher}}}',None,f'mCurrentFocus=Window{{1 u0 Application Not Responding: {launcher}}}']) as command:
            with self.assertRaisesRegex(RuntimeError,'unresolved system error'):await worker.application_ui('dev.fixture.app')
            self.assertEqual(sum(call.args[:3]==('shell','input','tap') for call in command.call_args_list),1)

    async def test_missing_ui_expires_instead_of_passing_launch(self):
        with patch.object(worker,'nodes',return_value=[]):
            with self.assertRaisesRegex(RuntimeError,'startup deadline'):await worker.application_ui('dev.fixture.app',timeout=0)

if __name__=='__main__':unittest.main()
