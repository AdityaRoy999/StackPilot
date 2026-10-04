"""Durable evidence journal; intentionally stores no prompts, credentials or values.

An interrupted command is uncertain, never an instruction to replay it. Browser
RAM and cookies are not recovered by this journal.
"""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid
from contextlib import contextmanager


def owner_key(user_id,session_id):
    return hashlib.sha256(json.dumps([user_id or '',session_id],separators=(',',':')).encode()).hexdigest()


class RunJournal:
    def __init__(self,path=None):
        self.path = Path(path or os.getenv('STACKPILOT_AGENT_RUN_DB') or
                         Path(__file__).resolve().parents[1]/'.runtime'/'browser-runs.sqlite3')
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with self.connection() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, goal_hash TEXT NOT NULL, state TEXT NOT NULL, updated REAL NOT NULL, pending TEXT NOT NULL, checks INTEGER NOT NULL DEFAULT 0)')
            db.execute('CREATE INDEX IF NOT EXISTS runs_owner ON runs(owner,updated)')
            db.execute('CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, serial INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id,serial))')

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path,timeout=5)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA synchronous=FULL')
            with db:
                yield db
        finally:
            db.close()

    def previous(self,owner):
        with self.connection() as db:
            # A later no-op or failed run must not hide an earlier command whose
            # outcome was never received. Keep it visible until reconciled.
            unresolved = db.execute("SELECT id,state,pending,checks FROM runs WHERE owner=? AND pending!='[]' ORDER BY updated DESC LIMIT 1",(owner,)).fetchone()
            if unresolved:
                return dict(unresolved)
            row = db.execute('SELECT id,state,pending,checks FROM runs WHERE owner=? ORDER BY updated DESC LIMIT 1',(owner,)).fetchone()
        if not row or (not json.loads(row['pending']) and row['state'] in {'verified','waiting_for_user','unverified','stopped'}):
            return None
        return dict(row)

    def start(self,owner,goal):
        run_id = str(uuid.uuid4())
        with self.connection() as db:
            db.execute('INSERT INTO runs(id,owner,goal_hash,state,updated,pending) VALUES(?,?,?,?,?,?)',
                (run_id,owner,hashlib.sha256(goal.encode()).hexdigest(),'observing',time.time(),'[]'))
        return run_id

    def record(self,run_id,event):
        kind = event.get('type')
        allowed = {'tool_call','tool_result','browser_timing','permission_request','agent_question','done','interrupted'}
        if kind not in allowed:
            return
        with self.connection() as db:
            row = db.execute('SELECT state,pending,checks FROM runs WHERE id=?',(run_id,)).fetchone()
            pending = json.loads(row['pending'])
            state,checks = row['state'],row['checks']
            safe = {}
            if kind == 'tool_call' and str(event.get('name','')).startswith('browser_'):
                # Only IDs, tool names and an opaque argument digest are saved.
                # Raw action text, URLs, selectors and assertion values stay out.
                safe = {'call_id':str(event.get('id','')),'tool':event['name'],
                        'argument_hash':hashlib.sha256(json.dumps(event.get('arguments',{}),sort_keys=True).encode()).hexdigest()}
                pending.append(safe)
                state = 'executing'
            elif kind == 'tool_result' and str(event.get('name','')).startswith('browser_'):
                result = event.get('result') or {}
                pending = [p for p in pending if p['call_id'] != str(event.get('id',''))]
                from ..testing_runtime import action_status
                status = action_status(result)
                outcomes = result.get('assertions',[]) + [a for step in result.get('results',[]) for a in step.get('assertions',[])]
                checks += sum(a.get('status') == 'passed' for a in outcomes)
                safe = {'call_id':str(event.get('id','')),'tool':event['name'],'status':status,'passed_checks':checks}
                state = 'recovering' if status == 'failed' else 'observing'
            elif kind == 'browser_timing':
                safe = {k:event[k] for k in ('phase','iteration','elapsed_ms','first_delta_ms','tool_count','finish_reason','model') if k in event}
                if event.get('phase') == 'planner':
                    state = 'planning'
            elif kind in {'permission_request','agent_question'}:
                state = 'waiting_for_user'
            elif kind == 'done':
                state = 'verified' if event.get('status') == 'verified' and checks > 0 and not pending else (
                    'stopped' if event.get('stopped') else 'waiting_for_user' if state == 'waiting_for_user' else 'unverified')
                safe = {'state':state}
            elif kind == 'interrupted':
                state = 'interrupted'
            else:
                return
            serial = db.execute('SELECT COALESCE(MAX(serial),0)+1 FROM events WHERE run_id=?',(run_id,)).fetchone()[0]
            db.execute('INSERT INTO events VALUES(?,?,?,?)',(run_id,serial,kind,json.dumps(safe)))
            db.execute('UPDATE runs SET state=?,updated=?,pending=?,checks=? WHERE id=?',
                (state,time.time(),json.dumps(pending),checks,run_id))

    def state(self,run_id):
        with self.connection() as db:
            return dict(db.execute('SELECT id,state,pending,checks FROM runs WHERE id=?',(run_id,)).fetchone())
