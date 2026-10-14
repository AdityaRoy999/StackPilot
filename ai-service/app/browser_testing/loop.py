"""State-sensitive loop checks: reading and legitimate repeated steps stay possible."""
import hashlib
import json

READ_TOOLS = {'browser_observe', 'browser_get_page_state', 'browser_assert', 'browser_inspect_console','browser_read_editor','browser_campaign_status'}


def browser_call_signature(name, arguments, session):
    signature = name + ':' + json.dumps(arguments, sort_keys=True)
    if name in READ_TOOLS:
        return None
    controls = [{k: el.get(k) for k in ('id','text','value','checked','disabled','expanded','selected','pressed',
                 'invalid','required','readonly','overlay_id','is_inside_modal','is_in_viewport','is_occluded','box')}
                for el in getattr(session, 'interactive_elements', [])]
    dialog = getattr(session, 'native_dialog', None) or {}
    state = [getattr(session, 'target_id', None), getattr(session, '_selected_frame', None),
             getattr(session, '_navigation_generation', None), getattr(session, 'current_url', ''),
             getattr(session, 'page_title', ''), getattr(session, 'scroll_y', 0),
             {k:dialog.get(k) for k in ('id','dialog_id','type')}, controls]
    return signature + ':' + hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()[:16]


class BrowserReadProgress:
    """Allow fresh reads and one pagination pass; bound cycles on unchanged UI."""
    def __init__(self):
        self.state = None
        self.seen = {}
        self.duplicates = 0
        self.rejections = 0

    def refresh(self, session):
        signature = browser_call_signature('_read_progress', {}, session)
        if signature != self.state:
            self.state = signature
            self.seen.clear()
            self.duplicates = self.rejections = 0

    @property
    def stalled(self):
        return self.duplicates >= 3

    @staticmethod
    def key(arguments):
        return (arguments.get('offset', 0), arguments.get('scope', 'page'),
                str(arguments.get('query') or '').strip().casefold())

    def record(self, session, arguments, result):
        self.refresh(session)
        if result.get('status') not in {'observed','unverified'}:
            return
        key = self.key(arguments)
        if key in self.seen:
            self.duplicates += 1
        self.seen[key] = True
        if len(self.seen) > 256:
            self.seen.pop(next(iter(self.seen)))
        if self.stalled:
            result['recovery_hint'] = ('Repeated observations produced no new usable evidence. Preserve the task and use a '
                'specific query with scope=viewport or overlay, act on a current control, wait for an '
                'expected UI change with browser_assert, or ask for an essential missing input. Do not restart pagination.')

    def reject(self, session, arguments):
        self.refresh(session)
        if not self.stalled or self.key(arguments) not in self.seen:
            return None
        self.rejections += 1
        return {'status': 'blocked', 'action': 'observe', 'dispatch_state': 'not_dispatched',
                'error': 'Repeated observation of the same controls made no progress. No duplicate scan executed.',
                'recovery': {'reason': 'observation_cycle',
                    'hint': 'Use a specific query for a current workflow control, restore a dismissed workflow, '
                            'wait for an expected state change, or request a required input. Do not rescan footer links.'}}
