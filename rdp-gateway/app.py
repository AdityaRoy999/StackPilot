"""Account-scoped RDP API and WebSocket-to-guacd bridge. One async worker."""
import asyncio
import base64
from contextlib import asynccontextmanager
import hashlib
import json
import os
from pathlib import Path
import secrets
import time
from uuid import UUID, uuid4
from http.cookies import SimpleCookie

import asyncpg
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from protocol import Reader, handshake, hostname, import_rdp, instruction, parse_instruction

BACKEND = os.environ.get('BACKEND_INTERNAL_URL', 'http://backend:8090')
GUACD = os.environ.get('GUACD_HOST', 'rdp-bridge')
GUACD_PORT = int(os.environ.get('GUACD_PORT', '4822'))
LAYOUTS = {'en-us-qwerty', 'en-gb-qwerty', 'de-de-qwertz', 'fr-fr-azerty', 'ja-jp-qwerty', 'es-es-qwerty'}
tickets, sessions = {}, {}


def cipher():
    material = os.environ.get('TOKEN_ENCRYPTION_KEY', '')
    if len(material) < 32:
        raise RuntimeError('TOKEN_ENCRYPTION_KEY must have at least 32 characters')
    return AESGCM(hashlib.sha256(material.encode()).digest())


def encrypt(value):
    nonce = secrets.token_bytes(12)
    data = cipher().encrypt(nonce, value.encode(), None)
    # Matches the backend TokenCrypto envelope, including detached GCM tag.
    return f'enc:v1:{nonce.hex()}:{data[-16:].hex()}:{data[:-16].hex()}'


def decrypt(value):
    prefix, version, nonce, tag, data = value.split(':')
    if (prefix, version) != ('enc', 'v1'):
        raise ValueError('Unsupported credential format')
    return cipher().decrypt(bytes.fromhex(nonce), bytes.fromhex(data + tag), None).decode()


def origin_allowed(origin):
    allowed = os.environ.get('RDP_ALLOWED_ORIGINS', os.environ.get('CORS_ALLOWED_ORIGIN', 'http://localhost:3000'))
    return bool(origin) and origin.rstrip('/') in {item.strip().rstrip('/') for item in allowed.split(',') if item.strip()}


def auth_headers(request):
    # Never forward arbitrary headers to the private backend.
    return {key: value for key in ('authorization', 'cookie') if (value := request.headers.get(key))}


async def authenticate(headers):
    if not headers:
        raise HTTPException(401, 'Sign in to StackPilot to use remote desktops')
    authorization = headers.get('authorization', '')
    cookie = SimpleCookie()
    try:
        cookie.load(headers.get('cookie', ''))
    except Exception:
        raise HTTPException(401, 'Invalid account session') from None
    credential = authorization[7:] if authorization.startswith('Bearer ') else cookie.get('token').value if cookie.get('token') else ''
    # Desktop control is not covered by an MCP token's read/deploy scope. Do not
    # turn an auth/me GET into broader authority over interactive desktops.
    if credential.startswith('STACKPILOT_mcp_'):
        raise HTTPException(403, 'Sign in with an interactive StackPilot account to control desktops')
    try:
        response = await app.state.http.get(BACKEND + '/api/v1/auth/me', headers=headers)
        if response.status_code != 200:
            raise HTTPException(401, 'Your StackPilot session expired')
        return UUID(response.json()['user']['id'])
    except (httpx.HTTPError, KeyError, ValueError):
        raise HTTPException(503, 'Account authentication is unavailable') from None


async def owner(request: Request):
    if request.method not in ('GET', 'HEAD'):
        if request.headers.get('x-stackpilot-csrf') != '1':
            raise HTTPException(403, 'CSRF header required')
        origin = request.headers.get('origin')
        if origin and not origin_allowed(origin):
            raise HTTPException(403, 'Origin not allowed')
    return await authenticate(auth_headers(request))


class Connection(BaseModel):
    model_config = ConfigDict(extra='forbid', hide_input_in_errors=True)
    name: str = Field(min_length=1, max_length=100)
    host: str = Field(min_length=1, max_length=253)
    port: int = Field(default=3389, ge=1, le=65535)
    username: str = Field(min_length=1, max_length=256)
    domain: str = Field(default='', max_length=256)
    password: str | None = Field(default=None, min_length=1, max_length=4096)
    security: str = 'nla'
    ignore_certificate: bool = False
    keyboard_layout: str = 'en-us-qwerty'

    @model_validator(mode='after')
    def normalize_account(self):
        if '\\' in self.username:
            domain, username = self.username.split('\\', 1)
            if not domain or not username or '\\' in username or (self.domain and self.domain.lower() != domain.lower()):
                raise ValueError('Use a single account domain and username')
            self.domain, self.username = domain, username
        return self

    @field_validator('host')
    @classmethod
    def validate_host(cls, value):
        return hostname(value)

    @field_validator('name', 'username', 'domain')
    @classmethod
    def validate_text(cls, value):
        if any(ord(char) < 32 for char in value):
            raise ValueError('Control characters are not allowed')
        return value.strip()

    @field_validator('name', 'username')
    @classmethod
    def validate_nonblank(cls, value):
        if not value:
            raise ValueError('Name and account cannot be blank')
        return value

    @field_validator('security')
    @classmethod
    def validate_security(cls, value):
        if value not in {'nla', 'tls', 'any'}:
            raise ValueError('Choose NLA, TLS, or automatic security')
        return value

    @field_validator('keyboard_layout')
    @classmethod
    def validate_layout(cls, value):
        if value not in LAYOUTS:
            raise ValueError('Unsupported keyboard layout')
        return value


def public(row):
    data = dict(row)
    data.pop('password_encrypted', None)
    data.pop('user_id', None)
    data['has_password'] = True
    return data


async def connection(identifier, user):
    row = await app.state.db.fetchrow('SELECT * FROM rdp_connections WHERE id=$1 AND user_id=$2', identifier, user)
    if not row:
        raise HTTPException(404, 'Remote desktop not found')
    return row


async def audit(user, action, identifier, metadata=None):
    await app.state.db.execute('INSERT INTO audit_logs(user_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
                               user, action, 'rdp_connection', str(identifier), json.dumps(metadata or {}))


@asynccontextmanager
async def lifespan(application):
    cipher()  # Fail closed if at-rest encryption is not configured.
    application.state.db = await asyncpg.create_pool(host=os.environ.get('DB_HOST', 'postgres'),
        port=int(os.environ.get('DB_PORT', '5432')), database=os.environ['DB_NAME'], user=os.environ['DB_USER'],
        password=os.environ['DB_PASSWORD'], min_size=1, max_size=2, command_timeout=5)
    async with application.state.db.acquire() as db:
        async with db.transaction():
            await db.execute('SELECT pg_advisory_xact_lock(8095070)')
            await db.execute(Path(__file__).with_name('schema.sql').read_text())
    application.state.http = httpx.AsyncClient(timeout=5, trust_env=False)
    yield
    for session in list(sessions.values()):
        session['stop'].set()
    await application.state.http.aclose()
    await application.state.db.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(RequestValidationError)
async def validation_error(request, error):
    # Pydantic's default JSON includes input values, including passwords.
    return JSONResponse({'detail': 'Invalid connection settings. Check the address, account, port, and security mode.'}, status_code=422)


@app.middleware('http')
async def bounded_requests(request, call_next):
    try:
        size = int(request.headers.get('content-length', '0'))
    except ValueError:
        return JSONResponse({'detail': 'Invalid request size'}, status_code=400)
    if size > 100000:
        return JSONResponse({'detail': 'Request too large'}, status_code=413)
    # Also bound chunked requests rather than trusting Content-Length.
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 100000:
            return JSONResponse({'detail': 'Request too large'}, status_code=413)
    request._body = bytes(body)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.get('/health')
async def health():
    await app.state.db.fetchval('SELECT 1')
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(GUACD, GUACD_PORT), 2)
        writer.close()
        await writer.wait_closed()
    except (OSError, asyncio.TimeoutError):
        raise HTTPException(503, 'RDP bridge unavailable') from None
    return {'status': 'ok'}


@app.get('/api/v1/rdp/connections')
async def list_connections(request: Request):
    user = await owner(request)
    rows = await app.state.db.fetch('SELECT * FROM rdp_connections WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', user)
    return {'connections': [public(row) for row in rows]}


@app.post('/api/v1/rdp/import')
async def import_file(request: Request):
    await owner(request)
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError('Invalid import request')
        if not str(data.get('filename', '')).lower().endswith('.rdp'):
            raise ValueError('Choose a .rdp file')
        return import_rdp(base64.b64decode(data.get('content', ''), validate=True))
    except (ValueError, TypeError, KeyError):
        raise HTTPException(400, 'Invalid .rdp file. Use a UTF-8 or UTF-16 .rdp file smaller than 64 KB.') from None


@app.post('/api/v1/rdp/connections', status_code=201)
async def create_connection(request: Request, data: Connection):
    user = await owner(request)
    if not data.password or not data.name or not data.username:
        raise HTTPException(400, 'Name, account, and password are required')
    async with app.state.db.acquire() as db:
        async with db.transaction():
            await db.execute('SELECT id FROM users WHERE id=$1 FOR UPDATE', user)
            if await db.fetchval('SELECT count(*) FROM rdp_connections WHERE user_id=$1', user) >= 100:
                raise HTTPException(409, 'Remote desktop connection limit reached')
            row = await db.fetchrow('INSERT INTO rdp_connections(user_id,name,host,port,username,domain,password_encrypted,security,ignore_certificate,keyboard_layout) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
                user, data.name, data.host, data.port, data.username, data.domain, encrypt(data.password), data.security, data.ignore_certificate, data.keyboard_layout)
    await audit(user, 'rdp.connection.create', row['id'])
    return {'connection': public(row)}


@app.put('/api/v1/rdp/connections/{identifier}')
async def update_connection(identifier: UUID, request: Request, data: Connection):
    user = await owner(request)
    row = await connection(identifier, user)
    password = encrypt(data.password) if data.password else row['password_encrypted']
    row = await app.state.db.fetchrow('UPDATE rdp_connections SET name=$3,host=$4,port=$5,username=$6,domain=$7,password_encrypted=$8,security=$9,ignore_certificate=$10,keyboard_layout=$11,revision=revision+1,updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *',
        identifier, user, data.name, data.host, data.port, data.username, data.domain, password, data.security, data.ignore_certificate, data.keyboard_layout)
    if not row:
        raise HTTPException(404, 'Remote desktop not found')
    stop_connection(identifier)
    await audit(user, 'rdp.connection.update', identifier)
    return {'connection': public(row)}


def stop_connection(identifier):
    for session in list(sessions.values()):
        if session['connection'] == identifier:
            session['stop'].set()
    for key, ticket in list(tickets.items()):
        if ticket['connection'] == identifier:
            tickets.pop(key, None)


@app.delete('/api/v1/rdp/connections/{identifier}')
async def delete_connection(identifier: UUID, request: Request):
    user = await owner(request)
    await connection(identifier, user)
    await app.state.db.execute('DELETE FROM rdp_connections WHERE id=$1 AND user_id=$2', identifier, user)
    stop_connection(identifier)
    await audit(user, 'rdp.connection.delete', identifier)
    return {'deleted': True}


@app.post('/api/v1/rdp/connections/{identifier}/ticket')
async def create_ticket(identifier: UUID, request: Request):
    user = await owner(request)
    row = await connection(identifier, user)
    now = time.monotonic()
    for key, ticket in list(tickets.items()):
        if ticket['expires'] < now:
            tickets.pop(key, None)
    if len(tickets) >= 128 or sum(item['user'] == user for item in tickets.values()) >= 4:
        raise HTTPException(429, 'Too many connection attempts. Try again shortly.')
    token = secrets.token_urlsafe(32)
    tickets[hashlib.sha256(token.encode()).hexdigest()] = {'user': user, 'connection': identifier,
        'revision': row['revision'], 'expires': now + 40, 'headers': auth_headers(request)}
    return {'ticket': token, 'expires_in': 40}


ERRORS = {
    '769': 'The Windows account was rejected. Check the username, password, domain, and Remote Desktop access.',
    '771': 'The RDP server denied access. Check this account’s Remote Desktop permissions.',
    '776': 'The RDP connection timed out. Check that Remote Desktop is enabled and reachable.',
    '514': 'The RDP host did not respond in time. Check its address, port, firewall, and network connection.',
    '519': 'The RDP host could not be found. Check its hostname and network connection.',
}


def error_message(code):
    return ERRORS.get(str(code), 'RDP connection failed. Check the host, credentials, security mode, and certificate settings.')


@app.websocket('/ws/rdp')
async def desktop(websocket: WebSocket):
    if not origin_allowed(websocket.headers.get('origin')) or 'guacamole' not in websocket.scope.get('subprotocols', []):
        await websocket.close(code=1008)
        return
    token = websocket.query_params.get('ticket', '')
    ticket = tickets.pop(hashlib.sha256(token.encode()).hexdigest(), None)
    if not ticket or ticket['expires'] < time.monotonic():
        await websocket.close(code=1008)
        return
    writer, tasks, identifier = None, [], uuid4()
    await websocket.accept(subprotocol='guacamole')
    try:
        user = await authenticate(ticket['headers'])
        if user != ticket['user']:
            raise HTTPException(403, 'Account changed')
        row = await connection(ticket['connection'], user)
        if row['revision'] != ticket['revision']:
            raise HTTPException(403, 'Connection changed')
        if len(sessions) >= 32 or sum(item['user'] == user for item in sessions.values()) >= 2:
            raise HTTPException(429, 'Two desktops are already open. Disconnect one first.')
        width = max(320, min(3840, int(websocket.query_params.get('width', '1280'))))
        height = max(240, min(2160, int(websocket.query_params.get('height', '720'))))
        session = {'user': user, 'connection': row['id'], 'stop': asyncio.Event()}
        sessions[identifier] = session
        stream, writer = await asyncio.wait_for(asyncio.open_connection(GUACD, GUACD_PORT), 5)
        reader = Reader(stream)
        await asyncio.wait_for(handshake(reader, writer, row, decrypt(row['password_encrypted']), width, height), 25)
        # WebSocketTunnel uses the empty opcode for its tunnel UUID / keepalive.
        await websocket.send_text(instruction('', str(identifier)))
        await audit(user, 'rdp.session.start', row['id'])

        async def downstream():
            while True:
                parts = await asyncio.wait_for(reader.read(), 30)
                if parts[0] == 'error':
                    await websocket.send_text(instruction('error', error_message(parts[-1]), parts[-1]))
                    return
                await websocket.send_text(instruction(*parts))

        async def upstream():
            buffer = ''
            while True:
                buffer += await websocket.receive_text()
                if len(buffer) > 262144:
                    raise ValueError('Input too large')
                while (parsed := parse_instruction(buffer)):
                    parts, count = parsed
                    buffer = buffer[count:]
                    opcode = parts[0]
                    if opcode == '':
                        await websocket.send_text(instruction(*parts))
                        continue
                    limits = {'mouse': 4, 'key': 3, 'size': 3, 'sync': 2, 'ack': 4, 'disconnect': 1, 'nop': 1}
                    if opcode not in limits or len(parts) != limits[opcode]:
                        raise ValueError('Unsupported desktop input')
                    if opcode in {'mouse', 'key', 'size', 'sync'}:
                        if any(not re_number(part, signed=opcode == 'mouse') for part in parts[1:]):
                            raise ValueError('Invalid desktop input')
                    if opcode == 'size' and not (320 <= int(parts[1]) <= 3840 and 240 <= int(parts[2]) <= 2160):
                        raise ValueError('Invalid desktop size')
                    writer.write(instruction(*parts).encode())
                    await writer.drain()

        async def authorization_watch():
            deadline = time.monotonic() + 4 * 3600
            while time.monotonic() < deadline:
                try:
                    await asyncio.wait_for(session['stop'].wait(), 10)
                    return
                except asyncio.TimeoutError:
                    await authenticate(ticket['headers'])
                    current = await connection(row['id'], user)
                    if current['revision'] != row['revision']:
                        return

        tasks = [asyncio.create_task(downstream()), asyncio.create_task(upstream()), asyncio.create_task(authorization_watch())]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except (WebSocketDisconnect, EOFError):
        pass
    except HTTPException as error:
        await safe_error(websocket, str(error.detail))
    except ConnectionError as error:
        await safe_error(websocket, error_message(str(error)))
    except (OSError, ValueError, asyncio.TimeoutError):
        await safe_error(websocket, 'Could not connect to the remote desktop. Check the address, credentials, certificate, and RDP service.')
    except Exception:
        await safe_error(websocket, 'Remote desktop service is unavailable. Try connecting again.')
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if writer:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), 2)
            except (OSError, asyncio.TimeoutError):
                pass
        session = sessions.pop(identifier, None)
        if session:
            try:
                await audit(session['user'], 'rdp.session.end', session['connection'])
            except (asyncpg.PostgresError, OSError, asyncio.TimeoutError):
                # Account deletion or a database outage must not prevent socket
                # cleanup. Never include credentials or request URLs in logs.
                import logging
                logging.getLogger(__name__).warning('RDP session-end audit could not be recorded')
        try:
            await websocket.close()
        except (RuntimeError, WebSocketDisconnect):
            pass


def re_number(value, signed=False):
    return bool(value) and len(value) <= 16 and (value.lstrip('-') if signed else value).isdecimal()


async def safe_error(websocket, message):
    try:
        await websocket.send_text(instruction('error', message, '512'))
    except (RuntimeError, WebSocketDisconnect):
        pass
