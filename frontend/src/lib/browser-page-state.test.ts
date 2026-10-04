import { expect, it } from "vitest";
import { LivePageState } from "./browser-page-state";

it("rejects delayed frames and DOM scans after a newer navigation", () => {
  const state = new LivePageState("agent");
  const old = { session_id: "agent", stream_id: "tab", state_seq: 1, url: "https://a.test/", title: "Old" };
  const next = { ...old, state_seq: 2, url: "https://a.test/detail", title: "" };
  expect(state.accept(old)).toEqual(old);
  expect(state.accept(next)).toEqual(next);
  expect(state.accept(old)).toBeNull();
  expect(state.accept({ url: old.url, title: old.title })).toBeNull();
  expect(state.accept({ ...next, title: "" })?.title).toBe("");
});

it("isolates page identity by session and tab incarnation", () => {
  const state = new LivePageState("agent");
  expect(state.accept({ session_id: "another", url: "https://a.test/" })).toBeNull();
  expect(state.accept({ stream_id: "old", state_seq: 10, url: "https://a.test/" })).not.toBeNull();
  expect(state.accept({ stream_id: "new", state_seq: 0, url: "https://b.test/" })).toBeNull();
  state.reset();
  expect(state.accept({ stream_id: "new", state_seq: 0, url: "https://b.test/" })).not.toBeNull();
});

it("supports unversioned legacy servers while rejecting malformed page identity", () => {
  const state = new LivePageState("agent");
  expect(state.accept({ url: "https://a.test/" })).not.toBeNull();
  for (const page of [null, {}, { url: 4 }, { url: "chrome-error://error" }, { url: "https://a.test/", state_seq: NaN }]) {
    expect(state.accept(page)).toBeNull();
  }
});
