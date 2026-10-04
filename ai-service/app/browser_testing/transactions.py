"""Preflight and terminal evidence for model-planned, domain-independent batches."""
from .assertions import BrowserExpectation
from ..testing_runtime import action_status

SUPPORTED_BATCH_ACTIONS = frozenset({'click','hover','type','scroll','scroll_to','press_key','navigate',
    'select_option','toggle_checkbox','set_checked','get_theme','assert'})
BATCH_ACTION_FIELDS = frozenset({'action','checked','expectations','timeout_seconds','purpose',
    'element_id','text','auto_select_suggestion','scroll_y','delta_y','field','key','value','url'})


def validate_batch(actions, complete_task=False):
    if not isinstance(actions,list) or not 1 <= len(actions) <= 8:
        return 'Provide 1–8 actions per bounded batch. No actions executed.'
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
        specs = action.get('expectations')
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
        if action.get('action') == 'navigate':
            if not isinstance(action.get('url'),str) or not action['url'].strip():
                return 'navigate requires an explicit URL. No actions executed.'
            navigated = True
    if complete_task and (actions[-1].get('action') != 'assert' or actions[-1].get('purpose') != 'outcome'):
        return 'Completion requires a final explicit purpose=outcome assertion covering the user request. No actions executed.'
    return None


def completion_evidence(actions, results, complete_task):
    return bool(complete_task is True and len(results) == len(actions) and results
                and all(action_status(r) == 'passed' for r in results)
                and results[-1].get('action') == 'assert' and results[-1].get('purpose') == 'outcome'
                and results[-1].get('assertions')
                and all(a.get('status') == 'passed' for a in results[-1]['assertions']))


def verified_batch_report(result):
    assertions = result['results'][-1]['assertions']
    lines = [f"Verified {len(assertions)} requested outcome check(s)."]
    for assertion in assertions:
        spec = assertion.get('expectation') or {}
        target = spec.get('selector') or (f"element #{spec['element_id']}" if spec.get('element_id') is not None else spec.get('kind','page'))
        actual = str(assertion.get('actual')).replace('\n',' ')[:300]
        lines.append(f"- {spec.get('kind', 'State')} for {target}: {actual}")
    lines.append('These checks cover the stated expectations; they do not establish exhaustive website coverage.')
    return '\n\n'.join([lines[0], '\n'.join(lines[1:-1]), lines[-1]])
