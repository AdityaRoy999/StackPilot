/** A readable preview for structured arguments; never coerce objects to strings. */
export function toolArgumentSummary(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, 80);
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (typeof value === "object") return Object.keys(value).slice(0, 3).join(" · ");
  return String(value);
}

export function browserBatchSummary(actions: unknown): string {
  if (!Array.isArray(actions)) return "Browser actions";
  const names = [...new Set(actions.map(action => String(action?.action || action?.type || "action").replaceAll("_", " ")))];
  return `${actions.length} ${actions.length === 1 ? "action" : "actions"}${names.length ? ` · ${names.slice(0, 3).join(" · ")}` : ""}`;
}

/** Keep image payloads and page dumps out of the text trace. Frames have their own viewer. */
export function browserResultSummary(result: Record<string, unknown>): string {
  const summary: Record<string, unknown> = {};
  for (const key of ["status", "title", "url", "error", "reason", "executed_count", "attempts"]) {
    if (["string", "number", "boolean"].includes(typeof result[key])) summary[key] = result[key];
  }
  if (result.verification && typeof result.verification === "object") {
    const verification = result.verification as Record<string, unknown>;
    summary.verification = verification.description;
  }
  if (Array.isArray(result.assertions)) summary.checks = result.assertions.map(check => ({
    status: check.status, reason: check.reason, expectation: check.expectation,
  }));
  return JSON.stringify(summary, null, 2);
}
