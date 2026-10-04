"""Verify all services, then select a declared or unambiguous HTTP endpoint."""
import json
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request


def resolve(project, model, plan):
    contract = json.loads(Path(plan).read_text())
    if contract.get('repository_plan'):
        from compose_runtime_evidence import collect
        definition=json.loads(Path(model).read_text())
        evidence=collect(project,definition,contract)
        destination=Path(model).resolve().parent/'component-runtime.json'
        if destination.is_symlink():raise ValueError('Component evidence must not use symlinks')
        destination.write_text(json.dumps(evidence));destination.chmod(0o600)
        primary=contract['repository_plan']['primary_component']
        print('__STACKPILOT_COMPONENT_RUNTIME__='+str(destination))
        # Worker-primary graphs legitimately have no browser URL. The broker
        # still runs the whole component verification gate before promotion.
        print('__STACKPILOT_COMPOSE_URL__='+(evidence['components'][primary]['url'] or ''))
        return
    response = subprocess.run(['docker','compose','-p',project,'-f',str(model),'ps','--format','json'],check=True,capture_output=True,text=True).stdout
    try:
        records = json.loads(response)
        if isinstance(records,dict): records = [records]
    except json.JSONDecodeError:
        records = [json.loads(line) for line in response.splitlines() if line.strip()]
    definition = json.loads(Path(model).read_text())
    observed = {r['Service']:r for r in records}
    for service in definition['services']:
        if service not in observed or observed[service].get('State') != 'running' or observed[service].get('Health') in {'unhealthy','starting'}:
            raise RuntimeError(f'{service}: service not ready')
    candidates = []
    for service, record in observed.items():
        if contract.get('primary_service') and service != contract['primary_service']:
            continue
        for mapping in record.get('Publishers') or []:
            if mapping.get('Protocol') != 'tcp' or not mapping.get('PublishedPort'): continue
            base = f"http://127.0.0.1:{mapping['PublishedPort']}"
            # The backend container accesses host mappings through the host gateway.
            for host in ('127.0.0.1','host.docker.internal'):
                try:
                    with urllib.request.urlopen(base.replace('127.0.0.1',host)+contract['health_path'],timeout=3) as response:
                        if response.status in contract['accepted_statuses']:
                            candidates.append((service,base.replace('127.0.0.1','localhost')))
                            break
                except (urllib.error.URLError,TimeoutError,OSError): pass
    if len(candidates) != 1:
        raise RuntimeError('Select primary_service and its health path in stackpilot.json; no ambiguous endpoint will be advertised')
    print('__STACKPILOT_COMPOSE_URL__='+candidates[0][1])


if __name__ == '__main__':
    resolve(*sys.argv[1:])
