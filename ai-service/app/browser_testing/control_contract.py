"""Ground input operations in the current control's observed native semantics.

This is a bounded compiler, not an autonomous form filler: it never invents a
choice and it never converts a partial label into a selection. The executor
still rechecks the live target and option before changing it.
"""
from __future__ import annotations

import re


def _normalized_label(value):
    return re.sub(r'\s+', ' ', str(value or '')).strip().casefold()


def native_select(control):
    return isinstance(control, dict) and str(control.get('tag', '')).lower() == 'select'


def exact_native_option(control, requested):
    """Resolve one enabled observed option; duplicates/disabled choices abstain."""
    if not native_select(control) or not isinstance(requested, str):
        return None
    options = control.get('options')
    if not isinstance(options, list):
        return None
    matches = [option for option in options if isinstance(option, dict)
               and isinstance(option.get('value'), str)
               and (option['value'] == requested or
                    _normalized_label(option.get('text')) == _normalized_label(requested))]
    if len(matches) != 1 or matches[0].get('disabled'):
        return None
    return matches[0]


def _target(arguments, controls):
    ref = arguments.get('element_id')
    if type(ref) is not int:
        return None
    return next((control for control in controls
                 if isinstance(control, dict) and control.get('id') == ref), None)


def normalize_control_action(arguments, controls=()):
    """Repair a wrong text/widget operation only for an exact observed SELECT.

    Preserve the caller's dictionary and unknown fields so normal validation can
    reject them. A missing/ambiguous observation always needs a fresh decision.
    """
    if not isinstance(arguments, dict) or arguments.get('action') not in {'type', 'choose_option'}:
        return arguments
    control = _target(arguments, controls)
    if not native_select(control) or control.get('multiple') or control.get('type') == 'select-multiple':
        return arguments
    requested = arguments.get('option_text') if arguments['action'] == 'choose_option' else arguments.get('text')
    choice = exact_native_option(control, requested)
    if choice is None or control.get('disabled'):
        return arguments
    normalized = {key: value for key, value in arguments.items()
                  if key not in {'text', 'option_text', 'auto_select_suggestion', 'field', 'target'}}
    return {**normalized, 'action': 'select_option', 'value': choice['value']}


def control_contract_result(arguments, controls=()):
    """Give a failed planner an actionable observation instead of an opaque error."""
    if not isinstance(arguments, dict) or arguments.get('action') not in {'type', 'choose_option', 'select_option'}:
        return None
    control = _target(arguments, controls)
    if (arguments.get('action') == 'type' and isinstance(control, dict) and control.get('tag') == 'input'
            and control.get('type') in {'checkbox', 'radio', 'file', 'range'}):
        expected = {'checkbox':'set_checked', 'radio':'set_checked', 'file':'upload', 'range':'press_key'}[control['type']]
        return {'status':'failed', 'action':'type',
                'error':'This '+control['type']+' control does not accept text input. Use its native '+expected+' operation with an explicit requested state; no input was dispatched.',
                'recovery':{'reason':'control_action_mismatch','expected_action':expected,'element_id':control['id']},
                'verification':{'verified':False,'effect_type':'not_dispatched'}}
    if not native_select(control):
        return None
    action = arguments['action']
    if action == 'select_option':
        # The live executor checks options, including ones beyond the bounded
        # cached observation. Do not reject a valid explicit value here.
        return None
    return {'status': 'failed', 'action': action,
            'error': 'This is a native select, not a text input. Use select_option with one exact observed option value; no input was dispatched.',
            'recovery': {'reason': 'control_action_mismatch', 'expected_action': 'select_option',
                         'element_id': control['id'], 'multiple': bool(control.get('multiple') or control.get('type') == 'select-multiple'),
                         'options': [{key: option.get(key) for key in ('text', 'value', 'disabled', 'selected')}
                                     for option in (control.get('options') or [])[:60] if isinstance(option, dict)]},
            'verification': {'verified': False, 'effect_type': 'not_dispatched'}}
