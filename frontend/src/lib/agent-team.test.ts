import { describe, expect, it } from 'vitest';
import { applyAgentEvent } from './agent-team';

describe('actual team execution events', () => {
  it('keeps same-role workers independent and ignores replayed events', () => {
    let tasks = applyAgentEvent([], {type:'subagent_start',id:'a',role:'Specialist',status:'queued',sequence:1});
    tasks = applyAgentEvent(tasks, {type:'subagent_start',id:'b',role:'Specialist',status:'running',sequence:2});
    tasks = applyAgentEvent(tasks, {type:'subagent_complete',id:'a',role:'Specialist',status:'blocked',sequence:3});
    expect(tasks.map(t=>t.status)).toEqual(['blocked','running']);
    expect(applyAgentEvent(tasks,{type:'subagent_start',id:'a',status:'running',sequence:1})).toBe(tasks);
  });
  it('attaches each step and screenshot to its actual worker', () => {
    let tasks = applyAgentEvent([], {type:'subagent_start',id:'a',status:'running'});
    tasks = applyAgentEvent(tasks,{type:'tool_step',agent_id:'a',id:'step',parent_id:'call',name:'browser_interact',arguments:{action:'click'},result:{frame:'data:image/png;base64,AA=='}});
    expect(tasks[0].toolCalls?.[0].result?.frame).toBe('data:image/png;base64,AA==');
    expect(applyAgentEvent(tasks,{type:'subagent_complete',role:'Specialist',status:'completed'})).toBe(tasks);
  });
  it('tracks real provider recovery without claiming task completion', () => {
    let tasks=applyAgentEvent([],{type:'subagent_start',id:'a',status:'running',sequence:1});
    tasks=applyAgentEvent(tasks,{type:'provider_retry',agent_id:'a',retry:1,reason:'ConnectTimeout',sequence:2});
    expect(tasks[0].providerRetry).toBe(1);
    tasks=applyAgentEvent(tasks,{type:'model_timing',agent_id:'a',elapsed_ms:32000,sequence:3});
    expect(tasks[0].status).toBe('running');
    expect(tasks[0].providerRetry).toBeUndefined();
    expect(tasks[0].lastModelLatencyMs).toBe(32000);
  });
});
