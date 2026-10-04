import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileSimulatorDialog } from "./MobileSimulatorDialog";
import api from "@/lib/api";

vi.mock("@/lib/api", () => ({ default: { get: vi.fn() } }));
vi.mock("@/lib/platform-icons", async () => import("lucide-react"));
vi.mock("@/lib/custom-icons", () => ({ AppIcon: () => null }));
vi.mock("@/components/HostRuntimeView", () => ({
  HostRuntimeView: ({ url }: { url: string }) => <div data-host-runtime={url} />,
}));

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem("stackpilot_remote_device", "sp_remote_fixture");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.mocked(api.get).mockResolvedValue({ data: { preview_url: "http://native-worker:8080/owned-preview" } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); });

it("lets a paired phone open and share a host-local web deployment", async () => {
  await act(async () => root.render(<MobileSimulatorDialog open onClose={() => {}} deploymentTitle="Owned app" runtimeUrl="http://localhost:56331" deploymentId="owned-deployment" />));
  expect(document.querySelector('[data-host-runtime="http://localhost:56331"]')).not.toBeNull();
  expect(document.querySelector('iframe[src^="http://localhost"]')).toBeNull();
  expect(document.querySelector('a[href="/preview/owned-deployment"]')).not.toBeNull();
  await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Scan on Phone"))!.click());
  const qr = document.querySelector<HTMLImageElement>('img[src^="https://api.qrserver.com"]')!;
  const shared = new URL(qr.src).searchParams.get("data");
  expect(shared).toContain("custom_url=http%3A%2F%2Flocalhost%3A56331");
  expect(shared).toContain("deploymentId=owned-deployment");
});

it("opens a private native emulator viewer through the host, instead of fetching it from the phone", async () => {
  await act(async () => root.render(<MobileSimulatorDialog open onClose={() => {}} deploymentTitle="Owned Android" runtimeUrl="http://localhost:56331/artifacts" deploymentId="owned-deployment" archetype="native_android" />));
  expect(api.get).toHaveBeenCalledWith("/deployments/owned-deployment/native-preview-ticket");
  expect(document.querySelector('[data-host-runtime="http://native-worker:8080/owned-preview"]')).not.toBeNull();
  expect(document.querySelector('iframe[src^="http:"]')).toBeNull();
});
