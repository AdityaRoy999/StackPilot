"""Bounded read-only names for observed controls, including nested native labels."""


CONTROL_NAME_HELPERS = r"""
const spLabelText = root => {
  if (!root) return '';
  const walker=root.ownerDocument.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  const parts=[];
  for(let node,count=0;(node=walker.nextNode()) && count<160;count++) {
    // A wrapping <label> includes its <select>'s options in innerText.
    // Those are the choices, not the name of the field. Do not clone or alter
    // the page to remove them. Explicitly referenced hidden labels still count.
    if(node.parentElement?.closest('select,textarea,button,script,style')) continue;
    if(node.textContent.trim()) parts.push(node.textContent);
  }
  return parts.join(' ').replace(/\s+/g,' ').trim().slice(0,240);
};
const spControlName = el => {
  const root=el.getRootNode();
  const labelled=(el.getAttribute('aria-labelledby')||'').trim().split(/\s+/).filter(Boolean)
    .map(id=>spLabelText(root.getElementById?.(id))).filter(Boolean).join(' ');
  const aria=(el.getAttribute('aria-label')||'').trim();
  const native=[...(el.labels||[])].map(spLabelText).filter(Boolean).join(' ');
  return [labelled,aria,native].find(text=>text && !/SafeValue|<\/?(?:body|html|script)|\[property\]/i.test(text)) || '';
};
"""
