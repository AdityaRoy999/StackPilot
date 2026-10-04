import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppIcon, DEFAULT_ICON_SETTINGS, ICON_DEFINITIONS, ICON_MAP, PLATFORM_ICON_IDS, adaptSvgColors, saveIconSettings, useIconSettings } from "./custom-icons";
import { PLATFORM_LUCIDE_ICONS } from "./platform-icon-map";
import { VECTOR_PACKS } from "./generated-icon-packs";
import api from "@/lib/api";

vi.mock("@/lib/api", () => ({ default: { get: vi.fn().mockRejectedValue(new Error("offline fixture")), put: vi.fn().mockResolvedValue({ data: {} }) } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { await act(async () => roots.splice(0).forEach((root) => root.unmount())); });

describe("platform icon coverage and saved customization", () => {
  it("registers every platform Lucide symbol in the configurable catalog", () => {
    for (const [name, Icon] of Object.entries(PLATFORM_LUCIDE_ICONS)) {
      expect(ICON_MAP.get(PLATFORM_ICON_IDS[name])?.defaultIcon).toBe(Icon);
    }
  });
  it("normalizes repeated imports without deleting legitimate outline geometry", () => {
    const raw = '<svg viewBox="0 0 24 24" fill="none" preserveAspectRatio="xMidYMid meet"><rect x="2" y="2" width="20" height="20" fill="none" stroke="#000"/></svg>';
    const once = adaptSvgColors(raw);
    expect(once).toContain('<rect');
    expect(once).toContain('stroke="currentColor"');
    expect(adaptSvgColors(once)).toBe(once);
  });
  it("keeps all batch edits and restores uploaded vectors after switching modes", async () => {
    const host = document.createElement("div");
    const root = createRoot(host); roots.push(root);
    let actions: ReturnType<typeof useIconSettings>[1];
    function Harness() { [, actions] = useIconSettings(); return <AppIcon name="server" />; }
    const one = '<svg viewBox="0 0 24 24"><path d="M1 1L2 2"/></svg>';
    const two = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>';
    await act(async () => { saveIconSettings(DEFAULT_ICON_SETTINGS); root.render(<Harness />); });
    await act(async () => { actions!.setOverride("server", one); actions!.setOverride("plus", two); actions!.setAllIconModes("custom"); });
    const saved = JSON.parse(localStorage.getItem("stackpilot.icon-settings")!);
    expect(saved.overrides.server).toContain('M1 1L2 2');
    expect(saved.overrides.plus).toContain('<circle');
    await act(async () => { actions!.setMode("default"); });
    expect(host.querySelector(".app-custom-svg")).toBeNull();
    expect(JSON.parse(localStorage.getItem("stackpilot.icon-settings")!).overrides.server).toContain('M1 1L2 2');
    await act(async () => { actions!.setMode("custom"); });
    expect(host.querySelector(".app-custom-svg path")?.getAttribute("d")).toBe('M1 1L2 2');
  });
  it("renders loaded custom vectors without forwarding caller children into innerHTML", async () => {
    const host = document.createElement("div");
    const root = createRoot(host); roots.push(root);
    await act(async () => {
      saveIconSettings(DEFAULT_ICON_SETTINGS);
      root.render(<AppIcon name="server" forceMode="custom">ignored child</AppIcon>);
    });
    await act(async () => { await import("./generated-icon-pack-duotone"); });
    expect(host.querySelector("svg path")).not.toBeNull();
    expect(host.textContent).not.toContain("ignored child");
  });
  it("has a usable vector for every configurable icon in all six packs", () => {
    for (const definition of ICON_DEFINITIONS) {
      for (const pack of ["minimal", "duotone", "neon", "carbon", "iconoir", "fluent"] as const) {
        const vector = VECTOR_PACKS[definition.id]?.[pack];
        expect(vector?.viewBox, `${definition.id} in ${pack}`).toMatch(/^0 0 \d+ \d+$/);
        expect(vector?.body, `${definition.id} in ${pack}`).toContain("<");
      }
    }
  });
  it("restores the signed-in account after login without merging another account's cached icons", async () => {
    const host = document.createElement("div");
    const root = createRoot(host); roots.push(root);
    history.replaceState({}, "", "/auth/login");
    vi.mocked(api.get).mockClear();
    await act(async () => { root.render(<AppIcon name="server" />); });
    expect(api.get).not.toHaveBeenCalled();
    vi.mocked(api.get).mockResolvedValueOnce({ data: { mode: "custom", pack: "minimal", icon_modes: { server: "custom" }, overrides: { server: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/></svg>' } } });
    history.replaceState({}, "", "/dashboard");
    await act(async () => { root.render(<AppIcon key="signed-in" name="server" />); });
    expect(host.querySelector(".app-custom-svg circle")?.getAttribute("r")).toBe("5");
    expect(JSON.parse(localStorage.getItem("stackpilot.icon-settings")!).overrides.plus).toBeUndefined();
  });
});
