"""Shared, read-only popup discovery for observations and native hit testing."""

OVERLAY_HELPERS = r"""
window.__spOverlay = window.__spOverlay || (() => {
 const visible = e => !!(e?.isConnected && e.getClientRects().length &&
   getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' &&
   getComputedStyle(e).opacity !== '0' && !e.closest('[hidden],[inert]'));
 const named = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open],.ui-dialog,.p-dialog,.swal2-popup,.modal.show,.ant-modal-content,.cdk-overlay-pane,.modal-wrapper,[class*="modal-content"],[class*="dialog-content"],[data-state="open"][role="alertdialog"]';
 const native = 'button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="option"],[role="gridcell"],[role="menuitem"],[contenteditable="true"],[tabindex="0"],iframe';
 const isClose = e => /(?:^|[\s_-])(?:ic)?close(?:$|[\s_-])|dismiss/i.test(
   [e.getAttribute('aria-label'),e.title,typeof e.className === 'string' ? e.className : '',
    ...[...e.querySelectorAll('[class]')].slice(0,3).map(n=>typeof n.className === 'string' ? n.className : '')].join(' '));
 const name = e => (e.getAttribute('aria-label') || e.title || e.innerText ||
   e.labels?.[0]?.innerText || e.placeholder || e.name || (isClose(e) ? 'Close' : ''))
   .replace(/\s+/g,' ').trim();
 const controls = root => {
   const items = [...root.querySelectorAll(native)].filter(visible);
   // Decorative aria-hidden icons can be inside real delegated close targets.
   // Admit only visible pointer boundaries, never every decorative descendant.
   for (const e of [...root.querySelectorAll('div,span,svg')].slice(0,800)) {
     if (!visible(e) || items.includes(e) || e.closest(native)) continue;
     const parent=e.parentElement;
     if (getComputedStyle(e).cursor!=='pointer' ||
         (parent && getComputedStyle(parent).cursor==='pointer' && !parent.matches(native))) continue;
     const r=e.getBoundingClientRect();
     if (r.width<8 || r.height<8 || r.width>300 || r.height>100 || (!name(e) && !isClose(e))) continue;
     items.push(e);
   }
   return items;
 };
 const hit = e => {
   const r=e.getBoundingClientRect();
   const x=Math.max(0,Math.min(innerWidth-1,r.x+r.width/2));
   const y=Math.max(0,Math.min(innerHeight-1,r.y+r.height/2));
   if(r.bottom<=0 || r.top>=innerHeight || r.right<=0 || r.left>=innerWidth) return false;
   let top=document.elementFromPoint(x,y);
   for(let i=0; i<8 && top?.shadowRoot; i++) {
     const child=top.shadowRoot.elementFromPoint(x,y);if(!child||child===top)break;top=child;
   }
   return !!top && (top===e || e.contains(top));
 };
 const surfaces = () => {
   const roots=[...document.querySelectorAll(named)].filter(visible);
   // Unlabelled portals need layout evidence: a floating form/surface that
   // actually covers a background control, rather than a normal page card.
   const background=[...document.querySelectorAll(native)].filter(visible).slice(0,80);
   for(const e of [...document.querySelectorAll('div,section,aside')].slice(0,2500)) {
     if(roots.includes(e) || !visible(e))continue;
     const s=getComputedStyle(e),r=e.getBoundingClientRect();
     if(!['fixed','absolute'].includes(s.position) || Number(s.zIndex)<=0 ||
        r.width<180 || r.height<100 || r.width*r.height<innerWidth*innerHeight*.035 ||
        r.bottom<innerHeight*.18 || r.top>innerHeight*.9)continue;
     if(!e.querySelector('form,input,textarea') && ![...e.querySelectorAll('button,span,div')].some(isClose))continue;
     const covers=background.some(n=>{
       if(e.contains(n))return false;const b=n.getBoundingClientRect();
       const top=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
       return top && e.contains(top);
     });
     if(covers && controls(e).length)roots.push(e);
   }
   return roots.filter(e=>!roots.some(other=>other!==e && e.contains(other) && controls(other).length));
 };
 const stack = e => {let z=0;for(let n=e;n;n=n.parentElement)z=Math.max(z,Number(getComputedStyle(n).zIndex)||0);return z;};
 const active = () => surfaces().reverse().sort((a,b)=>stack(b)-stack(a)).find(e=>controls(e).some(hit)) || null;
 return {visible,name,controls,hit,active,surfaces};
})();
"""
