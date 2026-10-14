import api from "./api";
import { browserSocketUrl } from "./browser-sandbox";

export interface CampaignEvent {
  sequence: number;
  type: string;
  question?: string;
  token?: string;
  description?: string;
  browser_step?: { label: string; url: string; action: string; reason: string };
  fields?: Array<{ id: string; label: string; options?: string[] }>;
}

export interface CampaignStatus {
  id: string;
  session_id: string;
  state: string;
  reason: string;
  max_pages: number;
  actions: number;
  tokens: number;
  deadline: number;
  tasks: Array<{ kind: string; state: string; count: number }>;
  events: CampaignEvent[];
  recording: { count: number; bytes: number };
  exhaustive: false;
  pending_request?: CampaignEvent | null;
}

export interface RecordingFrame { sequence: number; timestamp: number }
export const campaignEnded = (state: string) => ["completed", "cancelled", "failed", "budget_exhausted"].includes(state);

export function campaignEndpoint(sessionId: string, campaignId: string, suffix = "") {
  const url = new URL(browserSocketUrl(encodeURIComponent(sessionId)));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname += `/campaigns/${encodeURIComponent(campaignId)}`;
  // Keep query parameters out of pathname (URL would encode '?' as '%3F').
  return new URL(`${url.pathname}${suffix}`, url.origin).toString();
}

// Capability refresh stays behind the authenticated API. No service secret is
// sent to the browser, and revoked phone devices cannot refresh this ticket.
const tickets = new Map<string, { value: string; until: number }>();
export async function campaignFetch(sessionId: string, campaignId: string, suffix = "", init: RequestInit = {}) {
  let ticket = tickets.get(sessionId);
  if (!ticket || ticket.until < Date.now()) {
    const response = await api.get(`/ai/browser-ticket/${encodeURIComponent(sessionId)}`, { signal: init.signal ?? undefined });
    ticket = { value: response.data.ticket, until: Date.now() + 180000 };
    tickets.set(sessionId, ticket);
  }
  const response = await fetch(campaignEndpoint(sessionId, campaignId, suffix), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers, "X-StackPilot-Browser-Ticket": ticket.value },
    cache: "no-store",
  });
  if (response.status === 401 && tickets.get(sessionId) === ticket) tickets.delete(sessionId);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || "Campaign request failed. Retry after checking your connection.");
  }
  return response;
}

export async function campaignStatus(sessionId: string, campaignId: string, after = 0, signal?: AbortSignal): Promise<CampaignStatus> {
  return (await campaignFetch(sessionId, campaignId, `?after=${after}`, { signal })).json();
}

export async function controlCampaign(sessionId: string, campaignId: string, action: string, answer: { message?: string; approval_token?: string } = {}): Promise<CampaignStatus> {
  return (await campaignFetch(sessionId, campaignId, "/control", {
    method: "POST", body: JSON.stringify({ action, ...answer }),
  })).json();
}

export async function recordingManifest(sessionId: string, campaignId: string, signal?: AbortSignal) {
  const frames: RecordingFrame[] = [];
  let after = 0;
  do {
    const page: { frames: RecordingFrame[]; next_after: number | null } = await (await campaignFetch(sessionId, campaignId, `/recording?after=${after}`, { signal })).json();
    frames.push(...page.frames);
    if (page.next_after === null) break;
    if (page.next_after <= after) throw new Error("Recording pagination did not advance.");
    after = page.next_after;
  } while (!signal?.aborted);
  return frames;
}
