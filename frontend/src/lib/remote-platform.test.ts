import { afterEach, expect, it, vi } from "vitest";
import { isRemotePlatform, remoteHeaders, remoteDestination, platformSocketBase, remoteRuntimeHref } from "./remote-platform";
import { browserSocketUrl } from "./browser-sandbox";
import { streamAgentReply } from "./stream-agent";

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("keeps the whole paired dashboard and its browser on the phone gateway", () => {
  localStorage.setItem("stackpilot_remote_device", "sp_remote_fixture");
  expect(isRemotePlatform()).toBe(true);
  expect(remoteHeaders().Authorization).toBe("Bearer sp_remote_fixture");
  expect(browserSocketUrl("owned-chat")).toBe(`${platformSocketBase()}/ws/browser/owned-chat`);
});
it("accepts dashboard deep links and rejects redirects outside the platform", () => {
  expect(remoteDestination("?next=%2Fdashboard%2Fdeployments%3Fpage%3D2")).toBe("/dashboard/deployments?page=2");
  for (const next of ["//evil.test", "javascript:alert(1)", "/dashboard\\evil", "/dashboard-evil"]) {
    expect(remoteDestination(`?next=${encodeURIComponent(next)}`)).toBe("/dashboard");
  }
});
it("opens private runtimes on the host browser while keeping public web links usable", () => {
  localStorage.setItem("stackpilot_remote_device", "sp_remote_fixture");
  const link = remoteRuntimeHref("http://localhost:56331", "owned-deployment");
  expect(link).toContain("/dashboard/ai?");
  expect(link).toContain("deploymentId=owned-deployment");
  expect(link).toContain("custom_url=http%3A%2F%2Flocalhost%3A56331");
  expect(remoteRuntimeHref("https://public.example/app")).toBe("https://public.example/app");
  expect(remoteRuntimeHref("http://localhost:56331", undefined, false)).toBe("http://localhost:56331");
});
it("runs the full AI UI in the background and reads progress without replaying actions", async () => {
  localStorage.setItem("stackpilot_remote_device", "sp_remote_fixture");
  const events = [
    {type:"tool_call",name:"browser_interact",arguments:{action:"click"},sequence:1},
    {type:"permission_request",tool_name:"browser_interact",arguments:{action:"submit"},token:"one-step",sequence:2},
    {type:"done",content:"Waiting for approval",status:"waiting_for_permission",sequence:3},
  ];
  const fetch = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith("/chat/stream")
    ? {run_id:"owned-run",session_id:"owned-chat"}
    : {run:{id:"owned-run",state:"awaiting_approval",last_sequence:"3"},events}), {status:200}));
  vi.stubGlobal("fetch", fetch);
  const received = vi.fn();
  await streamAgentReply({message:"Test",sessionId:"owned-chat",agentAccessMode:"ask",onEvent:received});
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/v1/ai/chat/stream","/api/v1/remote/runs/owned-run?after=0"]);
  const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
  const body = JSON.parse(init.body as string);
  expect(body).toMatchObject({background:true,session_id:"owned-chat",agent_access_mode:"ask"});
  expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(received.mock.calls.slice(1).map(([event]) => event)).toEqual(events);
});
