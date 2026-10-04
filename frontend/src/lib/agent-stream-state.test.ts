import { describe, expect, it } from "vitest";
import { AgentTurnLifecycle, permissionMatchesCall, streamOutcome } from "./agent-stream-state";

describe("chat stream ownership", () => {
  it("rejects concurrent approval turns until the prior stream has finished", () => {
    const turns = new AgentTurnLifecycle();
    const first = turns.begin()!;
    expect(turns.begin()).toBeNull();
    turns.cancel();
    expect(first.controller.signal.aborted).toBe(true);
    expect(turns.begin()).toBeNull();
    expect(turns.finish(first)).toBe(true);
    expect(turns.begin()).not.toBeNull();
  });
  it("prevents late finalization from an old chat clearing its replacement turn", () => {
    const turns = new AgentTurnLifecycle();
    const abandoned = turns.begin()!;
    abandoned.sessionId = "old-chat";
    expect(turns.cancel(true)?.sessionId).toBe("old-chat");
    const current = turns.begin()!;
    current.sessionId = "new-chat";
    expect(turns.owns(abandoned)).toBe(false);
    expect(turns.finish(abandoned)).toBe(false);
    expect(turns.current).toBe(current);
    expect(current.controller.signal.aborted).toBe(false);
  });
});

describe("specific permission controls", () => {
  it("cannot approve a newer critical action by clicking an older tool row", () => {
    const pending = { id: "new-delete", toolName: "browser_interact", arguments: { action: "click", element_id: 9 } };
    expect(permissionMatchesCall(pending, { id: "old-submit", name: "browser_interact", arguments: { action: "click", element_id: 9 } })).toBe(false);
    expect(permissionMatchesCall(pending, { id: "new-delete", name: "browser_interact" })).toBe(true);
    expect(permissionMatchesCall(pending, { id: "new-delete", name: "terminal_run_command" })).toBe(false);
  });
  it("requires exact semantic arguments when a legacy tool row has no ID", () => {
    const pending = { id: "new", toolName: "browser_interact", arguments: { action: "type", text: "sample", element_id: 4 } };
    expect(permissionMatchesCall(pending, { name: "browser_interact", arguments: { element_id: 4, text: "sample", action: "type" } })).toBe(true);
    expect(permissionMatchesCall(pending, { name: "browser_interact", arguments: { element_id: 4, text: "different", action: "type" } })).toBe(false);
  });
});

describe("truthful stream completion", () => {
  it.each(["waiting_for_permission", "waiting_for_user_input", "unverified", "approval_stale", "blocked", "failed", "stopped"])
    ("never announces verified browser completion for %s", status => {
      expect(streamOutcome(status, true, true, true).browserCompleted).toBe(false);
    });
  it("only announces a browser completion from explicit verification evidence", () => {
    expect(streamOutcome("completed", undefined, true, true).browserCompleted).toBe(false);
    expect(streamOutcome(undefined, undefined, true, true).text).toContain("incomplete");
    expect(streamOutcome("verified", true, true, true).browserCompleted).toBe(true);
    expect(streamOutcome("verified", false, true, true).browserCompleted).toBe(false);
    expect(streamOutcome("verified", true, false, true).browserCompleted).toBe(false);
    expect(streamOutcome("waiting_for_permission", undefined, true, true).text).toContain("Waiting for your approval");
  });
});
