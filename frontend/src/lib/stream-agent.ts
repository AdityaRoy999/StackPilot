/**
 * Reads the agent's Server-Sent Events stream.
 *
 * EventSource is not usable here: it only issues GETs, and the request carries
 * a JSON body. So this is fetch + a ReadableStream reader, which also gives us
 * an AbortController for cancellation — worth having, because a thinking-mode
 * reply can run for minutes and the user may well change their mind.
 */

export type AgentStreamEvent =
  | { type: "start"; trace_id?: string; model?: string; provider?: string; session_id?: string }
  | { type: "reasoning"; delta: string }
  | { type: "content"; delta: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown>; id?: string }
  | { type: "tool_result"; name: string; result: Record<string, unknown>; id?: string }
  | {
      type: "permission_request";
      tool_name: string;
      arguments: Record<string, unknown>;
      risk_level?: string;
      token?: string;
    }
  | {
      type: "subagent_start";
      id?: string;
      role?: string;
      title?: string;
      task?: string;
      status?: string;
    }
  | {
      type: "subagent_complete";
      id?: string;
      role?: string;
      result?: string;
      status?: string;
    }
  | { type: "error"; error: string }
  | {
      type: "done";
      trace_id?: string;
      provider?: string;
      model?: string;
      content?: string;
      reasoning?: string;
      latency_ms?: number;
      token_usage?: Record<string, number>;
      session_id?: string;
    };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8090/api/v1";

export interface StreamAgentOptions {
  message: string;
  sessionId?: string;
  projectId?: string;
  deploymentId?: string;
  command?: string;
  workflowType?: string;
  modelMode?: "fast" | "thinking";
  model?: string;
  provider?: string;
  project?: unknown;
  agentAccessMode?: "ask" | "auto_review" | "full_access";
  remoteTerminal?: "ask" | "allow";
  images?: string[];
  customUrl?: string;
  sandboxMode?: "local" | "remote";
  signal?: AbortSignal;
  onEvent: (event: AgentStreamEvent) => void;
}

export async function streamAgentReply({
  message,
  sessionId,
  projectId,
  deploymentId,
  command,
  workflowType,
  modelMode = "fast",
  model,
  provider,
  project,
  agentAccessMode,
  remoteTerminal,
  images,
  customUrl,
  sandboxMode,
  signal,
  onEvent,
}: StreamAgentOptions): Promise<void> {
  const response = await fetch(`${API_BASE}/ai/chat/stream`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-stackpilot-CSRF": "1",
    },
    body: JSON.stringify({
      message,
      model_mode: modelMode,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(projectId ? { project_id: projectId } : {}),
      ...(deploymentId ? { deployment_id: deploymentId } : {}),
      ...(customUrl ? { custom_url: customUrl } : {}),
      sandbox_mode: sandboxMode || "local",
      ...(command ? { command } : {}),
      ...(workflowType ? { workflow_type: workflowType } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(project ? { project } : {}),
      ...(agentAccessMode ? { agent_access_mode: agentAccessMode } : {}),
      ...(remoteTerminal ? { remote_terminal: remoteTerminal } : {}),
      ...(images && images.length > 0 ? { images } : {}),
      runtime: {
        ...(customUrl ? { url: customUrl, custom_url: customUrl } : {}),
        permissions: {
          agent_access_mode: agentAccessMode || "ask",
          remote_terminal: remoteTerminal || "ask",
        },
      },
    }),
    signal,
  });

  if (!response.ok) {
    // The error arrives as normal JSON, because the stream never opened.
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      detail = body?.error || detail;
    } catch {
      // Keep the status line.
    }
    throw new Error(detail);
  }
  if (!response.body) {
    throw new Error("This browser did not provide a readable response stream.");
  }

  const reader = response.body.getReader();
  // stream: true matters — a multi-byte character can be split across two
  // network reads, and decoding each read independently would corrupt it.
  const decoder = new TextDecoder();
  let buffer = "";

  const parseFrame = (frame: string) => {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AgentStreamEvent);
      } catch {
        // A malformed frame should not kill a stream that is otherwise
        // producing a good answer.
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) {
          parseFrame(buffer);
          buffer = "";
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line (\r\n\r\n or \n\n). Anything after
      // the last complete separator is a partial frame and stays in the buffer.
      for (;;) {
        const crlfIdx = buffer.indexOf("\r\n\r\n");
        const lfIdx = buffer.indexOf("\n\n");
        if (crlfIdx === -1 && lfIdx === -1) break;

        let boundary: number;
        let delimLen: number;
        if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx < lfIdx)) {
          boundary = crlfIdx;
          delimLen = 4;
        } else {
          boundary = lfIdx;
          delimLen = 2;
        }

        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + delimLen);
        parseFrame(frame);
      }
    }
  } finally {
    // Releasing the lock lets the connection be torn down promptly on abort,
    // rather than lingering until GC.
    reader.releaseLock();
  }
}
