import { expect, it, vi } from "vitest";
import api from "@/lib/api";
import { destinationAfterLogin, onboardingDestination } from "./onboarding";

vi.mock("@/lib/api", () => ({ default: { get: vi.fn() } }));
it("opens the guide until completion is explicitly saved", () => {
  expect(onboardingDestination()).toBe("/dashboard/setup");
  expect(onboardingDestination({ preferences: { setup_completed: "true" } })).toBe("/dashboard/setup");
  expect(onboardingDestination({ preferences: { setup_completed: true } })).toBe("/dashboard");
});
it("checks the authenticated user's preferences after login", async () => {
  vi.mocked(api.get).mockResolvedValueOnce({ data: { user: { preferences: { preferences: { setup_completed: true } } } } });
  expect(await destinationAfterLogin()).toBe("/dashboard");
  vi.mocked(api.get).mockResolvedValueOnce({ data: { user: {} } });
  expect(await destinationAfterLogin()).toBe("/dashboard/setup");
});
it("allows login to complete when preferences cannot be loaded", async () => {
  vi.mocked(api.get).mockRejectedValueOnce(new Error("fixture outage"));
  expect(await destinationAfterLogin()).toBe("/dashboard");
});
