import type { AgentStreamEvent } from "./stream-agent";
import { remoteHeaders } from "./remote-platform";

export interface RemoteRun { id: string; session_id: string; state: string; last_sequence: string; }
export interface RemoteRunBatch { run: RemoteRun; events: AgentStreamEvent[]; }
export async function remoteRunRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/remote${path}`, {
    credentials: "include", cache: "no-store", headers: remoteHeaders(), signal,
  });
  if (!response.ok) throw new Error(response.status === 401 ? "This phone was disconnected. Pair again." : `Host progress unavailable (HTTP ${response.status}).`);
  return response.json();
}
export function remotePause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
// Quick Tunnels do not carry SSE. The host keeps producing events; the full
// dashboard reads sequence-numbered batches without replaying any AI action.
export async function followRemoteRun(id: string, onEvent: (event: AgentStreamEvent) => void, signal?: AbortSignal): Promise<void> {
  let cursor = 0;
  for (;;) {
    const batch = await remoteRunRequest<RemoteRunBatch>(`/runs/${encodeURIComponent(id)}?after=${cursor}`, signal);
    let completed = false;
    for (const event of [...batch.events].sort((a, b) => (a.sequence || 0) - (b.sequence || 0))) {
      if (!event.sequence || event.sequence <= cursor) continue;
      cursor = event.sequence; onEvent(event);
      if (event.type === "done") completed = true;
    }
    if (completed) return;
    if (cursor >= Number(batch.run.last_sequence) && batch.run.state !== "working") {
      if (batch.run.state === "interrupted" || batch.run.state === "failed") throw new Error("The host could not complete this request. Its last actions were not replayed.");
      return;
    }
    await remotePause(cursor < Number(batch.run.last_sequence) ? 0 : 800, signal);
  }
}
