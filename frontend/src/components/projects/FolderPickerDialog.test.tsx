import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import api from "@/lib/api";
import { FolderPickerDialog } from "./FolderPickerDialog";

vi.mock("@/lib/api", () => ({ default: { post: vi.fn(), get: vi.fn(() => Promise.resolve({ data: {} })) } }));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren();
  vi.resetAllMocks();
});

async function render(mode: "local" | "remote" = "local", initialPath = "") {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  const onSelect = vi.fn(); const onOpenChange = vi.fn();
  await act(async () => root.render(<FolderPickerDialog open mode={mode} connectionId="server" initialPath={initialPath} onSelect={onSelect} onOpenChange={onOpenChange} />));
  return { root, onSelect, onOpenChange };
}
function button(text: string) { return [...document.querySelectorAll("button")].find(node => node.textContent?.includes(text))!; }

it("keeps folder navigation provisional until explicitly selected and returns to allowed roots", async () => {
  const sourceRoots = [{ path: "/projects", name: "Projects" }];
  vi.mocked(api.post).mockResolvedValueOnce({ data: { path: "", roots: sourceRoots, entries: [] } }).mockResolvedValueOnce({ data: { path: "/projects", roots: sourceRoots, entries: [] } }).mockResolvedValueOnce({ data: { path: "", roots: sourceRoots, entries: [] } });
  const { onSelect } = await render();
  await act(async () => button("Projects").click());
  expect(onSelect).not.toHaveBeenCalled();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Parent folder"]')!.click());
  expect(api.post).toHaveBeenLastCalledWith("/local/sources/browse", { path: "" });
  expect(button("Use this folder").disabled).toBe(true);
});

it("browses the selected VPS and commits its current directory, while files remain unselectable", async () => {
  vi.mocked(api.post).mockResolvedValue({ data: { path: "/srv/app", entries: [{ name: "README.md", path: "/srv/app/README.md", directory: false }] } });
  const { onSelect, onOpenChange } = await render("remote", "/srv/app");
  expect(api.post).toHaveBeenCalledWith("/ssh/connections/server/browse", { path: "/srv/app" });
  expect(button("README.md").disabled).toBe(true);
  await act(async () => button("Use this folder").click());
  expect(onSelect).toHaveBeenCalledWith("/srv/app");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("does not let a delayed response from a closed picker replace a new session", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.post).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { root, onSelect, onOpenChange } = await render("remote", "/old");
  await act(async () => root.render(<FolderPickerDialog open={false} mode="remote" connectionId="server" initialPath="/old" onSelect={onSelect} onOpenChange={onOpenChange} />));
  vi.mocked(api.post).mockResolvedValue({ data: { path: "/new", entries: [] } });
  await act(async () => root.render(<FolderPickerDialog open mode="remote" connectionId="server" initialPath="/new" onSelect={onSelect} onOpenChange={onOpenChange} />));
  await act(async () => finish({ data: { path: "/old", entries: [] } }));
  expect(document.querySelector<HTMLInputElement>('[aria-label="Folder path"]')!.value).toBe("/new");
});
