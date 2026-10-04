import { afterEach, expect, it, vi } from "vitest";
import { streamAgentReply } from "./stream-agent";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("forwards one browser approval in memory and retains the paused/verified stream status", async () => {
  const frames = [
    { type: "permission_request", id: "step-1", tool_name: "browser_interact", arguments: {action: "click"}, token: "fixture-token",
      browser_step: {url:"https://fixture.invalid",label:"Submit",action:"click",reason:"Sends data",step_index:0} },
    { type: "done", status: "waiting_for_permission", verified: false, content: "" },
  ];
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), {status:200}));
  vi.stubGlobal("fetch", fetch);
  const onEvent = vi.fn();
  await streamAgentReply({message:"Approve this browser step and continue the website test.",sessionId:"fixture-chat",approvalToken:"fixture-token",onEvent});
  const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
  expect(body).toMatchObject({session_id:"fixture-chat",approval_token:"fixture-token",runtime:{permissions:{agent_access_mode:"ask"}}});
  expect(onEvent.mock.calls.map(([event]) => event)).toEqual(frames);
  expect(storage).not.toHaveBeenCalled();
});
