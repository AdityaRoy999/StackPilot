import { describe, expect, it } from "vitest";
import { defaultProjectEnvironments, inferProjectName, isGitHubRepositorySource, preferredRepositoryBranch } from "./project-setup";

describe("first project defaults", () => {
  it("does not invent a dev branch or require CI that the repository has never configured", () => {
    const environments = defaultProjectEnvironments();
    expect(environments).toHaveLength(1);
    expect(environments[0]).toMatchObject({ auto_deploy: false, require_ci: false, cleanup_previous_on_success: false });
    expect(preferredRepositoryBranch(["trunk"], environments[0].branch)).toBe("HEAD");
    expect(preferredRepositoryBranch(["trunk"], "main")).toBe("trunk");
    expect(preferredRepositoryBranch(["master"], "main")).toBe("master");
  });
  it("keeps a deliberately selected branch on refresh", () => {
    expect(preferredRepositoryBranch(["main", "release"], "release", "main")).toBe("release");
  });
  it("suggests names from repository URLs and allowed source folders", () => {
    expect(inferProjectName("https://github.com/owner/repo.git")).toBe("repo");
    expect(inferProjectName("/allowed/my-app/")).toBe("my-app");
  });
  it("rejects browser-autofilled account values in the repository field", () => {
    expect(isGitHubRepositorySource("someone@example.test")).toBe(false);
    expect(isGitHubRepositorySource("https://github.com/owner/repo")).toBe(true);
    expect(isGitHubRepositorySource("git@github.com:owner/repo.git")).toBe(true);
    expect(isGitHubRepositorySource("https://elsewhere.example/owner/repo")).toBe(false);
  });
});
