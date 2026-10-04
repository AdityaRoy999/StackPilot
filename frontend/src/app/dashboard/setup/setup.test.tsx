import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SetupPage from "./page";
import api from "@/lib/api";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/api", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("@/lib/platform-icons", async () => import("lucide-react"));
vi.mock("@/components/AiProviderConnections", () => ({ AiProviderConnections: () => <p>Saved provider</p> }));
let root: Root, host: HTMLDivElement, queryClient: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(api.get).mockImplementation(async path => ({ data: path === "/ai/settings" ? { model: "fixture-model", provider_connections: [] } : { status: "ok" } }));
  vi.mocked(api.put).mockResolvedValue({ data: { success: true } });
});
afterEach(async () => { await act(async () => root.unmount()); queryClient.clear(); host.remove(); });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); }
async function open() { await act(async () => root.render(<QueryClientProvider client={queryClient}><SetupPage /></QueryClientProvider>)); await settle(); }
function button(text: string) { return [...host.querySelectorAll("button")].find(item => item.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); await settle(); }

it("keeps the guide open after a failed AI test and never records success", async () => {
  vi.mocked(api.post).mockResolvedValue({ data: { ok: false, error: "Provider rejected the key." } });
  await open(); await click("Continue"); await click("Test AI connection");
  expect(host.textContent).toContain("Provider rejected the key.");
  expect(button("Continue").disabled).toBe(true);
  expect(api.put).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});
it("saves the tested model before completing onboarding", async () => {
  vi.mocked(api.post).mockResolvedValue({ data: { ok: true, model: "fixture-model", latency_ms: 42 } });
  await open(); await click("Continue"); await click("Test AI connection");
  expect(api.post).toHaveBeenCalledWith("/ai/connection-test", { model: "fixture-model" });
  expect(api.put).toHaveBeenCalledWith("/ai/settings", { model: "fixture-model" });
  await click("Continue"); await click("Open projects");
  expect(api.put).toHaveBeenCalledWith("/auth/preferences", { preferences: { setup_completed: true, setup_ai_verified: true } });
  expect(push).toHaveBeenCalledWith("/dashboard");
});
it("allows deployment-only setup without pretending AI was verified", async () => {
  await open(); await click("Continue"); await click("Skip AI for now");
  expect(api.post).not.toHaveBeenCalled();
  expect(api.put).toHaveBeenCalledWith("/auth/preferences", { preferences: { setup_completed: true, setup_ai_verified: false } });
});
