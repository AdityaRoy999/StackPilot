"""Background campaigns composed of bounded discovery and scenario tasks."""
import asyncio
import base64
from contextvars import ContextVar
import hashlib
import json
import logging
import os
import re
import time
import uuid

from .campaign_store import CampaignStore, TERMINAL
from .site_audit import SiteAuditor, canonical_url
from .session_checkpoint import capture_session, restore_session

logger=logging.getLogger(__name__)
campaign_scope=ContextVar('browser_campaign_scope',default=None)
_runtime=None


def requested_campaign(message,runtime=None):
    runtime=runtime or {}
    if runtime.get('browser_campaign') is True or str(message).startswith('/test-long'): return True
    if not re.search(r'\b(test|audit|crawl|explore|verify|check)\b',str(message),re.I): return False
    if re.search(r'\b(how|what if|want to know|tell me whether|can we|can our|can the system)\b',str(message),re.I) and not re.match(r'\s*(please|test|audit|crawl|explore|verify|check|run|can you|could you|would you)\b',str(message),re.I): return False
    pages=re.search(r'\b(\d+)\s*\+?\s*pages?\b',str(message),re.I)
    duration=re.search(r'\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b',str(message),re.I)
    return bool((pages and int(pages[1])>=80) or
                (duration and float(duration[1])*(60 if duration[2].lower().startswith(('hour','hr')) else 1)>=30))


def budgets_from_message(message):
    pages=re.search(r'\b(\d+)\s*(\+?)\s*pages?\b',message,re.I)
    duration=re.search(r'\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b',message,re.I)
    return {'max_pages':min(10000,max(250,int(pages[1])+(100 if pages[2] else 0))) if pages else 250,
            'max_seconds':min(86400,max(60,int(float(duration[1])*(3600 if duration[2].lower().startswith(('hour','hr')) else 60)))) if duration else 14400}


def strip_frames(value):
    if isinstance(value,dict): return {k:strip_frames(v) for k,v in value.items() if k not in {'frame','som_frame','raw_bytes','images'}}
    if isinstance(value,list): return [strip_frames(v) for v in value]
    return value


class CampaignRuntime:
    def __init__(self,store=None,manager=None,execute=None,workflow=None):
        self.store=store or CampaignStore()
        if manager is None:
            from ..browser_driver import browser_manager
            manager=browser_manager
        if execute is None:
            from ..tools import execute_tool_call
            execute=execute_tool_call
        self.manager,self.execute,self.workflow=manager,execute,workflow or self.run_workflow
        self.worker=uuid.uuid4().hex
        self.tasks={};self.sessions={};self.poller=None
        self.active_items={};self.cancellations={}
        self.provider_reservations={}

    def protected(self): return set(self.sessions)

    async def start(self,request,options=None):
        options=options or {}
        target=request.custom_url or (request.runtime or {}).get('custom_url')
        if not target:
            session=self.manager.sessions.get(request.session_id or '')
            target=getattr(session,'target_url',None) or getattr(session,'current_url',None)
        if not target or not canonical_url(target,target): raise ValueError('A concrete HTTP(S) website target is required')
        target=canonical_url(target,target)
        # Do not keep chat history, attachments or repository tool context in a
        # campaign. Provider configuration is sealed at rest alongside the job.
        payload={k:v for k,v in request.model_dump().items() if k in {
            'provider','model','model_mode','provider_overrides','user_id','session_id','sandbox_mode',
            'agent_access_mode','allow_agent_questions','message','custom_url','runtime'}}
        payload['custom_url']=target
        payload['runtime']={k:v for k,v in payload.get('runtime',{}).items() if k in {'permissions','browser_vision_model','vision_model','browser_planner_model','api_key','base_url','provider','model','timezone'}}
        payload['goal']=request.message
        from .intent import browser_task_context
        payload['task_context']=browser_task_context(request.message,request.runtime or {},request.history or [])
        budgets={**budgets_from_message(request.message),**options}
        campaign_id,created=await asyncio.to_thread(self.store.create,request.user_id,request.session_id,payload,initial_url=target,**budgets)
        if created:
            await asyncio.to_thread(self.store.event,campaign_id,{'type':'campaign_started','state':'queued'})
        await self.initialize()
        return {**await asyncio.to_thread(self.store.status,campaign_id,request.user_id,request.session_id),
                'status':'queued','campaign_id':campaign_id,'created_new':created,
                'hint':'Background campaign queued. Page navigation coverage and workflow outcome verification are reported separately. Monitor the campaign card; closing this chat does not cancel it.'}

    async def initialize(self):
        if self.poller is None or self.poller.done(): self.poller=asyncio.create_task(self.schedule())

    async def schedule(self):
        last_prune=0
        while True:
            try:
                if time.monotonic()-last_prune>=60:
                    await asyncio.to_thread(self.store.prune,max(1,int(os.getenv('STACKPILOT_BROWSER_CAMPAIGN_RETENTION_DAYS','7')))*86400)
                    last_prune=time.monotonic()
                await asyncio.to_thread(self.store.recover_expired)
                ready=await asyncio.to_thread(self.store.ready)
                capacity=max(1,min(4,int(os.getenv('STACKPILOT_BROWSER_CAMPAIGN_PARALLELISM','1'))))
                for job in ready:
                    from ..main import active_browser_runs
                    if job['session_id'] in active_browser_runs: continue
                    if job['id'] in self.tasks or job['session_id'] in self.sessions or len(self.tasks)>=capacity: continue
                    if not await asyncio.to_thread(self.store.claim_job,job['id'],self.worker): continue
                    self.sessions[job['session_id']]=job['id']
                    self.tasks[job['id']]=asyncio.create_task(self.run(job))
            except asyncio.CancelledError: raise
            except Exception as exc: logger.warning('Campaign scheduler unavailable: %s',type(exc).__name__)
            await asyncio.sleep(1)

    async def heartbeat(self,job,cancel):
        while not cancel.is_set():
            if not await asyncio.to_thread(self.store.heartbeat,job['id'],self.worker,self.active_items.get(job['id'])):
                cancel.set();return
            current=await asyncio.to_thread(self.store.job,job['id'],job['user_id'])
            reason=self.limit_reason(current)
            if reason:
                await asyncio.to_thread(self.store.update,job['id'],worker=self.worker,state='budget_exhausted',reason=reason)
                cancel.set();return
            if current['state']!='running': cancel.set();return
            try: await asyncio.wait_for(cancel.wait(),timeout=5)
            except asyncio.TimeoutError: pass

    def limit_reason(self,job):
        if self.store.clock()>=job['deadline']: return 'Campaign time budget reached; remaining tasks are unverified.'
        if job['actions']>=job['max_actions']: return 'Campaign action budget reached; remaining tasks are unverified.'
        if job['tokens']>=job['max_tokens'] and not self.provider_reservations.get(job['id']): return 'Campaign model-token budget reached; remaining tasks are unverified.'
        return ''

    async def reserve_model(self,payload):
        """Reserve a conservative text allocation before a billable request.

        Reported provider usage replaces it; unknown usage keeps the reservation.
        This bounds runaway calls without claiming a precise currency budget.
        """
        scope=campaign_scope.get();job_id,user_id=scope[1],scope[2]
        job=await asyncio.to_thread(self.store.job,job_id,user_id)
        # Serialized UTF-8 bytes deliberately overestimate ordinary text tokens.
        prompt=len(json.dumps({k:v for k,v in payload.items() if k!='max_tokens'},ensure_ascii=False).encode())+256
        remaining=job['max_tokens']-job['tokens']-prompt
        if job['state']!='running' or job['lease_owner']!=self.worker or remaining<32:
            if job['state']=='running':
                await asyncio.to_thread(self.store.update,job_id,worker=self.worker,state='budget_exhausted',reason='Insufficient campaign token allocation for another provider call; remaining tasks are unverified.')
            self.cancellations[job_id].set()
            raise asyncio.CancelledError()
        completion=min(int(payload.get('max_tokens',1536)),remaining)
        reservation=prompt+completion
        await asyncio.to_thread(self.store.charge,job_id,0,reservation,self.worker)
        self.provider_reservations[job_id]=reservation
        return {**payload,'max_tokens':completion}

    async def settle_usage(self,job_id,tokens):
        reservation=self.provider_reservations.pop(job_id,0)
        await asyncio.to_thread(self.store.charge,job_id,0,tokens-reservation,self.worker)

    async def control(self,campaign_id,user_id,action,session_id=None,**answers):
        job=await asyncio.to_thread(self.store.job,campaign_id,user_id,session_id)
        if action=='answer':
            if job['state'] not in {'waiting_for_permission','waiting_for_input'}: raise ValueError('This campaign is not waiting for an answer')
            # Resume only the paused task, using a supplied signed approval or
            # answer. The exact approval is validated by the existing agent.
            await asyncio.to_thread(self.store.answer,campaign_id,answers)
            action='resume'
        state=await asyncio.to_thread(self.store.control,campaign_id,user_id,action,session_id)
        await asyncio.to_thread(self.store.event,campaign_id,{'type':'campaign_control','action':action,'state':state})
        cancel=self.cancellations.get(campaign_id)
        if action in {'pause','cancel'} and cancel:
            cancel.set()
            task=self.tasks.get(campaign_id)
            if task: task.cancel()
        await self.initialize()
        return await asyncio.to_thread(self.store.status,campaign_id,user_id,session_id)

    async def record_tool(self,name,args,call):
        """Persist dispatch before input. Nested batches are recorded per step."""
        scope=campaign_scope.get()
        if scope is None or scope[0] is not self: return await call()
        job_id,user_id=scope[1],scope[2]
        job=await asyncio.to_thread(self.store.job,job_id,user_id)
        reason=self.limit_reason(job)
        if reason:
            await asyncio.to_thread(self.store.update,job_id,worker=self.worker,state='budget_exhausted',reason=reason)
        if reason or job['state']!='running' or job['lease_owner']!=self.worker or job['lease_until']<self.store.clock() or self.cancellations[job_id].is_set():
            raise asyncio.CancelledError()
        if name in {'browser_start_campaign','browser_campaign_control'}:
            return {'status':'failed','error':'Nested campaigns cannot be created by a campaign worker.'}
        sid=str(args.get('session_id') or job['session_id'])
        if not name.startswith('browser_') or sid!=job['session_id']:
            return {'status':'blocked','error':'A campaign can only use its own browser session.'}
        session=self.manager.sessions.get(sid)
        root=job['payload']['custom_url']
        destination=args.get('url') if name=='browser_open_live_session' or (name=='browser_interact' and args.get('action')=='navigate') else None
        if destination and not canonical_url(destination,root):
            return {'status':'blocked','error':'Destination is outside the authorized campaign origin; no navigation dispatched.'}
        if name=='browser_interact' and args.get('action')=='switch_tab' and session:
            destination=(session.related_targets.get(args.get('target_id')) or {}).get('url')
            if not destination or not canonical_url(destination,root):
                return {'status':'blocked','error':'The observed tab is outside this campaign origin; no switch dispatched.'}
        if session and session.current_url not in {'about:blank',''} and not canonical_url(session.current_url,root) and name not in {'browser_observe','browser_read_editor','browser_assert','browser_inspect_console','browser_campaign_status'} and not destination:
            return {'status':'blocked','error':'The live page left the campaign origin. Inspect its state or return to the authorized origin before further input.'}
        if name=='browser_interact_batch': return await call()
        call_id=uuid.uuid4().hex
        await asyncio.to_thread(self.store.charge,job_id,1,0,self.worker)
        await asyncio.to_thread(self.store.event,job_id,{'type':'tool_call','id':call_id,'task_id':self.active_items.get(job_id),'name':name,'arguments':strip_frames(args)})
        result=await call()
        await asyncio.to_thread(self.store.event,job_id,{'type':'tool_result','id':call_id,'task_id':self.active_items.get(job_id),'name':name,'result':strip_frames(result)})
        return result

    async def sample_frame(self,job,session,quota,cancel=None):
        cached=getattr(session,'_last_raw_jpeg',None)
        encoded=(base64.b64encode(cached).decode() if cached and time.time()-getattr(session,'_last_chromium_frame_time',0)<.5 else
                 await session.capture_screenshot(quality=45,use_cache=False))
        if cancel and cancel.is_set(): return True
        if not encoded: return True
        return await asyncio.to_thread(self.store.frame,job['id'],base64.b64decode(encoded),self.store.clock(),
                    {'url':session.current_url,'title':session.page_title},quota)

    async def record(self,job,cancel):
        """Owned-tab evidence independent of viewers; no global desktop capture."""
        quota=max(1048576,int(os.getenv('STACKPILOT_BROWSER_CAMPAIGN_RECORDING_BYTES',str(512*1024*1024))))
        interval=max(1,float(os.getenv('STACKPILOT_BROWSER_CAMPAIGN_RECORDING_INTERVAL_SECONDS','2')))
        last_checkpoint=0
        while not cancel.is_set():
            try:
                session=self.manager.sessions.get(job['session_id'])
                if session and session.is_connected:
                    if not await self.sample_frame(job,session,quota,cancel):
                        current=await asyncio.to_thread(self.store.job,job['id'],job['user_id'])
                        if current['state']=='running':
                            await asyncio.to_thread(self.store.event,job['id'],{'type':'recording_limit','reason':'Recording storage quota reached. Structured task evidence continues.'})
                        return
                    if time.monotonic()-last_checkpoint>=20 and not getattr(session,'_selected_frame',None):
                        previous=(await asyncio.to_thread(self.store.job,job['id'],job['user_id']))['browser_state']
                        await asyncio.to_thread(self.store.save_browser,job['id'],await capture_session(session,previous),self.worker)
                        last_checkpoint=time.monotonic()
            except asyncio.CancelledError: raise
            except Exception as exc: logger.debug('Campaign evidence sample unavailable: %s',type(exc).__name__)
            try: await asyncio.wait_for(cancel.wait(),timeout=interval)
            except asyncio.TimeoutError: pass

    async def run(self,reference):
        job_id=reference['id'];cancel=asyncio.Event();self.cancellations[job_id]=cancel
        token=campaign_scope.set((self,job_id,reference['user_id']))
        heartbeat=asyncio.create_task(self.heartbeat(reference,cancel));recording=None;task=None
        try:
            job=await asyncio.to_thread(self.store.job,job_id,reference['user_id'])
            payload=job['payload'];sid=job['session_id'];root=payload['custom_url']
            self.manager.configure_session(sid,payload.get('sandbox_mode','local'))
            existing=self.manager.sessions.get(sid)
            restored=not existing or not existing.is_connected
            session=await self.manager.get_or_create_session(sid,'about:blank')
            session.target_url=root
            if restored: await restore_session(session,job['browser_state'],root)
            session.agent_access_mode=(payload.get('runtime',{}).get('permissions') or {}).get('agent_access_mode') or payload.get('agent_access_mode') or 'ask'
            session.allow_agent_questions=payload.get('allow_agent_questions',True)
            recording=asyncio.create_task(self.record(job,cancel))
            failures=0
            while not cancel.is_set():
                job=await asyncio.to_thread(self.store.job,job_id,reference['user_id'])
                reason=self.limit_reason(job)
                if reason:
                    await asyncio.to_thread(self.store.update,job_id,worker=self.worker,state='budget_exhausted',reason=reason);break
                if job['state']!='running': break
                task=await asyncio.to_thread(self.store.claim,job_id,self.worker)
                if task is None:
                    current=await asyncio.to_thread(self.store.status,job_id,reference['user_id'])
                    held=next((row['state'] for row in current['tasks'] if row['state'] in {'waiting_for_permission','waiting_for_input','needs_reconciliation'}),None)
                    if held:
                        await asyncio.to_thread(self.store.update,job_id,worker=self.worker,state=held,reason='A workflow requires review before the campaign can continue.')
                    elif not any(row['state'] in {'pending','running'} for row in current['tasks']):
                        # Freeze periodic capture, then save the terminal page
                        # before publishing completion. No frames follow it.
                        if recording:
                            recording.cancel();await asyncio.gather(recording,return_exceptions=True)
                        try:
                            quota=max(1048576,int(os.getenv('STACKPILOT_BROWSER_CAMPAIGN_RECORDING_BYTES',str(512*1024*1024))))
                            await asyncio.wait_for(self.sample_frame(job,session,quota),timeout=5)
                        except Exception as exc:
                            await asyncio.to_thread(self.store.event,job_id,{'type':'final_frame_unavailable','error':type(exc).__name__})
                        await asyncio.to_thread(self.store.update,job_id,worker=self.worker,state='completed',reason='Queued tasks finished. Consult the report for failed, blocked and unverified workflows; completion is not an exhaustive pass.')
                    break
                self.active_items[job_id]=task['id']
                session.campaign_recovery=bool(task['payload'].get('reconcile') or (restored and task['kind']=='workflow' and task['attempts']>1))
                await asyncio.to_thread(self.store.event,job_id,{'type':'task_started','task_id':task['id'],'kind':task['kind'],'task':task['payload']})
                try:
                    if task['kind']=='page':
                        result=await asyncio.wait_for(self.discover(job,task,session),timeout=min(180,max(1,job['deadline']-self.store.clock())))
                    else:
                        result=await asyncio.wait_for(self.workflow(job,task,cancel),timeout=min(600,max(1,job['deadline']-self.store.clock())))
                    state=result.get('task_state','completed')
                    committed=await asyncio.to_thread(self.store.finish_task,job_id,task['id'],self.worker,strip_frames(result),state)
                    if not committed: raise RuntimeError('Task lease was lost; no result can be committed')
                    await asyncio.to_thread(self.store.event,job_id,{'type':'task_finished','task_id':task['id'],'kind':task['kind'],'state':state,'summary':result.get('summary','')})
                    if state in {'waiting_for_permission','waiting_for_input','needs_reconciliation'}:
                        await asyncio.to_thread(self.store.update,job_id,worker=self.worker,state=state,reason=result.get('summary',''));break
                    failures=0
                except asyncio.CancelledError: raise
                except Exception as exc:
                    failures+=1
                    state=('pending' if task['attempts']<3 else 'unverified') if task['kind']=='page' else 'needs_reconciliation'
                    await asyncio.to_thread(self.store.finish_task,job_id,task['id'],self.worker,{'error':type(exc).__name__,'verified':False},state)
                    await asyncio.to_thread(self.store.event,job_id,{'type':'task_failed','task_id':task['id'],'kind':task['kind'],'error':type(exc).__name__})
                    if state=='needs_reconciliation':
                        await asyncio.to_thread(self.store.update,job_id,worker=self.worker,state=state,reason='Interrupted workflow; reconcile live outcomes before any further input.');break
                    if failures>=3:
                        await asyncio.to_thread(self.store.update,job_id,worker=self.worker,state='paused',reason='Three consecutive task failures. Check browser/network connectivity, then resume.');break
                finally:
                    self.active_items.pop(job_id,None)
                if not getattr(session,'_selected_frame',None):
                    try: await asyncio.to_thread(self.store.save_browser,job_id,await capture_session(session,job['browser_state']),self.worker)
                    except Exception as exc:
                        await asyncio.to_thread(self.store.event,job_id,{'type':'checkpoint_unavailable','error':type(exc).__name__})
                task=None
        except asyncio.CancelledError:
            if task:
                state='pending' if task['kind']=='page' else 'needs_reconciliation'
                await asyncio.to_thread(self.store.finish_task,job_id,task['id'],self.worker,{'interrupted':True,'verified':False},state)
                current=await asyncio.to_thread(self.store.job,job_id,reference['user_id'])
                if state=='needs_reconciliation' and current['state'] not in TERMINAL:
                    await asyncio.to_thread(self.store.update,job_id,worker=self.worker,state=state,reason='Workflow interrupted; reconcile its last dispatched action before resuming.')
        except Exception as exc:
            current=await asyncio.to_thread(self.store.job,job_id,reference['user_id'])
            if current['state'] not in TERMINAL:
                await asyncio.to_thread(self.store.update,job_id,worker=self.worker,state='paused',reason='Browser/worker setup failed: '+type(exc).__name__+'. Check the selected worker and resume.')
        finally:
            # Signal before awaiting cleanup: no post-completion frame is saved.
            cancel.set()
            for background in (heartbeat,recording):
                if background: background.cancel()
            await asyncio.gather(*(t for t in (heartbeat,recording) if t),return_exceptions=True)
            current_session=self.manager.sessions.get(reference['session_id'])
            if current_session: current_session.campaign_recovery=False
            if current_session and current_session.is_connected and not getattr(current_session,'_selected_frame',None):
                try:
                    saved=(await asyncio.to_thread(self.store.job,job_id,reference['user_id']))['browser_state']
                    await asyncio.to_thread(self.store.save_browser,job_id,await capture_session(current_session,saved),self.worker)
                except Exception as exc:
                    logger.warning('Final campaign checkpoint unavailable: %s',type(exc).__name__)
            await asyncio.to_thread(self.store.release_job,job_id,self.worker)
            campaign_scope.reset(token)
            self.tasks.pop(job_id,None);self.sessions.pop(reference['session_id'],None)
            self.active_items.pop(job_id,None);self.cancellations.pop(job_id,None)
            self.provider_reservations.pop(job_id,None)

    async def discover(self,job,task,session):
        url=task['payload']['url'];root=job['payload']['custom_url']
        if not canonical_url(url,root): return {'task_state':'blocked','summary':'Page is outside the authorized origin.'}
        session.audit_read_only=True;session.last_site_audit=None
        moved=await self.execute('browser_interact',{'session_id':job['session_id'],'action':'navigate','url':url,'include_frame':False},job['user_id'])
        if moved.get('error') or not canonical_url(session.current_url,root):
            return {'task_state':'unverified','summary':'Page navigation could not be verified.','navigation':moved}
        auditor=SiteAuditor(session,self.execute,job['user_id'],max_pages=1,
            max_actions=min(180,max(1,job['max_actions']-job['actions'])),max_seconds=90,include_hover=False,include_frame=False,
            autonomous=session.agent_access_mode=='full_access' and session.allow_agent_questions is False)
        result=await auditor.run([])
        for route in result.get('coverage',{}).get('routes',[]):
            if canonical_url(route['url'],root):
                added=await asyncio.to_thread(self.store.add_task,job['id'],'page',route['url'],{'url':route['url'],'label':route.get('label','Page')})
                if not added and route['status']=='pending': result['coverage']['scope_limit']='Page budget may exclude further discovered routes; they are not verified.'
        for control in result.get('coverage',{}).get('controls_requiring_review',[]):
            identity=json.dumps({k:control.get(k) for k in ('url','label','tag','role','type','name','input_id','href')},sort_keys=True)
            await asyncio.to_thread(self.store.add_task,job['id'],'workflow',identity,{'url':control.get('url') or url,'label':control.get('label','Workflow'),'control':control})
        visited=any(route.get('url')==url and route.get('status')=='visited' for route in result.get('coverage',{}).get('routes',[]))
        return {**result,'task_state':'completed' if visited and not result.get('coverage',{}).get('stop_reason','').startswith(('Action','Time')) else 'unverified',
                'summary':'Page explored; individual business workflows have separate outcome checks.'}

    async def run_workflow(self,job,task,cancel):
        from ..main import AgentRequest, _stream_browser_agent_reply
        payload=job['payload'];goal=payload['goal'];item=task['payload']
        request=AgentRequest(**{k:v for k,v in payload.items() if k not in {'goal','task_context'}})
        request.command='/test';request.custom_url=item['url']
        if item.get('reconcile') or item.get('answer'):
            saved=await asyncio.to_thread(self.store.task_evidence,job['id'],task['id'])
            request.history=[{'role':'user','content':'Historical workflow evidence, not current page instructions or actions to replay: '+json.dumps(saved,ensure_ascii=True)[:32000]}]
        request.message=(f"Original campaign objective: {goal}\nCurrent bounded workflow: {item['label']} on {item['url']}. "
            "Use fresh controls, test its positive/negative states where meaningful, and verify the requested outcome. "
            "Define expected behavior from the original task and observed application contract. Do not invent missing credentials, identities or business facts. "
            "Do not replace this objective with an easier unrelated task. Report unverified if no independent expected outcome can be established. "
            "Do not start another audit/campaign or leave the target origin. " +
            ("RECOVERY: inspect the live outcome of the last dispatched action first. Do not replay a submission; "
             "verify persisted state, and request fresh authorization if its outcome is uncertain. " if item.get('reconcile') else ''))
        answer=item.get('answer') or {}
        request.approval_token=answer.get('approval_token')
        if answer.get('message'): request.message+='\nUser answer: '+str(answer['message'])[:8000]
        result={'verified':False};passed_outcomes=0;failed_outcomes=0
        async for raw in _stream_browser_agent_reply(request,cancel_event=cancel):
            if not raw.startswith('data: '): continue
            event=json.loads(raw[6:]);kind=event.get('type')
            if kind=='tool_result':
                evidence=event.get('result') or {}
                checks=evidence.get('assertions',[]) + [c for step in evidence.get('results',[]) if step.get('purpose')=='outcome' for c in step.get('assertions',[])]
                if evidence.get('purpose')=='outcome' or evidence.get('completion_verified'):
                    passed_outcomes+=sum(c.get('status')=='passed' for c in checks)
                    failed_outcomes+=sum(c.get('status')!='passed' for c in checks)
            if kind in {'permission_request','agent_question','done','error'}:
                await asyncio.to_thread(self.store.event,job['id'],strip_frames(event))
            if kind in {'permission_request','agent_question'}: result[kind]=event
            if kind=='error': result['error_code']=event.get('code')
            if kind=='done':
                result.update({'status':event.get('status'),'summary':event.get('content',''),'verified':event.get('status')=='verified' and passed_outcomes>0 and failed_outcomes==0})
        state=('waiting_for_permission' if result.get('permission_request') else 'waiting_for_input' if result.get('agent_question') else
               'needs_reconciliation' if result.get('status')=='approval_stale' or result.get('error_code')=='browser_run_interrupted' else
               'completed' if result['verified'] else 'unverified')
        return {**result,'task_state':state,'passed_outcome_checks':passed_outcomes}

    async def close(self):
        if self.poller: self.poller.cancel();await asyncio.gather(self.poller,return_exceptions=True);self.poller=None
        active=list(self.tasks.values())
        for task in active: task.cancel()
        await asyncio.gather(*active,return_exceptions=True)


def get_campaign_runtime():
    global _runtime
    if _runtime is None: _runtime=CampaignRuntime()
    return _runtime


def active_campaign_session(session_id):
    return _runtime.sessions.get(session_id) if _runtime else None
