import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from app.browser_testing.run_state import RunJournal,owner_key
from app.main import AgentRequest,stream_agent_reply,active_browser_runs,_sse


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)/'runs.sqlite3'
        self.journal = RunJournal(self.path)
        self.owner = owner_key('user','session')

    def test_unresolved_submission_survives_restart_without_raw_secrets(self):
        run = self.journal.start(self.owner,'Create account with secret-password')
        self.journal.record(run,{'type':'tool_call','name':'browser_interact','id':'submit',
                                 'arguments':{'text':'secret-password'}})
        self.journal.record(run,{'type':'interrupted'})
        restarted = RunJournal(self.path)
        previous = restarted.previous(self.owner)
        self.assertEqual(previous['state'],'interrupted')
        self.assertEqual(json.loads(previous['pending'])[0]['call_id'],'submit')
        with restarted.connection() as db:
            text = repr([tuple(row) for row in db.execute('SELECT * FROM events')])+repr([tuple(row) for row in db.execute('SELECT * FROM runs')])
        self.assertNotIn('secret-password',text)
        self.assertIsNone(restarted.previous(owner_key('other-user','session')))
        subsequent = restarted.start(self.owner,'Inspect without submitting')
        restarted.record(subsequent,{'type':'done'})
        self.assertEqual(restarted.previous(self.owner)['id'],run)

    def test_done_cannot_verify_pending_or_unasserted_work(self):
        run = self.journal.start(self.owner,'Check a result')
        self.journal.record(run,{'type':'done','status':'verified'})
        self.assertEqual(self.journal.state(run)['state'],'unverified')
        self.journal.record(run,{'type':'tool_call','name':'browser_interact','id':'submit','arguments':{}})
        self.journal.record(run,{'type':'done','stopped':True})
        self.assertIsNotNone(self.journal.previous(self.owner))

    def test_verified_result_is_terminal_and_failed_result_requires_recovery(self):
        run = self.journal.start(self.owner,'Check a result')
        self.journal.record(run,{'type':'tool_call','name':'browser_assert','id':'assert','arguments':{}})
        self.journal.record(run,{'type':'tool_result','name':'browser_assert','id':'assert',
            'result':{'action':'assert','purpose':'outcome','assertions':[{'status':'passed'}],
                      'verification':{'verified':True,'effect_type':'assertion'}}})
        self.journal.record(run,{'type':'done','status':'verified'})
        self.assertEqual(self.journal.state(run)['state'],'verified')
        self.assertIsNone(self.journal.previous(self.owner))
        run2 = self.journal.start(self.owner,'Click control')
        self.journal.record(run2,{'type':'tool_result','name':'browser_interact','id':'click',
            'result':{'status':'failed','error':'covered'}})
        self.assertEqual(self.journal.state(run2)['state'],'recovering')


class RunWrapperTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.journal = RunJournal(Path(self.directory.name)/'runs.sqlite3')
        self.enterContext(patch('app.browser_testing.run_state.RunJournal',return_value=self.journal))

    def request(self):
        return AgentRequest(message='Check the form',session_id='wrapper-fixture',custom_url='https://fixture.invalid/',user_id='fixture')

    async def test_concurrent_runs_cannot_control_same_session(self):
        ready,finish = asyncio.Event(),asyncio.Event()
        async def inner(*args):
            ready.set()
            await finish.wait()
            yield _sse({'type':'done'})
        async def consume():
            return [event async for event in stream_agent_reply(self.request())]
        with patch('app.main._stream_agent_reply_impl',inner):
            task = asyncio.create_task(consume())
            try:
                await asyncio.wait_for(ready.wait(),2)
                second = await consume()
                self.assertTrue(any('session_busy' in event for event in second))
            finally:
                finish.set()
                await task
        self.assertNotIn('wrapper-fixture',active_browser_runs)

    async def test_closed_stream_retains_pending_action_and_next_run_reconciles(self):
        recovered = []
        async def initial(*args):
            yield _sse({'type':'tool_call','name':'browser_interact','id':'uncertain','arguments':{'action':'click'}})
            yield _sse({'type':'done'})
        with patch('app.main._stream_agent_reply_impl',initial):
            stream = stream_agent_reply(self.request())
            await anext(stream)  # run starts
            await anext(stream)  # command intention is committed
            await stream.aclose()
        async def next_run(request,*args):
            recovered.append(request.runtime['browser_recovery_checkpoint'])
            yield _sse({'type':'done'})
        with patch('app.main._stream_agent_reply_impl',next_run):
            events = [event async for event in stream_agent_reply(self.request())]
        self.assertEqual(recovered[0]['state'],'interrupted')
        self.assertEqual(recovered[0]['pending'][0]['call_id'],'uncertain')
        self.assertTrue(any('recovery_required": true' in e for e in events))

    async def test_journal_failure_prevents_execution_and_releases_lock(self):
        async def should_not_run(*args):
            raise AssertionError('Executor must not start without a checkpoint store')
            yield ''
        with patch('app.browser_testing.run_state.RunJournal',side_effect=OSError('disk unavailable')), \
             patch('app.main._stream_agent_reply_impl',should_not_run):
            events = [event async for event in stream_agent_reply(self.request())]
        parsed = [json.loads(event[6:]) for event in events]
        self.assertEqual(next(event for event in parsed if event['type'] == 'error')['code'], 'browser_checkpoint_unavailable')
        self.assertEqual(parsed[-1]['status'], 'blocked')
        self.assertIn('No browser action was dispatched', parsed[-2]['error'])
        self.assertNotIn('last dispatched action', parsed[-2]['error'])
        self.assertNotIn('wrapper-fixture',active_browser_runs)

    async def test_session_configuration_failure_is_not_an_uncertain_action(self):
        with patch('app.main.browser_manager.configure_session', side_effect=ValueError('invalid mode')):
            events = [json.loads(event[6:]) async for event in stream_agent_reply(self.request())]
        self.assertEqual(events[-2]['code'], 'browser_session_unavailable')
        self.assertEqual(events[-1]['status'], 'blocked')
        self.assertIsNone(events[-1]['browser_run_id'])
        self.assertNotIn('wrapper-fixture', active_browser_runs)

    async def test_real_execution_interruption_retains_pending_action(self):
        async def interrupted(*args):
            yield _sse({'type': 'tool_call', 'name': 'browser_interact', 'id': 'uncertain', 'arguments': {'action': 'click'}})
            raise RuntimeError('Lost tool response')
        with patch('app.main._stream_agent_reply_impl', interrupted):
            events = [json.loads(event[6:]) async for event in stream_agent_reply(self.request())]
        self.assertEqual(events[-2]['code'], 'browser_run_interrupted')
        self.assertEqual(events[-1]['status'], 'unverified')
        previous = self.journal.previous(owner_key('fixture', 'wrapper-fixture'))
        self.assertEqual(json.loads(previous['pending'])[0]['call_id'], 'uncertain')
        self.assertEqual(previous['state'], 'interrupted')
