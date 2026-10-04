"""State-sensitive loop checks: reading and legitimate repeated steps stay possible."""
import hashlib
import json

READ_TOOLS = {'browser_observe', 'browser_get_page_state', 'browser_assert', 'browser_inspect_console'}


def browser_call_signature(name, arguments, session):
    signature = name + ':' + json.dumps(arguments, sort_keys=True)
    if name in READ_TOOLS:
        return None
    controls = [{k: el.get(k) for k in ('id','value','checked','disabled','expanded','is_in_viewport','is_occluded','box')}
                for el in getattr(session, 'interactive_elements', [])]
    state = [getattr(session, 'current_url', ''), getattr(session, 'scroll_y', 0), controls]
    return signature + ':' + hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()[:16]
