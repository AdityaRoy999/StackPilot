import type { SubagentTask } from "@/components/ui/subagent-block";
import type { AgentStreamEvent } from "@/lib/stream-agent";

export type AgentTaskStatus = "queued" | "running" | "submitted" | "blocked" | "completed" | "failed" | "canceled";

export function agentTaskStatus(value: unknown): AgentTaskStatus {
  return ["queued", "running", "submitted", "blocked", "completed", "failed", "canceled"].includes(String(value))
    ? value as AgentTaskStatus : "queued";
}

/** Apply actual execution evidence by agent ID, never by a shared role label. */
export function applyAgentEvent(tasks: SubagentTask[], event: AgentStreamEvent): SubagentTask[] {
  if (event.type === "done" && event.team_tasks) {
    return tasks.map(task => {
      const observed = event.team_tasks?.find(value => value.id === task.id);
      return observed ? { ...task, status: agentTaskStatus(observed.state) } : task;
    });
  }
  const id = event.type === "subagent_start" || event.type === "subagent_complete" || event.type === "agent_task_update"
    ? event.id : event.agent_id;
  if (!id || id === "lead") return tasks;
  const previous = tasks.find(task => task.id === id);
  if (previous?.lastSequence && event.sequence && event.sequence <= previous.lastSequence) return tasks;
  let next: SubagentTask;
  if (event.type === "subagent_start") {
    next = { ...previous, id, role: event.role || previous?.role || "Task worker",
      task: event.task || previous?.task, title: event.title || event.role || previous?.title,
      status: agentTaskStatus(event.status), lastSequence: event.sequence };
  } else if (!previous) {
    return tasks;
  } else if (event.type === "subagent_complete" || event.type === "agent_task_update") {
    next = { ...previous, status: agentTaskStatus(event.status), result: event.result || previous.result,
      lastSequence: event.sequence };
  } else if (event.type === "tool_call" || event.type === "tool_result" || event.type === "tool_step") {
    const calls = [...(previous.toolCalls || [])];
    const index = calls.findIndex(call => call.id === event.id);
    const call = event.type === "tool_result"
      ? { ...(index >= 0 ? calls[index] : {name: event.name, arguments: {}}), id: event.id, result: {...event.result,run_id:event.run_id} }
      : { id: event.id, name: event.name, arguments: event.arguments, ...(event.type === "tool_step" ? {result: {...event.result,run_id:event.run_id}} : {}) };
    if (index >= 0) calls[index] = call;
    else calls.push(call);
    next = { ...previous, toolCalls: calls, lastSequence: event.sequence };
  } else if (event.type === "agent_message") {
    next = { ...previous, messages: [...(previous.messages || []), {id: event.id, content: event.content, recipient: event.recipient}], lastSequence: event.sequence };
  } else if (event.type === 'provider_retry') {
    next={...previous,providerRetry:event.retry,lastSequence:event.sequence};
  } else if (event.type === 'model_timing') {
    next={...previous,modelCalls:(previous.modelCalls || 0)+1,lastModelLatencyMs:event.elapsed_ms,
      providerRetry:undefined,lastSequence:event.sequence};
  } else return tasks;
  return previous ? tasks.map(task => task.id === id ? next : task) : [...tasks, next];
}
