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
    return [{k:r[k] for k in ('url','label','tag','type','reason','native_validation_states') if k in r}
            for r in (coverage or {}).get('controls_requiring_review',[])][:60]
