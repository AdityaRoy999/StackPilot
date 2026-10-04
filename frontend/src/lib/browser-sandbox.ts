import api from "./api";
import { isRemotePlatform, platformSocketBase } from "./remote-platform";

export type BrowserSandboxMode = "local" | "remote" | "host";

export function browserSocketUrl(sessionId: string) {
  if (isRemotePlatform()) {
    return `${platformSocketBase()}/ws/browser/${sessionId}`;
  }
  const base = process.env.NEXT_PUBLIC_AI_SERVICE_WS_URL;
  if (base) return `${base.replace(/\/$/, "")}/ws/browser/${sessionId}`;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname === "localhost" ? "127.0.0.1" : window.location.hostname;
  return `${protocol}//${host}:8010/ws/browser/${sessionId}`;
}

export async function requestBrowserMode(sessionId: string, mode?: BrowserSandboxMode, url?: string): Promise<BrowserSandboxMode | null> {
  const capability = await api.get(`/ai/browser-ticket/${encodeURIComponent(sessionId)}`);
  if (mode && capability.data.control === false) throw new Error("Changing the sandbox requires session administration access.");
  const endpoint = new URL(browserSocketUrl(sessionId));
  endpoint.searchParams.set("ticket", capability.data.ticket);
  endpoint.searchParams.set("control_only", "1");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint.toString());
    let settled = false;
    const finish = (error?: Error, value: BrowserSandboxMode | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error); else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error("The browser worker did not respond. Your previous sandbox is still selected.")), 25000);
    socket.onopen = () => socket.send(JSON.stringify(mode
      ? { type: "switch_mode", sandbox_mode: mode, url: url || "about:blank" }
      : { type: "get_mode" }));
    socket.onmessage = event => {
      try {
        const result = JSON.parse(event.data);
        if (result.type === "browser_error") finish(new Error(result.message));
        else if (result.type === "browser_mode") {
          const actual = result.browser_mode;
          if (actual !== null && !["local", "remote", "host"].includes(actual)) finish(new Error("Invalid browser worker response."));
          else finish(undefined, actual);
        }
      } catch { finish(new Error("Invalid browser worker response.")); }
    };
    socket.onerror = () => finish(new Error("Could not connect to the browser service. Check that it is running."));
    socket.onclose = () => finish(new Error("The browser connection closed before confirming the sandbox change."));
  });
}
