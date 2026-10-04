import http.server
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'deployment-runtime'))
from artifact_server import make_handler
from compose_policy import sanitize
from planner import plan,prepare,desktop_dockerfile
from repository_tests import test as run_tests
from select_entrypoint import select,java,python_app,dotnet_project


class Contracts(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def write(self,name,value):
        path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(value);return path
    def test_api_health_is_not_browser_render(self):
        self.write('stackpilot.json',json.dumps({'workload':'api','port':8080,'health':{'path':'/ready','statuses':[204]}}))
        value=plan(self.root,'standard_web')
        self.assertEqual((value['port'],value['health_path'],value['verification_scope']),(8080,'/ready','http_contract'))
    def test_worker_has_process_contract(self):
        self.write('stackpilot.json','{"workload":"worker"}')
        self.assertEqual(plan(self.root,'standard_web')['verification_scope'],'process')
    def test_release_and_monitoring_workflows_have_distinct_contracts(self):
        release={'name':'Submit','steps':[{'action':'assert','expectations':[{'kind':'text','selector':'#result','expected':'created'}]}]}
        monitor={'name':'Read status','steps':[{'action':'assert','expectations':[{'kind':'visible','selector':'#ready','expected':True}]}]}
        self.write('stackpilot.json',json.dumps({'scenarios':[release],'monitor_scenarios':[monitor]}))
        value=plan(self.root,'standard_web')
        self.assertEqual(value['scenarios'],[release]);self.assertEqual(value['monitor_scenarios'],[monitor])
    def test_monitoring_workflows_require_outcomes_and_share_action_budget(self):
        assertion={'action':'assert','expectations':[{'kind':'visible','selector':'#ready','expected':True}]}
        for config in ({'monitor_scenarios':[{'steps':[{'action':'click','selector':'#submit'}]}]},
                       {'scenarios':[{'steps':[assertion]*60}],'monitor_scenarios':[{'steps':[assertion]*60}]}):
            self.write('stackpilot.json',json.dumps(config))
            with self.assertRaises(ValueError):plan(self.root,'standard_web')
    def test_finite_job_is_not_green_running_worker(self):
        self.write('stackpilot.json','{"workload":"job"}')
        with self.assertRaises(ValueError):plan(self.root,'standard_web')
    def test_invalid_contracts_fail_before_build(self):
        for value in ({'health':[]},{'health':{'path':'//other.test/'}},{'health':{'statuses':[]}},{'checks':[{'path':'https://other.test/'}]},{'port':True}):
            self.write('stackpilot.json',json.dumps(value))
            with self.subTest(value=value),self.assertRaises(ValueError):plan(self.root,'standard_web')
    def test_native_ios_requires_macos(self):
        self.assertEqual(plan(self.root,'native_ios')['requires_worker'],'macos')
    def test_android_artifact_delivery_has_explicit_scope(self):
        self.assertEqual(plan(self.root,'native_android')['verification_scope'],'artifact_delivery')
    def test_bad_health_path_rejected(self):
        self.write('stackpilot.json','{"health":{"path":"https://other.test/"}}')
        with self.assertRaises(ValueError):plan(self.root,'standard_web')
    def test_existing_dockerfile_preserved(self):
        self.write('Dockerfile','FROM owned:1\n');prepare(self.root,'native_android')
        self.assertEqual((self.root/'Dockerfile').read_text(),'FROM owned:1\n')
    def test_final_stage_port_overrides_base_image_exposes(self):
        self.write('Dockerfile','FROM builder AS build\nEXPOSE 8080\nFROM nginx:alpine\nEXPOSE 3000\n')
        self.assertEqual(plan(self.root,'standard_web')['port'],3000)
    def test_android_prepares_real_build_and_assets(self):
        prepare(self.root,'native_android');docker=(self.root/'Dockerfile').read_text()
        self.assertIn('sdkmanager',docker);self.assertIn('native_build.py android',docker)
        self.assertTrue((self.root/'.stackpilot-runtime/node_tasks.cjs').exists())
        self.assertNotIn('COPY . /app',docker)
    def test_node_runtime_runs_in_es_module_repositories(self):
        self.write('package.json',json.dumps({'type':'module','scripts':{'build':'node -e "process.stdout.write(\'ok\')"'}}))
        prepare(self.root,'standard_web')
        task=self.root/'.stackpilot-runtime/node_tasks.cjs'
        # The undeclared task exits after loading the helper, before invoking
        # npm (which is npm.cmd on native Windows). This catches the ESM require
        # failure that previously happened before task validation.
        result=subprocess.run(['node',str(task),'undeclared'],cwd=self.root,capture_output=True,text=True,timeout=30)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('No declared undeclared script',result.stderr)
        self.assertNotIn('require is not defined',result.stderr)
    def test_legacy_generated_node_dockerfile_is_migrated(self):
        self.write('package.json',json.dumps({'type':'module','scripts':{'build':'node build.js'}}))
        self.write('Dockerfile','FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN node .stackpilot-runtime/node_tasks.js install\n')
        prepare(self.root,'standard_web')
        dockerfile=(self.root/'Dockerfile').read_text()
        self.assertIn('node_tasks.cjs install',dockerfile)
        self.assertNotIn('node_tasks.js',dockerfile)
        self.assertTrue((self.root/'.stackpilot-runtime/node_tasks.cjs').is_file())
    def test_desktop_build_cannot_ignore_errors(self):
        self.assertNotIn('|| true',desktop_dockerfile())
        self.assertIn('native_build.py desktop',desktop_dockerfile())
    def test_empty_artifact_preview_refused(self):
        with self.assertRaises(RuntimeError):make_handler(self.root)
    def test_artifact_source_and_traversal_denied(self):
        self.write('application.apk','dummy isolated artifact');self.write('.env','DUMMY_SECRET=fixture')
        handler=make_handler(self.root);handler.log_message=lambda *args:None
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            base=f'http://127.0.0.1:{server.server_port}'
            for path in ('/.env','/artifacts/../.env','/artifacts/%2e%2e%2f.env','/manifest.json'):
                with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(base+path)
                self.assertEqual(error.exception.code,404)
            with urllib.request.urlopen(base+'/artifacts/application.apk') as response:self.assertEqual(response.status,200)
            with urllib.request.urlopen(base+'/healthz') as response:self.assertEqual(json.load(response)['artifacts'][0]['name'],'application.apk')
        finally:server.shutdown();server.server_close();thread.join(3)
    def test_unsafe_compose_is_refused(self):
        for service in ({'privileged':True},{'network_mode':'host'},{'cap_add':['SYS_ADMIN']},{'volumes':[{'type':'bind','source':'/var/run/docker.sock','target':'/socket','read_only':True}]}):
            with self.subTest(service=service),self.assertRaises(ValueError):sanitize({'services':{'app':service}},self.root)
    def test_compose_ports_and_resources_are_isolated(self):
        service=sanitize({'services':{'app':{'container_name':'shared','ports':[{'target':8080,'published':'8080'}]}}},self.root)['services']['app']
        self.assertNotIn('container_name',service);self.assertEqual(service['ports'][0]['host_ip'],'127.0.0.1')
        self.assertEqual(service['ports'][0]['published'],'0');self.assertEqual(service['pids_limit'],256)
    def test_compose_cannot_remove_quotas_or_drop_semantics(self):
        for values in ({'pids_limit':-1},{'cpus':0},{'deploy':{'replicas':3}},{'cpus':'nan'}):
            with self.subTest(values=values),self.assertRaises(ValueError):sanitize({'services':{'app':values}},self.root)
        value=sanitize({'services':{'app':{'mem_limit':'100g','pids_limit':10000}}},self.root)['services']['app']
        self.assertEqual(value['mem_limit'],2*1024**3);self.assertEqual(value['pids_limit'],512)
    def test_python_framework_entry_uses_real_variable(self):
        self.write('api.py','from fastapi import FastAPI\napi = FastAPI()\n')
        self.assertIn('api:api',python_app(self.root))
    def test_ambiguous_python_framework_entry_refused(self):
        self.write('one.py','from fastapi import FastAPI\napp = FastAPI()\n')
        self.write('two.py','from flask import Flask\napp = Flask(__name__)\n')
        with self.assertRaises(ValueError):python_app(self.root)
    def test_dotnet_library_not_chosen_as_app(self):
        self.write('library/library.csproj','<Project Sdk="Microsoft.NET.Sdk"/>')
        target=self.write('api/api.csproj','<Project Sdk="Microsoft.NET.Sdk.Web"/>')
        self.assertEqual(dotnet_project(self.root),target)
    def test_required_tests_cannot_be_missing(self):
        self.write('stackpilot.json','{"tests_required":true}')
        with self.assertRaises(RuntimeError):run_tests(self.root)
    def test_failed_test_blocks_promotion(self):
        self.write('stackpilot.json',json.dumps({'tests':[[sys.executable,'-c','raise SystemExit(19)']]}))
        with self.assertRaises(RuntimeError):run_tests(self.root)
        self.assertEqual(json.loads((self.root/'.stackpilot-tests.json').read_text())['results'][0]['exit_code'],19)
    def test_passed_tests_record_evidence(self):
        self.write('stackpilot.json',json.dumps({'tests':[[sys.executable,'-c','assert 2+2==4']]}))
        self.assertEqual(run_tests(self.root)['status'],'passed')
    def test_ambiguous_entrypoint_refused(self):
        with self.assertRaises(ValueError):select(self.root,[['app'],['unit_test']])
    def test_declared_entrypoint_resolves_ambiguity(self):
        self.write('stackpilot.json','{"entrypoint":["app"]}')
        self.assertEqual(select(self.root,[['app'],['test']]),['app'])
    def test_non_executable_jar_not_selected(self):
        artifact=self.root/'build/libs/library.jar';artifact.parent.mkdir(parents=True)
        with zipfile.ZipFile(artifact,'w') as archive:archive.writestr('META-INF/MANIFEST.MF','Manifest-Version: 1.0\n')
        with self.assertRaises(ValueError):java(self.root)

if __name__=='__main__':unittest.main()
