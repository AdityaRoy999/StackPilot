"""Deliver a fixed repository command, never a browser-selected shell command.

Interactive sessions run in their deployment container with bounded lifetimes.
Finite jobs run once; readiness requires an actual successful exit status.
"""
import errno
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_OUTPUT = 128 * 1024
MAX_SESSIONS = 4
IDLE_SECONDS = 90
PAGE = '''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Application console</title>
<style>body{background:#111;color:#eee;font:16px system-ui;margin:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;min-height:50vh;font:14px monospace}input{width:70%;padding:12px}button{padding:12px;margin:6px}#status{color:#aaa}</style></head>
<body><h1>Application console</h1><p id="status">Connecting to the original program…</p><pre id="output" role="log" aria-live="polite"></pre>
<form id="form"><input id="input" aria-label="Program input" autocomplete="off"><button>Send</button></form><button id="restart">Restart program</button>
<script>let id=null,offset=0,busy=false;const out=document.getElementById('output'),status=document.getElementById('status');
async function call(path,body){let r=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});let x=await r.json();if(!r.ok)throw Error(x.error||'Console request failed');return x}
async function start(){if(id)await call('/console/close',{session_id:id});out.textContent='';offset=0;let x=await call('/console/open',{});id=x.session_id;status.textContent='Program started';}
async function poll(){if(busy)return;busy=true;try{if(!id)await start();let x=await call('/console/read?session_id='+id+'&offset='+offset);out.textContent+=x.output;offset=x.offset;status.textContent=x.exit_code===null?'Program running':('Program exited with code '+x.exit_code);document.getElementById('input').disabled=x.exit_code!==null;document.getElementById('input').focus();}catch(e){status.textContent=e.message;}finally{busy=false}}
document.getElementById('form').onsubmit=async e=>{e.preventDefault();try{await call('/console/input',{session_id:id,input:document.getElementById('input').value+'\n'});document.getElementById('input').value='';await poll()}catch(e){status.textContent=e.message}};
document.getElementById('restart').onclick=async()=>{try{await start();document.getElementById('input').disabled=false;await poll()}catch(e){status.textContent=e.message}};
setInterval(poll,300);poll();</script></body></html>'''
# Keep the JavaScript escape intact inside this Python string.
PAGE = PAGE.replace("value+'\n'", "value+'\\n'")


class Process:
    def __init__(self, command, *, interactive=True, deadline=3600):
        if type(deadline) is not int or not 1 <= deadline <= 86400:
            raise ValueError('Execution deadline must be between 1 and 86400 seconds')
        self.output = bytearray()
        self.base = 0
        self.lock = threading.Lock()
        self.touched = time.monotonic()
        self.closed = False
        self.interactive = interactive
        self.timed_out = False
        self.cancelled = False
        self.execution_id = uuid.uuid4().hex
        self.started_at = time.time()
        self.started_monotonic = time.monotonic()
        self.finished_at = None
        self.deadline = deadline
        self.command_sha256 = hashlib.sha256(json.dumps(command,separators=(',',':')).encode()).hexdigest()
        self.collected = threading.Event()
        self.logged = 0
        self.master = None
        env = {**os.environ, 'PYTHONUNBUFFERED': '1', 'TERM': 'dumb'}
        if interactive:
            import pty
            import termios
            self.master, slave = pty.openpty()
            settings = termios.tcgetattr(slave)
            settings[3] &= ~termios.ECHO
            termios.tcsetattr(slave, termios.TCSANOW, settings)
            try:
                self.process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                                                start_new_session=True, env=env, close_fds=True)
            except BaseException:
                os.close(self.master)
                raise
            finally:
                os.close(slave)
        else:
            self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                            stderr=subprocess.STDOUT, start_new_session=True, env=env)
        threading.Thread(target=self.collect, daemon=True).start()
        if not interactive:
            threading.Thread(target=self.limit, args=(deadline,), daemon=True).start()

    def collect(self):
        try:
            while True:
                chunk = os.read(self.master if self.interactive else self.process.stdout.fileno(), 4096)
                if not chunk:
                    break
                if not self.interactive and self.logged < MAX_OUTPUT:
                    visible = chunk[:MAX_OUTPUT-self.logged]
                    sys.stdout.buffer.write(visible)
                    sys.stdout.buffer.flush()
                    self.logged += len(visible)
                with self.lock:
                    self.output.extend(chunk)
                    excess = max(0, len(self.output)-MAX_OUTPUT)
                    if excess:
                        del self.output[:excess]
                        self.base += excess
        except OSError as exc:
            if exc.errno not in {errno.EIO, errno.EBADF}:
                raise
        finally:
            self.process.wait()
            if self.interactive:
                try: os.close(self.master)
                except OSError: pass
            else:
                self.process.stdout.close()
            self.finished_at = time.time()
            self.collected.set()

    def limit(self, deadline):
        remaining=max(0,deadline-(time.monotonic()-self.started_monotonic))
        # Descendants can keep stdout open after the parent exits. Bound the
        # entire collection lifecycle as well as the original process exit.
        if not self.collected.wait(timeout=remaining):
            self.timed_out = True
            self.close(cancelled=False)

    def read(self, offset=0):
        self.touched = time.monotonic()
        with self.lock:
            if offset < 0 or offset > self.base+len(self.output):
                raise ValueError('Invalid output offset')
            start = max(offset-self.base, 0)
            exit_code = self.process.poll() if self.collected.is_set() else None
            result = {'output': bytes(self.output[start:]).decode('utf-8', errors='replace'),
                    'offset': self.base+len(self.output), 'truncated': offset < self.base,
                    'exit_code': exit_code, 'timed_out': self.timed_out}
            if not self.interactive:
                state = ('timed_out' if self.timed_out else 'cancelled' if self.cancelled else
                         'running' if exit_code is None else 'completed' if exit_code == 0 else 'failed')
                result.update({'execution_id':self.execution_id,'state':state,'started_at':self.started_at,
                               'finished_at':self.finished_at if self.collected.is_set() else None,
                               'deadline_at':self.started_at+self.deadline,'timeout_seconds':self.deadline,
                               'command_sha256':self.command_sha256,
                               'elapsed_seconds':round(time.monotonic()-self.started_monotonic,3) if self.finished_at is None else
                                                 round(self.finished_at-self.started_at,3)})
            return result

    def send(self, value):
        if not self.interactive or self.closed or self.process.poll() is not None:
            raise ValueError('Program is no longer accepting input')
        data = value.encode('utf-8')
        if not 0 < len(data) <= 4096:
            raise ValueError('Input must be between 1 and 4096 bytes')
        self.touched = time.monotonic()
        os.write(self.master, data)

    def close(self, *, cancelled=True):
        if cancelled and self.process.poll() is None:
            self.cancelled = True
        self.closed = True
        # Kill descendants even if the parent has already exited.
        try: os.killpg(self.process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        self.process.wait(timeout=5)


class Console:
    def __init__(self, command, workload='cli', deadline=3600):
        if not isinstance(command, list) or not command or not command[0] or any(not isinstance(a, str) or '\0' in a for a in command):
            raise ValueError('Console requires a fixed executable argument array')
        self.command, self.workload = command, workload
        self.sessions, self.lock = {}, threading.Lock()
        self.job = Process(command, interactive=False, deadline=deadline) if workload == 'job' else None

    def reap(self):
        with self.lock:
            expired = [key for key, process in self.sessions.items() if time.monotonic()-process.touched > IDLE_SECONDS]
            for key in expired:
                self.sessions.pop(key).close()

    def open(self):
        self.reap()
        if self.job:
            return 'job'
        with self.lock:
            if len(self.sessions) >= MAX_SESSIONS:
                raise ValueError('Console session capacity reached; close an existing session')
            key = uuid.uuid4().hex
            self.sessions[key] = Process(self.command)
            return key

    def session(self, key):
        if not isinstance(key,str): raise ValueError('Console session identity must be text')
        if self.job and key == 'job': return self.job
        with self.lock:
            process = self.sessions.get(key)
        if process is None: raise ValueError('Console session expired or unknown')
        return process

    def close(self, key):
        if not isinstance(key,str): raise ValueError('Console session identity must be text')
        if self.job: return
        with self.lock:
            process = self.sessions.pop(key, None)
        if process: process.close()

    def shutdown(self):
        if self.job:self.job.close()
        with self.lock:
            sessions=list(self.sessions.values());self.sessions.clear()
        for process in sessions:process.close()


def serve(command, workload='cli', port=3000, deadline=3600):
    console = Console(command, workload, deadline)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def reply(self, status, value, html=False):
            data = value.encode() if html else json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'text/html; charset=utf-8' if html else 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(data)
        def do_GET(self):
            from urllib.parse import parse_qs
            path = urlsplit(self.path)
            try:
                if path.path == '/':
                    page = PAGE
                    if console.job:
                        page=page.replace('Application console','Repository job')
                        page=page.replace('<form id="form">','<form id="form" hidden>')
                        page=page.replace('<button id="restart">','<button id="restart" hidden>')
                    self.reply(200, page, True)
                elif path.path == '/healthz':
                    result = console.job.read() if console.job else {}
                    ready = not console.job or result['state']=='completed'
                    # HTTP liveness permits a long-running job to start. The
                    # independent job verifier still requires a completed exit.
                    self.reply(200, {'workload': workload, 'ready': ready, **result})
                elif path.path == '/job/status' and console.job:
                    self.reply(200, {'workload':'job',**console.job.read()})
                elif path.path == '/console/read':
                    args = parse_qs(path.query)
                    self.reply(200, console.session(args.get('session_id', [''])[0]).read(int(args.get('offset', ['0'])[0])))
                else: self.reply(404, {'error': 'Unknown route'})
            except (ValueError, OSError) as exc: self.reply(400, {'error': str(exc)})
        def do_POST(self):
            try:
                origin = self.headers.get('Origin')
                if origin and urlsplit(origin).netloc != self.headers.get('Host'):
                    raise ValueError('Cross-origin console requests refused')
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                    raise ValueError('JSON input required')
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 8192: raise ValueError('Request size exceeds console bounds')
                self.connection.settimeout(5)
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict): raise ValueError('JSON object required')
                if self.path == '/console/open': self.reply(200, {'session_id': console.open()})
                elif self.path == '/console/input':
                    value = body.get('input')
                    if not isinstance(value, str): raise ValueError('Input must be text')
                    console.session(body.get('session_id')).send(value)
                    self.reply(200, {'accepted': True})
                elif self.path == '/console/close':
                    console.close(body.get('session_id')); self.reply(200, {'closed': True})
                else: self.reply(404, {'error': 'Unknown route'})
            except (ValueError, OSError) as exc: self.reply(400, {'error': str(exc)})
    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    def janitor():
        while True:
            time.sleep(10)
            console.reap()
    threading.Thread(target=janitor, daemon=True).start()
    if threading.current_thread() is threading.main_thread():
        def stop(*_):threading.Thread(target=server.shutdown,daemon=True).start()
        signal.signal(signal.SIGTERM,stop)
        signal.signal(signal.SIGINT,stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        console.shutdown()


if __name__ == '__main__':
    root = Path.cwd()
    plan = json.loads((root/'.stackpilot-plan.json').read_text())
    config = json.loads((root/'stackpilot.json').read_text()) if (root/'stackpilot.json').is_file() else {}
    command = plan.get('runtime_command') or config.get('build_recipe', {}).get('runtime_command') or plan.get('entrypoint') or json.loads((root/'.stackpilot-entry.json').read_text())
    serve(command, plan['workload'], int(os.getenv('PORT', '3000')), plan.get('job_timeout_seconds', 3600))
