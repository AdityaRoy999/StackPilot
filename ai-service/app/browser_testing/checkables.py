"""Read-only native checkable surfaces; input is still dispatched by CDP.

Styled checkboxes often paint their adjacent label while making the real input
transparent. Preserve the input's identity/state, and use only its own native
hit area or an explicitly associated visible label as the pointer surface.
"""

CHECKABLE_HELPERS = r"""
const spNativeCheckable = el => el?.tagName === 'INPUT' && ['checkbox','radio'].includes(el.type);
const spPainted = el => {
  if (!el?.isConnected || el.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
  const r=el.getBoundingClientRect();
  for(let node=el;node;node=node.parentElement || node.getRootNode()?.host) {
    const s=getComputedStyle(node);
    if(node.matches('[hidden],[inert],[aria-hidden="true"]') || s.display==='none' || s.visibility==='hidden' || s.visibility==='collapse' || Number(s.opacity)===0) return false;
  }
  return r.width>2 && r.height>2;
};
const spCheckableSurface = el => {
  if(!spNativeCheckable(el) || !el.isConnected || el.closest('[hidden],[inert],[aria-hidden="true"]')) return null;
  // Ignore only the input's opacity, never a hidden ancestor or display:none.
  if(typeof el.checkVisibility==='function' && !el.checkVisibility({checkOpacity:false,checkVisibilityCSS:true})) return null;
  for(let node=el;node;node=node.parentElement || node.getRootNode()?.host) {
    const s=getComputedStyle(node);
    if(node.matches('[hidden],[inert],[aria-hidden="true"]') || s.display==='none' || s.visibility==='hidden' || s.visibility==='collapse' || (node!==el && Number(s.opacity)===0)) return null;
  }
  const labels=[...(el.labels||[])].filter(spPainted);
  // Todo-style lists commonly use an adjacent <label> without a for attribute.
  // It supplies visible context only; it is NEVER used as a click proxy.
  const siblings=[...(el.parentElement?.children||[])];
  const siblingLabels=siblings.filter(n=>n.tagName==='LABEL' && !n.control && spPainted(n));
  const siblingInputs=siblings.filter(spNativeCheckable);
  const caption=labels[0] || (siblingInputs.length===1 && siblingLabels.length===1 ? siblingLabels[0] : null);
  const r=el.getBoundingClientRect(), s=getComputedStyle(el);
  const inView = node => {const box=node.getBoundingClientRect();return box.bottom>0 && box.top<innerHeight && box.right>0 && box.left<innerWidth;};
  const label=labels.find(n=>getComputedStyle(n).pointerEvents!=='none' && inView(n)) ||
    labels.find(n=>getComputedStyle(n).pointerEvents!=='none');
  if(label && (Number(s.opacity)===0 || !inView(el))) return {node:label,caption:label,proxy:true};
  const own=r.width>2 && r.height>2 && s.pointerEvents!=='none' && (Number(s.opacity)!==0 || caption);
  if(own) return {node:el,caption,proxy:false};
  return label ? {node:label,caption:label,proxy:true} : null;
};
"""
