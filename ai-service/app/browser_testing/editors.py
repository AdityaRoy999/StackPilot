"""Read editor documents through their owning view; input still uses native CDP.

Never select a global model merely because it is the only model on the page.
An output pane and a source editor can both expose role=textbox.
"""
import json


EDITOR_HELPERS = r"""
const normalizeCode = value => String(value ?? '').replace(/\r\n?/g, '\n');
const contentDocument = el => {
  let text=el.innerText;
  // Chromium leaves a <br> caret placeholder in the final empty block.
  // innerText counts both the block separator and this placeholder.
  const last=el.lastChild;
  if (last?.nodeType===1 && last.matches('div,p') && last.childNodes.length===1 &&
      last.firstChild.nodeName==='BR' && text.endsWith('\n')) text=text.slice(0,-1);
  if (el.childNodes.length===1 && el.firstChild.nodeName==='BR') return '';
  return text;
};
const editorView = el => {
  if (!el?.isConnected) return null;
  const aceRoot = el.closest('.ace_editor');
  const ace = aceRoot?.env?.editor;
  if (ace && typeof ace.getValue === 'function')
    return {kind:'ace', root:aceRoot, read:()=>ace.getValue(), focus:()=>ace.focus(), readonly:()=>ace.getReadOnly()};
  const cmRoot = el.closest('.CodeMirror');
  const cm = cmRoot?.CodeMirror;
  if (cm && typeof cm.getValue === 'function')
    return {kind:'codemirror', root:cmRoot, read:()=>cm.getValue(), focus:()=>cm.focus(), readonly:()=>!!cm.getOption('readOnly')};
  const cmContent = el.closest('.cm-content') || el.closest('.cm-editor')?.querySelector('.cm-content');
  const cm6 = cmContent?.cmView?.view;
  if (cm6?.state?.doc && cm6.contentDOM === cmContent)
    return {kind:'codemirror6', root:cm6.dom, read:()=>cm6.state.doc.toString(), focus:()=>cm6.focus(), readonly:()=>cm6.state.readOnly === true || cm6.contentDOM.contentEditable === 'false'};
  const monacoRoot = el.closest('.monaco-editor');
  const candidates = monacoRoot && typeof window.monaco?.editor?.getEditors === 'function'
    ? window.monaco.editor.getEditors().filter(view=>view.getDomNode() === monacoRoot) : [];
  if (candidates.length === 1) {
    const view=candidates[0];
    return {kind:'monaco', root:monacoRoot, read:()=>view.getModel()?.getValue(), focus:()=>view.focus(),
      readonly:()=>view.getOption(window.monaco.editor.EditorOption.readOnly)};
  }
  if (el.isContentEditable)
    return {kind:'contenteditable', root:el, read:()=>contentDocument(el), focus:()=>el.focus(), readonly:()=>el.getAttribute('aria-readonly')==='true'};
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
    return {kind:'native', root:el, read:()=>el.value, focus:()=>el.focus(), readonly:()=>!!el.readOnly};
  return null;
};
"""


def read_editor_script(target_js):
    return "(() => {" + EDITOR_HELPERS + f"""
      const el={target_js}, view=editorView(el);
      return view ? {{kind:view.kind,value:normalizeCode(view.read()),readonly:view.readonly()}} : null;
    }})()"""


def focus_editor_script(target_js):
    return "(() => {" + EDITOR_HELPERS + f"""
      const el={target_js}, view=editorView(el);
      if (!view) return {{error:'Requested control is not an editable input. Select the source editor, not its output pane.'}};
      if (view.readonly() || el.matches(':disabled') || el.closest('[inert]')) return {{error:'Requested input is readonly, disabled or inert.'}};
      const rect=view.root.getBoundingClientRect(), root=view.root.getRootNode();
      const hit=root.elementFromPoint?.(rect.x+rect.width/2,rect.y+rect.height/2);
      if (!rect.width || !rect.height || !hit || (hit!==view.root&&!view.root.contains(hit)))
        return {{error:'Requested input is hidden or covered by another control.'}};
      view.focus();
      let active=document.activeElement;
      while(active?.shadowRoot?.activeElement) active=active.shadowRoot.activeElement;
      if (active!==el && !view.root.contains(active)) return {{error:'Requested input could not be focused.'}};
      return {{value:normalizeCode(view.read()),editor_kind:view.kind,type:el.type || '',x:rect.x+Math.min(24,rect.width/2),y:rect.y+Math.min(24,rect.height/2),
        autocomplete:el.getAttribute('role')==='combobox'||!!el.getAttribute('aria-autocomplete')||!!el.getAttribute('list')||
          !!el.closest('p-autocomplete,[class*="autocomplete"],[class*="combobox"]')}};
    }})()"""


def typing_guard_script(target_js, expected):
    """Recheck focus and the exact prefix before sending another native batch."""
    return "(() => {" + EDITOR_HELPERS + f"""
      const el={target_js}, view=editorView(el);
      let active=document.activeElement;
      while(active?.shadowRoot?.activeElement) active=active.shadowRoot.activeElement;
      return !!view && !view.readonly() && !el.matches(':disabled') && !el.closest('[inert]') &&
        (active===el || view.root.contains(active)) && normalizeCode(view.read())==={json.dumps(expected)};
    }})()"""


async def read_editor(session, element_id):
    return await session.evaluate(read_editor_script(f"window.__spFast?.nodes.get({int(element_id)})"))


def editor_assertion_probe(specs):
    """Bounded document readback, preserving code whitespace and newlines."""
    return "(() => {" + EDITOR_HELPERS + "const specs=" + json.dumps(specs) + r""";
      return specs.map(spec=>{
        const nodes=spec.element_id!=null ? [window.__spFast?.nodes.get(spec.element_id)].filter(Boolean) : [...document.querySelectorAll(spec.selector)];
        if(nodes.length!==1) return {matched:false,actual:null,reason:'Expected one current editor target'};
        const view=editorView(nodes[0]);
        if(!view || nodes[0].type==='password') return {matched:false,actual:null,reason:'Editor document unavailable'};
        const actual=normalizeCode(view.read()), expected=normalizeCode(spec.expected);
        return {matched:spec.match==='contains'?actual.includes(expected):actual===expected,actual:actual.slice(0,2000)};
      });
    })()"""
