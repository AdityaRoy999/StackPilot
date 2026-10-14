"""Verified browser history and bounded restoration of an observed parent.

History movement is a different operation from closing a detail view. Never
report success because a destination merely contains the parent's URL.
"""
import asyncio
import time
from urllib.parse import urljoin, urlsplit


def display_url(url):
    from ..browser_driver import to_frontend_display_url
    return to_frontend_display_url(url)


def allowed_destination(session, url):
    from .site_audit import risky_label
    parsed = urlsplit(display_url(url))
    return (parsed.scheme in {'http', 'https'} and not parsed.username and not parsed.password
            and not risky_label('', url) and session.is_url_in_target_domain(display_url(url)))


async def history_state(session):
    state = await session.send_command('Page.getNavigationHistory', {})
    if not isinstance(state, dict) or not isinstance(state.get('entries'), list):
        raise RuntimeError('Browser history could not be observed')
    return state


def history_verification(action, expected, actual, verified, method='history_entry'):
    return {'verified': verified, 'action': action,
            'effect_type': 'history_change' if verified else 'no_effect',
            'description': ('Reached the exact observed browser history entry.' if verified else
                            'The requested browser history entry was not reached.'),
            'method': method, 'expected_url': expected, 'actual_url': actual}


async def move_history(session, direction, *, entry_id=None, timeout=2.5):
    action = 'navigate_back' if direction < 0 else 'navigate_forward'
    if getattr(session, '_selected_frame', None):
        return {'status':'blocked','action':action,'dispatch_state':'not_dispatched',
                'error':'Select the main browser frame before moving top-level browser history.'}
    before = await history_state(session)
    entries, index = before['entries'], before.get('currentIndex', -1)
    target_index = next((i for i, entry in enumerate(entries) if entry['id'] == entry_id), -1) if entry_id is not None else index + direction
    if not 0 <= target_index < len(entries) or target_index == index:
        return {'status': 'unverified', 'action': action, 'dispatch_state': 'not_dispatched',
                'error': 'No eligible browser history entry in that direction.',
                'recovery': {'reason': 'history_boundary', 'hint': 'Use an observed parent link or return_to_parent; do not repeat history movement.'}}
    target = entries[target_index]
    expected = display_url(target['url'])
    if not allowed_destination(session, expected):
        return {'status': 'blocked', 'action': action, 'dispatch_state': 'not_dispatched',
                'error': 'The history destination is outside the authorized navigation scope or may change account state.'}
    session._notify_listeners({'type': 'action', 'action': action, 'url': expected})
    await session.send_command('Page.navigateToHistoryEntry', {'entryId': target['id']})
    deadline = time.monotonic() + timeout
    matched = False
    while time.monotonic() < deadline:
        if getattr(session, 'native_dialog', None):
            break
        try:
            current = await history_state(session)
            current_index = current.get('currentIndex', -1)
            active = current['entries'][current_index] if 0 <= current_index < len(current['entries']) else {}
            actual = display_url(await session.evaluate('location.href'))
            matched = active.get('id') == target['id'] and actual == expected
            if matched:
                break
        except Exception:
            pass  # Document contexts can be briefly unavailable during a transition.
        await asyncio.sleep(.05)
    if not getattr(session, 'native_dialog', None):
        await session.wait_for_quiescence(network_idle_ms=80, dom_quiet_ms=40, max_timeout_s=.6)
        await session.extract_interactive_tree()
        actual = display_url(await session.evaluate('location.href'))
        matched = matched and actual == expected
    else:
        actual = session.current_url
        matched = False
    verification = history_verification(action, expected, actual, matched)
    session.last_action_verification = verification
    if matched and getattr(session, 'pda', None):
        # Reconcile with an existing ancestor; history forward will be observed
        # afresh. Do not blindly pop one frame or grow a stack of history visits.
        pda = session.pda
        matches = [i for i, frame in enumerate(pda.stack) if frame.url == actual]
        if matches:
            pda.stack = pda.stack[:matches[-1] + 1]
    return {'status': 'passed' if matched else 'unverified', 'action': action,
            'url': actual, 'verification': verification,
            'history_entry_id': target['id'], 'dispatch_state': 'dispatched'}


def parent_controls_match(expected, actual):
    required = [c for c in expected if c.get('global') or c.get('input_id') or c.get('card_context')]
    required = required or expected
    def identity(control):
        return tuple(str((control.get('label') or control.get('text') or '') if key == 'label' else control.get(key) or '')
                     for key in ('tag','label','href','name','input_id','type','card_context'))
    observed = {identity(c) for c in actual}
    return bool(required) and all(identity(c) in observed for c in required)


async def wait_for_parent(session, expected, controls=None, timeout=2):
    deadline = time.monotonic()+timeout
    while True:
        if getattr(session,'native_dialog',None):
            return False
        try:
            await session.extract_interactive_tree()
            if display_url(await session.evaluate('location.href')) == expected and (
                    controls is None or parent_controls_match(controls, session.interactive_elements)):
                return True
        except Exception:
            pass
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(.05)


async def restore_parent(session, parent_url, *, history_entry_id=None, expected_controls=None):
    """Close an observed detail, try exact history, then verify direct recovery."""
    from .permissions import observe_step, permission_reason
    from .widgets import observe_widgets
    expected = display_url(parent_url)
    if not allowed_destination(session, expected):
        return {'success': False, 'reason': 'Parent is outside the authorized navigation scope.'}
    if getattr(session, 'native_dialog', None):
        return {'success': False, 'reason': 'Resolve the observed native dialog before returning.'}
    if getattr(session, '_selected_frame', None):
        return {'success':False,'reason':'Select the main browser frame before restoring its parent.'}
    await session.extract_interactive_tree()
    overlay = (await observe_widgets(session)).get('active_overlay')
    if overlay:
        if not await session.dismiss_active_modal():
            return {'success': False, 'method': 'modal_requires_observed_step',
                    'reason': 'The detail overlay has no unique harmless close control; inspect its current choices.'}
        if await wait_for_parent(session, expected, expected_controls):
            return {'success': True, 'tier': 1, 'method': 'modal_dismiss', 'target_url': expected}
    state = await history_state(session)
    index = state.get('currentIndex', -1)
    candidates = [entry for entry in state['entries'][:max(index, 0)] if display_url(entry['url']) == expected]
    target = next((entry for entry in candidates if entry['id'] == history_entry_id), None) if history_entry_id is not None else (candidates[-1] if candidates else None)
    if target:
        moved = await move_history(session, -1, entry_id=target['id'])
        if moved['status'] == 'passed' and await wait_for_parent(session, expected, expected_controls):
            return {'success': True, 'tier': 2, 'method': 'history_entry', 'target_url': expected}
    # A SPA detail can keep the same URL and provide only a Back control.
    import re
    controls = getattr(session, 'interactive_elements', [])
    candidates = [control for control in controls if not control.get('disabled') and
                  (control.get('href') and display_url(urljoin(session.current_url, control['href'])) == expected or
                   re.fullmatch(r'(?:back|go back|back to .+|return to .+)', control.get('text', ''), re.I))]
    if len(candidates) == 1:
        arguments = {'action': 'click', 'element_id': candidates[0]['id']}
        control = await observe_step(session, arguments)
        if control and not permission_reason(arguments, control):
            await session.click_element(candidates[0]['id'], label=candidates[0].get('text', 'Return'))
            await session.extract_interactive_tree()
            if await wait_for_parent(session, expected, expected_controls):
                return {'success': True, 'tier': 3, 'method': 'observed_parent_control', 'target_url': expected}
    # A matching URL alone cannot clear a same-URL detail view. Force a fresh
    # document for this final recovery, rather than navigate()'s no-op shortcut.
    if any(c.get('tag') in {'input','textarea'} and c.get('value') and not c.get('readonly')
           and c.get('type') not in {'checkbox','radio','hidden','submit','button'} for c in controls):
        return {'success':False,'method':'unsaved_input_requires_review',
                'reason':'Direct reload would discard populated inputs. Use an observed navigation control or reconcile this draft first.'}
    await session.navigate(expected, force=True)
    actual = display_url(await session.evaluate('location.href'))
    verified = await wait_for_parent(session, expected, expected_controls)
    return {'success': verified, 'tier': 4, 'method': 'direct_navigation',
            'target_url': expected, 'actual_url': actual}
