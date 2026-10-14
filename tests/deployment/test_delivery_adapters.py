import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'deployment-runtime'))
from planner import prepare
from repository_discovery import analyze
from repository_toolchains import discover
from portable_build import recipe
from android_delivery import select
from windows_crossbuild import validate_pe
from artifact_evidence import inspect as inspect_artifact
from input_readiness import inspect as inspect_inputs
import zipfile


class DeliveryAdapters(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
    def write(self,name,text):
        path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text);return path
    def test_selected_windows_project_does_not_scan_unrelated_targets(self):
        self.write('stackpilot.json',json.dumps({'workload':'windows','delivery':'artifact','project':'selected/app.csproj'}))
        self.write('selected/app.csproj','<Project><PropertyGroup><TargetFramework>net8.0-windows</TargetFramework><UseWpf>true</UseWpf><OutputType>WinExe</OutputType></PropertyGroup></Project>')
        for i in range(140):self.write(f'unrelated/{i}/app.csproj','invalid xml')
        sdk=next(t for t in discover(self.root,nested=True) if t['kind']=='dotnet')
        self.assertEqual(sdk['status'],'selected')
        discovery=analyze(self.root);self.assertLess(discovery['files_scanned'],5)
        result=prepare(self.root,'dotnet_web')
        self.assertIsNone(result['requires_worker']);self.assertEqual(result['verification_scope'],'artifact_delivery')
        self.assertEqual(result['target']['os'],'windows')
    def test_native_windows_verification_cannot_be_cross_build_proof(self):
        self.write('app.csproj','<Project><PropertyGroup><TargetFramework>net8.0-windows</TargetFramework><UseWpf>true</UseWpf><OutputType>WinExe</OutputType></PropertyGroup></Project>')
        self.write('stackpilot.json',json.dumps({'workload':'windows','delivery':'artifact','native_preview_required':True}))
        self.assertEqual(prepare(self.root,'dotnet_web')['requires_worker'],'windows')
    def test_simple_go_packager_gets_producer_but_complex_dockerfile_keeps_authority(self):
        self.write('go.mod','module example.test/glow\ngo 1.24\n')
        self.write('main.go','package main\nfunc main() {}\n')
        original='FROM gcr.io/distroless/static\nCOPY glow /usr/local/bin/glow\nENTRYPOINT ["/usr/local/bin/glow"]\n'
        self.write('Dockerfile',original);result=prepare(self.root,'go_web')
        self.assertEqual(result['workload'],'cli');self.assertEqual((self.root/'.stackpilot-original.Dockerfile').read_text(),original)
        self.assertEqual(prepare(self.root,'go_web')['adapter'],'go-packaging-prebuild')
        complex_recipe=original+'RUN echo custom\n';self.write('Dockerfile',complex_recipe);self.write('stackpilot.json','{}')
        self.assertIsNone(prepare(self.root,'go_web')['adapter']);self.assertEqual((self.root/'Dockerfile').read_text(),complex_recipe)
    def test_pe_architecture_and_malformed_header_are_rejected(self):
        path=self.root/'app.exe';header=bytearray(64);header[:2]=b'MZ';struct.pack_into('<I',header,60,64)
        path.write_bytes(header+b'PE\0\0'+struct.pack('<H',0x8664));validate_pe(path,'amd64')
        with self.assertRaises(ValueError):validate_pe(path,'arm64')
        path.write_bytes(b'MZ')
        with self.assertRaises(ValueError):validate_pe(path,'amd64')
    def test_android_selected_variant_keeps_tests_in_selected_module(self):
        value,task,tests,lint=select({'app:bundleDemoRelease','app:testDemoReleaseUnitTest','app:lintDemoRelease','other:testDebugUnitTest'}, {'module':'app','variant':'DemoRelease','format':'aab'})
        self.assertEqual((task,tests,lint),('app:bundleDemoRelease',['app:testDemoReleaseUnitTest'],'app:lintDemoRelease'))
        with self.assertRaises(ValueError):select({'one:assembleDebug','two:assembleDebug'}, {})
    def test_direct_artifact_escape_and_unbounded_patterns_rejected(self):
        value={'workload':'package','build_recipe':{'image':'python:3.12-slim','commands':[['python','-m','build']],'outputs':['dist']}}
        for pattern in [['../secret'],['/secret'],['dist/*']*33]:
            value['build_recipe']['artifact_files']=pattern
            with self.assertRaises(ValueError):recipe(value,'package')
    def test_gui_is_detected_without_mistaking_library_for_server(self):
        self.write('main.py','from tkinter import *\nroot=Tk()\nroot.mainloop()\n')
        result=prepare(self.root,'python_web');self.assertEqual(result['workload'],'desktop')
        self.assertEqual(result['entrypoint'],['python','-u','main.py'])
        self.assertIn('libtk8.6',(self.root/'Dockerfile').read_text())
    def test_repaired_gui_entrypoint_refreshes_our_generated_runtime_command(self):
        self.write('main.py','from tkinter import Tk\nTk().mainloop()\n')
        config={'workload':'desktop','desktop_framework':'python-gui','entrypoint':['python','-u','missing.py']}
        self.write('stackpilot.json',json.dumps(config));prepare(self.root,'python_web')
        self.assertIn('missing.py',(self.root/'Dockerfile').read_text())
        config['entrypoint']=['python','-u','main.py'];self.write('stackpilot.json',json.dumps(config))
        prepare(self.root,'python_web')
        self.assertNotIn('missing.py',(self.root/'Dockerfile').read_text())
        self.assertIn('main.py',(self.root/'Dockerfile').read_text())
    def test_nested_private_configuration_is_not_exportable_in_a_package(self):
        archive=self.root/'package.whl'
        with zipfile.ZipFile(archive,'w') as output:
            output.writestr('package-1.dist-info/WHEEL','Wheel-Version: 1.0')
            output.writestr('package/.env','PRIVATE=value')
        with self.assertRaisesRegex(ValueError,'private configuration'):inspect_artifact(archive)
    def test_required_environment_uses_selected_keys_without_values(self):
        self.write('.stackpilot-context.json',json.dumps({'deployment':{'environment_name':'production','branch':'main'},'effective_env_keys':[{'key':'DATABASE_URL'}]}))
        result=inspect_inputs(self.root,{'required_env_keys':['DATABASE_URL']})
        self.assertFalse(result['values_visible']);self.assertEqual(result['branch'],'main')
        with self.assertRaisesRegex(ValueError,'OTHER_KEY'):inspect_inputs(self.root,{'required_env_keys':['OTHER_KEY']})
    def test_android_js_build_uses_native_root_and_node_sdk(self):
        self.write('package.json',json.dumps({'dependencies':{'react-native':'0.76.0'},'engines':{'node':'>=20'}}))
        self.write('android/gradlew','#!/bin/sh\n')
        self.write('android/build.gradle','plugins { id "com.android.application" }')
        self.write('stackpilot.json','{"workload":"android"}')
        result=prepare(self.root,'expo_react_native')
        self.assertEqual(result['adapter'],'android-js');self.assertEqual(result['android']['project_root'],'android')
        self.assertIn('AS node-sdk',(self.root/'Dockerfile').read_text())
        self.assertNotIn('expo export',(self.root/'Dockerfile').read_text())
    def test_signing_stage_has_no_source_code_and_no_network(self):
        self.write('gradlew','#!/bin/sh\n')
        self.write('build.gradle','plugins { id "com.android.application" }')
        keys={'keystore':'SIGNING_KEY','store_password':'STORE_PASS','key_password':'KEY_PASS','alias':'KEY_ALIAS'}
        self.write('stackpilot.json',json.dumps({'workload':'android','android':{'signing':keys},'build_secrets':list(keys.values())}))
        prepare(self.root,'native_android');recipe=(self.root/'Dockerfile').read_text()
        before,signing=recipe.split('FROM android-sdk AS signing')
        self.assertNotIn('type=secret',before);self.assertIn('RUN --network=none',signing)
        self.assertNotIn('COPY . .',signing);self.assertTrue((self.root/'.stackpilot-signing-job.json').is_file())
    def test_gradle_java_versions_are_selected_and_incompatibility_fails_early(self):
        from native_toolchains import select
        self.write('gradle/wrapper/gradle-wrapper.properties','distributionUrl=https\\://services.gradle.org/distributions/gradle-7.2-bin.zip')
        self.assertEqual(select(self.root,{}, {},'android')['jdk'],'11')
        with self.assertRaisesRegex(ValueError,'cannot run'):select(self.root,{'android':{'jdk':'21'}},{},'android')
    def test_project_cache_is_stable_isolated_and_exclusively_mounted(self):
        from build_cache import namespace
        from planner import android_dockerfile
        self.write('.stackpilot-context.json',json.dumps({'project':{'id':'e7feb0d7-c1dd-4d3f-afc7-76765499300a'}}))
        first=namespace(self.root);self.assertEqual(first,namespace(self.root))
        self.write('.stackpilot-context.json',json.dumps({'project':{'id':'be1f1783-41a3-481f-92aa-af822e8224cd'}}))
        second=namespace(self.root);self.assertNotEqual(first,second)
        self.assertIn('id='+second+'-gradle,sharing=locked',android_dockerfile(cache_id=second))
        self.write('.stackpilot-context.json','{}')
        self.assertNotEqual(namespace(self.root),namespace(self.root))

if __name__=='__main__':unittest.main()
