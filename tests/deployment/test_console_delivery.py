import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'deployment-runtime'))
sys.path.insert(0,str(ROOT/'ai-service'))
from planner import plan, prepare
from portable_build import dockerfile
from repository_discovery import analyze


class Discovery(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def write(self,name,text):
        target=self.root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(text)
    def test_original_interactive_program_gets_console_not_web(self):
        self.write('calculator.py',"while True:\n print(int(input('Number: '))*2)\n")
        value=prepare(self.root,'standard_web')
        self.assertEqual(value['workload'],'cli')
        self.assertEqual(value['entrypoint'],['python','-u','calculator.py'])
        self.assertEqual(value['verification_scope'],'console_workflow')
        self.assertIn('launch.py',(self.root/'Dockerfile').read_text())
    def test_discovery_never_executes_source(self):
        self.write('app.py',"open('EXECUTED','w').write(input())\n")
        analyze(self.root)
        self.assertFalse((self.root/'EXECUTED').exists())
    def test_web_framework_retains_its_endpoint(self):
        self.write('api.py','from fastapi import FastAPI\napp=FastAPI()\n')
        self.assertEqual(plan(self.root,'standard_web')['workload'],'web')
    def test_declared_program_overrides_unrelated_web_helper(self):
        self.write('calculator.py',"while True: print(input('Number: '))\n")
        self.write('placeholder.py','from flask import Flask\napp=Flask(__name__)\n')
        self.write('stackpilot.json',json.dumps({'entrypoint':['python','calculator.py']}))
        self.assertEqual(plan(self.root,'standard_web')['workload'],'cli')
    def test_multiple_cli_targets_are_not_chosen_by_directory_order(self):
        for name in ('one.py','two.py'):self.write(name,'print(input())\n')
        self.assertIsNone(analyze(self.root)['entrypoint'])
        self.assertIn('Multiple CLI candidates; declare entrypoint',analyze(self.root)['issues'])
    def test_helper_function_is_not_assumed_to_run(self):
        self.write('helper.py','def helper():\n return input()\n')
        self.assertEqual(analyze(self.root)['workload'],'unknown')
    def test_repository_dockerfile_is_authoritative(self):
        self.write('util.py','print(input())\n');self.write('Dockerfile','FROM owned:1\nCMD ["server"]\n')
        self.assertEqual(plan(self.root,'standard_web')['workload'],'web')
    def test_discovery_budget_is_explicit(self):
        self.write('one.py','pass');self.write('two.py','pass')
        self.assertTrue(analyze(self.root,max_files=1)['truncated'])
    def test_invalid_console_acceptance_rejected_before_execution(self):
        for step in ({'input':'2\n'},{'output_contains':''},{'exit_code':True},{'argv':['sh']}):
            self.write('stackpilot.json',json.dumps({'workload':'cli','entrypoint':['app'],
                'console_scenarios':[{'name':'Outcome','steps':[step]}]}))
            with self.assertRaises(ValueError):plan(self.root,'standard_web')
    def test_jobs_and_packages_have_distinct_verification(self):
        self.write('stackpilot.json',json.dumps({'workload':'job','entrypoint':['python','task.py']}))
        self.assertEqual(plan(self.root,'standard_web')['verification_scope'],'job_completion')
        recipe={'image':'python:3.12-slim','commands':[['python','build.py']],'outputs':['dist']}
        self.write('stackpilot.json',json.dumps({'workload':'package','build_recipe':recipe}))
        value=prepare(self.root,'library')
        self.assertEqual(value['verification_scope'],'artifact_delivery')
        self.assertIn('artifact_server.py',(self.root/'Dockerfile').read_text())
    def test_job_deadlines_allow_real_long_running_commands_with_bounds(self):
        config={'workload':'job','entrypoint':['python','task.py']}
        for timeout in (1,3600,86400):
            self.write('stackpilot.json',json.dumps({**config,'job_timeout_seconds':timeout}))
            self.assertEqual(plan(self.root,'standard_web')['job_timeout_seconds'],timeout)
        for timeout in (0,86401,True,1.5,'3600'):
            self.write('stackpilot.json',json.dumps({**config,'job_timeout_seconds':timeout}))
            with self.assertRaises(ValueError):plan(self.root,'standard_web')
    def test_other_toolchains_use_explicit_portable_console_recipe(self):
        config={'workload':'cli','build_recipe':{'image':'ruby:3.3','commands':[['bundle','install']],
            'runtime_command':['ruby','output/app.rb'],'outputs':['output']}}
        generated=dockerfile(config,'cli')
        self.assertIn('console_server.py',generated)
        self.assertIn('FROM ruby:3.3',generated)

    def test_component_cli_retains_declared_entrypoint(self):
        self.write('console/main.py','print(input())\n')
        self.write('stackpilot.json',json.dumps({'version':2,'primary_component':'console','components':[
            {'id':'console','root':'console','workload':'cli','entrypoint':['python','main.py']}]}))
        value=prepare(self.root,'monorepo')
        self.assertEqual(value['entrypoint'],['python','main.py'])
        self.assertEqual(value['verification_scope'],'console_workflow')
        self.assertTrue((self.root/'console/Dockerfile').is_file())
        self.assertEqual(value['repository_discovery']['workload'],'cli')

    def test_node_bin_is_delivered_as_the_original_cli(self):
        self.write('cli.js',"require('readline').createInterface({input:process.stdin}).on('line',x=>console.log(Number(x)*2))")
        self.write('package.json',json.dumps({'name':'fixture','bin':{'fixture':'cli.js'}}))
        value=prepare(self.root,'standard_web')
        self.assertEqual(value['entrypoint'],['node','cli.js']);self.assertEqual(value['workload'],'cli')
        self.assertIn('console_server.py',(self.root/'Dockerfile').read_text())

    def test_node_framework_and_ambiguous_bin_do_not_become_auto_cli(self):
        self.write('cli.js','process.stdout.write("example")')
        self.write('other.js','process.stdout.write("other")')
        for package in ({'dependencies':{'next':'15.0.0'},'bin':'cli.js'},
                        {'bin':{'one':'cli.js','two':'other.js'}}):
            self.write('package.json',json.dumps(package))
            self.assertEqual(plan(self.root,'standard_web')['workload'],'web')
            self.assertIsNone(analyze(self.root)['entrypoint'])


@unittest.skipIf(os.name=='nt','PTY and deployment process groups require Linux')
class RealConsole(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.servers=[]
    async def asyncTearDown(self):
        for process in self.servers:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill();process.wait()
        self.temp.cleanup()
    async def server(self,source,workload='cli',deadline=45):
        script=self.root/('program'+str(len(self.servers))+'.py');script.write_text(source)
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        code='from console_server import serve;serve('+repr([sys.executable,'-u',str(script)])+','+repr(workload)+','+str(port)+','+str(deadline)+')'
        process=subprocess.Popen([sys.executable,'-c',code],env={**os.environ,'PYTHONPATH':str(ROOT/'deployment-runtime')},
                                 stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.servers.append(process);base='http://127.0.0.1:'+str(port)
        for _ in range(100):
            try: await asyncio.to_thread(urllib.request.urlopen,base,timeout=1);return base
            except urllib.error.URLError: await asyncio.sleep(.05)
        self.fail('Console server did not start')
    async def verify(self,base,contract):
        from app import runtime_verification as verifier
        # The production helper maps host localhost to Docker's host gateway.
        # This fixture server is inside the same test container.
        with patch.object(verifier,'request_url',lambda url,path:url+path):
            return await verifier.verify_contract(base,{'health_path':'/healthz',**contract})
    async def test_original_calculator_operations_and_exit_are_exercised(self):
        base=await self.server("while True:\n s=input('Number: ')\n if s=='quit': break\n print('Result:', int(s)*int(s))\n")
        result=await self.verify(base,{'verification_scope':'console_workflow','console_scenarios':[
            {'name':'Square and exit','steps':[{'output_contains':'Number:'},
                {'input':'12\n','output_contains':'Result: 144'},{'input':'quit\n','exit_code':0}]}]})
        self.assertTrue(result['verified'],result);self.assertTrue(result['workflow_verified'])
    async def test_wrong_answer_fails_and_echo_cannot_satisfy_assertion(self):
        base=await self.server("while True:\n s=input('Number: ')\n print('WRONG')\n")
        result=await self.verify(base,{'verification_scope':'console_workflow','console_scenarios':[
            {'name':'Echo must not count','steps':[{'input':'Result: 144\n','output_contains':'Result: 144'}]}]})
        self.assertFalse(result['verified']);self.assertFalse(result['workflow_verified'])
    async def test_early_crash_is_not_successful_console_delivery(self):
        base=await self.server("raise RuntimeError('broken original program')")
        result=await self.verify(base,{'verification_scope':'console_workflow'})
        self.assertFalse(result['verified'])
        self.assertIn('broken original program',result['scenarios'][0]['output'])
    async def test_real_job_exit_failure_and_timeout(self):
        for source,deadline,passed in (("print('real work')",45,True),('raise SystemExit(7)',45,False),
                                       ('import time;time.sleep(10)',1,False)):
            base=await self.server(source,'job',deadline);await asyncio.sleep(1.1)
            result=await self.verify(base,{'verification_scope':'job_completion'})
            self.assertEqual(result['verified'],passed,result)
    async def test_pending_job_exposes_progress_and_later_real_completion(self):
        base=await self.server("import time\nprint('step 1/2',flush=True)\ntime.sleep(2)\nprint('real result: 42',flush=True)\n",'job',3600)
        started=time.monotonic()
        first=await self.verify(base,{'verification_scope':'job_completion','job_timeout_seconds':3600})
        self.assertLess(time.monotonic()-started,1)
        self.assertEqual(first['status'],'running');self.assertFalse(first['verified'])
        self.assertIn('step 1/2',first['output'])
        with urllib.request.urlopen(base+'/healthz') as response:
            self.assertFalse(json.load(response)['ready'])
        identity=first['job_execution_id']
        await asyncio.sleep(2.1)
        final=await self.verify(base,{'verification_scope':'job_completion','job_execution_id':identity,'job_timeout_seconds':3600})
        self.assertTrue(final['verified'],final);self.assertEqual(final['job_execution_id'],identity)
        self.assertEqual(final['job']['exit_code'],0);self.assertIn('real result: 42',final['output'])
    async def test_job_restarts_cannot_satisfy_existing_execution(self):
        first=await self.server("print('result')",'job',3600);await asyncio.sleep(.2)
        accepted=await self.verify(first,{'verification_scope':'job_completion'})
        self.assertTrue(accepted['verified'],accepted)
        second=await self.server("print('result')",'job',3600);await asyncio.sleep(.2)
        restarted=await self.verify(second,{'verification_scope':'job_completion','job_execution_id':accepted['job_execution_id']})
        self.assertFalse(restarted['verified']);self.assertEqual(restarted['status'],'failed')
    async def test_browser_open_does_not_replay_a_finite_job(self):
        from console_server import Console
        console=Console([sys.executable,'-u','-c',"print('once')"],'job',3600)
        try:
            identity=console.job.execution_id
            await asyncio.sleep(.2)
            for _ in range(3):
                key=console.open();console.close(key)
                self.assertEqual(console.session(key).execution_id,identity)
            self.assertEqual(console.job.read()['state'],'completed')
        finally:console.shutdown()
    async def test_descendant_output_cannot_outlive_the_job_deadline(self):
        base=await self.server("import subprocess,sys\nsubprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'])\nprint('spawned child',flush=True)\n",'job',1)
        await asyncio.sleep(1.2)
        result=await self.verify(base,{'verification_scope':'job_completion'})
        self.assertFalse(result['verified']);self.assertEqual(result['job']['state'],'timed_out')
    async def test_explicit_cancellation_has_terminal_process_evidence(self):
        from console_server import Process
        process=Process([sys.executable,'-u','-c',"import time;print('started',flush=True);time.sleep(10)"],interactive=False)
        await asyncio.sleep(.2)
        process.close()
        self.assertTrue(await asyncio.to_thread(process.collected.wait,2))
        result=process.read()
        self.assertEqual(result['state'],'cancelled');self.assertIsNotNone(result['exit_code'])
        self.assertFalse(result['timed_out']);self.assertIsNotNone(result['finished_at'])
    async def test_sessions_are_distinct_and_close_releases_capacity(self):
        from console_server import Console, MAX_SESSIONS
        console=Console([sys.executable,'-u','-c',"input('Prompt: ')"])
        keys=[console.open() for _ in range(MAX_SESSIONS)]
        try:
            self.assertEqual(len(set(keys)),MAX_SESSIONS)
            with self.assertRaises(ValueError):console.open()
            console.close(keys.pop());keys.append(console.open())
            with self.assertRaises(ValueError):console.session('not-an-owned-session')
        finally:
            for key in keys:console.close(key)


if __name__=='__main__':unittest.main()
