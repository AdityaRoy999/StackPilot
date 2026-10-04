"""Replay declared browser scenarios; each scenario needs an outcome assertion."""
import json
from .browser_testing.assertions import assert_browser_state
from .runtime_verification import request_url


async def resolve(session,selector):
    await session.extract_interactive_tree()
    target=await session.evaluate("""(() => {
      const matches=[...document.querySelectorAll(SELECTOR)];
      if(matches.length!==1)return null;
      for(const [id,node] of window.__spFast?.nodes || [])if(node===matches[0])return id;
      return null;
    })()""".replace('SELECTOR',json.dumps(selector)))
    if not isinstance(target,int):raise ValueError('Scenario target is missing, ambiguous or not interactive')
    return target


async def run(session,url,scenarios):
    if not isinstance(scenarios,list) or not scenarios or len(scenarios)>20 or any(
        not isinstance(s,dict) or not isinstance(s.get('steps'),list) or not s['steps'] or
        not all(isinstance(step,dict) for step in s['steps']) or
        s['steps'][-1].get('action')!='assert' or not s['steps'][-1].get('expectations')
        for s in scenarios) or sum(len(s['steps']) for s in scenarios)>100:
        return {'verified':False,'status':'failed','reason':'Scenarios require bounded steps and final assertions'}
    evidence=[]
    for scenario in scenarios:
        steps=[]
        try:
            # Every scenario starts from its declared route and a fresh observation.
            await session.navigate(request_url(url,scenario.get('path','/')))
            for step in scenario['steps']:
                action=step['action']
                if action=='assert':
                    result=await assert_browser_state(session,step['expectations'],timeout_seconds=5,purpose='outcome')
                    if result.get('verification',{}).get('verified') is not True:
                        steps.append({'action':action,'result':result});raise ValueError('Scenario outcome assertion failed')
                elif action=='press_key':
                    if not await session.press_key(step['key']):raise ValueError('Key dispatch failed')
                else:
                    target=await resolve(session,step['selector'])
                    if action=='click':
                        # A verified final assertion decides correctness, not a DOM delta.
                        if not await session.click_element(target,fast_mode=True):raise ValueError('Click target could not be acted on')
                    elif action=='fill':
                        if not await session.type_text(step['value'],element_id=target,clear_first=True):raise ValueError('Input dispatch failed')
                    elif action=='select':
                        if not await session.select_option(target,step['value']):raise ValueError('Option selection failed')
                    elif action=='check':
                        if not await session.set_checked(target,step['checked']):raise ValueError('Checkbox action failed')
                    else:raise ValueError('Unsupported scenario action')
                steps.append({'action':action,'status':'executed'})
            evidence.append({'name':scenario['name'],'status':'passed','steps':steps})
        except Exception as exc:
            evidence.append({'name':scenario.get('name','scenario'),'status':'failed','steps':steps,'reason':str(exc) if type(exc) is ValueError else type(exc).__name__})
            return {'verified':False,'status':'failed','scenarios':evidence}
    return {'verified':bool(evidence),'status':'passed' if evidence else 'unverified','scenarios':evidence}
