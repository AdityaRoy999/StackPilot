"""Separate browser input dispatch from observed checkpoints and task outcomes."""
from __future__ import annotations

from typing import Any


def classify_browser_result(tool: str, result: Any, dispatched_inputs: int | None = None,
                            command_id: str | None = None) -> dict:
    if not isinstance(result, dict):
        return {'dispatch_state': 'unknown', 'verification_state': 'unverified'}
    status = result.get('status')
    native_selection = result.get('verification') or {}
    read_only = tool in {'browser_assert', 'browser_observe', 'browser_get_page_state'}
    if read_only:
        dispatch = 'read_only'
    elif dispatched_inputs is not None and dispatched_inputs > 0:
        dispatch = 'dispatched'
    elif native_selection.get('control_kind') == 'native_select' and type(native_selection.get('changed')) is bool:
        # Native select transactions dispatch input/change browser events via
        # the typed widget executor, so no CDP Input.* command is counted.
        # A later framework revert still means the original event was sent.
        dispatch = 'dispatched' if native_selection['changed'] else 'not_dispatched'
    elif result.get('already_satisfied') and (result.get('verification') or {}).get('effect_type')=='value_already_set':
        dispatch = 'not_dispatched'
    elif (result.get('approval_required') or status in {'blocked', 'stale_element', 'requires_approval'}
          or (result.get('verification') or {}).get('effect_type') == 'dispatch_failed'
          or (result.get('recovery') or {}).get('reason') in {'disabled', 'hidden', 'occluded', 'stale_element', 'outside_viewport'}
          or 'no input was dispatched' in str(result.get('error', '')).lower()
          or 'no input dispatched' in str(result.get('error', '')).lower()):
        dispatch = 'not_dispatched'
    else:
        # A timeout or failed acknowledgment is not proof that the site did
        # not receive input. Never invite an automatic replay from this state.
        dispatch = 'unknown'
    if result.get('completion_verified') is True or (
        tool == 'browser_assert' and result.get('purpose') == 'outcome' and status == 'passed'
    ):
        verification = 'outcome_passed'
    elif status == 'passed':
        verification = 'checkpoint_passed'
    elif status in {'failed', 'error'}:
        verification = 'failed'
    elif status in {'blocked', 'needs_information', 'requires_approval'}:
        verification = 'blocked'
    else:
        verification = 'unverified'
    classified = {'dispatch_state': dispatch, 'verification_state': verification}
    if command_id:
        classified['command_id'] = command_id
    return classified
