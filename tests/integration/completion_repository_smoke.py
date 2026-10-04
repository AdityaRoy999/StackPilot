"""Incomplete CLI -> frozen requirements -> real worker checks -> routed console.

By default uses a known fixture repair to qualify completion/release gates.
--model MODEL instead gives the mostly empty source to the production agent.
Only disposable fixture accounts/projects are changed. Provider calls are opt-in.
"""
from stackpilot_test_artifacts import artifact_path
import asyncio
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
import uuid

IMPLEMENTATION = '''import sys

def calculate(operation, a, b):
    if operation == "add": return a + b
    if operation == "subtract": return a - b
    if operation == "multiply": return a * b
    if operation == "divide":
        if b == 0: raise ValueError("division by zero")
        return a / b
    raise ValueError("unknown operation")

def main():
    print("calc> ", end="", flush=True)
    for line in sys.stdin:
        if line.strip() == "exit": return
        try:
            operation, a, b = line.split()
            print(f"Result: {calculate(operation, float(a), float(b)):g}", flush=True)
        except ValueError as error:
            print(f"Error: {error}", flush=True)
        print("calc> ", end="", flush=True)

if __name__ == "__main__": main()
'''


def cli_check(input_text, expected):
    program = 'import subprocess; r=subprocess.run(["python","calculator.py"],input='+repr(input_text)+',text=True,capture_output=True,timeout=5); assert r.returncode==0,r.stderr; '
    program += '; '.join('assert '+repr(value)+' in r.stdout,r.stdout' for value in expected)
    program += '; print("CLI acceptance passed")'
    return {'argv': ['python', '-c', program], 'image': 'python:3.12-slim', 'timeout_seconds': 30, 'output_contains': ['CLI acceptance passed']}


def completion_contract():
    return {'version': 1, 'summary': 'Finish an interactive arithmetic CLI with error recovery', 'workload': 'cli', 'features': [
        {'id': 'addition', 'description': 'Add signed numbers', 'checks': [cli_check('add 12 3\nadd -4 1\nexit\n', ['Result: 15', 'Result: -3'])]},
        {'id': 'subtraction', 'description': 'Subtract numbers', 'checks': [cli_check('subtract 12 3\nexit\n', ['Result: 9'])]},
        {'id': 'multiplication', 'description': 'Multiply decimal numbers', 'checks': [cli_check('multiply 1.5 4\nexit\n', ['Result: 6'])]},
        {'id': 'error-recovery', 'description': 'Reject invalid input and division by zero, then continue working',
         'checks': [cli_check('divide 1 0\ninvalid\ndivide 12 3\nexit\n', ['Error: division by zero', 'Error:', 'Result: 4'])]}]}


async def inside(user, project, session):
    from app.agent_runtime.runtime import TeamRuntime
    from app.main import AgentRequest
    runtime = TeamRuntime()
    # The running AI service owns the real acceptance scheduler.
    runtime.store.initialize()
    actor = await runtime.attach(AgentRequest(message='Complete the README arithmetic CLI and deploy its real interactive console',
        user_id=user, project_id=project, session_id=session, agent_access_mode='full_access'))
    evidence = {'scope': 'completion_contract_real_docker_and_cli_release', 'model_calls': 0,
                'run_id': actor.run_id, 'cases': []}
    async def verify():
        queued = await runtime.handle(actor, 'verify_agent_source', {})
        end = time.monotonic()+180
        while time.monotonic() < end:
            await asyncio.to_thread(runtime.store.fence_lead, actor.run_id, actor.owner, True)
            task = runtime.store.task(queued['agent_id'], actor.run_id)
            if task['state'] in {'completed', 'failed', 'blocked', 'canceled'}:
                return json.loads(task['result'])
            await asyncio.sleep(.5)
        raise TimeoutError('Real acceptance worker did not finish')
    try:
        status = await runtime.handle(actor, 'get_completion_status', {})
        assert status['intent_source'] == 'repository_contract' and status['features_total'] == 4, status
        evidence['cases'].append('Original intended features imported automatically')
        broken = await verify()
        assert broken['status'] == 'failed' and not broken['verified'], broken
        assert (await runtime.handle(actor, 'workspace_trigger_rebuild', {}))['status'] == 'blocked'
        evidence['cases'].append('Incomplete source fails real Docker execution and cannot release')
        run = runtime.store.run(actor.run_id)
        revision, _ = runtime.workspaces.seal(actor.run_id)
        try:
            await runtime.broker('workspace_trigger_rebuild', {'agent_run_id': actor.run_id, 'agent_source_revision': revision,
                'deployment_id': run['deployment_id'], 'session_id': session}, user)
        except RuntimeError as error:
            assert 'acceptance' in str(error).lower() or 'completion' in str(error).lower(), str(error)
        else:
            raise AssertionError('Backend accepted unverified source without the Python gate')
        evidence['cases'].append('Backend independently rejects a direct unverified release')
        weaker = completion_contract(); weaker['features'].pop()
        try:
            await runtime.handle(actor, 'define_completion_plan', {'contract': weaker})
        except ValueError:
            pass
        else:
            raise AssertionError('Missing feature was waived')
        evidence['cases'].append('Removing requirements cannot turn failure into success')
        read = runtime.workspaces.read(actor.run_id, 'lead', 'calculator.py')
        await runtime.handle(actor, 'workspace_write_file', {'file_path': 'calculator.py', 'content': IMPLEMENTATION, 'expected_revision': read['revision']})
        report = await verify()
        assert report['status'] == 'passed' and report['verified'], report
        assert all(check['exit_code'] == 0 and check['check_passed'] and check.get('image_id') for check in report['commands']), report
        status = await runtime.handle(actor, 'get_completion_status', {})
        assert status['verified'] and status['features_passed'] == status['features_total'] == 4, status
        evidence['cases'].append('Completed CLI passes frozen feature checks on the exact integrated revision')
        queued = await runtime.handle(actor, 'workspace_trigger_rebuild', {})
        assert queued['status'] == 'rebuild_queued', queued
        result = await runtime.handle(actor, 'wait_for_deployment', {'job_id': queued['job_id'], 'timeout_seconds': 300})
        assert result.get('verified') and result.get('job_status') == 'completed', result
        evidence.update(deployment_id=queued['deployment_id'], job_id=queued['job_id'], revision=report['revision'],
                        feature_verification=status, runtime_result=result)
        evidence['cases'].append('Verified source is built and its real interactive console passes routed runtime acceptance')
        read = runtime.workspaces.read(actor.run_id, 'lead', 'calculator.py')
        await runtime.handle(actor, 'workspace_write_file', {'file_path': 'calculator.py', 'content': IMPLEMENTATION+'# later edit\n', 'expected_revision': read['revision']})
        assert (await runtime.handle(actor, 'get_completion_status', {}))['state'] == 'unverified'
        assert (await runtime.handle(actor, 'workspace_trigger_rebuild', {}))['status'] == 'blocked'
        evidence['cases'].append('A later source edit invalidates completion and blocks the next release')
        evidence['passed'] = True
        print('COMPLETION_SMOKE_RESULT '+json.dumps(evidence), flush=True)
    finally:
        runtime.store.cancel(actor.run_id)
        await runtime.close()


async def inside_model(user, project, session, model):
    """No fixture repair: the production agent must implement and release it."""
    from app.main import AgentRequest, stream_agent_reply
    from app.agent_runtime.runtime import get_runtime
    runtime = get_runtime()
    started = time.monotonic()
    evidence = {'scope': 'mostly_empty_cli_autonomous_completion', 'model': model,
                'prompt': 'Complete the application described in the README and deploy its real interactive CLI.',
                'cases': [], 'trace': [], 'passed': False}
    run_id = release = None
    stream = stream_agent_reply(AgentRequest(message=evidence['prompt'], user_id=user, project_id=project,
        session_id=session, model=model, agent_access_mode='full_access'))
    try:
        async with asyncio.timeout(900):
            async for raw in stream:
                if not raw.startswith('data: '): continue
                event = json.loads(raw[6:])
                if event.get('type') == 'agent_run':
                    run_id = event.get('run_id') or run_id
                    evidence['run_id'] = run_id
                if event.get('type') in {'tool_call', 'tool_result', 'provider_error', 'provider_retry'}:
                    observed = {key: event[key] for key in ('type', 'agent_id', 'name', 'status_code', 'retry', 'message') if key in event}
                    result = event.get('result')
                    if isinstance(result, str):
                        try: result = json.loads(result)
                        except ValueError: result = None
                    if isinstance(result, dict):
                        observed.update({key: result[key] for key in ('status', 'verified', 'job_status', 'error') if key in result})
                        if event.get('name') == 'wait_for_deployment' and result.get('verified') and result.get('job_status') == 'completed':
                            release = result
                    evidence['trace'].append(observed)
                if event.get('type') == 'done':
                    evidence['final_status'] = event.get('status')
                    evidence['final_content'] = str(event.get('content') or '')[:3000]
        assert run_id, 'The agent did not attach an authorized repository run'
        run = await asyncio.to_thread(runtime.store.run, run_id, user)
        status = await asyncio.to_thread(runtime.completion_status, run)
        evidence['feature_verification'] = status
        assert status['verified'] and status['features_passed'] == status['features_total'] == 4, status
        assert release and release.get('runtime_url'), 'The agent did not verify its exact deployed job'
        proof = await asyncio.to_thread(runtime.verification, run_id, run['effective_revision'])
        report = json.loads(proof['evidence'])
        assert all(item.get('image_id') and item.get('check_passed') for item in report['commands']), report
        evidence.update(revision=run['effective_revision'], runtime_result=release, passed=True)
        evidence['cases'].append('Production agent completed the unfinished CLI without a supplied repair')
        evidence['cases'].append('All four frozen features passed real Docker execution on the accepted revision')
        evidence['cases'].append('The built interactive CLI passed routed console verification')
    except BaseException as error:
        evidence['error'] = type(error).__name__+': '+str(error)[:2000]
        raise
    finally:
        await stream.aclose()
        evidence['elapsed_seconds'] = round(time.monotonic()-started, 2)
        if run_id: await asyncio.to_thread(runtime.store.cancel, run_id)
        await runtime.close()
        print('COMPLETION_SMOKE_RESULT '+json.dumps(evidence), flush=True)


def main():
    import argparse
    from release_pipeline_smoke import api, ROOT
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', help='Opt in to live production-agent completion with this model')
    args = parser.parse_args()
    name = uuid.uuid4().hex[:12]
    source = ROOT/'local-projects/completion-qualification'/name
    assert source.resolve().is_relative_to((ROOT/'local-projects/completion-qualification').resolve())
    source.mkdir(parents=True)
    user = project = None
    try:
        (source/'README.md').write_text('Build an interactive arithmetic CLI. Support add, subtract, multiply, divide. Reject bad input and division by zero while retaining the session. Read one operation and two numbers per line. exit closes the program.\n')
        (source/'calculator.py').write_text('def calculate(operation, a, b):\n    raise NotImplementedError("unfinished application")\n\nif __name__ == "__main__":\n    raise NotImplementedError("CLI not implemented")\n')
        contract = completion_contract()
        (source/'stackpilot.completion.json').write_text(json.dumps(contract))
        (source/'stackpilot.json').write_text(json.dumps({'version': 1, 'workload': 'cli', 'entrypoint': ['python', '-u', 'calculator.py'],
            'tests_required': True, 'tests': [feature['checks'][0]['argv'] for feature in contract['features']],
            'console_scenarios': [{'name': 'Arithmetic and error recovery', 'steps': [
                {'output_contains': 'calc> '}, {'input': 'add 12 3\n', 'output_contains': 'Result: 15'},
                {'input': 'divide 1 0\n', 'output_contains': 'Error: division by zero'},
                {'input': 'multiply 1.5 4\n', 'output_contains': 'Result: 6'}]}]}))
        api('POST', '/auth/register', {'username': 'completion-'+name, 'email': 'completion-'+name+'@example.test', 'password': 'Fixture-'+secrets.token_hex(16)+'!aA1'})
        profile = api('GET', '/auth/me'); user = (profile.get('user') or profile)['id']
        project = api('POST', '/projects', {'name': 'Completion CLI qualification '+name, 'source_type': 'local',
            'source_path': '/app/local-projects/completion-qualification/'+name, 'execution_mode': 'local', 'remote_runtime_type': 'docker'})['project']['id']
        subprocess.run(['docker', 'cp', str(Path(__file__)), 'stackpilot-ai-service:/tmp/completion_repository_smoke.py'], check=True)
        command = ['docker', 'exec', '-e', 'PYTHONPATH=/app', 'stackpilot-ai-service', 'python',
            '/tmp/completion_repository_smoke.py', 'inside-model' if args.model else 'inside', user, project, str(uuid.uuid4())]
        if args.model: command.append(args.model)
        result = subprocess.run(command, capture_output=True, text=True, timeout=1000 if args.model else 650)
        line = next((line for line in result.stdout.splitlines() if line.startswith('COMPLETION_SMOKE_RESULT ')), None)
        if line:
            evidence = json.loads(line.split(' ', 1)[1])
            filename = 'completion-model-qualification-2026-10-01.json' if args.model else 'completion-repository-qualification-2026-10-01.json'
            (artifact_path(filename)).write_text(json.dumps(evidence, indent=2)+'\n')
            print(json.dumps({'passed': evidence['passed'], 'cases': evidence['cases'],
                             'features_verified': evidence.get('feature_verification', {}).get('features_passed'),
                             'error': evidence.get('error')}))
        if result.returncode or not line:
            print(result.stderr[-6000:]); raise RuntimeError('Completion integration failed')
    finally:
        if project: api('DELETE', '/projects/'+project, expected=(200, 204))
        if user:
            uuid.UUID(user)
            query = "SELECT id FROM agent_runs WHERE user_id='"+user+"';"
            rows = subprocess.check_output(['docker', 'exec', 'stackpilot-postgres', 'sh', '-c', 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"', 'cleanup', query], text=True).splitlines()
            for run_id in rows:
                uuid.UUID(run_id)
                cleanup = 'import os,shutil,sys; from pathlib import Path; root=Path(os.getenv("STACKPILOT_AGENT_WORKSPACE_ROOT","/app/agent-workspaces")).resolve(); target=(root/sys.argv[1]).resolve(); assert target.parent==root and target!=root; shutil.rmtree(target) if target.exists() else None'
                subprocess.run(['docker', 'exec', 'stackpilot-ai-service', 'python', '-c', cleanup, run_id], check=True, capture_output=True)
            # Registration normalizes username punctuation; email and the
            # authenticated UUID retain the exact disposable fixture identity.
            query = "DELETE FROM agent_runs WHERE user_id='"+user+"'; DELETE FROM users WHERE id='"+user+"' AND email='completion-"+name+"@example.test';"
            subprocess.run(['docker', 'exec', 'stackpilot-postgres', 'sh', '-c', 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"', 'cleanup', query], check=True, capture_output=True)
        if source.exists(): shutil.rmtree(source)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'inside': asyncio.run(inside(*sys.argv[2:5]))
    elif len(sys.argv) > 1 and sys.argv[1] == 'inside-model': asyncio.run(inside_model(*sys.argv[2:6]))
    else: main()
