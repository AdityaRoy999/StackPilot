"""Bounded, observed-link exploration. No site-specific routes or click scripts.

The worker verifies navigation and pointer mechanics. Business workflows remain
explicitly untested unless a separate scenario supplies their expected outcomes.
"""
import asyncio
from collections import deque
import hashlib
import json
import re
import time
from urllib.parse import urljoin, urlsplit, urlunsplit, unquote

from ..apv_engine import ActionPerceptionVerification
from .actionability import prepare_pointer_target
from .assertions import assert_browser_state
from .permissions import CRITICAL, harmless_ui

CONTROL_IDENTITY = ('tag','role','label','href','type','name','input_id','scope','card_context')


def match_control(control, candidates):
    matches = [candidate for candidate in candidates if all(candidate.get(key,'') == control.get(key,'') for key in CONTROL_IDENTITY)]
    current = [candidate for candidate in matches if candidate.get('id') == control.get('id')]
    return current[0] if len(current) == 1 else matches[0] if len(matches) == 1 else None


def scene_signature(controls):
    return hashlib.sha256(json.dumps(sorted([tuple(str(c.get(key,'') or '') for key in CONTROL_IDENTITY)
        for c in controls]),ensure_ascii=True).encode()).hexdigest()


def canonical_url(value, base):
    from ..browser_driver import to_frontend_display_url
    base=to_frontend_display_url(base)
    value=to_frontend_display_url(urljoin(base,value))
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


def download_control(control):
    """Recognize assets before broad UI exploration can open an OS save dialog."""
    label=str(control.get('label') or control.get('text') or '').strip()
    href=unquote(str(control.get('href') or ''))
    return bool(control.get('download') or
        re.search(r'\.(?:pdf|zip|exe|dmg|mp4|png|jpe?g|svg|csv|xlsx?|docx?)(?:$|[?#])',href,re.I) or
        re.search(r'\b(?:download|export|save\s+as|save\s+(?:pdf|file)|brochure)\b',label,re.I) or
        re.fullmatch(r'(?:my\s+)?(?:resume|cv|curriculum\s+vitae)',label,re.I))


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
   readonly:!!e.readOnly,
   current_value:e.type === 'password' || e.type === 'file' ? null :
     ('value' in e && String(e.value || '').length <= 2000 ? String(e.value || '') : null),
   aria_controls:e.getAttribute('aria-controls') || '',
   global:!!e.closest('nav,header,footer,[role="navigation"]')
 }));
})()"""


class SiteAuditor:
    def __init__(self,session,execute,user_id='',max_pages=25,max_actions=120,max_seconds=120,include_hover=True,include_frame=True,autonomous=False):
        self.session,self.execute,self.user_id = session,execute,user_id
        self.max_pages,self.max_actions,self.max_seconds = max_pages,max_actions,max_seconds
        self.include_hover = include_hover
        self.include_frame = include_frame
        # A broad audit exercises UI/native validation. Business submissions
        # require a separate scenario and expected outcome, even in Full access.
        self.autonomous = bool(autonomous)
        self.started = time.monotonic()
        self.root = session.target_url or session.current_url
        self.queue,self.routes,self.cases,self.review,self.assets,self.external = deque(),{},[],{}, {},{}
        self.actions,self.stop = 0,''
        self.seen_controls = set()
        self.scenes = []
        self.seen_scenes = set()

    @staticmethod
    def _validation_cases(control):
        """Return synthetic native-validation cases for a safe input target."""
        kind = str(control.get('type') or 'text').lower()
        if control.get('tag') == 'select' or kind not in {'text','search','email','url','tel','number','textarea'}:
            return []
        required = bool(control.get('required'))
        if kind == 'email':
            return [('', False), ('qa+stackpilot@example.test', True)] if required else [
                ('invalid-email', False), ('qa+stackpilot@example.test', True)]
        if kind == 'url':
            return [('', False), ('https://example.test/', True)] if required else [
                ('not-a-url', False), ('https://example.test/', True)]
        if kind == 'number':
            return [('', False), ('1', True)] if required else [('1', True)]
        if required:
            return [('', False), ('StackPilot QA', True)]
        # Optional text fields have no portable invalid value. We still record
        # a harmless empty and positive state without inventing a failure.
        return [('', True), ('StackPilot QA', True)]

    async def validate_input(self, control, review):
        """Exercise native validation without submitting a form or sending data."""
        cases = self._validation_cases(control)
        if not cases or control.get('readonly') or not isinstance(control.get('current_value'), str):
            review['reason'] = 'This input needs a typed scenario or its original value could not be preserved; no value was dispatched.'
            return
        original = control['current_value']
        states = set(review.get('native_validation_states') or [])
        changed = False
        try:
            for text, expected in cases:
                # Reserve an input action for restoring the original value.
                if not self.budget() or self.actions + 1 >= self.max_actions:
                    break
                fresh = await self.current_control(control)
                if not fresh:
                    review['reason'] = 'Input was replaced or became ambiguous; no further input was dispatched.'
                    break
                # An empty required field is already the negative test case.
                # Do not demand a perceptual delta from retyping its value.
                if fresh.get('current_value') != text:
                    args = {'session_id':self.session.session_id,'action':'type','element_id':fresh['id'],
                            'text':text,'include_frame':False}
                    changed = True
                    typed = await self.interact('type', fresh, args)
                    await self.add_case('type', control.get('label','Input'), typed, control.get('url'))
                    if typed.get('status') != 'passed':
                        break
                    fresh = await self.current_control(control)
                    if not fresh:
                        break
                assertion = await self.execute('browser_assert', {
                    'session_id':self.session.session_id,'purpose':'checkpoint','timeout_seconds':0,
                    'expectations':[{'kind':'validity','element_id':fresh['id'],'expected':expected}]}, self.user_id)
                await self.add_case('assert', control.get('label','Input')+' native validity', assertion, control.get('url'))
                if assertion.get('status') == 'passed':
                    states.add(expected)
        finally:
            if changed:
                fresh = await self.current_control(control)
                restored = await self.interact('type', fresh, {
                    'session_id':self.session.session_id,'action':'type','element_id':fresh['id'],
                    'text':original,'include_frame':False}) if fresh else {
                        'status':'unverified','error':'Original input target disappeared; its value could not be restored.'}
                await self.add_case('restore', control.get('label','Input'), restored, control.get('url'))
                review['input_restored'] = restored.get('status') == 'passed'
                # A failed/no-effect dispatch can leave the original value
                # intact. Verify it explicitly instead of inferring damage.
                if fresh and restored.get('status') == 'unverified':
                    restored_target = await self.current_control(control)
                    if restored_target:
                        check = await self.execute('browser_assert', {
                            'session_id':self.session.session_id,'purpose':'checkpoint','timeout_seconds':0,
                            'expectations':[{'kind':'value','element_id':restored_target['id'],'expected':original}]}, self.user_id)
                        await self.add_case('assert', control.get('label','Input')+' original value', check, control.get('url'))
                        review['input_restored'] = check.get('status') == 'passed'
        review['native_validation_states'] = sorted(states)
        review['reason'] = ('Positive and negative native validation checks passed. Submission and business/server '
                            'behavior remain unverified.' if states == {False, True} else
                            'Native input validation was exercised; the complementary state or business behavior remains unverified.')

    async def current_control(self, control):
        return match_control(control, await self.controls())

    def discover_controls(self, fresh, pending, known, identity, route):
        for control in fresh:
            semantic = tuple(control.get(key,'') for key in identity)
            if semantic in known:
                continue
            known.add(semantic)
            pending.append(control)
            href = control.get('href')
            destination = canonical_url(href,route) if href else None
            if destination and not risky_label(control['label'],href) and not download_control(control):
                self.enqueue(destination,route,control['label'])

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
        for attempt in range(2):
            await self.session.extract_interactive_tree()
            result = await self.session.evaluate(DETAILS)
            if not isinstance(result,list):
                raise RuntimeError('Current controls could not be observed')
            descriptors = {c['id']:c for c in self.session.interactive_elements}
            result = [control for control in result if control['id'] in descriptors]
            # An animated replacement can land between the extraction and
            # details reads. Reacquire once instead of treating its empty old
            # node map as proof that the new detail has no controls.
            if result or not descriptors or attempt:
                break
            await asyncio.sleep(.05)
        for control in result:
            observed = descriptors.get(control['id'], {})
            control['card_context'] = observed.get('card_context','')
            control['is_inside_modal'] = bool(observed.get('is_inside_modal'))
            control['overlay_id'] = observed.get('overlay_id')
        return result

    async def explore_detail(self, trigger, before, source_url, history_entry=None, depth=0):
        """Explore newly mounted controls before returning to the sibling queue."""
        from .widgets import observe_widgets
        from .navigation import restore_parent
        old_ids = {c['id'] for c in before}
        previous_overlays = {c.get('overlay_id') for c in before if c.get('is_inside_modal')}
        primary = {'a','button','summary','input','textarea','select'}
        deadline = time.monotonic() + (1.5 if re.match(r'^(?:view|read|details|learn more)\b', trigger['label'], re.I) else 0)
        while True:
            fresh = await self.controls()
            widgets = await observe_widgets(self.session)
            overlay = widgets.get('active_overlay')
            new_overlay = overlay and overlay.get('id') not in previous_overlays
            children = [c for c in fresh if c.get('is_inside_modal')] if new_overlay else [c for c in fresh if c['id'] not in old_ids]
            current = self.session.current_url
            vanished = {c['id'] for c in before if c['tag'] in primary} - {c['id'] for c in fresh}
            # Lazy inline previews are not child pages. A same-URL detail view
            # may mount only after its exit animation, so wait for its controls.
            changed = current != source_url or new_overlay or len(vanished) >= 2 or any(
                re.fullmatch(r'(?:back|go back|back to .+|return to .+)',c['label'],re.I) for c in children)
            if changed and (children or current != source_url):
                break
            if time.monotonic() >= deadline or not self.budget():
                return
            await asyncio.sleep(.1)
        if current != source_url:
            destination = canonical_url(current, self.root)
            if destination:
                self.enqueue(destination, source_url, trigger['label'])
            children = fresh
        if not children or not any(c.get('tag') in {'a','button','summary'} for c in children):
            return
        signature = scene_signature(children)
        scene = {'url':current, 'parent_url':source_url, 'label':trigger['label'],
                 'card_context':trigger.get('card_context',''), 'depth':depth+1, 'status':'observed',
                 'controls_discovered':len(children)}
        self.scenes.append(scene)
        try:
            if depth >= 3 or not self.budget() or self.actions + 2 >= self.max_actions:
                scene.update(status='incomplete', reason='Detail depth/time/action budget reached; restoring its parent without further inputs.')
                return
            if signature in self.seen_scenes:
                scene['reason'] = 'This detail state was already explored; no repeated inputs.'
                return
            self.seen_scenes.add(signature)
            for child in children:
                if not self.budget() or self.actions + 2 >= self.max_actions:
                    scene['status'] = 'incomplete'
                    break
                child = await self.current_control(child)
                if not child:
                    continue
                href = child.get('href')
                if href:
                    destination = canonical_url(href, current)
                    if destination and not risky_label(child['label'],href) and not download_control(child):
                        self.enqueue(destination, current, child['label'])
                    elif not destination:
                        self.external[href] = {'href':href,'label':child['label'],'status':'outside_scope'}
                if download_control(child) or child.get('disabled') or child.get('form'):
                    self.review[(current,child['id'])] = {'url':current,'label':child['label'],
                        'card_context':child.get('card_context',''),'reason':'Detail download, disabled control or form needs a separate scenario.'}
                    continue
                # Close/back restores this scene only after its contents were inspected.
                if re.fullmatch(r'(?:close(?:\s+.+)?|dismiss|cancel|back|go back|back to .+|return to .+|[×✕])',child['label'],re.I):
                    continue
                if child['tag'] in {'button','summary'} or child.get('role') in {'tab','switch','checkbox'}:
                    if not harmless_ui(child):
                        self.review[(current,child['id'])] = {'url':current,'label':child['label'],
                            'card_context':child.get('card_context',''),'reason':'Detail control requires an explicit scenario and expected state.'}
                        continue
                    source_controls = await self.controls()
                    clicked = await self.interact('click',child)
                    await self.add_case('click',child['label'],clicked,current)
                    if clicked.get('status') == 'passed':
                        await self.explore_detail(child,source_controls,current,depth=depth+1)
        finally:
            # Budget exhaustion must not strand the user in a detail/modal.
            self.actions += 1
            restored = await restore_parent(self.session, source_url, history_entry_id=history_entry, expected_controls=before)
            observed = await self.controls()
            from .navigation import parent_controls_match
            restored['success'] = bool(restored.get('success') and parent_controls_match(before, observed))
            scene['parent_restored'] = restored['success']
            scene['return_method'] = restored.get('method')
            if not restored['success']:
                scene['reason'] = restored.get('reason') or 'Parent controls differed after returning.'
                scene['expected_parent_controls'] = [{k:c.get(k,'') for k in ('label','card_context','scope')} for c in before[:12]]
                scene['actual_parent_controls'] = [{k:c.get(k,'') for k in ('label','card_context','scope')} for c in observed[:12]]
            check = {'status':'passed' if restored['success'] else 'unverified','action':'return_to_parent',
                     'verification':{'verified':restored['success'],'effect_type':'parent_restored' if restored['success'] else 'no_effect',
                         'description':'Parent controls restored before exploring the next sibling.' if restored['success'] else 'The original parent controls were not restored.',
                         'method':restored.get('method')}}
            await self.add_case('return_to_parent',trigger['label'],check,source_url)
            if not restored['success']:
                self.stop = 'Parent restoration failed; remaining sibling controls are untested.'

    def enqueue(self,url,source,label):
        if url not in self.routes:
            self.routes[url] = {'url':url,'source':source,'label':label,'status':'pending'}
            self.queue.append(url)

    async def interact(self,action,control,arguments=None):
        self.actions += 1
        args = arguments or {'session_id':self.session.session_id,
            'action':action,'element_id':control['id'],'include_frame':False}
        return await self.execute('browser_interact',args,self.user_id)

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
        approved_controls = {tuple(actual[i].get(key,'') for key in CONTROL_IDENTITY) for i in approved}
        first = canonical_url(self.session.current_url,self.root)
        starting_url = self.session.current_url
        starting_scroll = getattr(self.session, 'scroll_y', 0)
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
                        elif download_control(c):
                            self.assets[destination] = {'url':destination,'label':c['label'],'status':'untested_download'}
                        else:
                            self.enqueue(destination,route,c['label'])
                    pending_controls = deque(observed)
                    identity = CONTROL_IDENTITY
                    known = {tuple(c.get(key,'') for key in identity) for c in observed}
                    while pending_controls:
                        c = pending_controls.popleft()
                        if not self.budget():
                            break
                        # Ordinary links were already queued from this tree.
                        # A discovery-only worker need not observe the entire
                        # document again for every link on a large navigation.
                        if not self.include_hover and c['tag']=='a' and c.get('href') and not c.get('custom_click'):
                            destination=canonical_url(c['href'],route)
                            fragment=urlsplit(urljoin(route,c['href'])).fragment
                            if destination and (destination!=route or not fragment or fragment.startswith(('/','!/'))):
                                continue
                        current_route = canonical_url(self.session.current_url,self.root)
                        if current_route != route:
                            await self.session.navigate(route)
                        # Returning to a route replaces its document, so every
                        # remaining entry in the original list has an old ID.
                        # Resolve its unique semantic identity in a fresh tree
                        # before dispatch, even when the URL already matches.
                        fresh = await self.controls()
                        if self.autonomous:
                            self.discover_controls(fresh,pending_controls,known,identity,route)
                        matched_control = match_control(c, fresh)
                        if not matched_control:
                            self.review[(route,c['id'])] = {'url':route,'label':c['label'],
                                'card_context':c.get('card_context',''),
                                'reason':'The discovered control disappeared or became ambiguous after a page update; no input was dispatched.'}
                            continue
                        c = matched_control
                        key = ('global' if c['global'] else route,*(c.get(part,'') for part in identity))
                        if key in self.seen_controls:
                            continue
                        self.seen_controls.add(key)
                        if download_control(c):
                            self.review[(route,c['id'])] = {'url':route,'label':c['label'],
                                'reason':'Download/export requires an explicit asset scenario; no click was dispatched.'}
                            if c.get('href'):
                                self.assets[c['href']] = {'url':c['href'],'label':c['label'],'status':'untested_download'}
                            continue
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
                            allowed = harmless_ui(c) or tuple(c.get(key,'') for key in identity) in approved_controls
                            submission = c['form'] and c['type'] in {'submit','image','reset'}
                            consequential = bool(CRITICAL.search(c['label']+' '+c.get('href','')))
                            review = {'url':route,'label':c['label'],
                                    'tag':c['tag'],'role':c['role'],'type':c['type'],
                                    'name':c.get('name',''),'input_id':c.get('input_id',''),'href':c.get('href',''),
                                    'form':c['form'],'card_context':c.get('card_context',''),
                                    'reason':('Disabled control needs its enabling prerequisites.' if c['disabled'] else
                                        'Submission or consequential operation needs an explicit task and expected outcome.'
                                        if submission or consequential else 'Unknown UI effect needs scenario verification.')}
                            if submission or c['disabled'] or consequential or not allowed:
                                self.review[(route,c['id'])] = review
                                # Full access/autonomous mode may exercise an
                                # unknown, reversible UI control. Known
                                # destructive labels and form submissions stay
                                # in the unverified business scenario ledger.
                                if not self.autonomous or c['disabled'] or submission or consequential:
                                    continue
                            await self.session.evaluate(f"(() => {{window.__spAuditApproved ||= new WeakSet(); const e=window.__spFast?.nodes.get({c['id']}); if(e) window.__spAuditApproved.add(e);}})()")
                            source_controls = await self.controls()
                            source_url = self.session.current_url
                            result = await self.interact('click',c)
                            # Animation-driven tabs may update after input quiescence.
                            if (result.get('verification') or {}).get('effect_type') in {'focus','no_effect'}:
                                self.review[(route,c['id'])] = {'url':route,'label':c['label'],'reason':'No verified state change; inspect before any retry.'}
                            elif self.autonomous and result.get('status') == 'passed':
                                self.review.pop((route,c['id']), None)
                            await self.add_case('click',c['label'],result)
                            if result.get('status') in {'passed','unverified'}:
                                await self.explore_detail(c,source_controls,source_url)
                        elif c['tag'] in {'input','textarea','select'}:
                            review = {'url':route,'label':c['label'],
                                'tag':c['tag'],'type':c.get('type',''),'name':c.get('name',''),'input_id':c.get('input_id',''),
                                'reason':'Input/schema discovered; positive and negative data scenarios are not yet verified.'}
                            self.review[(route,c['id'])] = review
                            if self.autonomous and not c['disabled']:
                                await self.validate_input(c, review)
                        if self.budget() and canonical_url(self.session.current_url,self.root) == route:
                            self.discover_controls(await self.controls(),pending_controls,known,identity,route)
                    entry['controls_discovered'] = len(known)
                except Exception as exc:
                    entry['status'] = 'unverified'
                    entry['reason'] = 'Page execution/observation failed: '+type(exc).__name__
        finally:
            from .navigation import restore_parent, parent_controls_match
            # Discovery must finish at its starting page, including when a
            # budget ends on a child route. Cleanup does not rerun any workflow.
            self.starting_page_restoration = {'status':'passed','url':starting_url,'method':'already_on_starting_page'}
            try:
                initial_overlays = {c.get('overlay_id') for c in initial if c.get('is_inside_modal')}
                current_overlays = {c.get('overlay_id') for c in self.session.interactive_elements if c.get('is_inside_modal')}
                if (self.session.current_url != starting_url or getattr(self.session,'native_dialog',None)
                        or current_overlays != initial_overlays
                        or not parent_controls_match(initial, self.session.interactive_elements)):
                    self.actions += 1
                    restored = await restore_parent(self.session, starting_url, expected_controls=initial)
                    self.starting_page_restoration = {'status':'passed' if restored.get('success') else 'unverified',
                        'url':starting_url,'method':restored.get('method'),'reason':restored.get('reason','')}
                    await self.add_case('return_to_parent','Starting page',{
                        'status':self.starting_page_restoration['status'], 'action':'return_to_parent',
                        'verification':{'verified':bool(restored.get('success')),'effect_type':'parent_restored' if restored.get('success') else 'no_effect',
                            'description':'Returned to the starting page after route exploration.'}},starting_url)
                if self.starting_page_restoration['status'] == 'passed' and not getattr(self.session,'native_dialog',None):
                    await self.session.scroll_to(starting_scroll)
            except Exception as exc:
                self.starting_page_restoration = {'status':'unverified','url':starting_url,'reason':'Starting page recovery failed: '+type(exc).__name__}
            result = self.result()
            self.session.last_site_audit = result
        return result

    def result(self):
        routes = list(self.routes.values())
        return {'status':'observed','action':'site_audit','url':self.root,
            'elapsed_ms':round((time.monotonic()-self.started)*1000),'actions':self.actions,
            'coverage':{'routes':routes,'visited_pages':sum(r['status']=='visited' for r in routes),
                'discovered_pages':len(routes),'pending_pages':sum(r['status']=='pending' for r in routes),
                'detail_views':self.scenes,
                'starting_page_restoration':getattr(self,'starting_page_restoration',None),
                'controls_requiring_review':list(self.review.values()),'assets':list(self.assets.values()),
                'external_links':list(self.external.values()),'stop_reason':self.stop,
                'exhaustive':False,'scope':'Discovered same-origin navigation, section targets, pointer hover and explicitly approved UI controls.'},
            'cases':self.cases,'hint':'This verifies recorded interaction mechanics. Remaining forms, downloads, external flows and business outcomes are untested. Do not claim full website reliability.'}
