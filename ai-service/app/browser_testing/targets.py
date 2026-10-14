"""Reacquire an observed control after a same-page rerender without guessing a new target."""
from __future__ import annotations

import re
from typing import Any


TARGET_FIELDS = ('tag', 'role', 'text', 'name', 'input_id', 'placeholder',
                 'href', 'form_id', 'card_context', 'type', 'editor_kind', 'is_inside_modal', 'overlay_id')


def _norm(value: Any) -> str:
    return re.sub(r'\s+', ' ', str(value or '')).strip().casefold()


def remember_targets(session: Any) -> None:
    """Keep bounded descriptors only for the current document and selected frame."""
    cache = getattr(session, 'observed_targets', None)
    if cache is None:
        cache = session.observed_targets = {}
    identity = (getattr(session, 'target_id', None), getattr(session, 'current_url', ''),
                getattr(session, '_navigation_generation', None),
                getattr(session, '_selected_frame', None))
    for item in getattr(session, 'interactive_elements', ()):
        ref = item.get('id')
        if type(ref) is int:
            cache[ref] = (identity, {key: item.get(key) for key in TARGET_FIELDS})
    if len(cache) > 1200:
        for ref in list(cache)[:len(cache) - 1200]:
            cache.pop(ref, None)


def _matches(previous: dict, current: dict) -> bool:
    if _norm(previous.get('tag')) != _norm(current.get('tag')):
        return False
    if previous.get('role') and _norm(previous['role']) != _norm(current.get('role')):
        return False
    for kind in ('type', 'editor_kind'):
        if previous.get(kind) and _norm(previous[kind]) != _norm(current.get(kind)):
            return False
    if previous.get('is_inside_modal') and not current.get('is_inside_modal'):
        return False
    if previous.get('overlay_id') is not None and previous['overlay_id'] != current.get('overlay_id'):
        return False
    for context in ('form_id', 'card_context'):
        if previous.get(context) and _norm(previous[context]) != _norm(current.get(context)):
            return False
    # Stable identifiers outrank text, which can change after localization or
    # asynchronous loading. Each branch still requires a unique current match.
    for key in ('input_id', 'name', 'href', 'placeholder'):
        if previous.get(key):
            return _norm(previous[key]) == _norm(current.get(key))
    return bool(previous.get('text') and _norm(previous['text']) == _norm(current.get('text')))


async def resolve_target_reference(session: Any, ref: int) -> dict:
    """Return a current ID or a non-dispatch result; never cross a route/frame."""
    current = next((item for item in getattr(session, 'interactive_elements', ())
                    if item.get('id') == ref), None)
    cache = getattr(session, 'observed_targets', {})
    saved = cache.get(ref)
    current_identity = (getattr(session, 'target_id', None), getattr(session, 'current_url', ''),
                        getattr(session, '_navigation_generation', None),
                        getattr(session, '_selected_frame', None))
    if saved and saved[0] != current_identity:
        return {'status': 'stale_element', 'error':
                'The page or frame changed after this control was observed. Observe again; no input was dispatched.'}
    if current is not None:
        try:
            connected = await session.evaluate(
                f"Boolean(window.__spFast?.nodes.get({int(ref)})?.isConnected)")
        except Exception:
            return {'status': 'stale_element', 'error':
                    'Current control connectivity could not be verified. Observe again; no input was dispatched.'}
        if connected is True:
            return {'status': 'ready', 'element_id': ref, 'rebound': False}
    if not saved:
        return {'status': 'stale_element', 'error':
                'The observed control is no longer current. Observe the page again; no input was dispatched.'}
    original_identity, descriptor = saved
    try:
        observation = await session.extract_interactive_tree()
        if isinstance(observation, dict) and observation.get('fresh') is False:
            return {'status': 'stale_element', 'error':
                    'A fresh observation was unavailable after the control changed. No input was dispatched.'}
    except Exception:
        return {'status': 'stale_element', 'error':
                'The control was replaced and a fresh observation was unavailable. No input was dispatched.'}
    if (getattr(session, 'target_id', None), getattr(session, 'current_url', ''),
            getattr(session, '_navigation_generation', None),
            getattr(session, '_selected_frame', None)) != original_identity:
        return {'status': 'stale_element', 'error':
                'The page changed while reacquiring the control. Observe again; no input was dispatched.'}
    matches = [item for item in session.interactive_elements if _matches(descriptor, item)]
    if len(matches) != 1:
        return {'status': 'stale_element',
                'error': ('The replaced control has no unique current match. '
                          'Observe and choose the intended control; no input was dispatched.'),
                'candidate_count': len(matches)}
    return {'status': 'ready', 'element_id': matches[0]['id'], 'rebound': True,
            'previous_element_id': ref}
