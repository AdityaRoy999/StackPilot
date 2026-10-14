import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_VOICE_BYTES, VoiceRecorder } from "./voice-recorder";

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  static latest: FakeMediaRecorder;
  state = "inactive";
  mimeType: string;
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  stopCalls = 0;
  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || "audio/webm";
    FakeMediaRecorder.latest = this;
  }
  start() { this.state = "recording"; }
  chunk(bytes = 5) { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) }); }
  stop() {
    this.stopCalls++;
    this.state = "inactive";
    queueMicrotask(() => this.onstop?.());
  }
}

const trackStop = vi.fn();
const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
beforeEach(() => {
  trackStop.mockClear();
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("finalizes one playable recording and shares it across concurrent stop requests", async () => {
  const capture = new VoiceRecorder();
  expect(await capture.start()).toBe(true);
  FakeMediaRecorder.latest.chunk();
  const first = capture.stop();
  expect(capture.stop()).toBe(first);
  const recording = await first;
  expect(recording?.dataUrl).toMatch(/^data:audio\/webm;codecs=opus;base64,/);
  expect(recording?.size).toBe(5);
  expect(FakeMediaRecorder.latest.stopCalls).toBe(1);
  expect(trackStop).toHaveBeenCalledOnce();
});

it("releases a microphone permission response that arrives after cancellation", async () => {
  let release!: (stream: MediaStream) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(new Promise(resolve => { release = resolve; }));
  const capture = new VoiceRecorder();
  const starting = capture.start();
  expect(await capture.stop()).toBeNull();
  release(stream);
  expect(await starting).toBe(false);
  expect(trackStop).toHaveBeenCalledOnce();
});

it("discarding a chat never returns its recording to another chat", async () => {
  const capture = new VoiceRecorder();
  await capture.start();
  FakeMediaRecorder.latest.chunk();
  const pending = capture.stop();
  capture.discard();
  expect(await pending).toBeNull();
  expect(trackStop).toHaveBeenCalledOnce();
});

it("automatically stops at two minutes and releases the microphone", async () => {
  vi.useFakeTimers();
  const autoStop = vi.fn();
  const capture = new VoiceRecorder(autoStop);
  await capture.start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(autoStop).toHaveBeenCalledOnce();
  expect(await capture.stop()).toBeNull();
  expect(trackStop).toHaveBeenCalledOnce();
});

it("rejects an oversized capture and releases the microphone", async () => {
  const capture = new VoiceRecorder();
  await capture.start();
  FakeMediaRecorder.latest.chunk(MAX_VOICE_BYTES + 1);
  await expect(capture.stop()).rejects.toThrow("exceeds 8 MB");
  expect(trackStop).toHaveBeenCalledOnce();
});

it("surfaces recorder errors and releases the microphone", async () => {
  const autoStop = vi.fn();
  const capture = new VoiceRecorder(autoStop);
  await capture.start();
  FakeMediaRecorder.latest.onerror?.();
  await expect(capture.stop()).rejects.toThrow("recording failed");
  expect(trackStop).toHaveBeenCalledOnce();
  expect(autoStop).toHaveBeenCalledOnce();
});
