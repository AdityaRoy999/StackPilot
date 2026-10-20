"""Query-targeted read-only text references, separate from actionable controls.

Plain prices, quantities and result labels need an exact observable target too.
Registering their DOM identity for assertions never makes them clickable controls.
"""
from __future__ import annotations

import json


async def assertion_recovery_evidence(session, result):
    """Return fresh candidate facts after a mismatch, never retarget or pass it.

    This removes an extra planner/observe round trip while preserving both the
    failed expectation and the decision about which target serves the goal.
    """
    if not isinstance(result, dict) or result.get('status') == 'passed':
        return result
    queries = []
    for check in result.get('assertions') or ():
        spec = check.get('expectation') or {}
        value = spec.get('expected')
        if (check.get('status') != 'passed' and spec.get('kind') == 'text'
                and isinstance(value, str) and value.strip()
                and check.get('actual') != '[redacted]' and value != '[redacted]'):
            query = value.strip()[:120]
            if query not in queries:
                queries.append(query)
        if len(queries) == 2:
            break
    candidates = {}
    for query in queries:
        evidence = await observe_text_evidence(session, query, scope='page', limit=8)
        for item in evidence.get('text_evidence') or ():
            candidates[item['id']] = item
    if not candidates:
        return result
    from .outcomes import outcome_guard_for
    guard = outcome_guard_for(session)
    if guard:
        guard.observe_readonly(list(candidates.values()), session.current_url)
    return {**result, 'recovery': {'reason':'assertion_target_mismatch',
        'text_evidence':list(candidates.values()),
        'hint':'The original assertion still failed. These are fresh read-only candidates, not a replacement expectation. Choose a target only if its context matches the user goal; preserve the expected result and never replay a submission.'}}


SAFE_SEMANTIC_TEXT_HELPERS = r"""
 const spSemanticTextSelector='h1,h2,h3,h4,h5,h6,[role="heading"],output,p,li,td,th,dt,dd,blockquote,figcaption';
 const spTextParent=e=>e.parentElement || e.getRootNode()?.host || null;
 const spTextExcluded=e=>{
   const forbidden='script,style,noscript,template,input,textarea,select,[contenteditable="true"],.ace_editor,.CodeMirror,.cm-editor,.monaco-editor';
   for(let p=e;p;p=spTextParent(p))if(p.isContentEditable||p.matches?.(forbidden))return true;
   return false;
 };
 const spTextVisible=e=>{
   if(!e?.isConnected || !e.getClientRects().length)return false;
   for(let p=e;p;p=spTextParent(p)) {
     if(p.matches?.('[hidden],[inert],[aria-hidden="true"]'))return false;
     const s=getComputedStyle(p);
     if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false;
   }
   return true;
 };
 const spReadSemanticText=root=>{
   const parts=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
   let scanned=0,length=0;
   for(let node;(node=walker.nextNode());) {
     if(++scanned>16000)return {complete:false,text:''};
     const e=node.parentElement,raw=node.textContent||'';
     if(!e||!raw||spTextExcluded(e)||!spTextVisible(e))continue;
     if((length+=raw.length)>32000)return {complete:false,text:''};
     parts.push(raw);
   }
   return {complete:true,text:parts.join('').replace(/\s+/g,' ').trim()};
 };
"""


TEXT_EVIDENCE_PROBE = r"""(() => {
 __SAFE_SEMANTIC_TEXT_HELPERS__
 const request=__REQUEST__, cache=window.__spFast;
 const empty={text_evidence:[],text_evidence_total:0,text_evidence_has_more:false,
              text_evidence_next_offset:null,text_evidence_scan_limited:false};
 if(!cache?.nodes || !cache?.ids || typeof window.__spGetOrAssignId!=='function')
   return {...empty,text_evidence_reason:'A fresh semantic observation is required.'};
 if(request.generation!==null && cache.generation!==request.generation)
   return {...empty,text_evidence_reason:'The observed document changed.'};
 const normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
 const lower=value=>normalize(value).toLocaleLowerCase();
 const interactive='a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="option"],[role="menuitem"],[role="combobox"],[tabindex="0"]';
 const composedParent=spTextParent;
 const inside=(root,e)=>{for(let p=e;p;p=composedParent(p))if(p===root)return true;return false;};
 const visible=spTextVisible,excluded=spTextExcluded;
 const inInteractive=e=>{for(let p=e;p;p=composedParent(p))if(p.matches?.(interactive))return true;return false;};
 const active=window.__spOverlay?.active?.();
 if(request.scope==='overlay' && !active)return empty;
 const root=request.scope==='overlay'?active:document.body;
 if(!root)return empty;
 const context=new Map(), records=[], semantic=new Map(), seen=new Set(), roots=[{root,depth:0}];
 let scanned=0,limited=false;
 // Context is built from the same visible, non-input text records. Reading an
 // ancestor's full textContent/innerText could disclose hidden/editor content.
 for(let r=0;r<roots.length && scanned<16000;r++) {
   const current=roots[r];
   const walker=document.createTreeWalker(current.root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
   for(let node;(node=walker.nextNode());) {
     if(++scanned>16000){limited=true;break;}
     if(node.nodeType===Node.ELEMENT_NODE) {
       if(node.shadowRoot && current.depth<3 && roots.length<16)roots.push({root:node.shadowRoot,depth:current.depth+1});
       continue;
     }
     const e=node.parentElement,raw=node.textContent||'',text=normalize(raw);
     if(!e || !raw || excluded(e) || !visible(e))continue;
     const rect=e.getBoundingClientRect(),inView=rect.bottom>0&&rect.top<innerHeight&&rect.right>0&&rect.left<innerWidth;
     if(request.scope==='viewport'&&!inView)continue;
     if(request.scope==='overlay'&&!inside(active,e))continue;
     // Semantic text can contain inline emphasis, links, code or a permalink.
     // Build their text from these same safe nodes, never ancestor textContent.
     for(let p=e,depth=0;p&&p!==document.body&&depth<12;p=composedParent(p),depth++) {
       if(!p.matches?.(spSemanticTextSelector))continue;
       if(inInteractive(p))break;
       let entry=semantic.get(p);
       if(!entry){entry={e:p,parts:[],length:0,truncated:false};semantic.set(p,entry);}
       if(entry.length<4000){entry.parts.push(raw.slice(0,4000-entry.length));entry.length+=raw.length;}
       else entry.truncated=true;
       if(entry.length>4000)entry.truncated=true;
       break;
     }
     if(!text)continue;
     for(let p=e,depth=0;p&&p!==document.body&&depth<5;p=composedParent(p),depth++) {
       let entry=context.get(p);
       if(!entry){entry={parts:[],length:0};context.set(p,entry);}
       if(entry.parts.length<12&&entry.length<480){entry.parts.push(text.slice(0,160));entry.length+=text.length;}
     }
     // A reference names the actual leaf element, never a large ancestor with
     // several unrelated values, and never a caption inside a clickable input.
     if(e.children.length || e.matches(spSemanticTextSelector) || seen.has(e) || inInteractive(e))continue;
     seen.add(e);
     const hint=normalize([e.id,e.className?.baseVal??e.className,e.getAttribute('data-test'),e.getAttribute('data-testid')].filter(v=>typeof v==='string').join(' ')).slice(0,240);
     records.push({e,text,inView,hint});
   }
 }
 if(scanned>=16000)limited=true;
 for(const entry of semantic.values()) {
   const e=entry.e,text=normalize(entry.parts.join(''));
   if(!text)continue;
   const rect=e.getBoundingClientRect(),inView=rect.bottom>0&&rect.top<innerHeight&&rect.right>0&&rect.left<innerWidth;
   const hint=normalize([e.id,e.className?.baseVal??e.className,e.getAttribute('data-test'),e.getAttribute('data-testid')].filter(v=>typeof v==='string').join(' ')).slice(0,240);
   const semanticRole=e.tagName==='OUTPUT'?'output':e.matches('h1,h2,h3,h4,h5,h6,[role="heading"]')?'heading':'text';
   records.push({e,text,inView,hint,semanticRole,truncated:entry.truncated||limited});
 }
 const query=lower(request.query),matches=[];
 for(const record of records) {
   const {e,text,hint}=record;
   let nearby='';
   for(let p=composedParent(e),depth=0;p&&p!==document.body&&depth<4;p=composedParent(p),depth++) {
     const entry=context.get(p);
     if(entry?.parts.length>1){nearby=normalize(entry.parts.join(' ')).slice(0,480);break;}
   }
   const name=normalize(e.getAttribute('aria-label')||e.getAttribute('title')).slice(0,160);
   const textKey=lower(text),hintKey=lower(hint+' '+name),contextKey=lower(nearby);
   const rank=textKey===query?0:hintKey.includes(query)?1:textKey.includes(query)?2:contextKey.includes(query)?3:-1;
   if(rank<0)continue;
   matches.push({...record,name,nearby,rank});
 }
 matches.sort((a,b)=>a.rank-b.rank || Number(!!b.semanticRole)-Number(!!a.semanticRole));
 const selected=matches.slice(request.offset,request.offset+request.limit);
 const items=selected.map(({e,text,inView,hint,name,nearby,rank,semanticRole,truncated})=>{
   // Register identity without data-* writes: observation must not trigger page
   // mutation handlers or create an actionable control.
   let id=cache.ids.get(e);
   if(id===undefined){id=cache.nextId++;cache.ids.set(e,id);}
   cache.nodes.set(id,e);
   return {id,tag:e.tagName.toLowerCase(),role:'text',text:text.slice(0,400),
     ...(name?{name}:{}),...(hint?{dom_hint:hint}:{}),...(nearby?{context:nearby}:{}),
     ...(semanticRole?{semantic_role:semanticRole}:{}),
     is_in_viewport:inView,read_only:true,supported_actions:['assert'],
     text_truncated:!!truncated||text.length>400,match_source:rank===0||rank===2?'text':rank===1?'observed_attribute':'context'};
 });
 const next=request.offset+items.length,more=next<matches.length;
 return {text_evidence:items,text_evidence_total:matches.length,text_evidence_has_more:more,
         text_evidence_next_offset:more?next:null,text_evidence_scan_limited:limited,
         next_element_id:cache.nextId};
})()""".replace('__SAFE_SEMANTIC_TEXT_HELPERS__', SAFE_SEMANTIC_TEXT_HELPERS)


def _identity(session):
    return (getattr(session, 'target_id', None), getattr(session, 'current_url', ''),
            getattr(session, '_navigation_generation', None), getattr(session, '_selected_frame', None))


def _empty(reason=''):
    return {'text_evidence': [], 'text_evidence_total': 0, 'text_evidence_has_more': False,
            'text_evidence_next_offset': None, 'text_evidence_scan_limited': False,
            **({'text_evidence_reason': reason} if reason else {})}


async def observe_text_evidence(session, query, *, scope='page', offset=0, limit=40):
    """Return assertion-only text references from this document/frame and query.

    Call after a fresh interactive-tree observation. Empty/unfiltered requests
    deliberately do not scan the DOM. Existing assertion exact/contains semantics
    are unchanged; callers choose expectations from the returned actual text.
    """
    if query is None:
        return _empty()
    if not isinstance(query, str) or not query.strip() or len(query) > 120:
        return _empty('A nonempty query of at most 120 characters is required.')
    if scope not in {'page', 'viewport', 'overlay'} or type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 80:
        return _empty('Invalid bounded text observation request.')
    if getattr(session, 'native_dialog', None):
        return _empty('Resolve the observed native dialog before reading page text.')
    identity = _identity(session)
    request = {'query': query.strip(), 'scope': scope, 'offset': offset, 'limit': limit,
               'generation': getattr(session, '_navigation_generation', None)}
    try:
        result = await session.evaluate(TEXT_EVIDENCE_PROBE.replace('__REQUEST__', json.dumps(request)), timeout=2)
    except Exception:
        return _empty('Current text evidence could not be observed.')
    if _identity(session) != identity:
        return _empty('The page or selected frame changed during text observation.')
    if not isinstance(result, dict) or not isinstance(result.get('text_evidence'), list):
        return _empty('Current text evidence could not be observed.')
    next_id = result.pop('next_element_id', None)
    if type(next_id) is int:
        session._next_element_id = max(getattr(session, '_next_element_id', 0), next_id)
    # This separate evidence channel must never enter observed_targets or
    # interactive_elements; action resolution continues to reject text refs.
    return result
