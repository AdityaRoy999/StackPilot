"""Keep scenario evidence available after old DOM/tool messages are compacted."""
import json


def browser_progress_summary(cases, coverage=None):
    completed, blocked = {}, {}
    for case in cases:
        result = case.get('result') or {}
        if not isinstance(result, dict):
            continue
        url = case.get('url') or result.get('url') or ''
        steps = result.get('results') or [result]
        for step in steps:
            if not isinstance(step, dict):
                continue
            action = step.get('action') or case.get('action')
            target = step.get('target') or case.get('label') or ''
            checks = step.get('assertions') or []
            for check in checks:
                if check.get('status') != 'passed':
                    continue
                spec = check.get('expectation') or {}
                record = {'url': url, 'expectation': spec}
                completed[json.dumps(record, sort_keys=True)] = record
            effect = (step.get('verification') or {}).get('effect_type')
            if step.get('status') == 'passed' and action not in {'assert','type','hover','scroll','scroll_to'}:
                record = {'url': url, 'action': action, 'target': target, 'observed_effect': effect,
                          'scope': 'UI mechanics; business outcome requires its own assertion'}
                completed[json.dumps([url, action, target, effect])] = record
            reason = (step.get('recovery') or {}).get('reason')
            if step.get('error') or reason:
                record = {'url': url, 'action': action, 'target': target,
                          'reason': reason or str(step.get('error'))[:220]}
                blocked[json.dumps([url, action, target, record['reason']])] = record
    # Include every unique case up to the normal run budget, rather than only
    # the last turn. Never call this a passed audit or omit outstanding gaps.
    from .coverage import coverage_obligations
    return {'instruction': 'Reuse recorded evidence. Do not rerun completed checks or unchanged blocked operations. Test remaining gaps; restore state when needed.',
            'completed_checks': list(completed.values())[-160:],
            'blocked_operations': list(blocked.values())[-40:],
            'remaining_review': coverage_obligations(coverage)}
