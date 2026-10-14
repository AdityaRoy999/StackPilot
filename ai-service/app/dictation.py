"""Bounded, ephemeral PCM dictation. Audio and transcripts are never persisted."""
import base64
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import threading
import time
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal


class DictationRequest(BaseModel):
    action: Literal['start','audio','stop','cancel']
    user_id: str = Field(min_length=1,max_length=128)
    session_id: str = Field(default='',max_length=36)
    sample_rate: int = Field(default=16000,ge=8000,le=48000)
    sequence: int = Field(default=0,ge=0,le=10000)
    pcm: str = Field(default='',max_length=87384)


@dataclass
class Session:
    owner: str
    recognizer: object
    rate: int
    started: float
    touched: float
    sequence: int = 0
    bytes: int = 0
    final: list = field(default_factory=list)
    last: dict = field(default_factory=dict)
    closed: bool = False
    lock: object = field(default_factory=threading.Lock)


class DictationRuntime:
    def __init__(self, factory=None, clock=time.monotonic):
        self.factory=factory
        self.clock=clock
        self.sessions={}
        self.model=None
        self.lock=threading.RLock()

    def load(self):
        with self.lock:
            if self.factory or self.model:return
            from vosk import Model,SetLogLevel
            path=Path(os.getenv('STACKPILOT_DICTATION_MODEL','/opt/stackpilot/speech/vosk-model-small-en-us-0.15'))
            if not path.is_dir():raise RuntimeError('Dictation model is unavailable')
            SetLogLevel(-1)
            self.model=Model(str(path))

    def reap(self):
        now=self.clock()
        with self.lock:
            for key,session in list(self.sessions.items()):
                if now-session.touched>30 or now-session.started>300:
                    with session.lock:session.closed=True
                    self.sessions.pop(key,None)

    def handle(self, request):
        self.reap()
        if request.action=='start':
            self.load()
            with self.lock:
                active=[session for session in self.sessions.values() if not session.closed]
                if len(active)>=4 or sum(s.owner==request.user_id for s in active)>=2:
                    raise HTTPException(429,'Dictation is busy. Finish an existing microphone session and try again.')
                for key in list(self.sessions):
                    if len(self.sessions)<16:break
                    if self.sessions[key].closed:self.sessions.pop(key)
                if self.factory:recognizer=self.factory(request.sample_rate)
                else:
                    from vosk import KaldiRecognizer
                    recognizer=KaldiRecognizer(self.model,request.sample_rate)
                identity=str(uuid.uuid4());now=self.clock()
                self.sessions[identity]=Session(request.user_id,recognizer,request.sample_rate,now,now)
                return {'session_id':identity,'text':'','final':False,'sequence':0}
        with self.lock:session=self.sessions.get(request.session_id)
        if not session or session.owner!=request.user_id:
            raise HTTPException(404,'Dictation session is unavailable.')
        with session.lock:
            if session.closed:
                if request.action in {'stop','cancel'}:return session.last
                raise HTTPException(410,'Dictation session has ended.')
            session.touched=self.clock()
            if request.action in {'stop','cancel'}:
                last=json.loads(session.recognizer.FinalResult()).get('text','') if request.action=='stop' else ''
                text=' '.join([*session.final,last]).strip()
                session.closed=True
                # Release the decoder before responding; no audio files or DB rows.
                session.recognizer=None
                session.last={'session_id':request.session_id,'text':text,'final':True,'sequence':session.sequence}
            else:
                if request.sequence==session.sequence-1:return session.last
                if request.sequence!=session.sequence:raise HTTPException(409,'Dictation audio arrived out of order.')
                try:data=base64.b64decode(request.pcm,validate=True)
                except ValueError:raise HTTPException(400,'Invalid PCM audio.') from None
                if not data or len(data)>65536 or len(data)%2:
                    raise HTTPException(400,'Audio must be bounded mono 16-bit PCM.')
                if session.bytes+len(data)>session.rate*2*300:
                    raise HTTPException(413,'Dictation exceeded five minutes. Stop and start a new microphone session.')
                session.bytes+=len(data)
                if session.recognizer.AcceptWaveform(data):
                    final=json.loads(session.recognizer.Result()).get('text','').strip()
                    if final:session.final.append(final)
                    partial=''
                else:partial=json.loads(session.recognizer.PartialResult()).get('partial','').strip()
                text=' '.join([*session.final,partial]).strip()
                session.sequence+=1
                session.last={'session_id':request.session_id,'text':text,'final':False,'sequence':session.sequence}
                return session.last
        return session.last


runtime=DictationRuntime()
router=APIRouter()


@router.post('/voice/dictation')
def dictation(request: DictationRequest):
    # FastAPI runs this synchronous decoder in its thread pool, not the event loop.
    try:return runtime.handle(request)
    except HTTPException:raise
    except Exception:raise HTTPException(503,'Dictation could not start. Please retry microphone input.') from None
