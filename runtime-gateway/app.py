"""Stable local origins. The active route switches in the promotion transaction.

This gateway is loopback-only in the local stack. Production requires its own
configured preview domain, TLS and tenant access policy before exposure.
"""
import asyncio
import os
import re
from urllib.parse import urlsplit,urlunsplit
import httpx
import psycopg2
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import Response, StreamingResponse
import websockets

app=FastAPI(docs_url=None,redoc_url=None,openapi_url=None)
HOP={'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length'}
SUFFIX=os.getenv('STACKPILOT_PREVIEW_HOST_SUFFIX','.preview.localhost')


def environment(host):
    value=host.split(':')[0].lower()
    if not value.endswith(SUFFIX):return None
    identity=value[:-len(SUFFIX)]
    return identity if re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',identity) else None


def route(identity):
    connection=psycopg2.connect(host=os.getenv('DB_HOST','postgres'),port=os.getenv('DB_PORT','5432'),
        user=os.environ['DB_USER'],password=os.environ['DB_PASSWORD'],dbname=os.environ['DB_NAME'],connect_timeout=3)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT upstream_url,generation FROM environment_runtime_routes WHERE environment_id=%s AND verification->>'verified'='true'",(identity,))
            result=cursor.fetchone()
        if not result:return None
        parts=urlsplit(result[0])
        # The local lane may route only allocated loopback HTTP runtimes.
        if parts.scheme not in {'http','https'} or parts.hostname not in {'localhost','127.0.0.1','host.docker.internal'} or not parts.port or parts.username:return None
        return (urlunsplit((parts.scheme,'host.docker.internal:'+str(parts.port),'','','')),result[1])
    finally:connection.close()


@app.get('/healthz')
async def health(request:Request):
    if environment(request.headers.get('host','')):return await forward('healthz',request)
    return {'status':'ok','service':'runtime-gateway'}


@app.api_route('/{path:path}',methods=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'])
async def forward(path:str,request:Request):
    identity=environment(request.headers.get('host',''))
    if not identity:return Response('Unknown preview origin',status_code=404)
    try:target=await asyncio.to_thread(route,identity)
    except Exception:return Response('Runtime routing unavailable',status_code=503)
    if not target:return Response('No verified release has been promoted',status_code=503)
    upstream,generation=target
    headers={k:v for k,v in request.headers.items() if k.lower() not in HOP and k.lower() not in {'host','accept-encoding'}}
    headers['host']=request.headers['host'];headers['x-forwarded-host']=request.headers['host']
    headers['x-forwarded-proto']=request.url.scheme
    client=httpx.AsyncClient(timeout=httpx.Timeout(30,connect=5),follow_redirects=False,trust_env=False)
    try:
        url=upstream+'/'+path+('?' + request.url.query if request.url.query else '')
        response=await client.send(client.build_request(request.method,url,headers=headers,content=request.stream()),stream=True)
        output=[(k,v) for k,v in response.headers.multi_items() if k.lower() not in HOP]
        # Preserve repeated Set-Cookie headers and the application origin.
        output=[(k,v.replace(upstream,str(request.base_url).rstrip('/')) if k.lower()=='location' and v.startswith(upstream+'/') else v) for k,v in output]
        async def chunks():
            try:
                async for chunk in response.aiter_raw():yield chunk
            finally:await response.aclose();await client.aclose()
        result=StreamingResponse(chunks(),status_code=response.status_code)
        result.raw_headers=[(k.encode('latin-1'),v.encode('latin-1')) for k,v in output]
        result.headers['x-stackpilot-route-generation']=str(generation)
        return result
    except Exception:
        await client.aclose();return Response('Promoted runtime is unreachable',status_code=502)


@app.websocket('/{path:path}')
async def socket(path:str,websocket:WebSocket):
    identity=environment(websocket.headers.get('host',''))
    try:target=await asyncio.to_thread(route,identity) if identity else None
    except Exception:target=None
    if not target:await websocket.close(code=1008);return
    upstream,_=target;url=upstream.replace('http','ws',1)+'/'+path+('?' + websocket.url.query if websocket.url.query else '')
    headers={k:v for k,v in websocket.headers.items() if k.lower() in {'cookie','origin','authorization'}}
    protocols=[p.strip() for p in websocket.headers.get('sec-websocket-protocol','').split(',') if p.strip()]
    try:
        async with websockets.connect(url,additional_headers=headers,subprotocols=protocols,open_timeout=5,max_size=8*1024**2) as remote:
            await websocket.accept(subprotocol=remote.subprotocol)
            async def inbound():
                while True:
                    message=await websocket.receive()
                    if message['type']=='websocket.disconnect':return
                    await remote.send(message.get('bytes') if message.get('bytes') is not None else message['text'])
            async def outbound():
                async for message in remote:
                    if isinstance(message,bytes):await websocket.send_bytes(message)
                    else:await websocket.send_text(message)
            tasks=[asyncio.create_task(inbound()),asyncio.create_task(outbound())]
            try:await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:task.cancel()
                await asyncio.gather(*tasks,return_exceptions=True)
    except Exception:
        try:await websocket.close(code=1011)
        except RuntimeError:pass
