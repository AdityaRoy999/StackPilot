"""Viewport geometry and occlusion across Chromium frame process boundaries."""


async def frame_offset(session, frame_id, visiting=None):
    if frame_id==session._main_frame_id:return (0,0)
    visiting=set(visiting or ())
    if frame_id in visiting or len(visiting)>=16:raise RuntimeError('Frame ancestry is cyclic or too deep.')
    visiting.add(frame_id)
    parent=session.frame_parents.get(frame_id,session._main_frame_id)
    parent_session=session.frame_contexts.get(parent,{}).get('session_id')
    owner=await session.send_command('DOM.getFrameOwner',{'frameId':frame_id},cdp_session_id=parent_session)
    box=await session.send_command('DOM.getBoxModel',{'backendNodeId':owner['backendNodeId']},cdp_session_id=parent_session)
    quad=box['model']['content']
    x,y=quad[:2]
    if len(quad)!=8 or abs(quad[1]-quad[3])>.5 or abs(quad[0]-quad[6])>.5:
        raise RuntimeError('Rotated or skewed frame geometry requires a visual handler.')
    context=session.frame_contexts.get(frame_id,{})
    if context.get('context_id'):
        viewport=await session.send_command('Runtime.evaluate',{'expression':'({width:innerWidth,height:innerHeight})',
            'contextId':context['context_id'],'returnByValue':True},cdp_session_id=context.get('session_id'))
        size=viewport.get('result',{}).get('value',{})
        if size and (abs(quad[2]-quad[0]-size['width'])>1 or abs(quad[7]-quad[1]-size['height'])>1):
            raise RuntimeError('Scaled frame geometry requires a visual handler.')
    if parent_session:
        root=session.frame_session_roots.get(parent_session)
        if not root:raise RuntimeError('Parent frame process root is unavailable.')
        ox,oy=await frame_offset(session,root,visiting)
        x+=ox;y+=oy
    return x,y


async def frame_point_is_clear(session,frame_id,x,y):
    """Check every process root, including covering elements outside the child."""
    target_session=session.frame_contexts[frame_id].get('session_id')
    roots=[]
    sid=target_session
    seen=set()
    while sid:
        if sid in seen or len(seen)>=16:raise RuntimeError('Invalid frame process ancestry.')
        seen.add(sid)
        root=session.frame_session_roots.get(sid)
        if not root:raise RuntimeError('Frame process root is unavailable.')
        roots.append((sid,root))
        parent=session.frame_parents.get(root,session._main_frame_id)
        sid=session.frame_contexts.get(parent,{}).get('session_id')
    roots.append((None,session._main_frame_id))
    roots.reverse()
    for index,(sid,root) in enumerate(roots):
        ox,oy=await frame_offset(session,root)
        hit=await session.send_command('DOM.getNodeForLocation',{'x':round(x-ox),'y':round(y-oy)},cdp_session_id=sid)
        if index==len(roots)-1:
            return hit.get('frameId')==frame_id
        boundary=roots[index+1][1]
        owner=await session.send_command('DOM.getFrameOwner',{'frameId':boundary},cdp_session_id=sid)
        # Some Chromium versions pierce the process boundary; others return
        # its iframe owner. Both must belong to this observed frame chain.
        ancestry=set()
        ancestor=frame_id
        while ancestor and ancestor not in ancestry:
            ancestry.add(ancestor)
            if ancestor==boundary:break
            ancestor=session.frame_parents.get(ancestor)
        if hit.get('backendNodeId')!=owner.get('backendNodeId') and hit.get('frameId') not in ancestry:
            return False
    return False
