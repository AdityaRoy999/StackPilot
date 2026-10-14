"""Dashboard access uses the existing short-lived, chat-bound browser ticket."""
import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from typing import Literal

from ..browser_ticket import verify, remote_device_active
from .campaigns import get_campaign_runtime

PREFIX='/ws/browser/{session_id}/campaigns'


def router(service_key):
    async def identity(request:Request,session_id:str):
        try:
            claims=verify(request.headers.get('x-stackpilot-browser-ticket',''),session_id,service_key)
            if not await asyncio.to_thread(remote_device_active,claims): raise ValueError('Remote device revoked')
            return claims
        except ValueError: raise HTTPException(401,'Browser capability expired or unavailable') from None

    api=APIRouter()

    async def owned(claims,session_id,campaign_id):
        runtime=get_campaign_runtime()
        try:
            await asyncio.to_thread(runtime.store.job,campaign_id,claims['user_id'],session_id)
        except PermissionError: raise HTTPException(404,'Campaign unavailable') from None
        return runtime

    @api.get(PREFIX+'/{campaign_id}')
    async def status(session_id:str,campaign_id:str,after:int=0,claims=Depends(identity)):
        runtime=await owned(claims,session_id,campaign_id)
        return await asyncio.to_thread(runtime.store.status,campaign_id,claims['user_id'],session_id,max(0,after))

    class Control(BaseModel):
        model_config=ConfigDict(extra='forbid')
        action:Literal['pause','resume','cancel','reconcile','answer']
        message:str=''
        approval_token:str=''

    @api.post(PREFIX+'/{campaign_id}/control')
    async def control(session_id:str,campaign_id:str,body:Control,claims=Depends(identity)):
        if not claims['control']: raise HTTPException(403,'Campaign control requires chat administration access')
        runtime=await owned(claims,session_id,campaign_id)
        try: return await runtime.control(campaign_id,claims['user_id'],body.action,session_id,message=body.message,approval_token=body.approval_token)
        except ValueError as exc: raise HTTPException(409,str(exc)) from None

    @api.get(PREFIX+'/{campaign_id}/report')
    async def report(session_id:str,campaign_id:str,offset:int=0,claims=Depends(identity)):
        runtime=await owned(claims,session_id,campaign_id)
        tasks=await asyncio.to_thread(runtime.store.results,campaign_id,claims['user_id'],session_id,max(0,offset))
        # The durable ledger retains detailed cases. Dashboard summaries avoid
        # rendering every observation/control tree across hundreds of pages.
        summaries=[{**task,'result':{key:(task['result'] or {}).get(key) for key in ('summary','status','verified','passed_outcome_checks','error')}} for task in tasks]
        return {'exhaustive':False,'tasks':summaries,'next_offset':max(0,offset)+100 if len(tasks)==100 else None}

    @api.get(PREFIX+'/{campaign_id}/recording')
    async def recording(session_id:str,campaign_id:str,after:int=0,claims=Depends(identity)):
        runtime=await owned(claims,session_id,campaign_id)
        frames=await asyncio.to_thread(runtime.store.frames,campaign_id,claims['user_id'],session_id,max(0,after))
        return {'frames':frames,'next_after':frames[-1]['sequence'] if len(frames)==1000 else None}

    @api.get(PREFIX+'/{campaign_id}/recording/{sequence}')
    async def frame(session_id:str,campaign_id:str,sequence:int,claims=Depends(identity)):
        runtime=await owned(claims,session_id,campaign_id)
        try: data=await asyncio.to_thread(runtime.store.read_frame,campaign_id,claims['user_id'],sequence,session_id)
        except ValueError: raise HTTPException(404,'Recording frame unavailable') from None
        return Response(data,media_type='image/jpeg',headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'})

    return api
