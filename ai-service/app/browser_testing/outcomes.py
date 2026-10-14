"""Keep unchanged UI markers from becoming proof of an action's outcome.

Checks still pass when their observation matches. Only their evidence role changes;
the planner must verify the requested result instead of lowering the success bar.
This is a bounded evidence guard, not a claim of universal goal understanding.
"""
from __future__ import annotations

import re


def _text(value):
    return " ".join(str(value or "").split()).casefold()


def _matches(actual, spec):
    expected = _text(spec.get('expected'))
    return bool(expected and (expected in _text(actual) if spec.get('match') == 'contains'
                              else expected == _text(actual)))


class BrowserOutcomeGuard:
    def __init__(self, goal: str, broad: bool = False):
        self.goal, self.broad = goal, broad
        self.controls = {}
        self.page = None
        self.reasons = []
        # Explicit observation requests may legitimately check unchanged state.
        self.observation_only = bool(re.match(r'^\s*(?:verify|check|assert|confirm|read|inspect|get|show|what|is|does)\b', goal, re.I)
            and not re.search(r'\b(?:click|open|navigate|go\s+to|enter|type|fill|set|change|toggle|send|submit|book|reserve|purchase|buy|delete|move|search|find|log\s*in|sign\s*in|authenticat\w*)\b', goal, re.I))

    def observe(self, controls, url='', title=''):
        if self.page is None:
            self.page = {'url': url, 'title': title}
        for control in controls or ():
            if not isinstance(control, dict) or control.get('role') in {'heading', 'status', 'alert'}:
                continue
            # Store label/visibility metadata only, never entered field values.
            before = {key: control.get(key) for key in ('text', 'aria_label', 'label', 'is_in_viewport')}
            keys = []
            if control.get('id') is not None:
                keys.append(('id', str(control['id'])))
            if re.fullmatch(r'[A-Za-z_][\w-]*', str(control.get('input_id') or '')):
                selector_key = ('selector', '#' + control['input_id'])
                before = self.controls.get(selector_key, before)
                keys.append(selector_key)
            for key in keys:
                if len(self.controls) < 800:
                    self.controls.setdefault(key, before)

    def checkpoint_reason(self, spec):
        kind = spec.get('kind')
        properties = {'title': r'\btitle\b', 'url': r'\b(url|address)\b',
                      'text': r'\b(text|label|caption)\b', 'accessible_name': r'\b(name|label|caption)\b',
                      'visible': r'\b(visible|visibility|exists|present)\b',
                      'in_viewport': r'\b(viewport|on\s*screen|in\s+view)\b'}
        if self.observation_only and kind in properties and re.search(properties[kind], self.goal, re.I):
            return ''
        if kind in {'url', 'title'} and self.page and _matches(self.page.get(kind), spec):
            return 'An unchanged page marker does not verify the requested action.'
        if kind == 'focused' and not re.search(r'\bfocus\b', self.goal, re.I):
            return 'Keyboard focus is an intermediate checkpoint, not the requested result.'
        key = (('id', str(spec['element_id'])) if spec.get('element_id') is not None
               else ('selector', spec.get('selector')))
        before = self.controls.get(key)
        if kind in {'text', 'accessible_name'}:
            candidates = [before] if before else list(self.controls.values())
            # Whole-page text containing a known button caption has the same flaw.
            # Unknown CSS aliases still cannot turn a known unchanged caption
            # into navigation/transaction proof. Assert the destination state.
            if any(_matches(control.get(field), spec) for control in candidates
                   for field in ('text', 'aria_label', 'label')):
                return 'An unchanged control label is a checkpoint. Verify the destination, response or requested state instead.'
        if before and (kind == 'visible' or (kind == 'in_viewport' and before.get('is_in_viewport') is True)):
            return 'The existing control remaining visible does not prove that its action succeeded.'
        return ''

    def assertion_result(self, result, expectations=()):
        if not isinstance(result, dict) or result.get('purpose') != 'outcome':
            return result
        if result.get('requested_purpose') == 'outcome' and all(
                'evidence_role' in check for check in result.get('assertions') or ()):
            return result
        checks = []
        rejected = []
        for index, check in enumerate(result.get('assertions') or ()):
            spec = check.get('expectation') or (expectations[index] if index < len(expectations) else {})
            reason = self.checkpoint_reason(spec)
            checks.append({**check, 'expectation': spec,
                           'evidence_role': 'checkpoint' if reason else 'outcome',
                           **({'completion_reason': reason} if reason else {})})
            if reason and check.get('status') == 'passed':
                rejected.append(reason)
        if not rejected:
            return {**result, 'assertions': checks}
        for reason in rejected:
            if reason not in self.reasons:
                self.reasons.append(reason)
        outcome = any(check.get('evidence_role') == 'outcome' for check in checks)
        return {**result, 'assertions': checks, 'purpose': 'outcome' if outcome else 'checkpoint',
                'requested_purpose': 'outcome', 'completion_reason': ' '.join(dict.fromkeys(rejected)),
                'hint': ' '.join(filter(None, (result.get('hint'), *dict.fromkeys(rejected))))}

    def tool_result(self, tool, arguments, result):
        if tool == 'browser_assert':
            return self.assertion_result(result, arguments.get('expectations') or ())
        if tool != 'browser_interact_batch' or not isinstance(result, dict):
            return result
        actions = arguments.get('actions') or ()
        steps = [self.assertion_result(step, (actions[index].get('expectations') or ()) if index < len(actions) else ())
                 if step.get('action') == 'assert' else step
                 for index, step in enumerate(result.get('results') or ())]
        from .transactions import completion_evidence
        complete = bool(not self.broad and result.get('completion_verified') is True
                        and completion_evidence(actions, steps, arguments.get('complete_task', False)))
        reason = ('A batch of checks does not complete a website audit. Continue the coverage plan.'
                  if self.broad and arguments.get('complete_task') else
                  next((step['completion_reason'] for step in reversed(steps) if step.get('completion_reason')), ''))
        return {**result, 'results': steps, 'completion_verified': complete,
                **({'completion_reason': reason} if reason else {})}


def outcome_guard_for(session):
    context = getattr(session, 'task_context', None) or {}
    if not context.get('goal'):
        return None
    guard = getattr(session, 'outcome_guard', None)
    if guard is None or guard.goal != context['goal']:
        from .intent import is_broad_browser_goal
        guard = BrowserOutcomeGuard(context['goal'], is_broad_browser_goal(context['goal']))
        session.outcome_guard = guard
        guard.observe(getattr(session, 'interactive_elements', ()),
                      getattr(session, 'current_url', ''), getattr(session, 'page_title', ''))
    return guard
