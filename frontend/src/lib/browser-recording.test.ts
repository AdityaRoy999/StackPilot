import { afterEach, expect, it, vi } from "vitest";
import { BrowserRecording, browserRecording, recordingOutcome } from "./browser-recording";

const context = { cursor: { x: 10, y: 20, visible: true, action: "click" }, ripples: [], url: "https://fixture.invalid", pageTitle: "Fixture" };
const image = new Blob(["jpeg"], { type: "image/jpeg" });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("records only during a test and freezes its timeline at completion while live frames continue", () => {
  vi.useFakeTimers();
  const recording = new BrowserRecording("complete");
  recording.recordBlob(image, context);
  expect(recording.frames).toHaveLength(0);
  recording.start("test");
  recording.recordBlob(image, context);
  vi.advanceTimersByTime(200);
  recording.recordBlob(image, context);
  recording.finish("completed");
  const duration = recording.durationSec;
  vi.advanceTimersByTime(5000);
  recording.recordBlob(image, context);
  expect(recording.frames).toHaveLength(2);
  expect(recording.durationSec).toBe(duration);
});

it.each(["stopped", "unverified", "paused"] as const)("stops accepting frames for %s and retains the replay", status => {
  vi.useFakeTimers();
  const recording = new BrowserRecording(status);
  recording.start("test"); recording.recordBlob(image, context);
  recording.finish(status);
  vi.advanceTimersByTime(300); recording.recordBlob(image, context);
  expect(recording.frames).toHaveLength(1);
  expect(recording.status).toBe(status);
  recording.finish("completed");
  expect(recording.status).toBe(status);
});

it("makes a short test replayable from its tool screenshot before the viewer connects", () => {
  const recording = new BrowserRecording("short-test");
  recording.start("test");
  recording.recordToolResult({ frame: "data:image/jpeg;base64,eA==", url: context.url, title: context.pageTitle });
  recording.finish("completed");
  expect(recording.frames).toHaveLength(1);
  expect(recording.frames[0].url).toBe(context.url);
  recording.recordToolResult({ frame: "data:image/jpeg;base64,eA==" });
  expect(recording.frames).toHaveLength(1);
});

it("keeps a paused continuation together and prevents a previous turn from stopping a newer test", () => {
  vi.useFakeTimers();
  const recording = new BrowserRecording("continuation");
  recording.start("first"); recording.recordBlob(image, context); recording.finish("paused");
  recording.start("second", true); recording.recordBlob(image, context);
  recording.finish("stopped", "first");
  expect(recording.status).toBe("recording");
  expect(recording.frames).toHaveLength(2);
  recording.finish("completed", "second");
  recording.start("third");
  expect(recording.frames).toHaveLength(0);
});

it("removes permission waiting time from the resumed replay timeline", () => {
  vi.useFakeTimers();
  const recording = new BrowserRecording("paused-time");
  recording.start("first"); recording.recordBlob(image, context);
  vi.advanceTimersByTime(400); recording.recordBlob(image, context); recording.finish("paused");
  vi.advanceTimersByTime(120000);
  recording.start("resume", true);
  vi.advanceTimersByTime(200); recording.recordBlob(image, context);
  expect(recording.durationSec).toBe(0.6);
});

it("encodes at most one small visual sample at a time and includes the final in-flight frame", () => {
  vi.useFakeTimers();
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  const callbacks: BlobCallback[] = [];
  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback) { callbacks.push(callback); });
  const recording = new BrowserRecording("visual");
  recording.start("rtc-test");
  const source = document.createElement("video");
  recording.recordVisual(source, 1280, 720, context);
  expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 720, 405);
  vi.advanceTimersByTime(1000);
  recording.recordVisual(source, 1280, 720, context);
  expect(encode).toHaveBeenCalledOnce();
  recording.finish("completed");
  callbacks[0](image);
  expect(recording.frames).toHaveLength(1);
  recording.recordVisual(source, 1280, 720, context);
  expect(encode).toHaveBeenCalledOnce();
});

it("discards an older test's pending encoded frame when a fresh test begins", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  let callback!: BlobCallback;
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(cb => { callback = cb; });
  const recording = new BrowserRecording("superseded");
  recording.start("old"); recording.recordVisual(document.createElement("canvas"), 1280, 720, context);
  recording.start("new"); callback(image);
  expect(recording.frames).toHaveLength(0);
});

it("bounds long-test memory while retaining its beginning and latest sampled frame", () => {
  vi.useFakeTimers();
  const recording = new BrowserRecording("bounded");
  recording.start("long");
  for (let index = 0; index < 2000; index++) {
    vi.advanceTimersByTime(200); recording.recordBlob(image, context);
  }
  expect(recording.frames.length).toBeLessThanOrEqual(1800);
  expect(recording.durationSec).toBeGreaterThan(390);
});

it("preserves a session replay when its panel remounts without leaking frames to a different chat", () => {
  const recording = browserRecording("remount-fixture");
  recording.start("test"); recording.recordBlob(image, context); recording.finish("completed");
  expect(browserRecording("remount-fixture").frames).toHaveLength(1);
  expect(browserRecording("other-chat").frames).toHaveLength(0);
});

it.each([
  ["verified", true, false, "completed"], ["completed", undefined, false, "unverified"],
  ["unverified", true, false, "unverified"], ["waiting_for_permission", false, false, "paused"],
  ["waiting_for_user_input", false, false, "paused"], ["verified", true, true, "stopped"],
  ["failed", true, false, "unverified"], ["error", undefined, false, "unverified"],
] as const)("maps %s to a truthful recording outcome", (status, verified, stopped, outcome) => {
  expect(recordingOutcome(status, verified, stopped)).toBe(outcome);
});
