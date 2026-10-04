import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProvider } from "@/context/WorkspaceContext";
import DashboardPage from "./page";
import api from "@/lib/api";

vi.mock("@/lib/api", () => ({ default: { get: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/platform-icons", async () => import("lucide-react"));
vi.mock("@/lib/custom-icons", () => ({ AppIcon: () => null }));
vi.mock("@/components/CreateProjectDialog", () => ({ CreateProjectDialog: () => <button>New Project</button> }));
vi.mock("@/components/EditProjectDialog", () => ({ EditProjectDialog: () => null }));
vi.mock("@/components/DeleteProjectDialog", () => ({ DeleteProjectDialog: () => null }));

const personal = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const team = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const projects = ["calculator", "club website", "portfolio"].map((name, index) => ({
  id: String(index), name, organization_id: personal, source_type: "github", repo_url: "https://example.test/repo", created_at: "2026-09-30",
}));
let root: Root, host: HTMLDivElement, client: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.get).mockImplementation(async path => ({ data: path === "/organizations"
    ? { organizations: [{ id: personal, name: "Personal" }, { id: team, name: "Team" }] }
    : { projects } }) as never);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });
async function render() {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><WorkspaceProvider><DashboardPage /></WorkspaceProvider></QueryClientProvider>);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
}

describe("project visibility", () => {
  it("recovers a stale workspace without sending its ID to the projects endpoint", async () => {
    localStorage.setItem("stackpilot_active_workspace_id", "deleted-workspace");
    await render();
    for (const project of projects) expect(host.textContent).toContain(project.name);
    expect(localStorage.getItem("stackpilot_active_workspace_id")).toBeNull();
    expect(api.get).toHaveBeenCalledWith("/projects");
  });

  it("explains an empty workspace and restores all projects with one click", async () => {
    localStorage.setItem("stackpilot_active_workspace_id", team);
    await render();
    expect(host.textContent).toContain("No projects in Team");
    expect(host.textContent).toContain("3 projects are available in your other workspaces");
    const all = [...host.querySelectorAll("button")].find(button => button.textContent === "View all projects")!;
    await act(async () => all.click());
    for (const project of projects) expect(host.textContent).toContain(project.name);
  });

  it("shows a request failure instead of saying the projects are gone, then retries", async () => {
    vi.mocked(api.get).mockImplementation(async path => {
      if (path === "/projects") throw new Error("offline");
      return { data: { organizations: [] } } as never;
    });
    await render();
    expect(host.textContent).toContain("Could not refresh your projects");
    expect(host.textContent).not.toContain("No projects yet");
    vi.mocked(api.get).mockResolvedValue({ data: { projects } } as never);
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Retry")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    expect(host.textContent).toContain("calculator");
  });
});
