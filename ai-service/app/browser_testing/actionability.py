"""Live hit testing and native pointer recovery; never forces DOM state."""
import asyncio
from .overlays import OVERLAY_HELPERS
from .checkables import CHECKABLE_HELPERS

ACTIONABILITY = r"""(() => {
 __SP_OVERLAY_HELPERS__
 __SP_CHECKABLE_HELPERS__
 const el = window.__spFast?.nodes.get(__ID__);
 if (!el || !el.isConnected) return {reason:'stale_element'};
 const checkable=spCheckableSurface(el), surface=checkable?.node || el;
 const r = surface.getBoundingClientRect(), s = getComputedStyle(surface);
 const disabled = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || !!el.closest('[inert]');
 const visible = spNativeCheckable(el) ? !!checkable : r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
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
     const nestedControl=checkable?.proxy && hit?.closest('a,button,input,select,textarea,[role="button"],[role="link"]');
     if ((hit === surface || surface.contains(hit)) && (!nestedControl || nestedControl===el)) {point={x,y}; break;}
     if (!blocker && hit) blocker=hit;
   }
 }
 const form = el.closest('form');
 const label = node => (node.getAttribute('aria-label') || node.labels?.[0]?.textContent || node.name || node.id || node.tagName).trim().slice(0,120);
 const invalid = form ? [...form.querySelectorAll('input,select,textarea')].filter(n=>!n.disabled && n.willValidate && !n.validity.valid)
   .slice(0,12).map(n=>({label:label(n),required:n.required,validation:n.validationMessage.slice(0,180)})) : [];
 const activeOverlay = window.__spOverlay.active();
 const outsideOverlay = activeOverlay && (!activeOverlay.contains(el) || !activeOverlay.contains(surface));
 const blockingDialog = outsideOverlay ? activeOverlay : blocker?.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]');
 if (outsideOverlay) {point=null;blocker=blocker || activeOverlay;}
 const blockingNavigation = blocker?.closest('header,nav,[role="navigation"]');
 const targetNavigation = el.closest('header,nav,[role="navigation"]');
 return {x:point?.x,y:point?.y,text:(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0,120),
   disabled,is_in_viewport:inView,is_occluded:inView && !point,checkable_label_proxy:!!checkable?.proxy,
   reason:disabled?'disabled':!visible?'hidden':!inView?'outside_viewport':!point?'occluded':'ready',
   invalid_fields:invalid,
   navigation_hover_blocker:!!blockingNavigation && !blockingNavigation.contains(el) && !blockingDialog,
   target_in_navigation:!!targetNavigation,
   neutral_pointer:{x:Math.max(0,innerWidth-2),y:Math.max(0,innerHeight-2)},
   blocker:blocker?{tag:blocker.tagName.toLowerCase(),role:blocker.getAttribute('role') || '',
     label:label(blocker),dialog:Boolean(blockingDialog),
     text:(blockingDialog?.innerText || blocker.innerText || '').slice(0,300)}:null};
})()""".replace('__SP_OVERLAY_HELPERS__', OVERLAY_HELPERS).replace('__SP_CHECKABLE_HELPERS__', CHECKABLE_HELPERS)


async def inspect_actionability(session, element_id: int) -> dict:
    result = await session.evaluate(ACTIONABILITY.replace('__ID__', str(int(element_id))))
    if isinstance(result,dict) and result.get('reason')=='ready':
        if getattr(session,'_selected_frame',None):
            # Scrolling a child can also scroll its parent. Recompute the owner
            # bounds and hit-test in the main page to avoid clicking its overlay.
            try:
                from .frames import frame_transform,frame_point_is_clear
                ox,oy,sx,sy=await frame_transform(session,session._selected_frame)
                session.frame_offset=(ox,oy);session.frame_scale=(sx,sy)
                if not await frame_point_is_clear(session,session._selected_frame,result['x']*sx+ox,result['y']*sy+oy):
                    return {**result,'reason':'occluded','is_occluded':True,'blocker':{'dialog':True,'text':'The frame is covered in its parent page.'}}
            except Exception:
                return {**result,'reason':'frame_geometry_unavailable','is_occluded':True}
        x,y=getattr(session,'frame_offset',(0,0))
        sx,sy=getattr(session,'frame_scale',(1,1))
        result['x']=result['x']*sx+x
        result['y']=result['y']*sy+y
        if result.get('neutral_pointer'):
            result['neutral_pointer']['x']=result['neutral_pointer']['x']*sx+x
            result['neutral_pointer']['y']=result['neutral_pointer']['y']*sy+y
    return result if isinstance(result, dict) else {"reason": "observation_unavailable"}


async def prepare_pointer_target(session, element_id: int) -> dict:
    result = await inspect_actionability(session, element_id)
    # Hydrating controls often become enabled a fraction of a second after
    # they enter the tree. Wait only for a transient disabled/hidden state;
    # never wait through a modal or dispatch through an overlay.
    if result.get('reason') in {'disabled', 'hidden'} and not result.get('invalid_fields'):
        for delay in (.06, .10, .16):
            await asyncio.sleep(delay)
            result = await inspect_actionability(session, element_id)
            if result.get('reason') not in {'disabled', 'hidden'} or result.get('invalid_fields'):
                break
    def hover_recovery_allowed(state: dict) -> bool:
        return (state.get('reason') == 'occluded'
                and not (state.get('blocker') or {}).get('dialog')
                and (state.get('navigation_hover_blocker') or state.get('target_in_navigation')))
    if not hover_recovery_allowed(result):
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
        if not hover_recovery_allowed(result):
            break
    return result
