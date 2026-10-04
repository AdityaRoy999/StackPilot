export const DEVICE_KEY = "stackpilot_remote_device";
export interface RemoteEvent {
  sequence: number; type: string; delta?: string; content?: string;
  name?: string; tool_name?: string; id?: string; token?: string;
  description?: string; error?: string; question?: string;
  arguments?: Record<string, unknown>; result?: Record<string, unknown>;
  browser_step?: Record<string, unknown>;
  fields?: Array<{ id: string; label: string; type: string; options?: string[]; default_value?: string; placeholder?: string }>;
}
export interface RemoteProgress { cursor: number; content: string; activity: RemoteEvent[]; approval: RemoteEvent | null; question: RemoteEvent | null; error: string; }
export const emptyProgress: RemoteProgress = { cursor: 0, content: "", activity: [], approval: null, question: null, error: "" };
// Replayed batches may overlap after reconnect. The sequence is the only event identity.
export function applyRemoteEvents(previous: RemoteProgress, incoming: RemoteEvent[]): RemoteProgress {
  const next = { ...previous, activity: [...previous.activity] };
  for (const event of [...incoming].sort((a, b) => a.sequence - b.sequence)) {
    if (event.sequence <= next.cursor) continue;
    next.cursor = event.sequence;
    if (event.type === "content") next.content += event.delta || "";
    if (event.type === "done" && typeof event.content === "string") next.content = event.content;
    if (event.type === "permission_request") next.approval = event;
    if (event.type === "agent_question") next.question = event;
    if (event.type === "error") next.error = event.error || "The request failed.";
    if (["tool_call", "tool_result", "tool_step", "agent_question", "subagent_complete"].includes(event.type)) {
      next.activity.push(event); next.activity = next.activity.slice(-100);
    }
  }
  return next;
}
export function deviceSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `sp_remote_${Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")}`;
}
export class RemoteError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function remoteRequest<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const token = localStorage.getItem(DEVICE_KEY);
  const response = await fetch(`/api/v1/remote${path}`, {
    method: method || (body ? "POST" : "GET"), credentials: "include", cache: "no-store",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok) throw new RemoteError(data.error || "The host did not respond.", response.status);
  return data as T;
}
