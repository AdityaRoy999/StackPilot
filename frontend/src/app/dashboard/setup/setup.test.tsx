import { expect, it, vi } from "vitest";
import SetupPage from "./page";

const redirect = vi.hoisted(() => vi.fn((path: string): never => { throw new Error(`Redirect: ${path}`); }));
vi.mock("next/navigation", () => ({ redirect }));
it("keeps old setup bookmarks working by redirecting to projects", () => {
  expect(() => SetupPage()).toThrow("Redirect: /dashboard");
  expect(redirect).toHaveBeenCalledWith("/dashboard");
});
