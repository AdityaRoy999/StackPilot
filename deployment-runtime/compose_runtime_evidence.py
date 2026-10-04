"""Collect broker-owned container identities for every declared Linux component.

The AI service receives observations, never Docker credentials. The broker must
collect again after endpoint verification and compare identity() before promotion.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


def digest(plan):
    value={key:plan.get(key) for key in ('repository_plan','component_contracts')}
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def command(argv, *, timeout=20, runner=subprocess.run):
    result=runner(argv,check=True,capture_output=True,text=True,timeout=timeout)
    if len(result.stdout.encode())>4*1024*1024:
        raise RuntimeError('Docker observation exceeded bounds')
    return result.stdout


def records(value):
    try:
        rows=json.loads(value)
        return [rows] if isinstance(rows,dict) else rows
    except json.JSONDecodeError:
        return [json.loads(line) for line in value.splitlines() if line.strip()]


def execute_check(container_id, check):
    # The candidate is removed by the broker after a timeout/failure, so a
    # detached in-container exec cannot survive as a promoted worker process.
    with tempfile.TemporaryFile() as output:
        try:
            result=subprocess.run(['docker','exec',container_id,*check['argv']],stdout=output,
                                  stderr=subprocess.STDOUT,timeout=check['timeout_seconds'])
            code=result.returncode;timed_out=False
        except subprocess.TimeoutExpired:
            code=None;timed_out=True
        output.seek(0,2);size=output.tell();output.seek(max(0,size-65536))
        observed=output.read().decode(errors='replace')
    passed=code==0 and not timed_out and size<=65536 and (
        'output_contains' not in check or check['output_contains'] in observed)
    return {'argv':check['argv'],'exit_code':code,'timed_out':timed_out,
            'truncated':size>65536,'output':observed[-8000:],'passed':passed}


def collect(project, model, plan, *, runner=subprocess.run, checker=execute_check, execute_checks=True, allow_restarts=False):
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,127}',project):
        raise ValueError('Invalid isolated Compose project identity')
    graph=plan.get('repository_plan') or {}
    contracts=plan.get('component_contracts') or {}
    declared=graph.get('execution_order') or []
    if not declared or set(declared)!=set(contracts) or not set(declared)<=set(model['services']):
        raise ValueError('Every repository component needs its compiled runtime contract')
    # Labels are queried in the daemon rather than accepting a repository's
    # container names, and IDs are subsequently used for every observation.
    ids=command(['docker','ps','-aq','--filter','label=com.docker.compose.project='+project],runner=runner).split()
    if not ids:raise RuntimeError('Compose candidate has no containers')
    inspected=json.loads(command(['docker','inspect',*ids],runner=runner))
    by_service={}
    for record in inspected:
        labels=record.get('Config',{}).get('Labels') or {}
        if labels.get('com.docker.compose.project')!=project or labels.get('com.docker.compose.oneoff')=='True':continue
        service=labels.get('com.docker.compose.service')
        if service in by_service:raise RuntimeError('Component replicas require a replica-aware verifier: '+service)
        by_service[service]=record
    components={}
    for service in declared:
        row=by_service.get(service)
        if row is None:raise RuntimeError('Missing component container: '+service)
        container_id=row.get('Id','');image_id=row.get('Image','')
        if not re.fullmatch('[a-f0-9]{64}',container_id) or not re.fullmatch('sha256:[a-f0-9]{64}',image_id):
            raise RuntimeError('Invalid daemon container/image identity')
        image=model['services'][service].get('image') or project+'-'+service
        expected=command(['docker','image','inspect','--format','{{.Id}}',image],runner=runner).strip()
        if image_id!=expected:raise RuntimeError('Component image changed after build: '+service)
        state=row.get('State',{})
        restarts=row.get('RestartCount',0)
        stable=state.get('Running') is True and type(restarts) is int and restarts>=0 and (allow_restarts or restarts==0) and state.get('OOMKilled') is not True and state.get('Health',{}).get('Status') not in {'unhealthy','starting'}
        if not stable:raise RuntimeError('Component is not a stable running candidate: '+service)
        contract=contracts[service];url=None
        if contract.get('protocol')!='process':
            port=contract.get('port')
            mappings=(row.get('NetworkSettings',{}).get('Ports') or {}).get(str(port)+'/tcp') or []
            if len(mappings)!=1 or mappings[0].get('HostIp')!='127.0.0.1' or not str(mappings[0].get('HostPort','')).isdigit():
                raise RuntimeError('Component needs exactly one isolated loopback mapping: '+service)
            scheme='tcp' if contract.get('protocol')=='tcp' else 'http'
            url=scheme+'://localhost:'+str(int(mappings[0]['HostPort']))
        from repository_plan import process_checks
        checks=[checker(container_id,check) for check in process_checks(contract.get('process_checks',[]))] if execute_checks else []
        components[service]={'service':service,'container_id':container_id,'image_id':image_id,
            'expected_image_id':expected,'status':state.get('Status'),'running':state.get('Running'),
            'started_at':state.get('StartedAt'),'restart_count':row.get('RestartCount',0),
            'url':url,'process_checks':checks}
    return {'version':1,'project':project,'generated_at':time.time(),'observation_mode':'serving' if allow_restarts else 'candidate',
            'contract_digest':digest(plan),'components':components}


def identity(evidence):
    return {key:{field:item.get(field) for field in ('container_id','image_id','started_at','restart_count','url')}
            for key,item in evidence.get('components',{}).items()}


if __name__=='__main__':
    project,model,plan,output=sys.argv[1:5]
    flags=sys.argv[5:]
    if len(set(flags))!=len(flags) or any(flag not in {'--identity-only','--allow-restarts'} for flag in flags):raise ValueError('Unknown observation mode')
    value=collect(project,json.loads(Path(model).read_text()),json.loads(Path(plan).read_text()),
                  execute_checks='--identity-only' not in flags,allow_restarts='--allow-restarts' in flags)
    destination=Path(output)
    if destination.is_symlink():raise ValueError('Runtime evidence destination cannot be a symlink')
    destination.write_text(json.dumps(value));destination.chmod(0o600)
