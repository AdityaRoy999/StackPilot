"""Real task-owned Docker provisioning; no model calls or existing projects.

Requires the local stack. Creates a disposable account/project and exercises
the production broker, real task leases and Linux distribution containers.
"""
import asyncio
import contextlib
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid


async def inside(user, project, session, resume_file):
    from app.agent_runtime.context import Actor
    from app.agent_runtime.runtime import TeamRuntime
    from app.main import AgentRequest
    runtime = TeamRuntime()
    runtime.store.initialize()
    runs, heartbeats = [], []
    evidence = {'scope': 'live_docker_instance_broker', 'model_calls': 0, 'cases': [], 'passed': False}

    async def actor_for(identity):
        lead = await runtime.attach(AgentRequest(message='Qualify Linux instance provisioning using the explicit fixture only',
            user_id=user, project_id=project, session_id=identity, agent_access_mode='full_access'))
        runs.append(lead.run_id)
        task_id, owner, now = str(uuid.uuid4()), 'instance-qa-'+uuid.uuid4().hex, time.time()
        with runtime.store.transaction() as tx:
            tx.execute('INSERT INTO agent_tasks(id,run_id,parent_id,role,goal,spec,state,attempt,lease_owner,lease_until,created_at,updated_at) '
                'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (task_id, lead.run_id, 'lead', 'Controlled instance qualification', 'Run explicit Docker fixture commands',
                 json.dumps({'write_scope': ['answer.txt']}), 'running', 1, owner, now+120, now, now))
        actor = Actor(runtime, lead.run_id, task_id, user, 1, owner)
        await asyncio.to_thread(runtime.allocate_task, actor)

        async def heartbeat():
            while True:
                await asyncio.sleep(10)
                await asyncio.to_thread(runtime.store.fence, task_id, owner, 1, None, True)
        heartbeats.append(asyncio.create_task(heartbeat()))
        return actor

    async def rejects(call, expected):
        try:
            result = await call
        except (RuntimeError, PermissionError, ValueError) as error:
            assert any(word in str(error).lower() for word in expected), str(error)
            return
        assert result.get('status') in {'blocked', 'failed', 'unavailable'}, result

    try:
        actor = await actor_for(session)
        registry = await runtime.handle(actor, 'get_execution_capabilities', {'image': 'ubuntu:24.04', 'capabilities': ['linux', 'distro.ubuntu']})
        assert registry['status'] == 'ready' and registry['verified'] is False, registry
        instance = await runtime.handle(actor, 'provision_worker_instance', {'image': 'ubuntu:24.04', 'network': True,
            'ttl_seconds': 600, 'memory_mb': 256, 'capabilities': ['linux', 'distro.ubuntu']})
        assert instance.get('status') == 'ready' and instance.get('sandbox_id') and instance.get('verified') is False, instance
        sid = instance['sandbox_id']
        evidence.update({'run_id': actor.run_id, 'sandbox_id': sid, 'instance': instance})
        evidence['cases'].append('Production lease broker provisioned an owned Ubuntu container and observed its identity')
        setup = await runtime.handle(actor, 'run_worker_command', {'sandbox_id': sid, 'timeout_seconds': 240,
            'argv': ['sh', '-ec', 'apt-get -o APT::Sandbox::User=root update -qq && DEBIAN_FRONTEND=noninteractive apt-get -o APT::Sandbox::User=root install -y -qq --no-install-recommends python3 && printf installed > /opt/instance-marker']})
        assert setup.get('status') == 'completed' and setup.get('exit_code') == 0, setup
        command = await runtime.handle(actor, 'run_worker_command', {'sandbox_id': sid, 'timeout_seconds': 30,
            'argv': ['python3', '-c', 'import os,pathlib;assert pathlib.Path("/opt/instance-marker").read_text()=="installed";assert not pathlib.Path("/var/run/docker.sock").exists();assert os.getenv("STACKPILOT_AI_SERVICE_TOKEN") is None;pathlib.Path("answer.txt").write_text("42");print(6*7)']})
        assert command.get('status') == 'completed' and command.get('output', '').strip() == '42', command
        assert command.get('changed_paths') == ['answer.txt'] and command.get('verified') is False, command
        evidence['command'] = {key: command.get(key) for key in ('status', 'exit_code', 'output', 'image_id', 'changed_paths', 'scope')}
        evidence['cases'].append('Installed Python and retained setup across commands; actual scoped source patch imported without host credentials')
        print('INSTANCE_RESTART_READY', flush=True)
        deadline = time.monotonic()+120
        while not Path(resume_file).exists():
            if time.monotonic() > deadline:
                raise RuntimeError('Host did not complete backend restart qualification')
            await asyncio.sleep(.25)
        resumed = TeamRuntime()
        resumed_actor = Actor(resumed, actor.run_id, actor.agent_id, user, 1, actor.owner)
        observation = await resumed.handle(resumed_actor, 'inspect_worker_instance', {'sandbox_id': sid})
        assert observation.get('status') == 'ready' and observation.get('container_id') == instance.get('container_id'), observation
        again = await resumed.handle(resumed_actor, 'run_worker_command', {'sandbox_id': sid,
            'argv': ['python3', '-c', 'import pathlib;assert pathlib.Path("answer.txt").read_text()=="42";print("persistent")']})
        assert again.get('status') == 'completed' and again.get('output', '').strip() == 'persistent', again
        await resumed.close()
        evidence['cases'].append('Actual backend restart and a fresh runtime recovered the same container and retained its workspace')
        foreign = await actor_for(str(uuid.uuid4()))
        await rejects(runtime.handle(foreign, 'inspect_worker_instance', {'sandbox_id': sid}), ('owner', 'ownership', 'foreign', 'another'))
        evidence['cases'].append('Different live run rejected from accessing the instance')
        for image, distro in [('debian:bookworm-slim', 'debian'), ('alpine:3.21', 'alpine')]:
            other = await runtime.handle(actor, 'provision_worker_instance', {'image': image, 'network': False,
                'ttl_seconds': 120, 'capabilities': ['distro.'+distro]})
            assert other.get('status') == 'ready', other
            result = await runtime.handle(actor, 'run_worker_command', {'sandbox_id': other['sandbox_id'],
                'argv': ['sh', '-ec', '. /etc/os-release; printf "%s" "$ID"']})
            assert result.get('status') == 'completed' and result.get('output', '').strip() == distro, result
            released = await runtime.handle(actor, 'release_worker_instance', {'sandbox_id': other['sandbox_id']})
            assert released.get('status') in {'released', 'completed'}, released
            evidence['cases'].append('Provisioned, executed and released actual '+distro+' userspace')
        await rejects(runtime.broker('_internal_agent_instance_cleanup', {'run_id': actor.run_id}, user), ('terminal', 'expiry'))
        runtime.store.cancel(actor.run_id, actor.agent_id)
        await rejects(runtime.broker('_internal_agent_process', {'run_id': actor.run_id, 'task_id': actor.agent_id,
            'lease_owner': actor.owner, 'attempt': 1, 'sandbox_id': sid, 'argv': ['true']}, user), ('revoked', 'lease'))
        evidence['cases'].append('Working-run full cleanup and revoked-task execution rejected independently by backend')
        runtime.store.cancel(actor.run_id)
        cleaned = await runtime.broker('_internal_agent_instance_cleanup', {'run_id': actor.run_id}, user)
        assert cleaned.get('status') == 'completed' and sid in cleaned.get('removed', []) and not cleaned.get('retained'), cleaned
        evidence['cleanup'] = cleaned
        evidence['cases'].append('Terminal-run reconciliation removed the owned instance')
        evidence['passed'] = True
    except Exception as error:
        evidence['error'] = type(error).__name__+': '+str(error)
    finally:
        for task in heartbeats:
            task.cancel()
        await asyncio.gather(*heartbeats, return_exceptions=True)
        for run in runs:
            with contextlib.suppress(Exception):
                runtime.store.cancel(run)
                await runtime.broker('_internal_agent_instance_cleanup', {'run_id': run}, user)
        await runtime.close()
        print('INSTANCE_RESULT '+json.dumps(evidence), flush=True)


def main():
    from release_pipeline_smoke import api, ROOT
    name = uuid.uuid4().hex[:12]
    base = (ROOT/'local-projects/docker-instance-qualification').resolve()
    source = base/name
    assert source.parent == base and source != base
    source.mkdir(parents=True)
    user = project = None
    remote = '/tmp/docker_instance_smoke_'+name+'.py'
    resume_file = '/tmp/docker_instance_resume_'+name
    try:
        (source/'README.md').write_text('Disposable Docker instance qualification; no model calls.\n')
        api('POST', '/auth/register', {'username': 'instance-'+name, 'email': 'instance-'+name+'@example.test',
            'password': 'Fixture-'+secrets.token_hex(16)+'!aA1'})
        profile = api('GET', '/auth/me')
        user = (profile.get('user') or profile)['id']
        project = api('POST', '/projects', {'name': 'Docker instance qualification '+name, 'source_type': 'local',
            'source_path': '/app/local-projects/docker-instance-qualification/'+name, 'execution_mode': 'local',
            'remote_runtime_type': 'docker'})['project']['id']
        subprocess.run(['docker', 'cp', str(Path(__file__)), 'stackpilot-ai-service:'+remote], check=True, capture_output=True)
        process = subprocess.Popen(['docker', 'exec', '-e', 'PYTHONPATH=/app', 'stackpilot-ai-service', 'python', remote,
            'inside', user, project, str(uuid.uuid4()), resume_file], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        output, restart_requested = [], threading.Event()
        def read_output():
            for line in process.stdout:
                output.append(line)
                if line.strip() == 'INSTANCE_RESTART_READY':
                    restart_requested.set()
        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()
        deadline, restarted = time.monotonic()+700, False
        try:
            while process.poll() is None:
                if restart_requested.is_set() and not restarted:
                    subprocess.run(['docker', 'restart', 'stackpilot-backend'], check=True, capture_output=True, timeout=60)
                    health_deadline = time.monotonic()+60
                    while True:
                        try:
                            api('GET', '/health')
                            break
                        except Exception:
                            if time.monotonic() > health_deadline:
                                raise
                            time.sleep(.5)
                    subprocess.run(['docker', 'exec', 'stackpilot-ai-service', 'python', '-c',
                        'from pathlib import Path;import sys;Path(sys.argv[1]).touch()', resume_file], check=True, capture_output=True)
                    restarted = True
                if time.monotonic() > deadline:
                    raise TimeoutError('Docker instance qualification timed out')
                time.sleep(.2)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
            reader.join(timeout=5)
        line = next((line for line in output if line.startswith('INSTANCE_RESULT ')), None)
        if not line:
            raise RuntimeError('Instance fixture returned no evidence: '+''.join(output)[-3000:])
        evidence = json.loads(line.split(' ', 1)[1])
        (ROOT/'docs/docker-instance-qualification-2026-10-01.json').write_text(json.dumps(evidence, indent=2)+'\n')
        print(json.dumps(evidence, indent=2))
        if process.returncode or not evidence.get('passed'):
            raise RuntimeError('Docker instance qualification failed')
    finally:
        if project:
            api('DELETE', '/projects/'+project, expected=(200, 204))
        if user:
            uuid.UUID(user)
            query = "SELECT id FROM agent_runs WHERE user_id='"+user+"';"
            rows = subprocess.check_output(['docker', 'exec', 'stackpilot-postgres', 'sh', '-c',
                'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"', 'probe', query], text=True).splitlines()
            for run in rows:
                uuid.UUID(run)
                code = 'import os,shutil,sys;from pathlib import Path;root=Path(os.getenv("STACKPILOT_AGENT_WORKSPACE_ROOT","/app/agent-workspaces")).resolve();target=(root/sys.argv[1]).resolve();assert target.parent==root and target!=root;shutil.rmtree(target) if target.exists() else None'
                subprocess.run(['docker', 'exec', 'stackpilot-ai-service', 'python', '-c', code, run], check=True, capture_output=True)
            query = "DELETE FROM agent_runs WHERE user_id='"+user+"'; DELETE FROM users WHERE id='"+user+"' AND email='instance-"+name+"@example.test';"
            subprocess.run(['docker', 'exec', 'stackpilot-postgres', 'sh', '-c',
                'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"', 'cleanup', query], check=True, capture_output=True)
        subprocess.run(['docker', 'exec', 'stackpilot-ai-service', 'python', '-c',
            'import pathlib,sys;p=pathlib.Path(sys.argv[1]);assert p.parent==pathlib.Path("/tmp") and p.name.startswith("docker_instance_smoke_");p.unlink(missing_ok=True)', remote], capture_output=True)
        subprocess.run(['docker', 'exec', 'stackpilot-ai-service', 'python', '-c',
            'import pathlib,sys;p=pathlib.Path(sys.argv[1]);assert p.parent==pathlib.Path("/tmp") and p.name.startswith("docker_instance_resume_");p.unlink(missing_ok=True)', resume_file], capture_output=True)
        if source.exists():
            shutil.rmtree(source)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'inside':
        asyncio.run(inside(*sys.argv[2:6]))
    else:
        main()
