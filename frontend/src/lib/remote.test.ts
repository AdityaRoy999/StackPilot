import { describe, expect, it } from "vitest";
import { applyRemoteEvents, emptyProgress } from "./remote";
describe("remote progress recovery", () => {
  it("does not repeat tokens or approvals when reconnect batches overlap", () => {
    const batch = [{ sequence: 1, type: "content", delta: "Hello " }, { sequence: 2, type: "permission_request", token: "one-step", arguments: { action: "submit" } }];
    const first = applyRemoteEvents(emptyProgress, batch);
    const recovered = applyRemoteEvents(first, [...batch, { sequence: 3, type: "content", delta: "world" }]);
    expect(recovered.content).toBe("Hello world"); expect(recovered.cursor).toBe(3); expect(recovered.approval?.token).toBe("one-step");
  });
  it("recovers a final response even if its content chunks were missed", () => {
    const result = applyRemoteEvents(emptyProgress, [{ sequence: 4, type: "done", content: "Verified result" }]);
    expect(result.content).toBe("Verified result");
  });
  it("sorts replayed events and preserves failures", () => {
    const result = applyRemoteEvents(emptyProgress, [{ sequence: 2, type: "content", delta: "b" }, { sequence: 1, type: "content", delta: "a" }, { sequence: 3, type: "error", error: "Interrupted" }]);
    expect(result.content).toBe("ab"); expect(result.error).toBe("Interrupted"); expect(emptyProgress.cursor).toBe(0);
  });
  it("recovers a follow-up question after reconnect without duplicating its activity", () => {
    const question = { sequence: 7, type: "agent_question", question: "Which target?", fields: [{ id: "target", label: "Target", type: "text" }] };
    const first = applyRemoteEvents(emptyProgress, [question]);
    const recovered = applyRemoteEvents(first, [question, { sequence: 8, type: "done", content: "Waiting for your target." }]);
    expect(recovered.question?.fields?.[0].id).toBe("target");
    expect(recovered.activity).toHaveLength(1);
    expect(recovered.content).toBe("Waiting for your target.");
  });

});
