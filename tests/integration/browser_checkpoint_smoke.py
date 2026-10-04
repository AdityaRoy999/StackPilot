"""Opt-in checkpoint and real-browser audit of a disposable three-page website.

Run inside the AI service with PYTHONPATH=/app:/tmp/stackpilot-browser-qa/tests.
Only project-context recovery is bypassed; the journal, Chromium, website tools
and selected provider calls are real. Deterministic nested audit mechanics are
reported separately from subsequent model-planned scenario/validation evidence.
Does not write a user chat, approve a critical step, or claim exhaustive coverage.
"""
import asyncio
import json
import os
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.browser_testing.run_state import RunJournal
from app.browser_testing.observations import browser_vision_enabled
from app.main import AgentRequest, stream_agent_reply
from test_browser_site_audit import LiveAuditTests


async def main():
    fixture = LiveAuditTests('test_route_queue_hover_and_section_oracle_never_submit_or_delete')
    await fixture.asyncSetUp()
    started = time.monotonic()
    trace, reports = [], []
    run_id, coverage, error = None, None, None
    final, planner_turns, scenario_checks, nested_checks, permissions = {}, [], [], [], []
    active_tool = None
    deadline = max(5,min(600,float(os.getenv('MODEL_SMOKE_TIMEOUT_SECONDS','300'))))
    try:
        request = AgentRequest(
            message=os.getenv('MODEL_SMOKE_MESSAGE',
                'Test this website end to end in depth. Discover its pages, check the local theme state, '
                'and test the required email input with both invalid text and qa@example.test using '
                'explicit native validity assertions. Complete all safe checks before requesting '
                'a step-scoped permission to send the form. Do not actually submit, delete, or visit external sites.'),
            custom_url=fixture.session.current_url,
            session_id=fixture.session.session_id,
            model=os.getenv('MODEL_SMOKE_MODEL', 'nvidia/nemotron-3-super-120b-a12b'))
        with patch('app.main.recover_session_context', AsyncMock()):
            async with asyncio.timeout(deadline):
                async for raw in stream_agent_reply(request):
                    event = json.loads(raw[6:])
                    kind = event.get('type')
                    if kind == 'browser_run':
                        run_id = event['run_id']
                    elif kind == 'tool_call':
                        active_tool = event.get('name')
                        arguments=event.get('arguments') or {}
                        trace.append({'tool': event.get('name'),'action':arguments.get('action'),
                            'element_id':arguments.get('element_id'),'argument_fields':sorted(arguments),
                            'batch_actions':[{'action':step.get('action'),'element_id':step.get('element_id'),
                                              'argument_fields':sorted(step)}
                                             for step in arguments.get('actions',[]) if isinstance(step,dict)]})
                    elif kind == 'tool_result':
                        result = event.get('result') or {}
                        trace.append({'tool_result': event.get('name'), 'status': result.get('status'), 'error': result.get('error'),
                            'steps':[{'action':s.get('action'),'status':s.get('status'),'error':s.get('error'),'theme':s.get('theme')}
                                     for s in result.get('results',[])]})
                        coverage = result.get('coverage') or coverage
                        checks=result.get('assertions',[]) + [check for step in result.get('results',[]) for check in step.get('assertions',[])]
                        for check in checks:
                            spec=check.get('expectation') or {}
                            scenario_checks.append({'tool':event.get('name'),'kind':spec.get('kind'),
                                'expected_boolean':spec.get('expected') if type(spec.get('expected')) is bool else None,
                                'status':check.get('status')})
                        active_tool = None
                    elif kind == 'tool_step':
                        result=event.get('result') or {}
                        for check in result.get('assertions',[]):
                            nested_checks.append({'parent_tool':active_tool,'tool':event.get('name'),
                                'kind':(check.get('expectation') or {}).get('kind'),'status':check.get('status')})
                    elif kind == 'browser_timing' and event.get('phase')=='planner':
                        planner_turns.append({key:event.get(key) for key in ('model','elapsed_ms','first_delta_ms','tool_count','finish_reason')})
                    elif kind == 'permission_request':
                        step=event.get('browser_step') or {}
                        permissions.append({'tool':event.get('tool_name'),'action':step.get('action'),
                            'label':step.get('label'),'reason':step.get('reason'),'step_index':step.get('step_index'),
                            'source':'workflow_controller' if event.get('workflow_obligation_id') else 'model_proposal'})
                    elif kind == 'done':
                        final={key:event.get(key) for key in ('status','browser_run_state','verified','provider','model','workflow_obligations')}
                    elif kind == 'content':
                        reports.append(event.get('delta', ''))
                    elif kind == 'error':
                        error = event.get('error') or event.get('message')
    except TimeoutError:
        error = f'{deadline:g} second qualification deadline exceeded'
    finally:
        requests = fixture.requests.copy()
        checkpoint = RunJournal().state(run_id) if run_id else None
        await fixture.cleanup()
    checkpoint_safe = bool(checkpoint and checkpoint['pending'] == '[]')
    no_side_effects = all(method == 'GET' and path != '/account/delete' for method, path in requests)
    discovery_passed = bool(coverage and coverage.get('visited_pages') == 3)
    validity_states = {check['expected_boolean'] for check in scenario_checks
                       if check['kind']=='validity' and check['status']=='passed'}
    deep_validation_passed = validity_states == {False,True}
    permission_paused = bool(permissions and final.get('status')=='waiting_for_permission')
    exact_send_approval = bool(permission_paused and permissions[-1]['label']=='Send' and permissions[-1]['action']=='click')
    selected_model_used = bool(planner_turns and all(turn.get('model')==request.model for turn in planner_turns))
    success = bool(discovery_passed and deep_validation_passed and selected_model_used and
                   exact_send_approval and not error and checkpoint_safe and no_side_effects)
    evidence={'scenario': 'deep_website_scenarios_before_step_approval', 'requested_model': request.model,
                      'vision_enabled':browser_vision_enabled(request.model,request.runtime),
                      'elapsed_seconds': round(time.monotonic() - started, 2),
                      'success': success,'discovery_passed':discovery_passed,
                      'deep_validation_passed':deep_validation_passed,'permission_paused':permission_paused,
                      'exact_send_approval':exact_send_approval,
                      'selected_model_used':selected_model_used,
                      'checkpoint_safe':checkpoint_safe,'no_side_effects':no_side_effects,
                      'error': error,'final':final,'planner_turns':planner_turns,
                      'model_planned_assertions':scenario_checks,'nested_tool_assertions':nested_checks,
                      'assertion_count_note':'Nested tool-step events can repeat the model-planned assertion results; count each assertion once, using its parent tool.',
                      'permission_steps':permissions,'coverage': coverage,
                      'checkpoint': checkpoint, 'requests': requests,
                      'trace': trace, 'report': ''.join(reports)}
    serialized=json.dumps(evidence,ensure_ascii=True)
    output_path=os.getenv('MODEL_SMOKE_OUTPUT')
    if output_path:
        Path(output_path).write_text(serialized+'\n',encoding='utf-8')
    print(serialized)
    return 0 if success else 1


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
