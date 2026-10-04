import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import api from "./api";
import { browserSocketUrl, requestBrowserMode } from "./browser-sandbox";

vi.mock("./api", () => ({ default: { get: vi.fn() } }));

class Socket {
  static latest: Socket;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) { Socket.latest = this; }
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", Socket);
  vi.mocked(api.get).mockResolvedValue({ data: { ticket: "owned-ticket", control: true } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("current-chat sandbox selection", () => {
  it("uses the configured worker URL", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_SERVICE_WS_URL", "wss://fixture.invalid/");
    expect(browserSocketUrl("owned")).toBe("wss://fixture.invalid/ws/browser/owned");
    vi.unstubAllEnvs();
  });

  it("waits for the actual worker acknowledgement", async () => {
    const pending = requestBrowserMode("owned", "remote", "https://fixture.invalid/current");
    await Promise.resolve();
    const socket = Socket.latest;
    expect(socket.url).toContain("control_only=1");
    socket.onopen?.();
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: "switch_mode", sandbox_mode: "remote", url: "https://fixture.invalid/current" });
    socket.onmessage?.({ data: JSON.stringify({ type: "browser_mode", browser_mode: "remote" }) });
    expect(await pending).toBe("remote");
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("reports unconfigured workers without pretending to switch", async () => {
    const pending = requestBrowserMode("owned", "host");
    await Promise.resolve();
    Socket.latest.onmessage?.({ data: JSON.stringify({ type: "browser_error", message: "Host Chrome is not configured" }) });
    await expect(pending).rejects.toThrow("Host Chrome is not configured");
  });

  it("allows reading the current chat without opening a browser", async () => {
    const pending = requestBrowserMode("owned");
    await Promise.resolve();
    Socket.latest.onopen?.();
    expect(JSON.parse(Socket.latest.send.mock.calls[0][0])).toEqual({ type: "get_mode" });
    Socket.latest.onmessage?.({ data: JSON.stringify({ type: "browser_mode", browser_mode: null }) });
    expect(await pending).toBeNull();
  });

  it("does not issue a mode change with a view-only capability", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { ticket: "view-ticket", control: false } });
    await expect(requestBrowserMode("owned", "remote")).rejects.toThrow("administration access");
  });
});
