"""Fresh-page, one-action authorization for consequential browser inputs.

Page labels are evidence, never authorization. Approvals bind an exact action to
the observed origin/control and expire with the live browser session. The existing
signed approval token supplies owner/chat binding and durable nonce consumption.
"""
import copy
from contextvars import ContextVar
import hashlib
import json
import re

from ..agent_runtime.approval import argument_digest


authorized_browser_step = ContextVar('authorized_browser_step', default=None)
CRITICAL = re.compile(r'\b(delete|remove|destroy|revoke|reset|purchase|checkout|pay|buy|order|subscribe|unsubscribe|send|submit|publish|transfer|withdraw|confirm\s+(?:booking|payment)|sign\s*out|log\s*out)\b', re.I)
SAFE_UI = re.compile(r'\b(theme|dark|light|menu|navigation|back|home|view\s+all|show\s+(?:more|less)|expand|collapse|close|dismiss|next|previous|tab)\b', re.I)


def harmless_ui(control):
    """Conservative UI semantics for navigation-only audits; no generic clicks."""
    label = str(control.get('label') or control.get('text') or control.get('aria_label') or '')
    if control.get('form') or control.get('disabled') or CRITICAL.search(label+' '+str(control.get('href') or '')):
        return False
    return bool(control.get('tag') == 'summary' or control.get('role') in {'tab','switch','checkbox','radio'}
                or control.get('aria_controls') or control.get('global')
                or SAFE_UI.search(label))


PROBE = r"""(() => {
 const a=__ACTION__, ref=a.element_id;
 const node=ref!==undefined ? window.__spFast?.nodes.get(Number(ref)) :
   (a.x!==undefined&&a.y!==undefined ? document.elementFromPoint(a.x,a.y) : document.activeElement);
 const e=node?.closest('button,a,input,textarea,select,summary,[role="button"],[role="tab"],[role="switch"],[role="checkbox"]') || node;
 if (!e?.isConnected) return null;
 const f=e.closest('form'), anchor=e.closest('a[href]');
 return {id:ref,tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||'',type:e.type||'',
   label:(e.getAttribute('aria-label')||e.innerText||e.textContent||e.placeholder||'').replace(/\s+/g,' ').trim().slice(0,160),
   name:e.name||'',input_id:e.id||'',href:anchor?.getAttribute('href')||'',
   form:!!f,form_action:f?.getAttribute('action')||'',form_method:f?.method||'',
   aria_controls:e.getAttribute('aria-controls')||'',global:!!e.closest('nav,[role="navigation"]'),
   disabled:e.matches(':disabled')||e.getAttribute('aria-disabled')==='true',url:location.href,
   native_validity:f ? [...f.elements].filter(n=>n.willValidate).every(n=>n.validity.valid) : null,
   _state:JSON.stringify({context:(e.closest('form,[role="dialog"],tr,article')?.innerText||'').slice(0,3000),
       inputs:f?[...f.elements].map(n=>[n.name||n.id,n.type,n.type==='password'?'[redacted]':n.value,n.checked]):[]})};
})()"""


def resolve_browser_arguments(session, name, arguments):
    """Bind a unique observed label before signing or dispatching an action.

    Missing or ambiguous labels remain unresolved so the executor returns its
    target error. A missing click target must never fall back to the focused body.
    """
    if name == 'browser_interact_batch':
        actions = arguments.get('actions')
        return {**arguments,'actions':[resolve_browser_arguments(session,'browser_interact',a)
                if isinstance(a,dict) else a for a in actions]} if isinstance(actions,list) else arguments
    action = str(arguments.get('action') or '').lower()
    targeted = {'click','hover','double_click','right_click','type','scroll_to','select_option','toggle_checkbox','set_checked'}
    if name != 'browser_interact' or action not in targeted or arguments.get('element_id') is not None:
        return arguments
    fields = ('name','placeholder','input_id') if action == 'type' else ('text','href','aria_label')
    query = str(arguments.get('field') or arguments.get('target') or
                (arguments.get('text') if action != 'type' else '') or '').strip().casefold()
    if not query:
        return arguments
    candidates = [c for c in getattr(session,'interactive_elements',[]) if any(query in str(c.get(k) or '').strip().casefold() for k in fields)]
    exact = [c for c in candidates if any(query == str(c.get(k) or '').strip().casefold() for k in fields)]
    candidates = exact or candidates
    return {**arguments,'element_id':candidates[0]['id']} if len(candidates)==1 else arguments


async def observe_step(session, arguments):
    action = str(arguments.get('action') or '').lower()
    if action == 'navigate':
        return {'url':getattr(session,'current_url',''),'href':arguments.get('url',''),'tag':'navigation','label':'Navigate'}
    if action not in {'click','double_click','right_click','press_key','type','set_checked','toggle_checkbox','select_option','drag_and_drop'}:
        return None
    arguments = resolve_browser_arguments(session,'browser_interact',arguments)
    if arguments.get('element_id') is None:
        if action in {'click','double_click','right_click'} and (arguments.get('x') is None or arguments.get('y') is None):
            return None
        if action in {'set_checked','toggle_checkbox','select_option'}:
            return None
        if action == 'type' and (arguments.get('field') or arguments.get('target')):
            return None
    # No generated JavaScript is accepted; only JSON parameters enter this probe.
    evaluator = getattr(session, 'evaluate', None)
    if callable(evaluator):
        target = {k:arguments[k] for k in ('element_id','x','y') if k in arguments}
        if action == 'drag_and_drop':
            target = {'x':arguments.get('end_x'),'y':arguments.get('end_y')}
        probe = await evaluator(PROBE.replace('__ACTION__', json.dumps(target)))
        if isinstance(probe, dict):
            state = probe.pop('_state',None)
            if state is not None:
                probe['state_digest'] = hashlib.sha256(str(state).encode()).hexdigest()
            return probe
        if action in {'drag_and_drop','press_key'}:
            return {'url':getattr(session,'current_url',''),'tag':'unknown','label':'Unobserved gesture target'}
        return None
    # Lightweight test/custom sessions may supply semantic observations directly.
    control = next((c for c in getattr(session,'interactive_elements',[]) if c.get('id') == arguments.get('element_id')),None)
    return {**control,'url':getattr(session,'current_url','')} if control else None


def permission_reason(action, control, broad_audit=False):
    kind = str(action.get('action') or '').lower()
    if not control or kind in {'hover','scroll_to'}:
        return ''
    label = str(control.get('label') or control.get('text') or control.get('aria_label') or '')
    if kind == 'type':
        return 'Entering credentials or uploading a file requires this specific step to be approved.' if control.get('type') in {'password','file'} else ''
    if kind == 'drag_and_drop':
        return 'Dragging into this target can move, upload, or delete content; approve this specific gesture.'
    if kind == 'navigate':
        return 'This destination may invoke a state-changing route.' if CRITICAL.search(str(control.get('href') or '')) else ''
    if kind in {'set_checked','toggle_checkbox','select_option'} and CRITICAL.search(label):
        return 'Changing this control may affect consent, billing, or account/server state.'
    if kind == 'press_key':
        key = str(action.get('key') or 'Enter').lower()
        modifiers = {str(m).lower() for m in action.get('modifiers',[])}
        if modifiers - {'shift'} or (key not in {'tab','escape','arrowup','arrowdown','arrowleft','arrowright','home','end','pageup','pagedown','enter','return','space',' '}):
            return 'This shortcut has no established read-only effect; approve this specific key gesture.'
        if key not in {'enter','return','space',' '}:
            return ''
    if kind in {'click','double_click','right_click','press_key'}:
        if CRITICAL.search(label+' '+str(control.get('href') or '')):
            return 'This control may send data, charge money, publish, or change account/server state.'
        if control.get('form') and (kind == 'press_key' or control.get('type') in {'submit','image'}):
            return 'Submitting this form can send data or change server state.'
        if broad_audit and not control.get('href') and not harmless_ui(control):
            return 'This control has no established harmless UI semantics; approve its specific effect before testing it.'
    return ''


def fingerprint(control):
    # Values and passwords are deliberately excluded from the permission binding.
    identity = {k:control.get(k) for k in ('url','tag','role','type','label','text','name','input_id','href','form','form_action','form_method','state_digest','native_validity')}
    return hashlib.sha256(json.dumps(identity,sort_keys=True,separators=(',',':')).encode()).hexdigest()


async def approval_requirement(session, name, arguments, broad_audit=False):
    if session is None or name not in {'browser_interact','browser_interact_batch'}:
        return None
    if name == 'browser_interact_batch':
        from .transactions import validate_batch
        if validate_batch(arguments.get('actions',[]),arguments.get('complete_task',False)):
            return None
    actions = arguments.get('actions',[]) if name == 'browser_interact_batch' else [arguments]
    for index, action in enumerate(actions):
        if not isinstance(action,dict):
            continue
        control = await observe_step(session,action)
        reason = permission_reason(action,control,broad_audit)
        if reason:
            return {'url':control.get('url') or getattr(session,'current_url',''),
                    'label':control.get('label') or control.get('text') or 'Current control',
                    'action':action.get('action'),'reason':reason,'step_index':index,
                    'fingerprint':fingerprint(control),'action_digest':argument_digest(action)}
    return None


def authorized(arguments, control):
    scope = authorized_browser_step.get()
    return bool(scope and scope['action_digest'] == argument_digest(arguments)
                and scope['fingerprint'] == fingerprint(control))


def authorization_scope(name, arguments, requirement):
    action = arguments.get('actions',[])[requirement['step_index']] if name == 'browser_interact_batch' else arguments
    # Nested batch dispatch adds these execution fields. Bind those exact fields.
    if name == 'browser_interact_batch':
        action = {**action,'session_id':arguments['session_id'],'include_frame':False}
    return {'fingerprint':requirement['fingerprint'],'action_digest':argument_digest(action)}


def public_arguments(arguments, requirement=None):
    """Approval UI shows actions without accidentally displaying credential text."""
    preview = copy.deepcopy(arguments)
    def scrub(value):
        if isinstance(value,dict):
            for key in list(value):
                if re.search(r'password|secret|token|credential',key,re.I):
                    value[key] = '[redacted]'
                else:
                    scrub(value[key])
        elif isinstance(value,list):
            for child in value:
                scrub(child)
    scrub(preview)
    if requirement and 'credentials' in requirement.get('reason',''):
        selected = preview.get('actions',[preview])[requirement['step_index']]
        if 'text' in selected:
            selected['text'] = '[redacted]'
    return preview
