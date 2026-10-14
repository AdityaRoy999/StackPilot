"""Task scope and at-most-once dispatch for consequential browser operations."""
import hashlib
import json

from .permissions import CRITICAL, readonly_query, authorized


def consequential(action, control):
    kind = action.get('action')
    if not control or kind not in {'click','double_click','press_key'}:
        return False
    if kind == 'press_key' and str(action.get('key') or 'Enter').lower() not in {'enter','return','space',' '}:
        return False
    label = str(control.get('label') or control.get('text') or '')
    return bool(CRITICAL.search(label+' '+str(control.get('href') or '')) or
                control.get('form') and (kind == 'press_key' or control.get('type') in {'submit','image'}) and not readonly_query(control))


def dispatch_key(session, action, control):
    # Form values and changing button labels must not turn a failed assertion
    # into permission to replay the same send. Separate cards remain distinct.
    target = control.get('submit_control') or control if action.get('action') == 'press_key' and control.get('form') else control
    identity = {key: target.get(key) for key in ('tag','role','name','input_id','href')}
    identity.update({key:control.get(key) for key in ('url','form_id','form_action')})
    # A field's own heading may differ from its submit button's heading; the
    # observed form identity is the common scope for implicit and explicit send.
    identity['card_context'] = None if control.get('form') else control.get('card_context')
    if not control.get('form'):
        identity['label'] = control.get('label') or control.get('text')
    context = getattr(session, 'task_context', None) or {}
    return hashlib.sha256(json.dumps([context.get('goal',''), getattr(session,'target_id',None),
        getattr(session,'_selected_frame',None), identity], sort_keys=True).encode()).hexdigest()


def preflight_submission(session, arguments, control):
    if not consequential(arguments, control):
        return None, None
    key = dispatch_key(session, arguments, control)
    recorded = getattr(session, 'completed_consequential_inputs', {})
    if key in recorded and not authorized(arguments, control):
        return {'status':'blocked', 'action':arguments.get('action'), 'dispatch_state':'not_dispatched',
                'error':'This consequential operation was already dispatched in this task. Inspect its feedback; a failed assertion or refilled form cannot trigger another submission.',
                'verification':{'verified':False, 'effect_type':'replay_prevented'},
                'recovery':{'reason':'submission_already_dispatched', 'requires_reconciliation':True}}, None
    goal = (getattr(session, 'task_context', None) or {}).get('goal', '')
    if getattr(session, 'audit_read_only', False) and not authorized(arguments, control):
        from .obligations import explicit_workflow, _matches_workflow
        workflow = explicit_workflow(goal)
        # Enter in a field invokes the form's observed default submit control.
        # Match task scope against that control, while approval stays bound to
        # the actual focused field and its current form state.
        target = control.get('submit_control') or control if arguments.get('action') == 'press_key' else control
        if workflow is None or not _matches_workflow(target, workflow):
            return {'status':'blocked', 'action':arguments.get('action'), 'dispatch_state':'not_dispatched',
                    'error':'A general site test does not include sending data or changing account/server state.',
                    'recovery':{'reason':'outside_test_scope', 'hint':'Continue navigation and unsent validation. Record this submission as an untested business scenario.'}}, None
    return None, key
