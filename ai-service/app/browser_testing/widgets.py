"""Scoped, verified widget operations using the existing native CDP executor."""
import asyncio
from datetime import date, datetime
import json
import re
import time
from .overlays import OVERLAY_HELPERS


WIDGET_PROBE = r"""(() => {
 __SP_OVERLAY_HELPERS__
 const visible=e=>e?.isConnected && !e.closest('[hidden],[inert],[aria-hidden="true"]') &&
   e.getClientRects().length && getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).display!=='none';
 const label=e=>(e.innerText || e.getAttribute('aria-label') || e.getAttribute('title') || e.value || '').replace(/\s+/g,' ').trim();
 const id=e=>window.__spGetOrAssignId?.(e);
 const controls=root=>window.__spOverlay.controls(root).slice(0,100).map(e=>({id:id(e),
   text:window.__spOverlay.name(e).slice(0,120),role:e.getAttribute('role')||e.tagName.toLowerCase(),
   type:e.type||'',placeholder:e.placeholder||'',
   disabled:e.matches(':disabled')||e.getAttribute('aria-disabled')==='true',selected:e.getAttribute('aria-selected')==='true'}));
 const active=window.__spOverlay.active();
 const calendars=[...document.querySelectorAll('[role="dialog"],.ui-datepicker,.p-datepicker,.ant-picker-panel,.rdp,[class*="datepicker"],[class*="calendar"],[data-calendar]')]
   .filter(e=>visible(e) && e.querySelector('td,[role="gridcell"],[data-date]'));
 const calendar=calendars.find(e=>!calendars.some(other=>other!==e && e.contains(other)));
 const popups=[...document.querySelectorAll('[role="listbox"],[role="menu"],.p-autocomplete-panel,.ui-autocomplete-panel')].filter(visible);
 // Many React/Vue station and location pickers render a plain UL under the
 // focused input with no ARIA roles or library-specific classes. Scope it to
 // the nearest input wrapper so navigation/footer lists are never options.
 let nearbyList=null;
 const focused=document.activeElement;
 if(focused?.matches('input,[role="combobox"]')) {
   let ancestor=focused.parentElement;
   for(let depth=0;ancestor&&depth<4&&!nearbyList;depth++,ancestor=ancestor.parentElement) {
     nearbyList=[...ancestor.querySelectorAll('ul')].find(root=>visible(root)&&
       [...root.querySelectorAll('li')].some(visible));
   }
 }
 const plainOptions=nearbyList?[...nearbyList.querySelectorAll('li')].filter(e=>visible(e)&&
   !e.querySelector('li')&&e.getAttribute('aria-disabled')!=='true').slice(0,30)
   .map(e=>({id:id(e),text:label(e).slice(0,180),role:'option',disabled:false,selected:e.getAttribute('aria-selected')==='true'})):[];
 return {active_overlay:active?{id:id(active),title:label(active.querySelector('h1,h2,h3,[class*="title"],[class*="header"]')||active).slice(0,300),controls:controls(active)}:null,
   popup_options:plainOptions.length?[{id:id(nearbyList),controls:plainOptions}]:popups.slice(0,4).map(root=>({id:id(root),controls:controls(root)})),
   calendar:calendar?{id:id(calendar),text:label(calendar).slice(0,600),controls:controls(calendar)}:null,
   focused_id:id(document.activeElement),focused_tag:document.activeElement?.tagName?.toLowerCase()||'',
   next_element_id:window.__spFast?.nextId};
})()""".replace('__SP_OVERLAY_HELPERS__', OVERLAY_HELPERS)


async def observe_widgets(session):
    if getattr(session, 'native_dialog', None):
        return {'native_dialog':{k:v for k,v in session.native_dialog.items() if not k.startswith('_')},
                'tabs':list(getattr(session,'related_targets',{}).values())}
    evaluator = getattr(session, 'evaluate', None)
    state = await evaluator(WIDGET_PROBE, timeout=1) if callable(evaluator) else {}
    state = state if isinstance(state, dict) else {}
    if type(state.get('next_element_id')) is int:
        session._next_element_id=max(getattr(session,'_next_element_id',0),state.pop('next_element_id'))
    focused_id=state.get('focused_id')
    if (state.get('popup_options') and state.get('focused_tag') in {'input','textarea'} and
        type(focused_id) is int and
        not any(item.get('id')==focused_id for item in getattr(session,'interactive_elements',()))):
        # The popup may mount after the click's first tree scan. Bind its
        # focused input in the target cache before returning this observation.
        try: await session.extract_interactive_tree()
        except Exception: pass
    state['tabs'] = [{k:v for k,v in tab.items() if k in {'targetId','url','title','openerId'}} |
                     {'active':tab.get('targetId')==getattr(session,'target_id',None)}
                    for tab in getattr(session,'related_targets',{}).values()]
    selected=getattr(session,'_selected_frame',None) or getattr(session,'_main_frame_id',None)
    state['frames'] = [{'frame_id':key,'active':key==selected,
                       'url':value.get('url',''),'name':value.get('name','')}
                      for key,value in getattr(session,'frame_contexts',{}).items()]
    previous = (getattr(session, 'widget_state', None) or {}).get('active_overlay')
    current = state.get('active_overlay')
    history = getattr(session, 'overlay_target_history', None)
    if history is None:
        history = session.overlay_target_history = {}
    if previous and (not current or previous.get('id') != current.get('id')):
        for control in previous.get('controls', []):
            if type(control.get('id')) is int:
                history[control['id']] = {'overlay_id': previous.get('id'),
                    'overlay_title': previous.get('title'),
                    'target': {key: control[key] for key in ('text', 'role', 'type') if key in control}}
        while len(history) > 200:
            history.pop(next(iter(history)))
    session.widget_state = state
    return state


def outcome_contract_error(session, expectations, purpose):
    goal = (getattr(session,'task_context',None) or {}).get('goal','')
    if re.search(r'\b(test|check|verify)\b',goal,re.I) and re.search(r'\b(negative|invalid|validation|rejection|disabled)\b',goal,re.I):
        return ''
    if purpose != 'outcome' or not re.search(r'\b(book|reserve|purchase|buy|checkout|search|find|send|publish|delete|execute|compile|log\s*in|sign\s*in|authenticate|run\s+(?:code|program))\b',goal,re.I):
        return ''
    if expectations and all(isinstance(e,dict) and e.get('kind') in {'value','editor_value','checked','validity','focused','expanded','selected','pressed'} for e in expectations):
        return 'These checks verify input preparation only. Use purpose=checkpoint, then assert the requested results, validation response or confirmation as the outcome. Do not repeat a submission to obtain a pass.'
    return ''


async def focus_target(session, element_id):
    from .actionability import inspect_actionability
    scroll=getattr(session,'scroll_to_element',None)
    if callable(scroll):await scroll(element_id)
    actionable=await inspect_actionability(session,element_id)
    if actionable.get('disabled') or actionable.get('is_occluded') or actionable.get('reason') in {'stale_element','hidden','frame_geometry_unavailable'}:
        raise RuntimeError('Requested keyboard target is blocked or unavailable. Resolve its overlay before dispatch.')
    result = await session.evaluate("""(() => {
      const e=window.__spFast?.nodes.get(__ID__);
      if (!e?.isConnected || e.matches(':disabled') || e.closest('[inert]')) return false;
      e.focus({preventScroll:true});
      return e.getRootNode().activeElement===e;
    })()""".replace('__ID__',str(element_id)))
    if result is not True:
        raise RuntimeError('Requested keyboard target is missing, disabled or cannot be focused. No key was dispatched.')


async def choose_option(session, args):
    """Commit a native select or a whole scoped autocomplete transaction."""
    ref, wanted = args.get('element_id'), args.get('option_text')
    if type(ref) is not int or not isinstance(wanted,str) or not wanted.strip():
        return {'status':'failed','error':'choose_option requires a current input element_id and exact option_text.'}
    timeout = args.get('timeout_seconds', 3)
    if type(timeout) not in {int,float} or not .2 <= timeout <= 5:
        return {'status':'failed','error':'Autocomplete timeout must be between 0.2 and 5 seconds.'}
    if args.get('text') is not None and not isinstance(args['text'], str):
        return {'status':'failed','error':'Autocomplete text must be a string.'}
    native = await session.evaluate("""(() => {
      const input=window.__spFast?.nodes.get(__ID__);
      if (!input?.isConnected || input.tagName!=='SELECT') return null;
      return {id:__ID__,tag:'select',multiple:input.multiple,disabled:input.matches(':disabled') || input.getAttribute('aria-disabled')==='true',
        options:[...input.options].map(option=>({text:option.label||option.text,value:option.value,
          disabled:option.disabled||!!option.parentElement?.disabled,selected:option.selected}))};
    })()""".replace('__ID__',str(ref)))
    if isinstance(native, dict) and native.get('tag') == 'select':
        from .control_contract import exact_native_option
        chosen = exact_native_option(native, wanted)
        if native.get('multiple') or native.get('disabled') or chosen is None:
            return {'status':'failed','action':'choose_option',
                    'error':'No unique enabled native option matches the exact label/value, or this select needs explicit multiple selections. No choice was changed.',
                    'recovery':{'reason':'native_option_unavailable','expected_action':'select_option',
                                'element_id':ref,'multiple':native.get('multiple',False),'options':native['options'][:60]}}
        await session.select_option(ref, chosen['value'])
        return {'status':'passed','action':'choose_option','selection':chosen['text'],'value':chosen['value'],
                'already_satisfied':bool((getattr(session,'last_action_verification',None) or {}).get('already_satisfied')),
                'verification':getattr(session,'last_action_verification',None) or
                               {'verified':True,'effect_type':'control_change','description':'Exact native option selected and read back.'}}
    if args.get('text') is not None:
        await session.type_text(args['text'], element_id=ref)
    else:
        await focus_target(session,ref)
    probe = r"""(() => {
     const input=window.__spFast?.nodes.get(__ID__);
     if(!input?.isConnected) return {error:'Autocomplete input was replaced'};
     if(input.list)return {native:true,value:input.value,label:input.getAttribute('aria-label')||input.placeholder||input.name||'this field',
       options:[...input.list.options].filter(o=>!o.disabled).slice(0,100).map(o=>({id:window.__spGetOrAssignId(o),text:o.label||o.text||o.value,value:o.value}))};
     const ids=((input.getAttribute('aria-controls')||'')+' '+(input.getAttribute('aria-owns')||'')).trim().split(/\s+/).filter(Boolean);
     const roots=ids.map(id=>input.getRootNode().getElementById?.(id)||document.getElementById(id)).filter(Boolean);
     const visible=e=>e.isConnected&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none'&&e.getAttribute('aria-disabled')!=='true';
     const selector='[role="option"],.p-autocomplete-item,.ui-autocomplete-list-item,mat-option,.ant-select-item-option,.select2-results__option';
     let options=roots.length?[...new Set(roots.flatMap(root=>[...root.querySelectorAll(selector)]))].filter(visible):[];
     if(!options.length&&!roots.length) {
       let ancestor=input.parentElement;
       for(let depth=0;ancestor&&depth<4&&!options.length;depth++,ancestor=ancestor.parentElement) {
         const lists=[...ancestor.querySelectorAll('ul')].filter(visible);
         for(const list of lists) {
           options=[...list.querySelectorAll('li')].filter(e=>visible(e)&&!e.querySelector('li'));
           if(options.length)break;
         }
       }
     }
     if(!options.length) {
       const scope=input.closest('p-autocomplete')||input.getRootNode();
       options=[...scope.querySelectorAll(selector)].filter(visible);
     }
     let field=null, ancestor=input.parentElement;
     for(let depth=0;ancestor&&depth<4&&!field;depth++,ancestor=ancestor.parentElement) {
       if(!ancestor.querySelector('ul'))continue;
       field=[...(ancestor.parentElement?.children||[])].find(node=>node!==ancestor&&
         node.getClientRects().length&&node.innerText?.trim()&&node.innerText.trim().length<=140)||null;
     }
     return {label:input.getAttribute('aria-label')||input.placeholder||input.name||'this field',value:input.value,
       field_id:field?window.__spGetOrAssignId(field):null,field_text:field?.innerText?.replace(/\s+/g,' ').trim()||'',
       options:options.slice(0,30).map(e=>({id:window.__spGetOrAssignId(e),text:(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim()}))};
    })()""".replace('__ID__',str(ref))
    deadline=time.monotonic()+timeout
    state={}
    while True:
        state=await session.evaluate(probe) or {}
        if state.get('error') or state.get('options') or time.monotonic()>=deadline: break
        await asyncio.sleep(.08)
    options=state.get('options',[])
    normalize=lambda s:re.sub(r'\s+',' ',s).strip().casefold()
    exact=[o for o in options if normalize(o['text'])==normalize(wanted)]
    matches=exact or [o for o in options if normalize(wanted) in normalize(o['text'])]
    if len(matches)!=1:
        return {'status':'needs_information' if len(matches)>1 else 'failed','action':'choose_option',
          'error':'No unique current autocomplete option was found. No option was selected.',
          'question':f"Which option should I use for {state.get('label','this field')}?",
          'choices':[o['text'] for o in matches or options]}
    from ..apv_engine import ActionPerceptionVerification
    chosen=matches[0]
    if state.get('native'):
        await session.type_text(chosen['value'],element_id=ref)
    else:
        dispatched=await ActionPerceptionVerification.dispatch_two_tier_click(session,chosen['id'],label=chosen['text'],fast_mode=True)
        if not dispatched and (getattr(session,'last_actionability',{}) or {}).get('reason')=='stale_element':
            # Debounced suggestions can replace their LI between observation
            # and hit testing. No input was sent, so rebind the same unique
            # visible label once; never repeat a dispatched selection.
            fresh=await session.evaluate(probe) or {}
            same=[option for option in fresh.get('options',[])
                  if normalize(option.get('text'))==normalize(chosen['text'])]
            if len(same)==1:
                chosen=same[0]
                dispatched=await ActionPerceptionVerification.dispatch_two_tier_click(
                    session,chosen['id'],label=chosen['text'],fast_mode=True)
        if not dispatched:
            return {'status':'failed','error':'Autocomplete changed before dispatch; observe its current choices.'}
    # Blur exercises framework change/validation without Enter, which can submit a form.
    commit_probe="""(() => {
      const e=window.__spFast?.nodes.get(__ID__);
      const field=window.__spFast?.nodes.get(__FIELD__);
      return {input_connected:Boolean(e?.isConnected),value:e?.isConnected?e.value:null,
        expanded:e?.getAttribute('aria-expanded'),valid:e?.getAttribute('aria-invalid')!=='true',
        selected:window.__spFast?.nodes.get(__OPTION__)?.getAttribute('aria-selected')==='true',
        field_text:field?.isConnected?(field.innerText||'').replace(/\\s+/g,' ').trim():null};
    })()""".replace('__ID__',str(ref)).replace('__OPTION__',str(chosen['id'])).replace('__FIELD__',str(state.get('field_id') or 0))
    await session.evaluate(f"window.__spFast?.nodes.get({ref})?.blur()")
    deadline=time.monotonic()+.8
    while True:
        commit=await session.evaluate(commit_probe)
        if not commit or (commit.get('expanded')!='true' and
                (commit.get('value')!=state.get('value') or commit.get('selected') or
                 commit.get('field_text')!=state.get('field_text'))) or time.monotonic()>=deadline:break
        await asyncio.sleep(.05)
    valid=isinstance(commit,dict) and bool(commit.get('value')) and commit.get('expanded')!='true' and commit.get('valid')
    # A popup closing alone is insufficient; the input must commit the selected label/value.
    value=normalize(str((commit or {}).get('value','')))
    selected=normalize(chosen['value'] if state.get('native') else chosen['text'])
    valid=valid and (value==selected or (len(value)>=3 and (value in selected or selected in value))) and (
        (commit or {}).get('value')!=state.get('value') or (commit or {}).get('selected'))
    if not valid and not (commit or {}).get('input_connected') and state.get('field_id'):
        # React often unmounts the autocomplete input on selection. Verify the
        # nearby field's *new* display text, rather than treating the lost
        # input node as an unverified action or blindly trusting the click.
        before=state.get('field_text') or ''
        after=(commit or {}).get('field_text') or ''
        leading=chosen['text'].split(' - ',1)[0]
        expected=[part for part in re.findall(r'\w+',leading.casefold()) if len(part)>=2]
        observed=set(re.findall(r'\w+',after.casefold()))
        valid=bool(before!=after and expected and all(part in observed for part in expected))
    return {'status':'passed' if valid else 'unverified','action':'choose_option','selection':chosen['text'],
      'value':(commit or {}).get('value') or (commit or {}).get('field_text'),
      'verification':{'verified':bool(valid),'effect_type':'autocomplete_commit'}}


CALENDAR_PROBE = r"""(() => {
 const visible=e=>e?.isConnected&&e.getClientRects().length&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden';
 const roots=[...document.querySelectorAll('.ui-datepicker,.p-datepicker,.ant-picker-panel,.rdp,[role="dialog"],[class*="datepicker"],[class*="calendar"],[data-calendar]')].filter(e=>visible(e)&&e.querySelector('td,[role="gridcell"],[data-date]'));
 const root=roots.find(e=>!roots.some(other=>other!==e&&e.contains(other))); if(!root)return null;
 const text=e=>(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||'').replace(/\s+/g,' ').trim();
 const header=root.querySelector('[class*="title"],[class*="header"],[class*="caption"],[aria-live],caption')||root;
 const heading=text(header),year=Number(heading.match(/(?:^|\D)((?:19|20|21)\d{2})(?:\D|$)/)?.[1]);
 const locales=[document.documentElement.lang||'en',navigator.language||'en','en'];
 let month=0;
 for(const locale of locales)for(let m=0;m<12;m++)for(const style of ['long','short']){
   try{const name=new Intl.DateTimeFormat(locale,{month:style}).format(new Date(2020,m,1));
     if(heading.toLocaleLowerCase().includes(name.toLocaleLowerCase()))month=m+1;}catch{}
 }
 const iso=(y,m,d)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
 const dateNodes=[...root.querySelectorAll('[data-date],[datetime],td[title],td a,td span,.ant-picker-cell-inner,[role="gridcell"],button')].filter(visible);
 // A gridcell wrapping its day button is one target, not two matching dates.
 const dates=dateNodes.filter(e=>!dateNodes.some(child=>child!==e&&e.contains(child))).map(e=>{
   let raw=e.getAttribute('data-date')||e.getAttribute('datetime')||e.getAttribute('aria-label')||e.getAttribute('title')||e.closest('td[title]')?.getAttribute('title')||'',value='';
   if(/^\d{4}-\d{2}-\d{2}$/.test(raw))value=raw;
   else if(/(?:19|20|21)\d{2}/.test(raw)) {const d=new Date(raw);if(!isNaN(d))value=iso(d.getFullYear(),d.getMonth()+1,d.getDate());}
   else {const day=(e.innerText||'').trim();
     const other=e.closest('[class*="other-month"],[class*="outside"],[class*="neighboringMonth"],[data-outside="true"]');
     if(year&&month&&/^\d{1,2}$/.test(day)&&!other)value=iso(year,month,Number(day));}
   return {id:window.__spGetOrAssignId(e),date:value,disabled:e.matches(':disabled')||e.getAttribute('aria-disabled')==='true'||!!e.closest('[aria-disabled="true"],[class*="disabled"]')};
 }).filter(e=>e.date);
 const nav=[...root.querySelectorAll('button,a,[role="button"]')].filter(visible).map(e=>({id:window.__spGetOrAssignId(e),label:text(e),classes:typeof e.className==='string'?e.className:'',disabled:e.matches(':disabled')||e.getAttribute('aria-disabled')==='true'}));
 const monthNav=e=>!e.disabled&&!/\byear\b|super-prev|super-next|prev2|next2/i.test(e.label+' '+e.classes);
 return {heading,year,month,dates,previous:nav.filter(e=>monthNav(e)&&/prev|previous|back|chevron-left/i.test(e.label+' '+e.classes)),next:nav.filter(e=>monthNav(e)&&/next|forward|chevron-right/i.test(e.label+' '+e.classes))};
})()"""


async def choose_date(session, args, dispatch):
    ref,value=args.get('element_id'),args.get('value')
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',value):
        return {'status':'failed','error':'choose_date requires an actual YYYY-MM-DD date.'}
    try: requested=date.fromisoformat(value)
    except (TypeError,ValueError): return {'status':'failed','error':'choose_date requires an actual YYYY-MM-DD date.'}
    if type(ref) is not int: return {'status':'failed','error':'Choose an observed date input element_id.'}
    probe=await session.evaluate("""(() => {const e=window.__spFast?.nodes.get(__ID__);return e?.isConnected?
       {type:e.type,value:e.value,placeholder:e.placeholder||'',readonly:e.readOnly,min:e.min||'',max:e.max||'',disabled:e.matches(':disabled')}:null})()""".replace('__ID__',str(ref)))
    if not isinstance(probe,dict) or probe.get('disabled'): return {'status':'failed','error':'Date input is missing or disabled.'}
    if any(bound and re.fullmatch(r'\d{4}-\d{2}-\d{2}',bound) and
           ((kind=='min' and value<bound) or (kind=='max' and value>bound))
           for kind,bound in ((key,probe.get(key,'')) for key in ('min','max'))):
        return {'status':'failed','error':'Requested date is outside the observed allowed range. No input dispatched.'}
    if probe.get('type')=='date' or not probe.get('readonly'):
        fmt=args.get('format')
        if probe.get('type')=='date': fmt='YYYY-MM-DD'
        elif not fmt:
            hint=str(probe.get('placeholder') or probe.get('value') or '')
            if re.search(r'^\d{4}-|yyyy-mm',hint,re.I): fmt='YYYY-MM-DD'
            elif re.search(r'dd[/. -]mm',hint,re.I): fmt='DD/MM/YYYY'
            elif re.search(r'mm[/. -]dd',hint,re.I): fmt='MM/DD/YYYY'
            else:
                # Editable custom pickers can still be resolved through their calendar.
                fmt=None
        if fmt:
            formats={'YYYY-MM-DD':'%Y-%m-%d','DD/MM/YYYY':'%d/%m/%Y','MM/DD/YYYY':'%m/%d/%Y'}
            if fmt not in formats:return {'status':'failed','error':'Unsupported explicit date format.'}
            await session.type_text(requested.strftime(formats[fmt]),element_id=ref)
            await session.evaluate(f"window.__spFast?.nodes.get({ref})?.blur()")
            return await date_commit(session,ref,requested,formats[fmt])
    opened=await dispatch({'action':'click','element_id':ref})
    if opened.get('error') or opened.get('status') in {'failed','stale_element','requires_approval'}:return opened
    previous=None
    for _ in range(36):
        state=await session.evaluate(CALENDAR_PROBE)
        if not isinstance(state,dict):return {'status':'failed','error':'No observable calendar. Inspect the widget or use an explicit date format.'}
        options=[o for o in state['dates'] if o['date']==value and not o['disabled']]
        if len(options)==1:
            clicked=await dispatch({'action':'click','element_id':options[0]['id']})
            if clicked.get('status') in {'failed','requires_approval','stale_element'}:return clicked
            await session.evaluate(f"window.__spFast?.nodes.get({ref})?.blur()")
            hint=str(args.get('format') or probe.get('placeholder') or '')
            observed_format=('%d/%m/%Y' if re.search(r'dd[/. -]mm',hint,re.I) else
                             '%m/%d/%Y' if re.search(r'mm[/. -]dd',hint,re.I) else None)
            return await date_commit(session,ref,requested,observed_format)
        if len(options)>1:return {'status':'failed','error':'Calendar has duplicate matching days. No date selected; inspect current month scope.'}
        y,m=state.get('year'),state.get('month')
        if not y or not m:return {'status':'failed','error':'Calendar month/year cannot be observed. A visual observation is required.'}
        current=(y,m)
        if current==previous:return {'status':'failed','error':'Calendar navigation did not change month; no repeated click was dispatched.'}
        if current==(requested.year,requested.month):return {'status':'failed','error':'Requested date is unavailable or disabled.'}
        direction='next' if current<(requested.year,requested.month) else 'previous'
        nav=state.get(direction,[])
        if len(nav)!=1:return {'status':'failed','error':'Calendar has no unique enabled month navigation control.'}
        previous=current
        moved=await dispatch({'action':'click','element_id':nav[0]['id']})
        if moved.get('status') in {'failed','requires_approval','stale_element'}:return moved
        # Wait for the observable month transition, not a fixed animation delay.
        deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            refreshed=await session.evaluate(CALENDAR_PROBE)
            if refreshed and (refreshed.get('year'),refreshed.get('month'))!=current:break
            await asyncio.sleep(.05)
    return {'status':'failed','error':'Calendar navigation limit reached; requested date was not selected.'}


async def date_commit(session,ref,requested,expected_format=None):
    state=await session.evaluate(f"(() => {{const e=window.__spFast?.nodes.get({ref});return e?.isConnected?{{value:e.value,invalid:e.getAttribute('aria-invalid')==='true'||(e.willValidate&&!e.validity.valid)}}:null}})()")
    observed=str((state or {}).get('value',''))
    dates=[]
    # A typed date has one observed format. Never treat a swapped month/day as
    # a pass merely because a second locale could interpret it differently.
    for fmt in ((expected_format,) if expected_format else ('%Y-%m-%d','%d/%m/%Y','%m/%d/%Y')):
        try: dates.append(datetime.strptime(observed,fmt).date())
        except ValueError:pass
    verified=bool(state) and not state.get('invalid') and requested in dates
    return {'status':'passed' if verified else 'unverified','action':'choose_date','date':requested.isoformat(),
      'value':observed,'verification':{'verified':verified,'effect_type':'date_commit'}}
