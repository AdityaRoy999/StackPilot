"""Own a Chromium storage context per agent session, without touching user tabs."""
import asyncio
import json
from urllib.parse import urlparse

import httpx
import websockets


async def browser_command(endpoint, method, params=None, headers=None):
    async with httpx.AsyncClient(timeout=6, trust_env=False, headers={'Host':'localhost', **(headers or {})}) as client:
        response = await client.get(endpoint+'/json/version')
        response.raise_for_status()
        raw = response.json()['webSocketDebuggerUrl']
    address = 'ws://'+urlparse(endpoint).netloc+'/devtools/'+raw.split('/devtools/')[1]
    async with websockets.connect(address,max_size=1024*1024, additional_headers=headers) as socket:
        return await command(socket,method,params)


async def command(socket,method,params=None,serial=1):
    await socket.send(json.dumps({'id':serial,'method':method,'params':params or {}}))
    async with asyncio.timeout(6):
        async for raw in socket:
            result = json.loads(raw)
            if result.get('id') != serial:
                continue
            if result.get('error'):
                raise RuntimeError('Browser context command failed: '+method)
            return result.get('result',{})
    raise RuntimeError('Browser context command disconnected: '+method)


async def open_context_owner(endpoint, headers=None):
    async with httpx.AsyncClient(timeout=6, trust_env=False, headers={'Host': 'localhost', **(headers or {})}) as client:
        response = await client.get(endpoint + '/json/version')
        response.raise_for_status()
        raw = response.json()['webSocketDebuggerUrl']
    address = 'ws://' + urlparse(endpoint).netloc + '/devtools/' + raw.split('/devtools/')[1]
    return await websockets.connect(address, max_size=1024 * 1024, additional_headers=headers)


async def create_isolated_target(endpoint, owner_socket=None, headers=None, fullscreen=True):
    async def call(method, params=None):
        if owner_socket is not None:
            return await command(owner_socket, method, params)
        return await browser_command(endpoint, method, params, **({"headers": headers} if headers else {}))
    # The persistent owner connection survives individual CDP calls. Chrome
    # disposes this context itself if the worker crashes or loses that connection.
    context = await call('Target.createBrowserContext', {'disposeOnDetach': True} if owner_socket is not None else None)
    context_id = context['browserContextId']
    try:
        target = await call('Target.createTarget',
            {'url':'about:blank','browserContextId':context_id})
        # A new incognito context opens a separate window. It does not inherit
        # the startup window's kiosk geometry; toolbar offsets would make the
        # desktop stream disagree with CDP input/screenshot coordinates.
        if fullscreen:
            window = await call('Browser.getWindowForTarget',{'targetId':target['targetId']})
            await call('Browser.setWindowBounds',
                {'windowId':window['windowId'],'bounds':{'windowState':'fullscreen'}})
        return context_id,target['targetId']
    except BaseException:
        try:
            await call('Target.disposeBrowserContext',{'browserContextId':context_id})
        except Exception:
            pass
        raise


async def dispose_context(endpoint,context_id,headers=None):
    if context_id:
        await browser_command(endpoint,'Target.disposeBrowserContext',{'browserContextId':context_id},headers)
