import { afterEach, expect, it, vi } from "vitest";
import api from "./api";
import { browserSocketUrl } from "./browser-sandbox";
import { campaignEndpoint, campaignFetch, campaignStatus, recordingManifest } from "./browser-campaign";

vi.mock("./api", () => ({ default: { get: vi.fn() } }));
vi.mock("./browser-sandbox", () => ({ browserSocketUrl: vi.fn(() => "wss://remote.invalid/gateway/ws/browser/chat") }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

it("preserves remote routing and sends pagination as a query, not an encoded path", () => {
  vi.mocked(browserSocketUrl).mockReturnValue("wss://remote.invalid/gateway/ws/browser/chat");
  const status = new URL(campaignEndpoint("chat", "job", "?after=99"));
  expect(status.pathname).toBe("/gateway/ws/browser/chat/campaigns/job");
  expect(status.searchParams.get("after")).toBe("99");
  expect(campaignEndpoint("chat", "job", "/recording?after=1000")).toBe("https://remote.invalid/gateway/ws/browser/chat/campaigns/job/recording?after=1000");
  vi.mocked(browserSocketUrl).mockReturnValue("ws://127.0.0.1:8010/ws/browser/chat");
  expect(campaignEndpoint("chat", "job", "/control")).toBe("http://127.0.0.1:8010/ws/browser/chat/campaigns/job/control");
});

it("uses a short-lived backend capability and refreshes it after rejection", async () => {
  vi.mocked(browserSocketUrl).mockReturnValue("ws://localhost:8010/ws/browser/auth");
  vi.mocked(api.get).mockResolvedValueOnce({ data: { ticket: "expired-ticket" } }).mockResolvedValueOnce({ data: { ticket: "renewed-ticket" } });
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Expired" }), { status: 401 }))
    .mockResolvedValue(new Response(JSON.stringify({ state: "running" })));
  vi.stubGlobal("fetch", fetcher);
  await expect(campaignFetch("auth", "job")).rejects.toThrow("Expired");
  expect((await campaignStatus("auth", "job", 15)).state).toBe("running");
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toContain("?after=15");
  expect(fetcher.mock.calls[1][1].headers["X-StackPilot-Browser-Ticket"]).toBe("renewed-ticket");
});

it("loads all replay pages and rejects a stuck cursor", async () => {
  vi.mocked(browserSocketUrl).mockReturnValue("ws://localhost:8010/ws/browser/replay");
  vi.mocked(api.get).mockResolvedValue({ data: { ticket: "replay-ticket" } });
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ frames: [{ sequence: 1, timestamp: 0 }], next_after: 1 })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ frames: [{ sequence: 2, timestamp: 2 }], next_after: null })))
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ frames: [], next_after: 0 }))));
  vi.stubGlobal("fetch", fetcher);
  expect(await recordingManifest("replay", "job")).toHaveLength(2);
  expect(fetcher.mock.calls[1][0]).toContain("/recording?after=1");
  await expect(recordingManifest("replay", "job")).rejects.toThrow("did not advance");
});
