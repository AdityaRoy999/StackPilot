export interface ProjectRelease {
  status?: string;
  ci_required?: boolean;
  ci_status?: string;
  runtime_snapshot?: {
    runtime_verification?: { verified?: boolean; workflow_verified?: boolean };
    routed_verification?: { verified?: boolean };
  };
}

export function projectReleaseLabel(release?: ProjectRelease, unavailable = false): { label: string; tone: "neutral" | "positive" | "negative" | "pending" } {
  if (unavailable) return { label: "Status unavailable", tone: "neutral" };
  if (!release) return { label: "Not deployed", tone: "neutral" };
  if (release.ci_required && release.ci_status !== "passed" && ["pending", "queued", "blocked"].includes(release.status || "")) return { label: "Waiting for CI", tone: "pending" };
  if (["running", "ready", "succeeded"].includes(release.status || "")) {
    const proof = release.runtime_snapshot?.runtime_verification;
    if (proof?.workflow_verified) return { label: "Workflow tested", tone: "positive" };
    if (proof?.verified || release.runtime_snapshot?.routed_verification?.verified) return { label: "Health verified", tone: "positive" };
    return { label: "Running · unverified", tone: "neutral" };
  }
  if (["failed", "failed_ci"].includes(release.status || "")) return { label: release.status === "failed_ci" ? "CI failed" : "Last deploy failed", tone: "negative" };
  const labels: Record<string, string> = { queued: "Queued", pending: "Pending", building: "Building", deploying: "Deploying", blocked: "Blocked", canceled: "Canceled", cancelled: "Canceled", retired: "Retired", stopped: "Stopped", superseded: "Superseded" };
  return { label: labels[release.status || ""] || "Not verified", tone: ["queued", "pending", "building", "deploying"].includes(release.status || "") ? "pending" : "neutral" };
}
