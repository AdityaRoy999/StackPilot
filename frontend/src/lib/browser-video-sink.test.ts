import { afterEach, expect, it, vi } from "vitest";
import { createNativeVideoSink } from "./browser-video-sink";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  let finish: () => void = () => {};
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const writer = { write: vi.fn(() => blocked), abort: vi.fn(async () => {}) };
  const stop = vi.fn();
  vi.stubGlobal("MediaStreamTrackGenerator", class {
    stop = stop;
    writable = { getWriter: () => writer };
  });
  vi.stubGlobal("MediaStream", class { constructor(public tracks: unknown[]) {} });
  const callbacks: VideoFrameRequestCallback[] = [];
  const video = {
    srcObject: null,
    requestVideoFrameCallback: vi.fn((fn: VideoFrameRequestCallback) => { callbacks.push(fn); return callbacks.length; }),
    cancelVideoFrameCallback: vi.fn(), play: vi.fn(async () => {}),
  };
  const presented = vi.fn(), failed = vi.fn();
  const sink = createNativeVideoSink(video as unknown as HTMLVideoElement, presented, failed)!;
  return { sink, writer, stop, video, callbacks, presented, failed, finish };
}

it("keeps one write and one newest pending frame on a blocked compositor", async () => {
  const { sink, writer, finish } = fixture();
  const frames = Array.from({ length: 30 }, () => ({ close: vi.fn() }));
  for (const frame of frames) sink.push(frame as unknown as VideoFrame);
  expect(writer.write).toHaveBeenCalledOnce();
  expect(frames.slice(1, -1).every(frame => frame.close.mock.calls.length === 1)).toBe(true);
  sink.close();
  expect(frames.at(-1)!.close).toHaveBeenCalledOnce();
  finish();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(frames[0].close).toHaveBeenCalledOnce();
  expect(writer.write).toHaveBeenCalledOnce();
});

it("counts compositor presentations rather than received packets", () => {
  const { callbacks, presented, sink, stop, video } = fixture();
  callbacks[0](1, { presentedFrames: 3 } as VideoFrameCallbackMetadata);
  callbacks[1](2, { presentedFrames: 5 } as VideoFrameCallbackMetadata);
  expect(presented.mock.calls).toEqual([[1], [1]]);
  sink.close();
  expect(stop).toHaveBeenCalledOnce();
  expect(video.srcObject).toBeNull();
  callbacks[2](3, { presentedFrames: 8 } as VideoFrameCallbackMetadata);
  expect(presented).toHaveBeenCalledTimes(2);
});

it("uses the canvas path when native video generation is unavailable", () => {
  vi.stubGlobal("MediaStreamTrackGenerator", undefined);
  vi.stubGlobal("VideoTrackGenerator", undefined);
  expect(createNativeVideoSink({} as HTMLVideoElement, vi.fn(), vi.fn())).toBeNull();
});

it("releases the native writer when RTC replaces its video track without reporting a decoder failure", () => {
  const { callbacks, presented, sink, stop, video, writer, failed } = fixture();
  const replacement = {} as MediaStream;
  (video as unknown as HTMLVideoElement).srcObject = replacement;
  callbacks[0](1, {} as VideoFrameCallbackMetadata);
  expect(stop).toHaveBeenCalledOnce();
  expect(writer.abort).toHaveBeenCalledOnce();
  expect(presented).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  expect(video.srcObject).toBe(replacement);
  const lateFrame = { close: vi.fn() };
  sink.push(lateFrame as unknown as VideoFrame);
  expect(lateFrame.close).toHaveBeenCalledOnce();
  expect(writer.write).not.toHaveBeenCalled();
});
