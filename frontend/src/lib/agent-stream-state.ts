export interface ActiveAgentTurn { controller: AbortController; sessionId: string }

/** A stale stream may finish, but may never alter a newer chat/turn. */
export class AgentTurnLifecycle {
  current: ActiveAgentTurn | null = null;
  begin(): ActiveAgentTurn | null {
    if (this.current) return null;
    return this.current = { controller: new AbortController(), sessionId: "" };
  }
  owns(turn: ActiveAgentTurn) { return this.current === turn; }
  cancel(discard = false) {
    const turn = this.current;
    turn?.controller.abort();
    if (discard) this.current = null;
    return turn;
  }
  finish(turn: ActiveAgentTurn) {
    if (!this.owns(turn)) return false;
    this.current = null;
    return true;
  }
}

type ProposedCall = { id?: string; name: string; arguments?: Record<string, unknown> };
type PendingPermission = { id: string; toolName?: string; arguments?: Record<string, unknown> };

export function permissionMatchesCall(permission: PendingPermission, call: ProposedCall) {
  if (call.id) return permission.id === call.id && permission.toolName === call.name;
  if (!permission.toolName || !permission.arguments || permission.toolName !== call.name) return false;
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
    return JSON.stringify(value) ?? "undefined";
  };
  return canonical(permission.arguments) === canonical(call.arguments || {});
}

export function streamOutcome(status: string | undefined, verified: boolean | undefined,
                              browserUsed: boolean, hasTools: boolean) {
  if (status === "waiting_for_permission") return { text: "Waiting for your approval of the specific step above.", browserCompleted: false };
  if (status === "waiting_for_user_input") return { text: "Waiting for your input before continuing.", browserCompleted: false };
  if (["blocked", "approval_stale", "unverified", "failed", "error", "stopped", "canceled"].includes(status || ""))
    return { text: status === "approval_stale" ? "That approval is no longer valid. Request a fresh review of the current page."
      : "The task did not finish with verified results. See the details above.", browserCompleted: false };
  const browserCompleted = browserUsed && verified !== false && (verified === true || status === "verified");
  return { text: browserUsed ? browserCompleted ? "Website testing finished with verified results."
    : "Browser actions were performed; end-to-end verification remains incomplete."
    : hasTools ? "Workspace actions finished. See the tool results above." : "_The model returned nothing._", browserCompleted };
}
