"""Preflight and terminal evidence for model-planned, domain-independent batches."""
import copy

from .assertions import BrowserExpectation, normalize_expectation
from ..testing_runtime import action_status

SUPPORTED_BATCH_ACTIONS = frozenset({'click','hover','type','scroll','scroll_to','press_key','navigate','navigate_back','navigate_forward','return_to_parent',
    'select_option','choose_option','choose_date','toggle_checkbox','set_checked','get_theme','assert','switch_tab','switch_frame','handle_dialog'})
BATCH_ACTION_FIELDS = frozenset({'action','checked','expectations','timeout_seconds','purpose',
    'element_id','text','auto_select_suggestion','scroll_y','delta_y','field','key','value','url','option_text','format',
    'target_id','frame_id','dialog_id','accept'})

BENIGN_NO_EFFECT_ACTIONS = frozenset({'scroll', 'scroll_to', 'hover'})


def benign_no_effect(result):
    """A harmless gesture may have no visible delta; it is never an outcome."""
    return (isinstance(result, dict) and result.get('action') in BENIGN_NO_EFFECT_ACTIONS
            and not result.get('error') and not result.get('approval_required')
            and action_status(result) == 'unverified'
            and (result.get('verification') or {}).get('effect_type') == 'no_effect')


def continue_batch_after(result):
    return action_status(result) == 'passed' or benign_no_effect(result)


def editable_control(control):
    if not isinstance(control, dict):
        return False
    tag = str(control.get('tag', '')).lower()
    role = str(control.get('role', '')).lower()
    return (tag == 'textarea' or control.get('contenteditable') is True or
            (tag == 'input' and str(control.get('type') or 'text').lower() in
             {'text', 'search', 'email', 'url', 'tel', 'password', 'number'}) or
            (role == 'textbox' and tag not in {'button', 'a'}))


def compile_batch(actions, controls=()):
    """Remove redundant syntax and focus clicks; never invent targets or values.

    Validate the entire bounded plan before dispatch. The executor observes
    each step and stops at a new page/modal, rather than asking the model to
    repair a long but otherwise valid form-filling plan.
    """
    if not isinstance(actions, list) or not 1 <= len(actions) <= 32:
        return actions
    normalized = copy.deepcopy(actions)
    editable_ids = {c.get('id') for c in controls if editable_control(c)}
    compiled = []
    for index, action in enumerate(normalized):
        if not isinstance(action, dict):
            compiled.append(action)
            continue
        # Descriptions annotate an action; they do not authorize or change it.
        if isinstance(action.get('description'), str):
            action.pop('description')
        if action.get('action') == 'assert' and isinstance(action.get('expectations'), list):
            target = action.pop('element_id', None)
            for spec in action['expectations']:
                if (isinstance(spec, dict) and spec.get('kind') not in {'url', 'title'}
                        and target is not None and 'element_id' not in spec and 'selector' not in spec):
                    spec['element_id'] = target
        following = normalized[index + 1] if index + 1 < len(normalized) else None
        if (action.get('action') == 'click' and not set(action) - {'action', 'element_id'}
                and isinstance(following, dict) and following.get('action') == 'type'
                and type(action.get('element_id')) is int
                and action['element_id'] in editable_ids
                and following.get('element_id') == action['element_id']):
            # Native type focuses and checks the same observed field itself.
            continue
        compiled.append(action)
    return compiled


def scene_changed(result):
    return (result.get('verification') or {}).get('effect_type') in {
        'route_change', 'modal_open', 'modal_close', 'tab_switch', 'frame_switch',
        'native_dialog_handled', 'popup_open', 'history_change', 'parent_restored',
    }


def page_assertion(action):
    return (isinstance(action, dict) and action.get('action') == 'assert'
            and bool(action.get('expectations')) and all(
                isinstance(spec, dict) and spec.get('kind') in {'url', 'title'}
                for spec in action['expectations']))


def validate_batch(actions, complete_task=False, *, max_actions=8):
    if not isinstance(actions,list) or not 1 <= len(actions) <= max_actions:
        return f'This batch exceeds {max_actions} actions. Split it into sequential batches of at most {max_actions}, including assertions. No actions executed.'
    if type(complete_task) is not bool:
        return 'complete_task must be a boolean.'
    navigated = False
    for index,action in enumerate(actions):
        if not isinstance(action, dict):
            return 'Each action must be an object.'
        if action.get('action') not in SUPPORTED_BATCH_ACTIONS:
            return f'Unsupported batch action at index {index}. Use one of: '+', '.join(sorted(SUPPORTED_BATCH_ACTIONS))+'. No actions executed.'
        if set(action)-BATCH_ACTION_FIELDS:
            return f'Unsupported batch fields at index {index}. Target controls using their observed integer element_id; selectors belong only in assertion expectations. No actions executed.'
        if 'element_id' in action and (type(action['element_id']) is not int or action['element_id'] < 0):
            return f'Invalid element_id at index {index}. Copy the current integer tool reference; never a DOM id string. No actions executed.'
        if action['action'] in {'click', 'hover', 'type', 'toggle_checkbox', 'select_option'} and type(action.get('element_id')) is not int:
            return f"{action['action']} requires an observed element_id at index {index}. No actions executed."
        if action['action'] == 'type' and not isinstance(action.get('text'), str):
            return f'type requires explicit text at index {index}. No actions executed.'
        if action['action'] == 'select_option' and not isinstance(action.get('value'), str):
            return f'select_option requires an explicit value at index {index}. No actions executed.'
        if action['action'] == 'press_key' and (not isinstance(action.get('key'), str) or not action['key'].strip()):
            return f'press_key requires an explicit key at index {index}. No actions executed.'
        specs = action.get('expectations')
        if action.get('action') == 'assert' and isinstance(specs, list):
            specs = [normalize_expectation(spec) for spec in specs]
            action['expectations'] = specs
        if navigated and (action.get('element_id') is not None or (
                isinstance(specs,list) and any(isinstance(spec,dict) and spec.get('element_id') is not None for spec in specs))):
            return 'Navigation invalidates element IDs. End the batch with page assertions, then observe fresh controls before further input. No actions executed.'
        if action.get('action') == 'assert':
            try:
                specs = action.get('expectations')
                if not isinstance(specs, list) or not 1 <= len(specs) <= 20:
                    raise ValueError()
                for spec in specs:
                    BrowserExpectation.model_validate(spec)
                if action.get('purpose','checkpoint') not in {'checkpoint','outcome'}:
                    raise ValueError()
                timeout = action.get('timeout_seconds',5)
                if type(timeout) not in {int,float} or not 0 <= timeout <= 30:
                    raise ValueError()
            except (ValueError,TypeError):
                return 'Invalid batch assertion: use kind checked with a boolean, or value/text with a string, and current element_id (not a fabricated CSS #ID). No actions executed.'
        if action.get('action') == 'set_checked' and (type(action.get('element_id')) is not int or type(action.get('checked')) is not bool):
            return 'set_checked requires element_id and a checked boolean. No actions executed.'
        if action.get('action') in {'choose_option','choose_date'}:
            field='option_text' if action['action']=='choose_option' else 'value'
            if type(action.get('element_id')) is not int or not isinstance(action.get(field),str) or not action[field].strip():
                return action['action']+' requires an observed element_id and '+field+'. No actions executed.'
        if action.get('action') == 'navigate':
            if not isinstance(action.get('url'),str) or not action['url'].strip():
                return 'navigate requires an explicit URL. No actions executed.'
            navigated = True
        if action.get('action') in {'navigate_back','navigate_forward','return_to_parent'}:
            navigated = True
        if action.get('action') in {'switch_tab','switch_frame'}:
            field='target_id' if action['action']=='switch_tab' else 'frame_id'
            if not isinstance(action.get(field),str) or not action[field].strip() or 'element_id' in action:
                return f"{action['action']} requires an observed {field} string, never a page element_id. No actions executed."
            navigated = True
        if action.get('action') == 'handle_dialog':
            if not isinstance(action.get('dialog_id'),str) or type(action.get('accept')) is not bool:
                return 'handle_dialog requires the current dialog_id and an accept boolean. No actions executed.'
            navigated = True
    if complete_task and (actions[-1].get('action') != 'assert' or actions[-1].get('purpose') != 'outcome'):
        return 'Completion requires a final explicit purpose=outcome assertion covering the user request. No actions executed.'
    return None


def completion_evidence(actions, results, complete_task):
    return bool(complete_task is True and len(results) == len(actions) and results
                and all(continue_batch_after(r) for r in results)
                and results[-1].get('action') == 'assert' and results[-1].get('purpose') == 'outcome'
                and results[-1].get('assertions')
                and all(a.get('status') == 'passed' for a in results[-1]['assertions']))


def verified_batch_report(result):
    assertions = [check for check in result['results'][-1]['assertions']
                  if check.get('evidence_role') != 'checkpoint']
    lines = [f"Verified {len(assertions)} requested outcome check(s)."]
    for assertion in assertions:
        spec = assertion.get('expectation') or {}
        target = spec.get('selector') or (f"element #{spec['element_id']}" if spec.get('element_id') is not None else spec.get('kind','page'))
        actual = str(assertion.get('actual')).replace('\n',' ')[:300]
        lines.append(f"- {spec.get('kind', 'State')} for {target}: {actual}")
    lines.append('These checks cover the stated expectations; they do not establish exhaustive website coverage.')
    return '\n\n'.join([lines[0], '\n'.join(lines[1:-1]), lines[-1]])
