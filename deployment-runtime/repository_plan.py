"""Version 2 repository component contracts, normalized into existing release gates."""
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import re

WORKLOADS = {'web','api','cli','worker','job','tcp','grpc','artifact','desktop','android','ios','macos','windows','package'}


def process_checks(value):
    """Bound commands executed inside the already isolated component container."""
    if not isinstance(value,list) or len(value)>16:
        raise ValueError('process_checks must contain at most 16 checks')
    result=[]
    for check in value:
        if not isinstance(check,dict) or not set(check)<= {'argv','timeout_seconds','output_contains'}:
            raise ValueError('Process check needs argv and optional output/deadline assertions')
        argv=check.get('argv')
        if not isinstance(argv,list) or not 1<=len(argv)<=64 or any(not isinstance(a,str) or '\0' in a or len(a)>8192 for a in argv) or not argv[0]:
            raise ValueError('Process check argv must be bounded executable arguments')
        deadline=check.get('timeout_seconds',10)
        if type(deadline) is not int or not 1<=deadline<=60:
            raise ValueError('Process check deadline must be 1–60 seconds')
        output=check.get('output_contains')
        if output is not None and (not isinstance(output,str) or not 1<=len(output)<=4096):
            raise ValueError('Process check output assertion must be bounded nonempty text')
        result.append({**check,'timeout_seconds':deadline})
    return result


def path_in(root, value):
    if not isinstance(value,str) or '\\' in value or ':' in value or '\0' in value:
        raise ValueError('Component root must be a relative repository directory')
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Component root escapes repository')
    resolved = root.joinpath(*path.parts)
    if not resolved.resolve().is_relative_to(root) or any(part.is_symlink() for part in [resolved,*resolved.parents] if part.is_relative_to(root)) or not resolved.is_dir():
        raise ValueError('Component root is missing or uses a symlink')
    return resolved


def normalize(root, config):
    root = Path(root).resolve()
    if not isinstance(config,dict):
        raise ValueError('Repository plan must be an object')
    if config.get('version',1) == 1:
        return copy.deepcopy(config), None
    if config.get('version') != 2:
        raise ValueError('Unsupported repository plan version')
    components = config.get('components')
    if not isinstance(components,list) or not 1 <= len(components) <= 32:
        raise ValueError('Version 2 requires 1–32 components')
    indexed = {}
    for value in components:
        if not isinstance(value,dict) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,62}', str(value.get('id',''))):
            raise ValueError('Component needs a unique lowercase id')
        key = value['id']
        if key in indexed: raise ValueError('Duplicate component: '+key)
        path_in(root,value.get('root','.'))
        if value.get('workload','web') not in WORKLOADS: raise ValueError('Unknown component workload')
        capabilities = value.get('capabilities',[])
        if not isinstance(capabilities,list) or len(capabilities)>32 or any(not isinstance(c,str) or not re.fullmatch(r'[a-z][a-z0-9_.-]{0,80}',c) for c in capabilities):
            raise ValueError('Component capabilities must be bounded identifiers')
        dependencies = value.get('depends_on',[])
        if not isinstance(dependencies,list) or len(dependencies)>32 or any(not isinstance(d,str) for d in dependencies):
            raise ValueError('Component dependencies must name component IDs')
        state = value.get('state')
        if state is not None and not isinstance(state,dict):raise ValueError('Component state must be an object')
        if state:
            # Existing candidate swaps create fresh isolated volumes. They must
            # not masquerade as migration/rollback of serving production data.
            raise ValueError('Stateful component '+key+' requires a data migration/backup executor; automatic fresh-volume promotion is refused')
        if value.get('process_checks') and value.get('workload','web')!='worker':
            raise ValueError('process_checks are worker assertions; use the workload adapter for other components')
        process_checks(value.get('process_checks',[]))
        indexed[key] = copy.deepcopy(value)
    order, visiting = [], set()
    def visit(key):
        if key not in indexed:raise ValueError('Missing dependency: '+key)
        if key in visiting:raise ValueError('Component dependency cycle: '+key)
        if key in order:return
        visiting.add(key)
        for dependency in indexed[key].get('depends_on',[]):visit(dependency)
        visiting.remove(key);order.append(key)
    for key in indexed:visit(key)
    primary = config.get('primary_component',components[0]['id'] if len(components)==1 else None)
    if primary not in indexed:raise ValueError('Declare primary_component for a multi-component repository')
    primary_component = indexed[primary]
    roots=[path_in(root,item.get('root','.')) for item in components]
    if len(set(roots))!=len(roots):raise ValueError('Component build roots must be distinct')
    from sandbox_capabilities import select
    for component in components:
        # Submitted Dockerfiles/recipes keep authority over their image. Image
        # allow-lists govern generic agent command workers, not repository builds.
        admission=select(required=component.get('capabilities',[]),image=None)
        if admission['status']!='ready':
            raise ValueError('Component '+component['id']+' has unmet sandbox capabilities: '+', '.join(admission['missing']))
        indexed[component['id']]['sandbox']=admission
    target = primary_component.get('target_os','linux')
    if target not in {'linux','android','windows','macos','ios'}:raise ValueError('Unknown target OS')
    result = {key:value for key,value in config.items() if key not in {'components','primary_component','version'}}
    result.update({key:value for key,value in primary_component.items() if key not in {'id','root','depends_on','capabilities','target_os','state'}})
    result['version'] = 1
    if target in {'windows','macos','ios','android'}:result['workload'] = target
    if len(components)>1:
        if any(item.get('workload','web') not in {'web','api','worker','tcp','grpc','cli','job','package','artifact','desktop'} or item.get('target_os','linux') != 'linux' for item in components):
            raise ValueError('Mixed native component delivery requires a matching native multi-adapter executor')
        result['primary_service'] = primary
        result['test_services'] = [key for key in order if indexed[key].get('tests') or indexed[key].get('tests_required')]
    elif primary_component.get('root','.') != '.':
        result['primary_service'] = primary
    graph = {'version':2,'primary_component':primary,'components':[indexed[key] for key in order],
             'execution_order':order,'acceptance_revision':config.get('acceptance_revision',1)}
    return result, graph


def prepare_components(root, config, graph, prepare):
    """Compile stateless OCI components into the existing gated Compose lane."""
    root = Path(root).resolve()
    if not graph:return {}
    services = {}
    contracts = {}
    for component in graph['components']:
        directory = path_in(root,component.get('root','.'))
        if len(graph['components'])>1 and directory == root:
            raise ValueError('Multi-component build roots must be separate subdirectories')
        normalized = {key:value for key,value in component.items() if key not in {'id','root','depends_on','capabilities','target_os','state','sandbox','process_checks'}}
        normalized['version'] = 1
        if len(graph['components'])==1: normalized={key:value for key,value in config.items() if key!='process_checks'}
        worker_checks=process_checks(component.get('process_checks',[]))
        target = directory/'stackpilot.json'
        if target.is_symlink():raise ValueError('Component contract is a symlink')
        if target.is_file() and directory!=root:
            existing=json.loads(target.read_text())
            if existing.get('workload') and existing['workload']!=normalized.get('workload','web'):
                raise ValueError('Component '+component['id']+' cannot replace the original workload contract')
            if existing.get('state'):
                raise ValueError('Stateful component '+component['id']+' requires a data migration/backup executor')
            for key in ('tests','checks','scenarios','monitor_scenarios','browser_checks','native_scenarios','console_scenarios','build_secrets'):
                normalized[key] = existing.get(key,[]) + [value for value in normalized.get(key,[]) if value not in existing.get(key,[])]
            if existing.get('tests_required'):normalized['tests_required']=True
            if existing.get('fail_on_console_error'):normalized['fail_on_console_error']=True
            if existing.get('native_preview_required'):normalized['native_preview_required']=True
            if existing.get('health'):
                if not isinstance(existing['health'],dict):raise ValueError('Original component health must be an object')
                if not normalized.get('health'):normalized['health']=existing['health']
                elif existing['health']!=normalized['health']:
                    original={'path':existing['health'].get('path','/'),'statuses':existing['health'].get('statuses',[200])}
                    if original not in normalized['checks']:normalized['checks'].append(original)
            for check in process_checks(existing.get('process_checks',[])):
                if check not in worker_checks:worker_checks.append(check)
            worker_checks=process_checks(worker_checks)
        if worker_checks and normalized.get('workload','web')!='worker':
            raise ValueError('Imported worker process assertions require a worker component: '+component['id'])
        target.write_text(json.dumps(normalized,indent=2))
        contract = prepare(directory,'standard_web')
        contract['process_checks']=worker_checks
        contract['sandbox']=component.get('sandbox')
        contracts[component['id']]=contract
        if contract.get('requires_worker'):raise ValueError('Required component worker unavailable: '+str(contract['requires_worker']))
        if contract.get('build_secrets'):raise ValueError('Component '+component['id']+' private build inputs require a per-service secret adapter')
        if contract.get('verification_scope')!='render_smoke' and any(contract.get(key) for key in ('browser_checks','scenarios','monitor_scenarios')):
            raise ValueError('Component '+component['id']+' browser assertions require a web/render adapter')
        if contract.get('workload')!='cli' and contract.get('console_scenarios'):
            raise ValueError('Component '+component['id']+' console assertions require the interactive CLI adapter')
        if contract.get('native_scenarios') and contract.get('workload')!='android':
            raise ValueError('Component '+component['id']+' native assertions require a matching device workflow executor')
        if contract.get('protocol') in {'process','tcp'} and (normalized.get('health') or contract.get('checks')):
            raise ValueError('Component '+component['id']+' HTTP assertions require an HTTP adapter; use worker process checks or repository protocol tests')
        if len(graph['components'])==1 and directory==root and not contract.get('process_checks'):continue
        if not (directory/'Dockerfile').is_file():raise ValueError('Component '+component['id']+' needs a Dockerfile or portable build_recipe')
        service = {'build':{'context':component.get('root','.')},'restart':'unless-stopped'}
        if component.get('depends_on'):service['depends_on']=component['depends_on']
        if contract.get('protocol')!='process':
            port=contract.get('port')
            if not port:raise ValueError('Network component '+component['id']+' needs an explicit port')
            # Every declared service is independently verified. Host ports stay
            # ephemeral/loopback under compose_policy, rather than being shared.
            service['ports']=[str(port)]
        services[component['id']]=service
    if services:
        target=root/'compose.yaml'
        marker=root/'.stackpilot-components-generated.json'
        if target.is_symlink() or marker.is_symlink():raise ValueError('Generated component topology cannot use symlinks')
        previous=json.loads(marker.read_text()) if marker.is_file() else {}
        owned=target.is_file() and previous.get('sha256')==hashlib.sha256(target.read_bytes()).hexdigest()
        if (target.exists() and not owned) or any((root/name).exists() for name in ('compose.json','compose.yml','docker-compose.yml','docker-compose.yaml')):
            raise ValueError('Version 2 generated components cannot override an existing Compose contract; choose one authoritative topology')
        # BuildService searches the standard name; JSON is valid YAML.
        target.write_text(json.dumps({'services':services},indent=2))
        marker.write_text(json.dumps({'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}))
    return contracts
