"""Finite original-goal reviews; permission preparation never dispatches input."""
import hashlib
import json
import re
from collections import Counter

from .permissions import CRITICAL, observe_step, fingerprint, permission_reason


VERBS = r'send|submit|publish|delete|remove|purchase|buy|pay|transfer'
PERMISSION = re.compile(r'\b(?:request(?:ing)?|ask(?:ing)?(?:\s+for)?|prepare|show)\b[^.!?;]{0,90}?\b(?:permission|approval|confirmation)\b\s+(?:to|for|before)\s+(?P<verb>'+VERBS+r')\b(?P<object>[^.!?;]*)',re.I)
DIRECT = re.compile(r'(?:^|[.!?;]\s*|\bthen\s+)(?:please\s+)?(?P<verb>'+VERBS+r')\b(?P<object>[^.!?;]*)',re.I)
FAMILIES = {'send':{'send','submit'},'submit':{'send','submit'},'delete':{'delete','remove'},
            'remove':{'delete','remove'},'purchase':{'purchase','buy'},'buy':{'purchase','buy'}}
STOP_WORDS = {'a','an','the','this','that','my','our','its','form','message','email','workflow','step','button','specific','exact','it'}


def explicit_workflow(goal):
    matches=[]
    for pattern in (PERMISSION,DIRECT):
        for match in pattern.finditer(goal):
            prefix=goal[max(0,match.start()-18):match.start()].lower()
            if re.search(r'(?:do\s+not|don.t|never|without|rather\s+than)\s*$',prefix):
                continue
            verb=match.group('verb').lower()
            obj=re.split(r'\b(?:and|then|but)\b',match.group('object'),1,flags=re.I)[0]
            terms={w for w in re.findall(r'[\w-]+',obj.lower()) if w not in STOP_WORDS}
            family=FAMILIES.get(verb,{verb})
            matches.append((frozenset(family),frozenset(terms)))
    distinct=set(matches)
    return next(iter(distinct)) if len(distinct)==1 else None


def _matches_workflow(review,workflow):
    family,terms=workflow
    label=str(review.get('label') or '').lower()
    words=set(re.findall(r'[\w-]+',label))
    if not words.intersection(family) or not terms.issubset(words):
        return False
    # Unqualified send/submit refers only to a real form; generic critical
    # buttons such as Send invoice still need a specific original-goal object.
    return bool(terms or (family==frozenset({'send','submit'}) and
                         review.get('type') in {'submit','image'}))


def refresh_obligations(goal,coverage):
    digest=hashlib.sha256(goal.encode()).hexdigest()
    previous={o['id']:o for o in coverage.get('workflow_obligations',[]) if o.get('goal_hash')==digest}
    result=[]
    for review in coverage.get('controls_requiring_review',[]):
        label=str(review.get('label') or '')
        critical=bool(CRITICAL.search(label) or review.get('type') in {'submit','image'})
        semantic={k:review.get(k) or '' for k in ('url','tag','role','type','name','input_id','href','form_action','form_method')}
        semantic['label']=' '.join(label.casefold().split())
        identity=hashlib.sha256((digest+'|'+json.dumps(semantic,sort_keys=True,separators=(',',':'))).encode()).hexdigest()[:24]
        states=review.get('native_validation_states') or []
        obligation={**previous.get(identity,{}),'id':identity,'goal_hash':digest,
            'url':review.get('url'),'label':label,'kind':'critical_review' if critical else 'workflow_review',
            'reason':previous.get(identity,{}).get('reason') or review.get('reason','Expected workflow outcome remains unverified.')}
        if not critical:
            obligation['state']='native_checks_recorded' if states==[False,True] else 'pending_review'
            obligation['reason']=review.get('reason','Expected workflow outcome remains unverified.')
        else:
            obligation.setdefault('state','pending_review')
            obligation['executed_once']=bool(obligation.get('executed_once') or obligation['state']=='executed_pending_verification')
        result.append(obligation)
    duplicates={identity for identity,count in Counter(o['id'] for o in result).items() if count>1}
    for obligation in result:
        if obligation['id'] in duplicates:
            obligation.update(state='blocked_ambiguous',reason='Duplicate indistinguishable control identities require clarification; no step can be prepared.')
    coverage['workflow_obligations']=result
    return result


async def prepare_explicit_workflow_review(goal,coverage,session):
    """Return a current exact step proposal, or retain a precise blocked review.

    This function performs observations only. A separate ticket path pauses;
    neither discovery labels nor a generic deep-test request authorize sending.
    """
    obligations=refresh_obligations(goal,coverage)
    workflow=explicit_workflow(goal)
    if workflow is None:
        return None
    matches=[(review,obligations[index]) for index,review in enumerate(coverage.get('controls_requiring_review',[]))
             if _matches_workflow(review,workflow)]
    if not matches:
        return None
    if len(matches)!=1:
        for _,obligation in matches:
            obligation.update(state='blocked_ambiguous',reason='The requested workflow matches multiple discovered controls; identify its intended page/control.')
        return None
    review,obligation=matches[0]
    if obligation.get('executed_once') or obligation.get('state') in {'executed_pending_verification','stopped'}:
        return None
    if not session or not session.is_connected or session.current_url!=review.get('url'):
        obligation.update(state='blocked_stale',reason='The requested control is not on the current connected page; navigate and observe it before preparing permission.')
        return None
    extractor=getattr(session,'extract_interactive_tree',None)
    if callable(extractor):
        await extractor()
    label=str(review.get('label') or '').strip().casefold()
    candidates=[c for c in session.interactive_elements if label in {
        str(c.get(k) or '').strip().casefold() for k in ('text','label','aria_label')}
        and c.get('tag') in {'button','a','input'}]
    if len(candidates)!=1:
        obligation.update(state='blocked_ambiguous' if candidates else 'blocked_stale',
            reason='A unique current observed target is unavailable; refresh or clarify the intended control.')
        return None
    args={'action':'click','element_id':candidates[0]['id'],'session_id':session.session_id,'include_frame':False}
    control=await observe_step(session,args)
    if not control or str(control.get('label') or control.get('text') or '').strip().casefold()!=label or control.get('url')!=review.get('url'):
        obligation.update(state='blocked_stale',reason='The target context changed during observation; no permission or input was prepared.')
        return None
    if control.get('disabled') or not permission_reason(args,control,True):
        obligation.update(state='blocked_prerequisite',reason='The requested consequential target is not currently actionable or its effect no longer matches the review.')
        return None
    if control.get('form'):
        if control.get('native_validity') is not True:
            obligation.update(state='blocked_prerequisite',reason='The current form validity is not established; complete its reversible input checks first.')
            return None
        input_reviews=[r for r in coverage.get('controls_requiring_review',[]) if r.get('url')==review.get('url') and r.get('tag') in {'input','textarea','select'}]
        if any(r.get('native_validation_states')!=[False,True] for r in input_reviews):
            obligation.update(state='blocked_prerequisite',reason='Discovered input scenarios still require recorded positive/negative native validation before this workflow review.')
            return None
    obligation.update(state='permission_prepared',reason='The original goal explicitly requested this workflow; its unique current step is prepared for review, with no input dispatched.')
    return {'arguments':args,'fingerprint':fingerprint(control),'obligation_id':obligation['id'],'goal_hash':obligation['goal_hash']}
