import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import * as campaign from "@/lib/browser-campaign";
import { BrowserCampaignCard } from "./BrowserCampaignCard";

vi.mock("@/lib/browser-campaign", () => ({ campaignEnded: (state: string) => ["completed", "cancelled", "budget_exhausted"].includes(state), campaignStatus: vi.fn(), controlCampaign: vi.fn(), campaignFetch: vi.fn(), recordingManifest: vi.fn() }));
vi.mock("@/components/ui/chat-markdown", () => ({ ChatMarkdown: ({ content }: { content: string }) => <p>{content}</p> }));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren(); vi.useRealTimers(); vi.resetAllMocks();
});

function status(state: string): campaign.CampaignStatus {
  return { id: "job", session_id: "chat", state, reason: "", max_pages: 250, actions: 5, tokens: 0, deadline: 0,
    tasks: [{ kind: "page", state: "completed", count: 120 }, { kind: "workflow", state: "completed", count: 2 }, { kind: "workflow", state: "unverified", count: 3 }],
    events: [], recording: { count: 5, bytes: 500 }, exhaustive: false };
}
async function render() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(<BrowserCampaignCard sessionId="chat" campaignId="job" />));
  return host;
}
function button(host: HTMLElement, text: string) { return [...host.querySelectorAll("button")].find(node => node.textContent === text)!; }

it("separates page coverage from workflow verification and stops polling after completion", async () => {
  vi.useFakeTimers();
  vi.mocked(campaign.campaignStatus).mockResolvedValueOnce(status("running")).mockResolvedValue(status("completed"));
  const host = await render();
  expect(host.textContent).toContain("120 / 120 pages explored · 2 / 5 workflows verified");
  expect(button(host, "Replay").disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(button(host, "Replay").disabled).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(campaign.campaignStatus).toHaveBeenCalledTimes(2);
});

it("keeps a pending permission visible after refresh and sends only its exact signed approval", async () => {
  const waiting = { ...status("waiting_for_permission"), pending_request: { sequence: 125, type: "permission_request", token: "exact-approval", browser_step: { label: "Submit booking", url: "https://fixture.invalid", action: "click", reason: "Commit" } } };
  vi.mocked(campaign.campaignStatus).mockResolvedValue(waiting);
  vi.mocked(campaign.controlCampaign).mockResolvedValue(status("queued"));
  const host = await render();
  expect(host.textContent).toContain("Submit booking");
  await act(async () => button(host, "Approve & continue").click());
  expect(campaign.controlCampaign).toHaveBeenCalledWith("chat", "job", "answer", { approval_token: "exact-approval" });
  expect(host.textContent).not.toContain("Submit booking");
});
