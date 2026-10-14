import { describe, expect, it } from "vitest";
import { projectReleaseLabel } from "./project-release";

describe("release evidence labels", () => {
  it("does not turn a saved project or running process into a verified application", () => {
    expect(projectReleaseLabel().label).toBe("Not deployed");
    expect(projectReleaseLabel({ status: "running" }).label).toBe("Running · unverified");
    expect(projectReleaseLabel(undefined, true).label).toBe("Status unavailable");
  });
  it("separates health and declared workflow evidence", () => {
    expect(projectReleaseLabel({ status: "running", runtime_snapshot: { routed_verification: { verified: true } } }).label).toBe("Health verified");
    expect(projectReleaseLabel({ status: "running", runtime_snapshot: { runtime_verification: { workflow_verified: true } } }).label).toBe("Workflow tested");
  });
  it("shows CI and failed latest release without claiming a healthy earlier release was lost", () => {
    expect(projectReleaseLabel({ status: "blocked", ci_required: true, ci_status: "pending" }).label).toBe("Waiting for CI");
    expect(projectReleaseLabel({ status: "failed" }).label).toBe("Last deploy failed");
  });
});
