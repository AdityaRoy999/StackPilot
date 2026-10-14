import base64
import json
import unittest
from fastapi import HTTPException
from app.dictation import DictationRequest,DictationRuntime


class Recognizer:
    def __init__(self,rate):self.calls=0
    def AcceptWaveform(self,data):self.calls+=1;return self.calls==2
    def Result(self):return json.dumps({'text':'check the deployment'})
    def PartialResult(self):return json.dumps({'partial':'check' if self.calls==1 else 'status'})
    def FinalResult(self):return json.dumps({'text':'status'})


class DictationTests(unittest.TestCase):
    def setUp(self):
        self.now=0
        self.engine=DictationRuntime(Recognizer,clock=lambda:self.now)
        self.session=self.call(action='start')['session_id']
    def call(self,**kw):
        return self.engine.handle(DictationRequest(user_id='owner',session_id=getattr(self,'session',''),**kw))
    def audio(self,sequence=0):
        return self.call(action='audio',sequence=sequence,pcm=base64.b64encode(b'\0\0'*256).decode())
    def test_partial_results_arrive_before_stop_and_final_transcript_is_complete(self):
        self.assertEqual(self.audio()['text'],'check')
        self.assertEqual(self.audio(1)['text'],'check the deployment')
        self.assertEqual(self.audio(2)['text'],'check the deployment status')
        final=self.call(action='stop')
        self.assertEqual(final['text'],'check the deployment status')
        self.assertTrue(final['final'])
        self.assertIsNone(self.engine.sessions[self.session].recognizer)
    def test_audio_and_stop_retries_do_not_repeat_words(self):
        first=self.audio()
        self.assertEqual(self.audio(),first)
        self.assertEqual(self.engine.sessions[self.session].recognizer.calls,1)
        final=self.call(action='stop')
        self.assertEqual(self.call(action='stop'),final)
    def test_cross_user_reads_audio_stop_and_cancel_are_denied(self):
        for action in ['audio','stop','cancel']:
            with self.assertRaises(HTTPException) as caught:
                self.engine.handle(DictationRequest(action=action,user_id='other',session_id=self.session))
            self.assertEqual(caught.exception.status_code,404)
    def test_invalid_out_of_order_and_oversized_audio_cannot_reach_decoder(self):
        for kwargs,status in [({'pcm':'!invalid!'},400),({'pcm':base64.b64encode(b'x').decode()},400),
                              ({'sequence':7,'pcm':'AAAA'},409),({'pcm':base64.b64encode(b'x'*65538).decode()},400)]:
            with self.assertRaises(HTTPException) as caught:self.call(action='audio',**kwargs)
            self.assertEqual(caught.exception.status_code,status)
        self.assertEqual(self.engine.sessions[self.session].recognizer.calls,0)
    def test_cancel_discards_text_and_decoder_and_rejects_later_audio(self):
        self.audio()
        self.assertEqual(self.call(action='cancel')['text'],'')
        self.assertIsNone(self.engine.sessions[self.session].recognizer)
        with self.assertRaises(HTTPException) as caught:self.audio(1)
        self.assertEqual(caught.exception.status_code,410)
    def test_inactive_and_long_running_sessions_expire(self):
        self.now=31;self.engine.reap()
        self.assertNotIn(self.session,self.engine.sessions)
        self.session=self.call(action='start')['session_id']
        self.now=332;self.engine.sessions[self.session].touched=self.now
        self.engine.reap()
        self.assertNotIn(self.session,self.engine.sessions)
    def test_concurrency_limit_and_closed_sessions_do_not_hold_capacity(self):
        self.call(action='start')
        with self.assertRaises(HTTPException) as caught:self.call(action='start')
        self.assertEqual(caught.exception.status_code,429)
        self.call(action='cancel')
        self.assertTrue(self.call(action='start')['session_id'])
