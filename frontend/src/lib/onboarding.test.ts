import { expect, it } from "vitest";
import { destinationAfterLogin, onboardingDestination } from "./onboarding";

it("opens projects without the removed setup guide", async () => {
  expect(onboardingDestination()).toBe("/dashboard");
  expect(await destinationAfterLogin()).toBe("/dashboard");
});
