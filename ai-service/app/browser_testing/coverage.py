"""Reconcile specific scenario evidence with discovery's remaining review ledger."""


def reconcile_native_validation(coverage, result, current_url, controls):
    if not isinstance(coverage,dict) or not isinstance(result,dict):
        return
    assertions = list(result.get('assertions') or [])
    for step in result.get('results') or []:
        assertions.extend(step.get('assertions') or [])
    for assertion in assertions:
        spec = assertion.get('expectation') or {}
        if assertion.get('status')!='passed' or spec.get('kind')!='validity' or type(spec.get('expected')) is not bool:
            continue
        control = next((c for c in controls if c.get('id')==spec.get('element_id')),None)
        if control is None:
            continue  # Selector checks or superseded references need explicit identity evidence.
        names = {str(control.get(k) or '').strip().casefold()
                 for k in ('label','text','aria_label','name','placeholder','input_id')}
        names.discard('')
        matches = [r for r in coverage.get('controls_requiring_review',[])
                   if r.get('url')==current_url and str(r.get('label') or '').strip().casefold() in names
                   and r.get('tag',control.get('tag')) in {'input','textarea','select'}
                   and (not r.get('name') or r['name']==control.get('name'))
                   and (not r.get('input_id') or r['input_id']==control.get('input_id'))]
        if len(matches)!=1:
            continue
        review=matches[0]
        states=set(review.get('native_validation_states') or [])
        states.add(spec['expected'])
        review['native_validation_states']=sorted(states)
        if states=={False,True}:
            review['reason']='Positive and negative native validation checks passed. Submission and business/server validation remain unverified.'
        else:
            review['reason']='One native validation state passed; the complementary input case and business/server behavior remain unverified.'


def coverage_obligations(coverage):
    """Return exact recorded gaps; a passed field check never completes a send."""
    return [{**{k:r[k] for k in ('url','label','card_context','tag','type','reason','native_validation_states') if k in r},
             **({'remaining_checks':['submission_and_business_validation_only; native input checks already recorded']}
                if set(r.get('native_validation_states') or [])=={False,True} else {})}
            for r in (coverage or {}).get('controls_requiring_review',[]) if not r.get('ui_mechanics_verified')][:60]


def reconcile_ui_review(coverage, result, arguments, current_url, controls):
    """Resolve discovery's UI-only gap using the action's observed state delta."""
    if not isinstance(coverage,dict) or not isinstance(result,dict):return
    from .permissions import CRITICAL
    actions=arguments.get('actions') or [arguments]
    results=result.get('results') or [result]
    for action,step in zip(actions,results):
        if step.get('status')!='passed' or action.get('action') not in {'click','set_checked','select_option'}:continue
        effect=(step.get('verification') or {}).get('effect_type')
        if effect not in {'visual_state_change','control_change','scroll','route_change','modal_open','modal_close','dom_mutation'}:continue
        control=next((c for c in controls if c.get('id')==action.get('element_id')),None)
        if not control:continue
        label=str(control.get('text') or control.get('aria_label') or control.get('label') or '').strip().casefold()
        if not label or control.get('form') or CRITICAL.search(label):continue
        matches=[r for r in coverage.get('controls_requiring_review',[]) if r.get('url')==current_url
                 and str(r.get('label') or '').strip().casefold()==label
                 and (not r.get('card_context') or r['card_context']==control.get('card_context'))]
        if len(matches)==1:
            matches[0]['ui_mechanics_verified']=True
            matches[0]['observed_effect']=effect
