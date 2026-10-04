"""Live hit testing and native pointer recovery; never forces DOM state."""
import asyncio

ACTIONABILITY = r"""(() => {
 const el = window.__spFast?.nodes.get(__ID__);
 if (!el || !el.isConnected) return {reason:'stale_element'};
 const r = el.getBoundingClientRect(), s = getComputedStyle(el);
 const disabled = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || !!el.closest('[inert]');
 const visible = r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
 const l = Math.max(0,r.left), t = Math.max(0,r.top), right = Math.min(innerWidth-1,r.right), bottom = Math.min(innerHeight-1,r.bottom);
 const inView = visible && right > l && bottom > t;
 const deepHit = (x,y) => {
   let hit = document.elementFromPoint(x,y);
   for (let i=0; i<8 && hit?.shadowRoot; i++) {
     const child = hit.shadowRoot.elementFromPoint(x,y);
     if (!child || child === hit) break;
     hit = child;
   }
   return hit;
 };
 let point = null, blocker = null;
 if (inView) {
   for (const [fx,fy] of [[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]]) {
     const x=Math.round(l+(right-l)*fx), y=Math.round(t+(bottom-t)*fy), hit=deepHit(x,y);
     if (hit === el || el.contains(hit)) {point={x,y}; break;}
     if (!blocker && hit) blocker=hit;
   }
 }
 const form = el.closest('form');
 const label = node => (node.getAttribute('aria-label') || node.labels?.[0]?.textContent || node.name || node.id || node.tagName).trim().slice(0,120);
 const invalid = form ? [...form.querySelectorAll('input,select,textarea')].filter(n=>!n.disabled && n.willValidate && !n.validity.valid)
   .slice(0,12).map(n=>({label:label(n),required:n.required,validation:n.validationMessage.slice(0,180)})) : [];
 const blockingDialog = blocker?.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]');
 const blockingNavigation = blocker?.closest('header,nav,[role="navigation"]');
 return {x:point?.x,y:point?.y,text:(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0,120),
   disabled,is_in_viewport:inView,is_occluded:inView && !point,
   reason:disabled?'disabled':!visible?'hidden':!inView?'outside_viewport':!point?'occluded':'ready',
   invalid_fields:invalid,
   navigation_hover_blocker:!!blockingNavigation && !blockingNavigation.contains(el) && !blockingDialog,
   neutral_pointer:{x:Math.max(0,innerWidth-2),y:Math.max(0,innerHeight-2)},
   blocker:blocker?{tag:blocker.tagName.toLowerCase(),role:blocker.getAttribute('role') || '',
     label:label(blocker),dialog:Boolean(blockingDialog),
     text:(blockingDialog?.innerText || blocker.innerText || '').slice(0,300)}:null};
})()"""


async def inspect_actionability(session, element_id: int) -> dict:
    result = await session.evaluate(ACTIONABILITY.replace('__ID__', str(int(element_id))))
    return result if isinstance(result, dict) else {"reason": "observation_unavailable"}


async def prepare_pointer_target(session, element_id: int) -> dict:
    result = await inspect_actionability(session, element_id)
    if result.get('reason') != 'occluded' or not result.get('navigation_hover_blocker'):
        return result
    # A prior hover can leave a sticky navigation flyout over a scrolled
    # target. Leave that navigation with native pointer input; never dismiss
    # a dialog, change styles or click through the covering element.
    point = result.get('neutral_pointer') or {}
    if type(point.get('x')) is not int or type(point.get('y')) is not int:
        return result
    await session.send_command('Input.dispatchMouseEvent', {
        'type':'mouseMoved', 'x':point['x'], 'y':point['y']})
    session.cursor_x, session.cursor_y = point['x'], point['y']
    session._notify_listeners({'type':'cursor_action','action':'move',
                              **point,'label':'Moving away from navigation menu'})
    for delay in (.08, .12, .2):
        await asyncio.sleep(delay)
        result = await inspect_actionability(session, element_id)
        if result.get('reason') != 'occluded' or not result.get('navigation_hover_blocker'):
            break
    return result
