import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import api from "@/lib/api";
import { ProjectStackIcons, useProjectStack } from "./ProjectStack";
import type { ProjectStackResponse } from "@/lib/project-stack";

vi.mock("@/lib/api", () => ({ default: { get: vi.fn() } }));
vi.mock("./TechnologyIcon", () => ({ TechnologyIcon: ({ name }: { name: string }) => <span>{name}</span> }));

let root: Root;
let client: QueryClient;
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  document.body.replaceChildren();
  vi.resetAllMocks();
});

const saved = (id: string): ProjectStackResponse => ({
  stack: { status: "detected", components: [{ id, name: id, kind: "framework", role: "frontend", evidence: ["package.json"] }], manifests: ["package.json"], files_scanned: 1, truncated: false, message: "", method: "manifests" },
  cache: { cached: true, stale: false, inspected_at: "2026-10-16T00:00:00Z" },
});

function Controls() {
  const query = useProjectStack("project", "revision");
  return <><button onClick={() => query.refresh()}>Refresh stack</button>{query.refreshFailed && <p>Saved stack retained</p>}</>;
}

async function render() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><ProjectStackIcons projectId="project" updatedAt="revision" /><Controls /></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

it("shares the saved stack and updates project icons after an explicit source refresh", async () => {
  vi.mocked(api.get).mockImplementation(async url => ({ data: String(url).startsWith("/projects/") ? saved(String(url).includes("?refresh=1") ? "Vue" : "React") : {} }));
  await render();
  expect(vi.mocked(api.get).mock.calls.filter(([url]) => url === "/projects/project/stack")).toHaveLength(1);
  expect(document.body.textContent).toContain("React");
  await act(async () => document.querySelector("button")!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(api.get).toHaveBeenCalledWith("/projects/project/stack?refresh=1");
  expect(document.body.textContent).toContain("Vue");
  expect(document.body.textContent).not.toContain("React");
});

it("keeps saved project icons when a manual refresh cannot reach the source", async () => {
  vi.mocked(api.get).mockImplementation(async url => {
    if (String(url).includes("?refresh=1")) throw new Error("Source offline");
    return { data: String(url).startsWith("/projects/") ? saved("React") : {} };
  });
  await render();
  await act(async () => document.querySelector("button")!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(document.body.textContent).toContain("React");
  expect(document.body.textContent).toContain("Saved stack retained");
});
