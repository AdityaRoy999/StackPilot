"""Regression scenarios for dismissed workflows and observation cycles."""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from app.browser_driver import BrowserSession, browser_manager
from app.browser_testing.loop import BrowserReadProgress
from app.browser_testing.planning import compact_browser_messages, historical_browser_turns, browser_planner_tools
from app.browser_testing.targets import remember_targets, resolve_target_reference
from app.browser_testing.widgets import outcome_contract_error
from app.tools import AGENT_TOOLS, execute_tool_call


class RecoveryContractTests(unittest.TestCase):
    def session(self):
        return SimpleNamespace(current_url='https://fixture.invalid/',scroll_y=0,
            interactive_elements=[{'id':10,'tag':'input','text':'Phone','value':''}])

    def test_pagination_can_discover_all_controls_once_but_cannot_cycle(self):
        session=self.session(); progress=BrowserReadProgress()
        for offset in range(0,480,80):
            self.assertIsNone(progress.reject(session,{'offset':offset}))
            progress.record(session,{'offset':offset},{'status':'observed'})
        self.assertFalse(progress.stalled)
        for offset in (0,80,160):
            progress.record(session,{'offset':offset},{'status':'observed'})
        self.assertTrue(progress.stalled)
        self.assertEqual(progress.reject(session,{'offset':240})['recovery']['reason'],'observation_cycle')
        # A specific new query can find a workflow without another full-page cycle.
        self.assertIsNone(progress.reject(session,{'query':'Sign in','scope':'viewport'}))

    def test_real_ui_change_reenables_same_observation(self):
        session=self.session(); progress=BrowserReadProgress()
        for _ in range(4):progress.record(session,{}, {'status':'observed'})
        self.assertIsNotNone(progress.reject(session,{}))
        session.interactive_elements[0]['value']='synthetic'
        self.assertIsNone(progress.reject(session,{}))
        self.assertFalse(progress.stalled)

    def test_new_frame_and_same_url_navigation_are_fresh_states(self):
        for attr,value in [('_selected_frame','child'),('_navigation_generation',2),('target_id','second-tab')]:
            session=self.session(); progress=BrowserReadProgress()
            for _ in range(4):progress.record(session,{}, {'status':'observed'})
            setattr(session,attr,value)
            self.assertIsNone(progress.reject(session,{}))

    def test_screenshots_cannot_disguise_an_unchanged_read(self):
        session=self.session(); progress=BrowserReadProgress()
        for frame in (False,True,False,True):
            progress.record(session,{'include_frame':frame},{'status':'observed'})
        self.assertTrue(progress.stalled)

    def test_repeated_unavailable_observations_are_also_bounded(self):
        session=self.session();progress=BrowserReadProgress()
        for _ in range(4):progress.record(session,{}, {'status':'unverified','interactive_elements':[]})
        self.assertTrue(progress.stalled)
        self.assertIsNotNone(progress.reject(session,{}))

    def test_disconnected_session_can_stop_repeated_reads_without_a_dom(self):
        progress=BrowserReadProgress()
        for _ in range(4):progress.record(None,{}, {'status':'unverified'})
        self.assertEqual(progress.reject(None,{})['recovery']['reason'],'observation_cycle')

    def test_widget_state_changes_allow_a_fresh_read(self):
        for key,value in [('selected','true'),('pressed','true'),('invalid',True),('readonly',True)]:
            session=self.session();progress=BrowserReadProgress()
            for _ in range(4):progress.record(session,{}, {'status':'observed'})
            session.interactive_elements[0][key]=value
            self.assertIsNone(progress.reject(session,{}))
        session=self.session();progress=BrowserReadProgress()
        for _ in range(4):progress.record(session,{}, {'status':'observed'})
        session.native_dialog={'id':'new-dialog','type':'confirm'}
        self.assertIsNone(progress.reject(session,{}))

    def test_recent_paginated_observation_loses_no_control_references(self):
        observation={'status':'observed','interactive_elements':[{'id':i,'text':str(i)} for i in range(80)],
                     'offset':0,'next_offset':80,'has_more':True,'frame':'must-not-be-in-prompt'}
        messages=[{'role':'assistant','tool_calls':[{'id':'page'}]},
                  {'role':'tool','tool_call_id':'page','content':json.dumps(observation)}]
        compact=compact_browser_messages(messages)
        result=json.loads(compact[-1]['content'])
        self.assertEqual([e['id'] for e in result['interactive_elements']],list(range(80)))
        self.assertEqual(result['next_offset'],80)
        self.assertNotIn('frame',result)

    def test_previous_run_keeps_outcome_but_expires_control_references(self):
        history=[{'role':'user','content':'Sign in'}, {'role':'assistant','content':'Stopped',
            'tool_calls':[{'id':'old','name':'browser_interact','arguments':{'action':'click','element_id':458},
                'result':{'status':'passed','target':'Close','interactive_elements':[{'id':454,'text':'Phone'}],
                          'widget_state':{'active_overlay':{'id':497}}}}]}]
        current=historical_browser_turns(history)
        self.assertEqual(current[0],history[0])
        self.assertIn('Close',current[1]['content'])
        self.assertNotIn('458',json.dumps(current))
        self.assertNotIn('454',json.dumps(current))
        self.assertFalse(current[1]['tool_calls'])
        self.assertEqual(history[1]['tool_calls'][0]['arguments']['element_id'],458)

    def test_stalled_schema_requests_search_and_keeps_question_policy(self):
        selected=browser_planner_tools(AGENT_TOOLS,True,allow_questions=False,observation_recovery=True)
        observe=next(t['function'] for t in selected if t['function']['name']=='browser_observe')
        self.assertIn('query',observe['parameters']['required'])
        self.assertNotIn('ask_user_question',[t['function']['name'] for t in selected])
        normal=next(t['function'] for t in AGENT_TOOLS if t['function']['name']=='browser_observe')
        self.assertNotIn('query',normal['parameters'].get('required',[]))

    def test_mixed_history_keeps_other_tool_pairs_and_browser_summary(self):
        other={'id':'question','name':'ask_user_question','result':{'answer':'Continue'}}
        browser={'id':'click','name':'browser_interact','arguments':{'element_id':454},
                 'result':{'status':'stale_element','target':'Phone'}}
        current=historical_browser_turns([{'role':'assistant','content':'Previous run',
                                          'tool_calls':[other,browser]}])
        self.assertEqual(current[0]['tool_calls'],[other])
        self.assertFalse(current[1]['tool_calls'])
        self.assertIn('Phone',current[1]['content'])
        self.assertNotIn('454',json.dumps(current))

    def test_preparing_login_input_does_not_verify_authentication(self):
        for goal in ('login with my phone number','Sign in','Authenticate my account'):
            session=SimpleNamespace(task_context={'goal':goal})
            self.assertTrue(outcome_contract_error(session,[{'kind':'value','expected':'synthetic'}],'outcome'))
            self.assertFalse(outcome_contract_error(session,[{'kind':'value','expected':'synthetic'}],'checkpoint'))


class ObservationSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_cached_observation_after_timeout_is_never_current_evidence(self):
        session=SimpleNamespace(is_connected=True,interactive_elements=[{'id':9,'text':'Old control'}],
            extract_interactive_tree=AsyncMock(return_value={'fresh':False}),capture_screenshot=AsyncMock())
        with patch.dict(browser_manager.sessions,{'search-fixture':session}):
            result=await execute_tool_call('browser_observe',{'session_id':'search-fixture'},'fixture')
        self.assertEqual(result['status'],'unverified')
        self.assertEqual(result['interactive_elements'],[])
        session.capture_screenshot.assert_not_awaited()

    async def observe(self,args,controls):
        session=SimpleNamespace(is_connected=True,current_url='https://fixture.invalid/',page_title='Fixture',
            interactive_elements=controls,extract_interactive_tree=AsyncMock(),capture_screenshot=AsyncMock())
        with patch.dict(browser_manager.sessions,{'search-fixture':session}):
            result=await execute_tool_call('browser_observe',{'session_id':'search-fixture','include_frame':False,**args},'fixture')
        session.capture_screenshot.assert_not_awaited()
        return result

    async def test_query_and_scope_find_launcher_beyond_footer_links(self):
        controls=[{'id':i,'tag':'a','text':'Unrelated link','is_in_viewport':False} for i in range(520)]
        controls += [{'id':600,'tag':'button','text':'Sign in','is_in_viewport':True},
                     {'id':601,'tag':'a','text':'Sign in help','is_in_viewport':False}]
        result=await self.observe({'query':'SIGN IN','scope':'viewport'},controls)
        self.assertEqual([e['id'] for e in result['interactive_elements']],[600])
        self.assertEqual(result['total_controls'],1)
        self.assertFalse(result['has_more'])
        self.assertEqual(result['page_total_controls'],522)

    async def test_overlay_search_excludes_matching_background_field(self):
        controls=[{'id':1,'tag':'input','text':'Phone','is_in_viewport':True},
                  {'id':2,'tag':'input','text':'Phone','is_in_viewport':True,'is_inside_modal':True}]
        result=await self.observe({'query':'phone','scope':'overlay'},controls)
        self.assertEqual([e['id'] for e in result['interactive_elements']],[2])

    async def test_filtered_pagination_counts_matches_in_any_language(self):
        controls=[{'id':i,'tag':'button','text':'保存 '+str(i),'is_in_viewport':True} for i in range(90)]
        first=await self.observe({'query':'保存'},controls)
        second=await self.observe({'query':'保存','offset':first['next_offset']},controls)
        self.assertEqual(len(first['interactive_elements']),80)
        self.assertEqual(len(second['interactive_elements']),10)
        self.assertFalse(second['has_more'])

    async def test_invalid_search_never_scans(self):
        for args in ({'query':''},{'query':False},{'query':'x'*121},{'scope':'unknown'}):
            result=await self.observe(args,[])
            self.assertEqual(result['status'],'failed')


class TargetSafetyTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_tree_scan_preserves_ui_cache_without_claiming_freshness(self):
        session=BrowserSession('offline-tree-fixture')
        session.interactive_elements=[{'id':10,'tag':'input','text':'Cached phone'}]
        session.send_command=AsyncMock(side_effect=TimeoutError('Fixture timeout'))
        observation=await session.extract_interactive_tree()
        self.assertIs(observation['fresh'],False)
        self.assertEqual(session.interactive_elements[0]['id'],10)

    async def test_replaced_control_cannot_rebind_using_a_cached_scan(self):
        original={'id':4,'tag':'input','name':'phone'}
        session=SimpleNamespace(interactive_elements=[original],evaluate=AsyncMock(return_value=False),
            extract_interactive_tree=AsyncMock(return_value={'fresh':False}))
        remember_targets(session)
        session.interactive_elements=[{**original,'id':9}]
        result=await resolve_target_reference(session,4)
        self.assertEqual(result['status'],'stale_element')
        self.assertNotIn('element_id',result)

    async def test_same_named_field_in_a_different_popup_cannot_replace_old_field(self):
        original={'id':4,'tag':'input','name':'phone','is_inside_modal':True,'overlay_id':44}
        session=SimpleNamespace(interactive_elements=[original],evaluate=AsyncMock(return_value=False))
        remember_targets(session)
        async def observe():session.interactive_elements=[{**original,'id':9,'overlay_id':99}]
        session.extract_interactive_tree=observe
        result=await resolve_target_reference(session,4)
        self.assertEqual(result['status'],'stale_element')
        self.assertEqual(result['candidate_count'],0)

    async def test_transport_failure_never_claims_target_ready(self):
        session=SimpleNamespace(interactive_elements=[{'id':4,'tag':'input','name':'phone'}],
            evaluate=AsyncMock(side_effect=RuntimeError('CDP offline')))
        remember_targets(session)
        result=await resolve_target_reference(session,4)
        self.assertEqual(result['status'],'stale_element')
        self.assertIn('no input was dispatched',result['error'].lower())

    async def test_same_named_background_field_cannot_replace_modal_field(self):
        original={'id':4,'tag':'input','name':'phone','is_inside_modal':True}
        session=SimpleNamespace(interactive_elements=[original],evaluate=AsyncMock(return_value=False))
        remember_targets(session)
        async def observe():session.interactive_elements=[{**original,'id':9,'is_inside_modal':False}]
        session.extract_interactive_tree=observe
        result=await resolve_target_reference(session,4)
        self.assertEqual(result['status'],'stale_element')
        self.assertEqual(result['candidate_count'],0)

    async def test_new_browser_instance_never_uses_legacy_small_references(self):
        session=BrowserSession('restarted-reference-fixture')
        self.assertGreaterEqual(session._next_element_id,1<<32)
        self.assertLess(session._next_element_id,1<<53)
        session.interactive_elements=[{'id':session._next_element_id,'tag':'button','text':'Terms of Service'}]
        remember_targets(session)
        result=await resolve_target_reference(session,458)
        self.assertEqual(result['status'],'stale_element')
