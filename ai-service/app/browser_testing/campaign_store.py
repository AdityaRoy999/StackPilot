"""Durable, owner-scoped campaigns, task leases and encrypted evidence.

SQLite shares the existing persistent AI state volume. A campaign is not an SSE
connection. Payloads (including provider configuration and login storage) are
authenticated/encrypted using the service key, never returned in status APIs.
"""
import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


TERMINAL = {'completed','budget_exhausted','cancelled','failed'}


class CampaignStore:
    def __init__(self, path=None, key=None, clock=time.time):
        self.clock=clock
        self.path=Path(path or os.getenv('STACKPILOT_BROWSER_CAMPAIGN_DB') or
                       Path(os.getenv('STACKPILOT_AGENT_RUN_DB','/state/browser-runs.sqlite3')).with_name('browser-campaigns.sqlite3'))
        self.path.parent.mkdir(parents=True,exist_ok=True)
        secret=key or os.getenv('STACKPILOT_AI_SERVICE_TOKEN','')
        if not secret: raise RuntimeError('Campaign encryption requires the configured service token')
        self.cipher=AESGCM(hashlib.sha256(('stackpilot-browser-campaign-v1:'+secret).encode()).digest())
        with self.connection() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS campaigns (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
                    state TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL,
                    deadline REAL NOT NULL, max_pages INTEGER NOT NULL, max_actions INTEGER NOT NULL,
                    max_tokens INTEGER NOT NULL, actions INTEGER NOT NULL DEFAULT 0,
                    tokens INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
                    payload BLOB NOT NULL, browser_state BLOB, reason TEXT NOT NULL DEFAULT '',
                    lease_owner TEXT, lease_until REAL);
                CREATE UNIQUE INDEX IF NOT EXISTS one_campaign_per_chat ON campaigns(user_id,session_id)
                    WHERE state IN ('queued','running','paused','waiting_for_permission','waiting_for_input','needs_reconciliation');
                CREATE TABLE IF NOT EXISTS campaign_tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL, kind TEXT NOT NULL,
                    identity TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                    lease_owner TEXT, lease_until REAL, payload BLOB NOT NULL, result BLOB,
                    UNIQUE(campaign_id,kind,identity));
                CREATE INDEX IF NOT EXISTS campaign_task_queue ON campaign_tasks(campaign_id,state,kind,id);
                CREATE TABLE IF NOT EXISTS campaign_events (
                    campaign_id TEXT NOT NULL, sequence INTEGER NOT NULL, created REAL NOT NULL,
                    payload BLOB NOT NULL, PRIMARY KEY(campaign_id,sequence));
                CREATE TABLE IF NOT EXISTS campaign_frames (
                    campaign_id TEXT NOT NULL, sequence INTEGER NOT NULL, timestamp REAL NOT NULL,
                    payload BLOB NOT NULL, PRIMARY KEY(campaign_id,sequence));
            ''')
        try: self.path.chmod(0o600)
        except OSError: pass

    @contextmanager
    def connection(self):
        db=sqlite3.connect(self.path,timeout=15)
        db.row_factory=sqlite3.Row
        try:
            db.execute('PRAGMA synchronous=FULL')
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally: db.close()

    def seal(self,value,owner):
        nonce=os.urandom(12)
        return nonce+self.cipher.encrypt(nonce,json.dumps(value,separators=(',',':')).encode(),owner.encode())

    def open(self,value,owner):
        return json.loads(self.cipher.decrypt(value[:12],value[12:],owner.encode())) if value else None

    def _owned(self,db,campaign_id,user_id,session_id=None):
        row=db.execute('SELECT * FROM campaigns WHERE id=? AND user_id=?',(campaign_id,user_id)).fetchone()
        if not row or (session_id is not None and row['session_id']!=session_id): raise PermissionError('Campaign unavailable')
        return row

    def create(self,user_id,session_id,payload,max_pages=250,max_seconds=14400,max_actions=20000,max_tokens=1000000,initial_url=None):
        if not user_id or not session_id or len(session_id)>200: raise ValueError('A user-owned chat is required')
        for value,low,high in ((max_pages,1,10000),(max_seconds,60,86400),(max_actions,1,100000),(max_tokens,100,10000000)):
            if type(value) is not int or not low<=value<=high: raise ValueError('Invalid campaign budget')
        campaign_id=str(uuid.uuid4()); now=self.clock()
        with self.connection() as db:
            existing=db.execute("SELECT id FROM campaigns WHERE user_id=? AND session_id=? AND state NOT IN ('completed','budget_exhausted','cancelled','failed')",(user_id,session_id)).fetchone()
            if existing: return existing['id'],False
            db.execute('INSERT INTO campaigns(id,user_id,session_id,state,created,updated,deadline,max_pages,max_actions,max_tokens,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                       (campaign_id,user_id,session_id,'queued',now,now,now+max_seconds,max_pages,max_actions,max_tokens,self.seal(payload,campaign_id)))
            if initial_url:
                db.execute('INSERT INTO campaign_tasks(campaign_id,kind,identity,payload) VALUES(?,?,?,?)',
                           (campaign_id,'page',hashlib.sha256(initial_url.encode()).hexdigest(),self.seal({'url':initial_url,'label':'Requested page'},campaign_id)))
        return campaign_id,True

    def job(self,campaign_id,user_id,session_id=None):
        with self.connection() as db: row=dict(self._owned(db,campaign_id,user_id,session_id))
        row['payload']=self.open(row['payload'],campaign_id)
        row['browser_state']=self.open(row['browser_state'],campaign_id)
        return row

    def ready(self):
        with self.connection() as db:
            return [dict(r) for r in db.execute("SELECT id,user_id,session_id FROM campaigns WHERE state IN ('queued','running') ORDER BY created")]

    def claim_job(self,campaign_id,worker):
        with self.connection() as db:
            return bool(db.execute("UPDATE campaigns SET lease_owner=?,lease_until=?,state='running',updated=? WHERE id=? AND state IN ('queued','running') AND (lease_owner IS NULL OR lease_until<? OR lease_owner=?)",(worker,self.clock()+45,self.clock(),campaign_id,self.clock(),worker)).rowcount)

    def release_job(self,campaign_id,worker):
        with self.connection() as db:
            db.execute('UPDATE campaigns SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?',(campaign_id,worker))

    def add_task(self,campaign_id,kind,identity,payload):
        if kind not in {'page','workflow'}: raise ValueError('Invalid task kind')
        with self.connection() as db:
            if kind=='page':
                budget=db.execute('SELECT max_pages FROM campaigns WHERE id=?',(campaign_id,)).fetchone()
                count=db.execute("SELECT COUNT(*) FROM campaign_tasks WHERE campaign_id=? AND kind='page'",(campaign_id,)).fetchone()[0]
                if count>=budget['max_pages']: return False
            elif db.execute("SELECT COUNT(*) FROM campaign_tasks WHERE campaign_id=? AND kind='workflow'",(campaign_id,)).fetchone()[0]>=10000:
                return False
            return bool(db.execute('INSERT OR IGNORE INTO campaign_tasks(campaign_id,kind,identity,payload) VALUES(?,?,?,?)',
                (campaign_id,kind,hashlib.sha256(identity.encode()).hexdigest(),self.seal(payload,campaign_id))).rowcount)

    def claim(self,campaign_id,worker,lease_seconds=45):
        with self.connection() as db:
            if not db.execute("SELECT 1 FROM campaigns WHERE id=? AND state='running' AND lease_owner=? AND lease_until>=?",(campaign_id,worker,self.clock())).fetchone(): return None
            row=db.execute("SELECT * FROM campaign_tasks WHERE campaign_id=? AND state='pending' ORDER BY CASE kind WHEN 'page' THEN 0 ELSE 1 END,id LIMIT 1",(campaign_id,)).fetchone()
            if not row: return None
            db.execute("UPDATE campaign_tasks SET state='running',attempts=attempts+1,lease_owner=?,lease_until=? WHERE id=?",(worker,self.clock()+lease_seconds,row['id']))
        task=dict(row);task['attempts']+=1;task['payload']=self.open(task['payload'],campaign_id)
        return task

    def heartbeat(self,campaign_id,worker,task_id=None):
        with self.connection() as db:
            if not db.execute('UPDATE campaigns SET updated=?,lease_until=? WHERE id=? AND lease_owner=?',(self.clock(),self.clock()+45,campaign_id,worker)).rowcount:
                return False
            if task_id is not None:
                if db.execute("UPDATE campaign_tasks SET lease_until=? WHERE id=? AND campaign_id=? AND lease_owner=? AND state='running'",(self.clock()+45,task_id,campaign_id,worker)).rowcount: return True
                # The task may have finished while this heartbeat was queued.
                row=db.execute('SELECT state FROM campaign_tasks WHERE id=? AND campaign_id=?',(task_id,campaign_id)).fetchone()
                return bool(row and row['state']!='running')
        return True

    def recover_expired(self):
        """Only discovery tasks can be requeued blindly. Workflows reconcile first."""
        with self.connection() as db:
            db.execute("UPDATE campaigns SET state='budget_exhausted',reason='Campaign wall-time budget reached; remaining tasks are unverified.',updated=? WHERE deadline<=? AND state NOT IN ('completed','budget_exhausted','cancelled','failed')",(self.clock(),self.clock()))
            expired=list(db.execute("SELECT id,campaign_id,kind FROM campaign_tasks WHERE state='running' AND lease_until<?",(self.clock(),)))
            for task in expired:
                state='pending' if task['kind']=='page' else 'needs_reconciliation'
                db.execute('UPDATE campaign_tasks SET state=?,lease_owner=NULL,lease_until=NULL WHERE id=?',(state,task['id']))
                if task['kind']=='workflow':
                    db.execute("UPDATE campaigns SET state='needs_reconciliation',reason='An interrupted workflow requires live outcome reconciliation before resuming.' WHERE id=? AND state NOT IN ('cancelled','completed','budget_exhausted','failed')",(task['campaign_id'],))
        return len(expired)

    def finish_task(self,campaign_id,task_id,worker,result,state='completed'):
        with self.connection() as db:
            return bool(db.execute("UPDATE campaign_tasks SET state=?,result=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND campaign_id=? AND lease_owner=? AND state='running' AND lease_until>=? AND EXISTS (SELECT 1 FROM campaigns WHERE id=? AND lease_owner=? AND lease_until>=?)",(state,self.seal(result,campaign_id),task_id,campaign_id,worker,self.clock(),campaign_id,worker,self.clock())).rowcount)

    def update(self,campaign_id,worker=None,**values):
        allowed={'state','reason','actions','tokens','failures','browser_state'}
        if not values or set(values)-allowed: raise ValueError('Unsupported campaign update')
        if 'browser_state' in values: values['browser_state']=self.seal(values['browser_state'],campaign_id)
        values['updated']=self.clock()
        with self.connection() as db:
            where=' WHERE id=?'+(' AND lease_owner=? AND lease_until>=?' if worker else '')
            if worker and 'state' in values: where+=" AND state NOT IN ('completed','budget_exhausted','cancelled','failed')"
            return bool(db.execute('UPDATE campaigns SET '+','.join(key+'=?' for key in values)+where,(*values.values(),campaign_id,*((worker,self.clock()) if worker else ()))).rowcount)

    def charge(self,campaign_id,actions=0,tokens=0,worker=None):
        with self.connection() as db:
            where=' WHERE id=?'+(' AND lease_owner=?' if worker else '')
            return bool(db.execute('UPDATE campaigns SET actions=actions+?,tokens=MAX(0,tokens+?),updated=?'+where,(actions,tokens,self.clock(),campaign_id,*((worker,) if worker else ()))).rowcount)

    def event(self,campaign_id,event):
        with self.connection() as db:
            serial=db.execute('SELECT COALESCE(MAX(sequence),0)+1 FROM campaign_events WHERE campaign_id=?',(campaign_id,)).fetchone()[0]
            db.execute('INSERT INTO campaign_events VALUES(?,?,?,?)',(campaign_id,serial,self.clock(),self.seal(event,campaign_id)))
        return serial

    def status(self,campaign_id,user_id,session_id=None,after=0):
        with self.connection() as db:
            row=self._owned(db,campaign_id,user_id,session_id)
            tasks=[dict(r) for r in db.execute('SELECT kind,state,COUNT(*) AS count FROM campaign_tasks WHERE campaign_id=? GROUP BY kind,state',(campaign_id,))]
            events=[{'sequence':r['sequence'],**self.open(r['payload'],campaign_id)} for r in db.execute('SELECT sequence,payload FROM campaign_events WHERE campaign_id=? AND sequence>? ORDER BY sequence LIMIT 100',(campaign_id,after))]
            frames=db.execute('SELECT COUNT(*) AS count,COALESCE(SUM(LENGTH(payload)),0) AS bytes FROM campaign_frames WHERE campaign_id=?',(campaign_id,)).fetchone()
            paused=db.execute("SELECT result FROM campaign_tasks WHERE campaign_id=? AND state IN ('waiting_for_permission','waiting_for_input') ORDER BY id DESC LIMIT 1",(campaign_id,)).fetchone()
            pending=self.open(paused['result'],campaign_id) if paused else {}
            return {**{key:row[key] for key in ('id','session_id','state','created','updated','deadline','max_pages','max_actions','max_tokens','actions','tokens','reason')},
                'tasks':tasks,'events':events,'recording':dict(frames),'exhaustive':False,
                'pending_request':pending.get('permission_request') or pending.get('agent_question')}

    def control(self,campaign_id,user_id,action,session_id=None):
        with self.connection() as db:
            row=self._owned(db,campaign_id,user_id,session_id)
            if row['state'] in TERMINAL: raise ValueError('Campaign has already ended')
            if action not in {'pause','resume','cancel','reconcile'}: raise ValueError('Unsupported campaign control')
            if action=='resume' and db.execute("SELECT 1 FROM campaign_tasks WHERE campaign_id=? AND state='needs_reconciliation'",(campaign_id,)).fetchone(): raise ValueError('Reconcile the interrupted workflow first')
            if action=='resume' and db.execute("SELECT 1 FROM campaign_tasks WHERE campaign_id=? AND state IN ('waiting_for_permission','waiting_for_input')",(campaign_id,)).fetchone(): raise ValueError('Answer the pending question or review the specific permission first')
            if action=='reconcile' and row['state']!='needs_reconciliation': raise ValueError('This campaign has no interrupted workflow to reconcile')
            state={'pause':'paused','resume':'queued','cancel':'cancelled','reconcile':'queued'}[action]
            if action=='reconcile':
                for task in db.execute("SELECT id,payload FROM campaign_tasks WHERE campaign_id=? AND state='needs_reconciliation'",(campaign_id,)).fetchall():
                    payload=self.open(task['payload'],campaign_id);payload['reconcile']=True
                    db.execute("UPDATE campaign_tasks SET state='pending',payload=? WHERE id=?",(self.seal(payload,campaign_id),task['id']))
            db.execute('UPDATE campaigns SET state=?,reason=?,updated=? WHERE id=?',(state,'',self.clock(),campaign_id))
        return state

    def answer(self,campaign_id,answer):
        with self.connection() as db:
            tasks=db.execute("SELECT id,payload FROM campaign_tasks WHERE campaign_id=? AND state IN ('waiting_for_permission','waiting_for_input')",(campaign_id,)).fetchall()
            if len(tasks)!=1: raise ValueError('Expected one paused workflow')
            payload=self.open(tasks[0]['payload'],campaign_id)
            payload['answer']={key:str(value)[:8000] for key,value in answer.items() if key in {'message','approval_token'} and value and str(value).strip()}
            if not payload['answer']: raise ValueError('An answer or signed approval is required')
            db.execute("UPDATE campaign_tasks SET state='pending',payload=? WHERE id=?",(self.seal(payload,campaign_id),tasks[0]['id']))

    def save_browser(self,campaign_id,value,worker=None): return self.update(campaign_id,worker=worker,browser_state=value)

    def prune(self,retention_seconds=7*86400):
        """Remove ended campaigns; SQLite reuses freed pages for future runs."""
        with self.connection() as db:
            ids=[r['id'] for r in db.execute("SELECT id FROM campaigns WHERE state IN ('completed','budget_exhausted','cancelled','failed') AND updated<? AND lease_owner IS NULL",(self.clock()-max(3600,retention_seconds),))]
            for campaign_id in ids:
                for table in ('campaign_frames','campaign_events','campaign_tasks'):
                    db.execute('DELETE FROM '+table+' WHERE campaign_id=?',(campaign_id,))
                db.execute('DELETE FROM campaigns WHERE id=?',(campaign_id,))
        return len(ids)

    def frame(self,campaign_id,jpeg,timestamp,metadata,limit_bytes=512*1024*1024):
        with self.connection() as db:
            job=db.execute('SELECT state FROM campaigns WHERE id=?',(campaign_id,)).fetchone()
            if not job or job['state']!='running': return False
            current=db.execute('SELECT COALESCE(SUM(LENGTH(payload)),0),COALESCE(MAX(sequence),0)+1 FROM campaign_frames WHERE campaign_id=?',(campaign_id,)).fetchone()
            payload=self.seal({'jpeg':base64.b64encode(jpeg).decode(),'metadata':metadata},campaign_id)
            if current[0]+len(payload)>limit_bytes: return False
            db.execute('INSERT INTO campaign_frames VALUES(?,?,?,?)',(campaign_id,current[1],timestamp,payload))
        return True

    def frames(self,campaign_id,user_id,session_id=None,after=0):
        with self.connection() as db:
            self._owned(db,campaign_id,user_id,session_id)
            return [dict(r) for r in db.execute('SELECT sequence,timestamp FROM campaign_frames WHERE campaign_id=? AND sequence>? ORDER BY sequence LIMIT 1000',(campaign_id,after))]

    def read_frame(self,campaign_id,user_id,sequence,session_id=None):
        with self.connection() as db:
            self._owned(db,campaign_id,user_id,session_id)
            row=db.execute('SELECT payload FROM campaign_frames WHERE campaign_id=? AND sequence=?',(campaign_id,sequence)).fetchone()
        if not row: raise ValueError('Recording frame unavailable')
        return base64.b64decode(self.open(row['payload'],campaign_id)['jpeg'])

    def results(self,campaign_id,user_id,session_id=None,offset=0,limit=100):
        with self.connection() as db:
            self._owned(db,campaign_id,user_id,session_id)
            return [{'id':r['id'],'kind':r['kind'],'state':r['state'],'task':self.open(r['payload'],campaign_id),
                     'result':self.open(r['result'],campaign_id)} for r in db.execute('SELECT id,kind,state,payload,result FROM campaign_tasks WHERE campaign_id=? ORDER BY id LIMIT ? OFFSET ?',(campaign_id,max(1,min(1000,limit)),max(0,offset)))]

    def task_evidence(self,campaign_id,task_id):
        with self.connection() as db:
            events=[self.open(r['payload'],campaign_id) for r in db.execute('SELECT payload FROM campaign_events WHERE campaign_id=? ORDER BY sequence DESC LIMIT 1000',(campaign_id,))]
        # Saved dispatch/evidence informs reconciliation. It is never a script
        # to execute, and no persisted browser element ID is treated as current.
        return [e for e in reversed(events) if e.get('task_id')==task_id and e.get('type') in {'tool_call','tool_result'}][-40:]
