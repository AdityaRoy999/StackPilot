"""A deterministic browser smoke gate, not a claim of business correctness."""
import asyncio
import hashlib
import json
import os
import re
import time
import uuid
from urllib.parse import quote, urlsplit, urlunsplit
import httpx

_slots = asyncio.Semaphore(2)

RENDER_STATE = """(() => {
 const b = document.body;
 const visible = e => {const r=e.getBoundingClientRect(),s=getComputedStyle(e);
   return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden' && s.opacity!=='0';};
 return {url:location.href, title:document.title, ready:document.readyState,
   text:(b?.innerText||'').trim().slice(0,2000),
   visible_content:!!b && [...b.querySelectorAll('img,svg,canvas,video,input,button,iframe')].some(visible),
   visible_busy:!!b && [...b.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible),
   source_modules:[...document.querySelectorAll('script[type="module"][src]')]
      .map(e=>e.src).filter(s=>/\\.(tsx?|jsx)(?:[?#]|$)/.test(s)),
   response_status:performance.getEntriesByType('navigation')[0]?.responseStatus || 0,
   failed_assets:performance.getEntriesByType('resource').filter(e=>e.responseStatus>=400 &&
      new URL(e.name).origin===location.origin && (e.initiatorType==='script' ||
       [...document.querySelectorAll('link[rel="stylesheet"][href]')].some(l=>l.href===e.name)))
      .map(e=>({url:e.name,status:e.responseStatus})).slice(0,20),
   content_type:document.contentType};
})()"""


def judge_render(state):
    if not isinstance(state, dict):
        return False, 'Browser observation unavailable.'
    if state.get('source_modules'):
        return False, 'Served uncompiled TypeScript/JSX module entrypoints instead of production build output.'
    if state.get('response_status', 0) >= 400 or state.get('failed_assets'):
        return False, 'Runtime document or same-origin assets failed to load.'
    if state.get('ready') != 'complete':
        return False, 'Document did not finish loading.'
    if state.get('visible_busy'):
        return False, 'Application still reports a visible busy/progress state.'
    if not state.get('text') and not state.get('visible_content'):
        return False, 'Runtime responded but the browser rendered an empty page.'
    return True, 'Browser rendered content; business workflows remain unverified.'


async def verify_runtime(url, contract=None, *, deployment_id=None):
    contract = contract or {}
    # This endpoint receives server-generated contracts through service auth.
    # A stable preview must still traverse the gateway to qualify route publication.
    if urlsplit(url).hostname in {'localhost', '127.0.0.1', '::1'} and contract.get('runtime_internal_url'):
        url = contract['runtime_internal_url']
    if contract.get('repository_plan'):
        components=contract['repository_plan'].get('components') or []
        if len(components)==1 and components[0].get('root','.')=='.' and not contract.get('component_runtime'):
            # A sole root component compiles into the ordinary immutable image
            # lane. Its acceptance fields are already merged into this plan.
            ordinary={key:value for key,value in contract.items() if key not in {'repository_plan','component_contracts','component_runtime'}}
            if components[0].get('process_checks'):
                return {'status':'unverified','verified':False,'scope':'component_contracts',
                        'reason':'Declared worker process checks require broker container observations'}
            return await verify_runtime(url,ordinary,deployment_id=deployment_id)
        return await verify_components(url,contract,deployment_id=deployment_id)
    scope = contract.get('verification_scope', 'render_smoke')
    if scope != 'render_smoke':
        result=await verify_contract(url, contract)
        if result.get('verified') and contract.get('workload')=='android':
            worker=os.getenv('STACKPILOT_ANDROID_WORKER_URL','').rstrip('/')
            if worker and deployment_id:
                artifacts=[a for a in result.get('artifacts',[]) if a['name'].endswith('.apk')]
                if len(artifacts)!=1:
                    return {**result,'verified':False,'status':'unverified','reason':'Select a single APK for the Android device lane'}
                try:
                    async with httpx.AsyncClient(timeout=180,trust_env=False) as client:
                        response=await client.post(worker+'/verify',headers={'x-stackpilot-service-token':os.getenv('STACKPILOT_AI_SERVICE_TOKEN','')},
                            json={'deployment_id':deployment_id,'artifact_url':url,'artifact':artifacts[0],
                                  'app_id':contract.get('app_id'),'native_scenarios':contract.get('native_scenarios',[])})
                        response.raise_for_status();native=response.json()
                    return {**result,'native':native,'verified':native.get('verified') is True,
                            'status':native.get('status','unverified'),'workflow_verified':native.get('workflow_verified',False),
                            'reason':native.get('reason','Android launch and declared native scenarios passed' if native.get('verified') else 'Native verification did not pass')}
                except Exception as exc:
                    return {**result,'verified':False,'status':'unverified','reason':'Android worker unavailable: '+type(exc).__name__}
            elif contract.get('native_preview_required'):
                return {**result,'verified':False,'status':'unverified','reason':'A configured Android worker and deployment identity are required'}
        return result
    # A render check supplements the declared contract; it must never replace it.
    http_result = await verify_contract(url, {**contract, 'verification_scope':'http_contract'})
    if not http_result.get('verified'):
        return {**http_result, 'scope':'render_smoke', 'stage':'http_contract'}
    from .browser_driver import browser_manager
    session_id = 'runtime-check-' + uuid.uuid4().hex
    async def check():
        try:
            session = await browser_manager.get_or_create_session(session_id, url)
            deadline = asyncio.get_running_loop().time() + 5
            state = None
            while True:
                state = await session.evaluate(RENDER_STATE)
                passed, reason = judge_render(state)
                if passed or (isinstance(state, dict) and (state.get('source_modules') or state.get('failed_assets') or state.get('response_status',0) >= 400)) or asyncio.get_running_loop().time() >= deadline:
                    break
                await asyncio.sleep(.15)
            errors = [e for e in session.console_logs if e.get('type') == 'error'][-10:]
            if errors and contract.get('fail_on_console_error', True):
                passed, reason = False, 'Browser console errors occurred; inspect the captured errors.'
            browser_checks = None
            if passed and contract.get('browser_checks'):
                from .browser_testing.assertions import assert_browser_state
                browser_checks = await assert_browser_state(session, contract['browser_checks'],
                    timeout_seconds=5, purpose='outcome')
                passed = browser_checks.get('verification', {}).get('verified') is True
                reason = 'Declared browser assertions passed.' if passed else 'Declared browser assertions did not pass.'
            scenarios=None
            if passed and contract.get('scenarios'):
                from .release_scenarios import run
                scenarios=await run(session,url,contract['scenarios'])
                passed=scenarios['verified'];reason='Declared browser scenarios passed.' if passed else 'Declared browser scenario failed.'
            errors = [e for e in session.console_logs if e.get('type') == 'error'][-10:]
            if errors and contract.get('fail_on_console_error', True):
                passed, reason = False, 'Browser console errors occurred during verification.'
            return {'status':'passed' if passed else 'failed', 'verified':passed,
                    'scope':'render_smoke', 'reason':reason, 'observation':state, 'console_errors':errors,
                    'checks':http_result.get('checks', []), 'browser_checks':browser_checks,
                    'scenarios':scenarios,'workflow_verified': bool((browser_checks or scenarios) and passed)}
        finally:
            await browser_manager.close_session(session_id)
    try:
        async with _slots:
            return await asyncio.wait_for(check(), timeout=120 if contract.get('scenarios') else 25)
    except Exception as exc:
        return {'status':'unverified', 'verified':False, 'scope':'render_smoke', 'reason':str(exc) or type(exc).__name__}


async def verify_components(url, contract, *, deployment_id=None):
    try:
        return await asyncio.wait_for(_verify_components(url,contract,deployment_id=deployment_id),timeout=200)
    except asyncio.TimeoutError:
        return {'status':'unverified','verified':False,'scope':'component_contracts',
                'reason':'Component verification exceeded its 200 second observation budget'}


async def _verify_components(url, contract, *, deployment_id=None):
    """Verify every declared component against broker-collected daemon evidence.

    Container and image identities are returned for the broker's mandatory fresh
    post-check comparison. A model cannot substitute a success flag for checks.
    """
    scope='component_contracts'
    try:
        graph=contract['repository_plan'];contracts=contract.get('component_contracts') or {}
        order=graph.get('execution_order') or [];evidence=contract.get('component_runtime') or {}
        observed=evidence.get('components') or {}
        if not 1<=len(order)<=32 or len(set(order))!=len(order) or set(order)!=set(contracts) or set(order)!=set(observed):
            raise ValueError('Every component needs its compiled contract and daemon observation')
        canonical={key:contract.get(key) for key in ('repository_plan','component_contracts')}
        digest=hashlib.sha256(json.dumps(canonical,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        if evidence.get('version')!=1 or evidence.get('contract_digest')!=digest:
            raise ValueError('Component observations do not match the compiled release contract')
        generated=evidence.get('generated_at')
        if not isinstance(generated,(int,float)) or not -5<=time.time()-generated<=180:
            raise ValueError('Fresh broker container observations are required')
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,127}',str(evidence.get('project',''))):
            raise ValueError('Missing isolated Compose release identity')
        mode=evidence.get('observation_mode','candidate')
        if mode not in {'candidate','serving'}:raise ValueError('Unknown broker observation mode')
        primary=graph.get('primary_component')
        if primary not in observed or (observed[primary].get('url') or '')!=(url or ''):
            raise ValueError('Primary endpoint does not match the candidate container mapping')
        identities={};results={}
        for name in order:
            row=observed[name];component=contracts[name]
            if row.get('service')!=name or not re.fullmatch('[a-f0-9]{64}',str(row.get('container_id',''))) or not re.fullmatch('sha256:[a-f0-9]{64}',str(row.get('image_id',''))) or row.get('image_id')!=row.get('expected_image_id'):
                raise ValueError('Exact component container/image evidence is missing: '+name)
            restarts=row.get('restart_count')
            if row.get('running') is not True or row.get('status')!='running' or type(restarts) is not int or restarts<0 or (mode=='candidate' and restarts!=0) or not row.get('started_at'):
                raise ValueError('Component is not a stable observed process: '+name)
            identities[name]={field:row.get(field) for field in ('container_id','image_id','started_at','restart_count','url')}
            if component.get('protocol')=='process':
                expected=component.get('process_checks') or [];checks=row.get('process_checks') or []
                if len(expected)!=len(checks) or any(e.get('argv')!=c.get('argv') for e,c in zip(expected,checks)):
                    raise ValueError('Declared worker process checks were not executed: '+name)
                passed=all(c.get('exit_code')==0 and c.get('timed_out') is False and c.get('truncated') is False and c.get('passed') is True for c in checks)
                results[name]={'status':'passed' if passed else 'failed','verified':passed,'scope':'process',
                    'checks':checks,'workflow_verified':bool(checks) and passed,
                    'reason':'Fresh stable worker observation and declared process checks passed' if passed else 'Declared worker process checks failed'}
            else:
                endpoint=row.get('url');parts=urlsplit(endpoint or '')
                expected_scheme='tcp' if component.get('protocol')=='tcp' else 'http'
                if parts.scheme!=expected_scheme or parts.hostname!='localhost' or not parts.port or parts.path or parts.query or parts.fragment or parts.username:
                    raise ValueError('Component endpoint is not its isolated daemon mapping: '+name)
                nested={key:value for key,value in component.items() if key not in {'repository_plan','component_contracts','component_runtime'}}
                results[name]=await verify_runtime(endpoint,nested,deployment_id=deployment_id)
        passed=all(result.get('verified') is True for result in results.values())
        pending=any(result.get('status')=='running' for result in results.values())
        failed=any(result.get('status')=='failed' for result in results.values())
        status='passed' if passed else 'failed' if failed else 'running' if pending else 'unverified'
        executions={name:result['job_execution_id'] for name,result in results.items()
                    if isinstance(result.get('job_execution_id'),str) and re.fullmatch('[0-9a-f]{32}',result['job_execution_id'])}
        deadlines=[result['job']['deadline_at'] for result in results.values()
                   if result.get('status')=='running' and isinstance(result.get('job'),dict) and
                   type(result['job'].get('deadline_at')) in {int,float}]
        return {'status':status,'verified':passed,'scope':scope,'project':evidence['project'],
            'observation_mode':mode,
            'contract_digest':digest,'identities':identities,'components':results,
            'pending':status=='running','job_execution_ids':executions,
            'deadline_at':max(deadlines) if deadlines else None,
            'workflow_verified':passed and all(result.get('workflow_verified') is True for result in results.values()),
            'reason':'All declared component checks passed on the candidate images' if passed else
                     'A finite component is still running' if status=='running' else 'Component verification did not pass'}
    except Exception as exc:
        return {'status':'unverified','verified':False,'scope':scope,'reason':str(exc) or type(exc).__name__}


def request_url(base, path):
    if not isinstance(path,str) or not path.startswith('/') or path.startswith('//') or '\\' in path or any(c in path for c in '\r\n'):
        raise ValueError('Check paths must remain on the deployment origin')
    parts=urlsplit(base)
    host=parts.hostname
    gateway=os.getenv('STACKPILOT_RUNTIME_GATEWAY_URL','')
    if host and host.endswith('.preview.localhost') and gateway:
        netloc=urlsplit(gateway).netloc
    elif host in {'localhost','127.0.0.1','::1'} or (host and host.endswith('.localhost')):
        netloc='host.docker.internal'+(':'+str(parts.port) if parts.port else '')
    else:
        netloc=parts.netloc
    check=urlsplit(path)
    return urlunsplit((parts.scheme,netloc,check.path,check.query,''))


async def verify_contract(url, contract, *, download_artifacts=True):
    try:
        return await asyncio.wait_for(_verify_contract(url,contract,download_artifacts=download_artifacts),timeout=50)
    except asyncio.TimeoutError:
        return {'status':'unverified','verified':False,'scope':contract.get('verification_scope','http_contract'),
                'reason':'Runtime verification exceeded its 50 second observation budget'}


async def _verify_contract(url, contract, *, download_artifacts=True):
    scope=contract.get('verification_scope','http_contract')
    try:
        if scope=='job_completion':
            from .job_verification import verify_job
            return await verify_job(url,contract,request_url=request_url)
        if scope=='tcp_connect':
            parts=urlsplit(url)
            host='host.docker.internal' if parts.hostname in {'localhost','127.0.0.1','::1'} or (parts.hostname and parts.hostname.endswith('.localhost')) else parts.hostname
            reader,writer=await asyncio.wait_for(asyncio.open_connection(host,parts.port),timeout=5)
            writer.close();await writer.wait_closed()
            return {'status':'passed','verified':True,'scope':scope,'reason':'TCP connection established; application protocol workflows remain unverified'}
        if scope=='process':
            return {'status':'unverified','verified':False,'scope':scope,'reason':'Process workloads require a fresh runtime process observation'}
        checks=[{'path':contract.get('health_path',urlsplit(url).path or '/'),'statuses':contract.get('accepted_statuses',[200])}, *contract.get('checks',[])]
        if len(checks)>51: raise ValueError('Too many verification checks')
        evidence=[];artifacts=None
        async with httpx.AsyncClient(timeout=10,follow_redirects=False,trust_env=False) as client:
            for check in checks:
                # Deployment health checks never silently submit forms or mutate data.
                response=await client.get(request_url(url,check.get('path','/')),headers={'Host':urlsplit(url).netloc})
                passed=response.status_code in check.get('statuses',[200])
                if 'json_contains' in check:
                    value=response.json()
                    passed=passed and isinstance(value,dict) and all(value.get(k)==v for k,v in check['json_contains'].items())
                if 'text_contains' in check:
                    passed=passed and str(check['text_contains']) in response.text
                if (contract.get('workload') in {'android','artifact'} or scope=='artifact_delivery') and check==checks[0]:
                    value=response.json()
                    artifacts=value.get('artifacts') if isinstance(value,dict) else None
                    passed=passed and isinstance(artifacts,list) and 0<len(artifacts)<=32 and all(
                        isinstance(e,dict) and isinstance(e.get('sha256'),str) and
                        len(e['sha256'])==64 and all(c in '0123456789abcdef' for c in e['sha256']) and
                        isinstance(e.get('size'),int) and not isinstance(e['size'],bool) and 0<e['size']<=1024**3 and
                        isinstance(e.get('name'),str) and bool(e['name']) and
                        not any(c in e['name'] for c in '/\\\r\n\0') and e['name'] not in {'.','..'}
                        for e in artifacts)
                    if passed and download_artifacts:
                        if sum(e['size'] for e in artifacts)>1024**3:
                            passed=False
                        else:
                            for artifact in artifacts:
                                digest=hashlib.sha256();size=0
                                async with client.stream('GET',request_url(url,'/artifacts/'+quote(artifact['name'],safe='')),headers={'Host':urlsplit(url).netloc}) as stream:
                                    if stream.status_code!=200:
                                        passed=False;break
                                    async for chunk in stream.aiter_bytes():
                                        size+=len(chunk)
                                        if size>artifact['size']:
                                            passed=False;break
                                        digest.update(chunk)
                                passed=passed and size==artifact['size'] and digest.hexdigest()==artifact['sha256']
                                if not passed:break
                evidence.append({'path':check.get('path','/'),'status':response.status_code,'passed':passed})
                if not passed:
                    return {'status':'failed','verified':False,'scope':scope,'reason':'Declared runtime contract failed','checks':evidence}
            if scope == 'console_workflow':
                return await verify_console(client,url,contract,evidence)
        observed_scope='artifact_inventory' if scope=='artifact_delivery' and not download_artifacts else scope
        return {'status':'passed','verified':True,'scope':observed_scope,'reason':'Declared checks passed; undeclared business and device workflows remain unverified','checks':evidence,'artifacts':artifacts}
    except (httpx.ConnectError, httpx.ReadTimeout, ConnectionRefusedError) as exc:
        return {'status':'failed','verified':False,'scope':scope,'reason':'Application endpoint is unreachable: '+type(exc).__name__}
    except Exception as exc:
        return {'status':'unverified','verified':False,'scope':scope,'reason':str(exc) or type(exc).__name__}


async def verify_console(client,url,contract,checks):
    """Exercise the original program, using fresh processes for each scenario."""
    headers={'Host':urlsplit(url).netloc}
    scenarios=contract.get('console_scenarios') or [{'name':'Program starts and accepts input','steps':[]}]
    evidence=[]
    for scenario in scenarios:
        key=None;observed=''
        try:
            response=await client.post(request_url(url,'/console/open'),headers=headers,json={})
            response.raise_for_status();key=response.json()['session_id']
            if not isinstance(key,str) or not key or len(key)>64: raise ValueError('Invalid console session identity')
            offset=0;observed=''
            async def poll():
                nonlocal offset,observed
                response=await client.get(request_url(url,'/console/read?session_id='+quote(key,safe='')+'&offset='+str(offset)),headers=headers)
                response.raise_for_status();state=response.json()
                offset=state['offset'];observed=(observed+state['output'])[-128*1024:]
                if state.get('truncated'):raise ValueError('Console output exceeded observation bounds')
                return state
            await asyncio.sleep(.3)
            state=await poll()
            if state.get('exit_code') is not None:
                raise ValueError('Interactive program exited before accepting input: '+str(state['exit_code']))
            for step in scenario.get('steps',[]):
                if 'input' in step:
                    # Drain prior output so a previous result cannot satisfy a
                    # later assertion. PTY echo is disabled by the adapter.
                    await poll();observed=''
                    response=await client.post(request_url(url,'/console/input'),headers=headers,
                                               json={'session_id':key,'input':step['input']})
                    response.raise_for_status()
                deadline=asyncio.get_running_loop().time()+5
                while 'output_contains' in step or 'exit_code' in step:
                    state=await poll()
                    matched=('output_contains' not in step or step['output_contains'] in observed) and (
                        'exit_code' not in step or state.get('exit_code')==step['exit_code'])
                    if matched:break
                    if state.get('exit_code') is not None or asyncio.get_running_loop().time()>=deadline:
                        raise ValueError('Console outcome assertion failed; exit='+str(state.get('exit_code'))+' output='+observed[-2000:])
                    await asyncio.sleep(.1)
            evidence.append({'name':scenario['name'],'passed':True,'output':observed[-4000:]})
        except Exception as exc:
            evidence.append({'name':scenario.get('name','Console scenario'),'passed':False,'reason':str(exc),
                             'output':observed[-4000:]})
            return {'status':'failed','verified':False,'scope':'console_workflow','checks':checks,
                    'scenarios':evidence,'workflow_verified':False,'reason':'Original console program verification failed'}
        finally:
            if key:
                try:
                    await client.post(request_url(url,'/console/close'),headers=headers,json={'session_id':key})
                except Exception:pass
    return {'status':'passed','verified':True,'scope':'console_workflow','checks':checks,'scenarios':evidence,
            'workflow_verified':bool(contract.get('console_scenarios')),
            'reason':'Declared program input/output checks passed' if contract.get('console_scenarios') else
                     'Original program starts; business behavior has no declared assertions'}
