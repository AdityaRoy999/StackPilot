"""Bounded, observed-link exploration. No site-specific routes or click scripts.

The worker verifies navigation and pointer mechanics. Business workflows remain
explicitly untested unless a separate scenario supplies their expected outcomes.
"""
import asyncio
from collections import deque
import json
import re
import time
from urllib.parse import urljoin, urlsplit, urlunsplit, unquote

from ..apv_engine import ActionPerceptionVerification
from .actionability import prepare_pointer_target
from .assertions import assert_browser_state
from .permissions import harmless_ui


def canonical_url(value, base):
    raw = urlsplit(urljoin(base,value))
    if raw.scheme not in {'http','https'} or raw.username or raw.password:
        return None
    root = urlsplit(base)
    def origin(u):
        return u.scheme.lower(),u.hostname,(u.port or (443 if u.scheme == 'https' else 80))
    if origin(raw) != origin(root):
        return None
    # Ordinary fragments identify sections; hash-router URLs identify pages.
    fragment = raw.fragment if raw.fragment.startswith(('/', '!/')) else ''
    return urlunsplit((raw.scheme,raw.netloc,raw.path or '/',raw.query,fragment))


def risky_label(label, href=''):
    # Conservative side-effect guard, not a vocabulary used to discover pages.
    return bool(re.search(r'\b(delete|remove|logout|log\s*out|sign\s*out|purchase|pay|buy|subscribe|unsubscribe|reset|revoke|destroy)\b',
                          unquote(str(label)+' '+str(href)),re.I))


DETAILS = r"""(() => {
 const nodes = window.__spFast?.nodes;
 const visible = e => e?.isConnected && (!e.checkVisibility || e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))
     && e.getClientRects().length > 0 && !e.closest('[hidden],[inert],[aria-hidden="true"]');
 const scope = e => {
   const parts = [];
   for (let n=e.parentElement; n; n=n.parentElement) {
     if (n.matches('header,footer,main,nav,section,form,dialog,[role="navigation"],[role="dialog"]')) {
       parts.unshift([n.tagName.toLowerCase(),n.id,n.getAttribute('role'),n.getAttribute('aria-label')].filter(Boolean).join(':'));
     }
   }
   return parts.join('/');
 };
 return [...(nodes || [])].filter(([id,e])=>visible(e)).map(([id,e])=>({
   id, tag:e.tagName.toLowerCase(), role:e.getAttribute('role') || '',
   scope:scope(e),
   label:(e.getAttribute('aria-label') || [...(e.labels||[])].map(l=>l.textContent).join(' ') || e.innerText || e.textContent || e.placeholder || e.name || '').replace(/\s+/g,' ').trim().slice(0,160),
   href:e.getAttribute('href') || '', download:e.hasAttribute('download'),
   form:!!e.closest('form'), disabled:e.matches(':disabled') || e.getAttribute('aria-disabled')==='true',
   custom_click:typeof e.onclick==='function',
   is_in_viewport:(()=>{const r=e.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth})(),
   type:e.type || '', name:e.name || '', input_id:e.id || '', required:!!e.required, invalid:e.willValidate ? !e.validity.valid : false,
   aria_controls:e.getAttribute('aria-controls') || '',
   global:!!e.closest('nav,header,footer,[role="navigation"]')
 }));
})()"""


class SiteAuditor:
    def __init__(self,session,execute,user_id='',max_pages=25,max_actions=120,max_seconds=120,include_hover=True,include_frame=True):
        self.session,self.execute,self.user_id = session,execute,user_id
        self.max_pages,self.max_actions,self.max_seconds = max_pages,max_actions,max_seconds
        self.include_hover = include_hover
        self.include_frame = include_frame
        self.started = time.monotonic()
        self.root = session.target_url or session.current_url
        self.queue,self.routes,self.cases,self.review,self.assets,self.external = deque(),{},[],{}, {},{}
        self.actions,self.stop = 0,''
        self.seen_controls = set()

    def budget(self):
        if self.actions >= self.max_actions:
            self.stop = 'Action budget reached; remaining controls/pages are untested.'
        elif time.monotonic()-self.started >= self.max_seconds:
            self.stop = 'Time budget reached; remaining controls/pages are untested.'
        return not self.stop

    async def add_case(self,action,label,result,url=None):
        case = {'action':action,'label':label,'url':url or self.session.current_url,'result':result}
        self.cases.append(case)
        self.session.audit_progress = {'pages':sum(r['status']=='visited' for r in self.routes.values()),
                                       'actions':self.actions,'cases':len(self.cases)}
        from ..tool_progress import snapshot_step
        await snapshot_step(self.session, 'browser_assert' if action == 'assert' else 'browser_interact',
                            {'action':action, 'label':label}, result, include_frame=self.include_frame)

    async def controls(self):
        await self.session.extract_interactive_tree()
        result = await self.session.evaluate(DETAILS)
        if not isinstance(result,list):
            raise RuntimeError('Current controls could not be observed')
        return result

    def enqueue(self,url,source,label):
        if url not in self.routes:
            self.routes[url] = {'url':url,'source':source,'label':label,'status':'pending'}
            self.queue.append(url)

    async def interact(self,action,control):
        self.actions += 1
        return await self.execute('browser_interact',{'session_id':self.session.session_id,
            'action':action,'element_id':control['id'],'include_frame':False},self.user_id)

    async def hover(self,control):
        self.actions += 1
        # Most discovered controls are already in the current viewport. Avoid
        # a second DOM round trip and scroll animation in that common case.
        if not control.get('is_in_viewport', True):
            await self.session.scroll_to_element(control['id'])
        point = await prepare_pointer_target(self.session,control['id'])
        if point.get('reason') != 'ready':
            return {'status':'unverified','action':'hover','reason':point.get('reason'),
                    'verification':{'verified':False,'effect_type':'unavailable','description':'Hover target is not currently actionable.'}}
        await self.session.send_command('Input.dispatchMouseEvent',{'type':'mouseMoved','x':point['x'],'y':point['y']})
        self.session._notify_listeners({'type':'cursor_action','action':'move','x':point['x'],'y':point['y'],'label':control['label']})
        hovered = await self.session.evaluate(f"Boolean(window.__spFast?.nodes.get({control['id']})?.matches(':hover'))")
        # The pointer dispatch itself is the reliable executor fact. CSS
        # :hover can be intentionally suppressed by a site or by a remote
        # compositor, so expose that observation without turning it into a
        # false interaction failure.
        return {'status':'passed','action':'hover',
                'verification':{'verified':True,'effect_type':'pointer_target',
                                'hover_match':hovered is True,
                                'description':'Native pointer reached this control; hover appearance/workflow correctness is not asserted.'}}

    async def route_assertion(self,expected):
        deadline = time.monotonic()+3
        actual = None
        while True:
            actual = await self.session.evaluate('location.href')
            matched = isinstance(actual,str) and canonical_url(actual,self.root)==expected
            if matched or time.monotonic()>=deadline:
                break
            await asyncio.sleep(.05)
        return {'status':'passed' if matched else 'failed','action':'assert','purpose':'checkpoint',
            'assertions':[{'status':'passed' if matched else 'failed',
                'expectation':{'kind':'same_origin_route','expected':expected},'actual':actual}],
            'verification':{'verified':matched,'effect_type':'assertion',
                'description':'Observed destination matches the discovered page route (section fragment verified separately).' if matched else 'Actual destination differs from the discovered route.'}}

    async def direct_route_recovery(self, route, label, reason):
        """Visit a previously observed same-origin route when pointer dispatch
        is blocked by a compositor overlay or the source rerendered. This keeps
        page coverage truthful while retaining the failed click as evidence.
        """
        await self.session.navigate(route, force=True)
        checked = await self.route_assertion(route)
        checked['verification']['description'] = reason + (' Route was reached directly.' if checked['status']=='passed' else '')
        await self.add_case('navigate',label+' route recovery',checked)
        return checked['status'] == 'passed'

    async def run(self,ui_control_ids):
        initial = await self.controls()
        approved = set(ui_control_ids)
        actual = {c['id']:c for c in initial}
        if not approved.issubset(actual):
            return {'status':'failed','action':'site_audit','error':'UI control IDs must come from the current observation; no inputs executed.'}
        approved_labels = {(actual[i]['tag'],actual[i]['role'],actual[i]['label']) for i in approved}
        first = canonical_url(self.session.current_url,self.root)
        if not first:
            return {'status':'failed','action':'site_audit','error':'The current page is outside the requested origin.'}
        self.enqueue(first,first,'Requested page')
        try:
            while self.queue and self.budget():
                if sum(r['status']=='visited' for r in self.routes.values()) >= self.max_pages:
                    self.stop = 'Page budget reached; pending pages are untested.'
                    break
                route = self.queue.popleft()
                entry = self.routes[route]
                try:
                    if canonical_url(self.session.current_url,self.root) != route:
                        source = entry['source']
                        await self.session.navigate(source)
                        observed = await self.controls()
                        matches = [c for c in observed if c['href'] and canonical_url(c['href'],source)==route
                                   and not risky_label(c['label'],c['href'])]
                        if not matches:
                            if await self.direct_route_recovery(route,entry['label'],'The discovered link was not present after source re-render.'):
                                entry['status'] = 'visited'
                                entry['fallback'] = 'direct_navigation'
                                entry['title'] = self.session.page_title
                                observed = await self.controls()
                            else:
                                entry['status'] = 'untested'
                                entry['reason'] = 'The discovered link disappeared and direct route recovery failed.'
                                continue
                        else:
                            clicked = await self.interact('click',matches[0])
                            if clicked.get('error') or clicked.get('status') in {'failed','stale_element'}:
                                await self.add_case('click',matches[0]['label'],clicked)
                                if not await self.direct_route_recovery(route,entry['label'],'Pointer activation was blocked or stale.'):
                                    entry['status'] = 'blocked'
                                    continue
                                entry['status'] = 'visited'
                                entry['fallback'] = 'direct_navigation'
                            else:
                                checked = await self.route_assertion(route)
                                await self.add_case('assert',entry['label']+' route',checked)
                                if checked['status'] != 'passed':
                                    entry['status'] = 'failed'
                                    entry['reason'] = 'Actual destination differs from the discovered route.'
                                    continue
                    entry['status'] = 'visited'
                    entry['title'] = self.session.page_title
                    observed = await self.controls()
                    frames = await self.session.evaluate("[...document.querySelectorAll('iframe')].map(e=>({src:e.getAttribute('src') || '',title:e.title || ''}))")
                    for index,frame in enumerate(frames or []):
                        self.review[(route,'frame',index)] = {'url':route,'label':frame.get('title') or 'Embedded frame',
                            'reason':'Embedded content requires a frame-scoped scenario; its business behavior is untested.'}
                    # Discovered routes belong to an explicit queue, not model memory.
                    for c in observed:
                        if not c['href']:
                            continue
                        destination = canonical_url(c['href'],route)
                        if not destination:
                            self.external[c['href']] = {'href':c['href'],'label':c['label'],'status':'outside_scope'}
                        elif risky_label(c['label'],c['href']):
                            self.review[(route,c['id'])] = {'url':route,'label':c['label'],'reason':'Link may change account/server state.'}
                        elif c['download'] or re.search(r'\.(pdf|zip|exe|dmg|mp4|png|jpe?g|svg)(?:$|\?)',destination,re.I):
                            self.assets[destination] = {'url':destination,'label':c['label'],'status':'untested_download'}
                        else:
                            self.enqueue(destination,route,c['label'])
                    for c in observed:
                        if not self.budget():
                            break
                        current_route = canonical_url(self.session.current_url,self.root)
                        if current_route != route:
                            await self.session.navigate(route)
                        # Returning to a route replaces its document, so every
                        # remaining entry in the original list has an old ID.
                        # Resolve its unique semantic identity in a fresh tree
                        # before dispatch, even when the URL already matches.
                        fresh = await self.controls()
                        identity = ('tag','role','label','href','type','name','input_id','scope')
                        matches = [n for n in fresh if all(n.get(k,'') == c.get(k,'') for k in identity)]
                        if len(matches) != 1:
                            self.review[(route,c['id'])] = {'url':route,'label':c['label'],
                                'reason':'The discovered control disappeared or became ambiguous after a page update; no input was dispatched.'}
                            continue
                        c = matches[0]
                        key = ('global' if c['global'] else route,c['tag'],c['role'],c['label'],c['href'])
                        if key in self.seen_controls:
                            continue
                        self.seen_controls.add(key)
                        if self.include_hover and (c['tag'] in {'a','button','summary'} or c['role'] in {'button','tab','menuitem'} or c.get('custom_click')):
                            await self.add_case('hover',c['label'],await self.hover(c))
                        if not self.budget():
                            break
                        href = c['href']
                        fragment = urlsplit(urljoin(route,href)).fragment if href else ''
                        if href and fragment and not fragment.startswith(('/','!/')) and canonical_url(href,route)==route:
                            target = await self.session.evaluate(f"Boolean(document.getElementById({json.dumps(unquote(fragment))}))")
                            if target:
                                clicked = await self.interact('click',c)
                                if clicked.get('error') or clicked.get('status') in {'failed','stale_element'}:
                                    await self.add_case('click',c['label'],clicked)
                                else:
                                    assertion = await assert_browser_state(self.session,[{'kind':'in_viewport','selector':'[id='+json.dumps(unquote(fragment))+']'}],2,'checkpoint')
                                    await self.add_case('assert',c['label']+' target section',assertion)
                            else:
                                self.review[(route,c['id'])] = {'url':route,'label':c['label'],'reason':'Fragment target absent on this document; cross-page behavior needs review.'}
                        elif c['tag'] in {'button','summary'} or c['role'] in {'button','tab','switch','checkbox'} or c.get('custom_click'):
                            allowed = harmless_ui(c)
                            if c['form'] or c['disabled'] or risky_label(c['label']) or not allowed:
                                self.review[(route,c['id'])] = {'url':route,'label':c['label'],
                                    'tag':c['tag'],'role':c['role'],'type':c['type'],
                                    'name':c.get('name',''),'input_id':c.get('input_id',''),'href':c.get('href',''),
                                    'reason':('Disabled control needs its enabling prerequisites.' if c['disabled'] else
                                        'Submission/unknown effect requires an explicit scenario and action-scoped approval.')}
                                continue
                            await self.session.evaluate(f"(() => {{window.__spAuditApproved ||= new WeakSet(); const e=window.__spFast?.nodes.get({c['id']}); if(e) window.__spAuditApproved.add(e);}})()")
                            result = await self.interact('click',c)
                            # Animation-driven tabs may update after input quiescence.
                            if (result.get('verification') or {}).get('effect_type') in {'focus','no_effect'}:
                                self.review[(route,c['id'])] = {'url':route,'label':c['label'],'reason':'No verified state change; inspect before any retry.'}
                            await self.add_case('click',c['label'],result)
                        elif c['tag'] in {'input','textarea','select'}:
                            self.review[(route,c['id'])] = {'url':route,'label':c['label'],
                                'tag':c['tag'],'type':c.get('type',''),'name':c.get('name',''),'input_id':c.get('input_id',''),
                                'reason':'Input/schema discovered; positive and negative data scenarios are not yet verified.'}
                    entry['controls_discovered'] = len(observed)
                except Exception as exc:
                    entry['status'] = 'unverified'
                    entry['reason'] = 'Page execution/observation failed: '+type(exc).__name__
        finally:
            result = self.result()
            self.session.last_site_audit = result
        return result

    def result(self):
        routes = list(self.routes.values())
        return {'status':'observed','action':'site_audit','url':self.root,
            'elapsed_ms':round((time.monotonic()-self.started)*1000),'actions':self.actions,
            'coverage':{'routes':routes,'visited_pages':sum(r['status']=='visited' for r in routes),
                'discovered_pages':len(routes),'pending_pages':sum(r['status']=='pending' for r in routes),
                'controls_requiring_review':list(self.review.values()),'assets':list(self.assets.values()),
                'external_links':list(self.external.values()),'stop_reason':self.stop,
                'exhaustive':False,'scope':'Discovered same-origin navigation, section targets, pointer hover and explicitly approved UI controls.'},
            'cases':self.cases,'hint':'This verifies recorded interaction mechanics. Remaining forms, downloads, external flows and business outcomes are untested. Do not claim full website reliability.'}
