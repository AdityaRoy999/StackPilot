import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserPeer } from "./browser-peer";

class Peer extends EventTarget {
  static latest: Peer;
  iceGatheringState = "complete";
  connectionState = "new";
  localDescription = { sdp: "fixture-offer" };
  ontrack?: (event: { track: object }) => void;
  onconnectionstatechange?: () => void;
  close = vi.fn();
  receiver = { jitterBufferTarget: 500 };
  addTransceiver = vi.fn(() => ({ receiver: this.receiver }));
  getStats = vi.fn(async () => new Map<string, Record<string, unknown>>());
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "fixture-offer" }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  constructor() { super(); Peer.latest = this; }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("WebRTC viewer lifecycle", () => {
  function setup(acquireVideo?: () => boolean) {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", Peer);
    const stop = vi.fn();
    vi.stubGlobal("MediaStream", class { getTracks() { return [{ stop }]; } });
    let present: VideoFrameRequestCallback | null = null;
    const video = { srcObject: null, play: vi.fn(async () => {}),
      requestVideoFrameCallback: vi.fn(callback => { present = callback; return 1; }),
      cancelVideoFrameCallback: vi.fn() } as unknown as HTMLVideoElement;
    const signal = vi.fn(), painted = vi.fn(), failed = vi.fn();
    const viewer = createBrowserPeer(video, signal, painted, failed, [], acquireVideo);
    return { video, viewer, signal, painted, failed, stop, present: () => present! };
  }
  it("switches transport only after a video frame is presented", async () => {
    const qa = setup();
    await qa.viewer.offer();
    expect(qa.signal).toHaveBeenCalledWith({ type: "rtc_offer", sdp: "fixture-offer" });
    Peer.latest.ontrack?.({ track: {} });
    expect(qa.painted).not.toHaveBeenCalled();
    qa.present()(100, {} as VideoFrameCallbackMetadata);
    expect(qa.signal).toHaveBeenCalledWith({ type: "rtc_ready" });
    expect(qa.painted).toHaveBeenCalledOnce();
    qa.viewer.close();
    expect(qa.stop).toHaveBeenCalledOnce();
    expect(qa.video.srcObject).toBeNull();
    await vi.advanceTimersByTimeAsync(16000);
    expect(qa.failed).not.toHaveBeenCalled();
  });
  it("falls back after negotiation times out and closes without repeating browser input", async () => {
    const qa = setup();
    await qa.viewer.offer();
    await vi.advanceTimersByTimeAsync(15000);
    expect(qa.failed).toHaveBeenCalledOnce();
    qa.viewer.close();
    expect(Peer.latest.close).toHaveBeenCalledOnce();
    expect(qa.signal.mock.calls.every(([message]) => message.type.startsWith("rtc_"))).toBe(true);
  });
  it("cancels pending ICE gathering when the viewer closes", async () => {
    const qa = setup();
    Peer.latest.iceGatheringState = "gathering";
    const offer = qa.viewer.offer();
    await vi.advanceTimersByTimeAsync(1);
    qa.viewer.close();
    await offer;
    expect(qa.signal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("requests a low interactive buffer target and measures interval buffer delay", async () => {
    const qa = setup();
    expect(Peer.latest.receiver.jitterBufferTarget).toBe(0);
    const stat = (emitted: number, delay: number, dropped: number) => new Map([
      ["video", { id: "video", type: "inbound-rtp", kind: "video", jitterBufferEmittedCount: emitted,
        jitterBufferDelay: delay, framesDropped: dropped }],
    ]);
    Peer.latest.getStats.mockResolvedValueOnce(stat(100, 15, 3)).mockResolvedValueOnce(stat(120, 15.4, 5));
    expect(await qa.viewer.metrics()).toEqual({ jitterBufferMs: null, droppedFrames: 0 });
    expect(await qa.viewer.metrics()).toEqual({ jitterBufferMs: 20, droppedFrames: 2 });
    qa.viewer.close();
    expect(await qa.viewer.metrics()).toEqual({ jitterBufferMs: null, droppedFrames: 0 });
    expect(Peer.latest.getStats).toHaveBeenCalledTimes(2);
  });
  it("acquires exclusive video ownership and ignores callbacks after another sink takes over", () => {
    const acquire = vi.fn(() => true);
    const qa = setup(acquire);
    Peer.latest.ontrack?.({ track: {} });
    expect(acquire).toHaveBeenCalledOnce();
    const replacement = {} as MediaStream;
    qa.video.srcObject = replacement;
    qa.present()(100, {} as VideoFrameCallbackMetadata);
    expect(qa.painted).not.toHaveBeenCalled();
    expect(qa.signal).not.toHaveBeenCalled();
    qa.viewer.close();
    expect(qa.video.srcObject).toBe(replacement);
  });
  it("stops a stale incoming track when its connection no longer owns the viewer", () => {
    const qa = setup(() => false);
    const track = { stop: vi.fn() };
    Peer.latest.ontrack?.({ track });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(qa.video.srcObject).toBeNull();
    expect(qa.video.play).not.toHaveBeenCalled();
    qa.viewer.close();
  });
  it("does not set a local description after a closed peer's offer resolves", async () => {
    const qa = setup();
    let finish!: (offer: { type: string; sdp: string }) => void;
    Peer.latest.createOffer.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const offer = qa.viewer.offer();
    qa.viewer.close();
    finish({ type: "offer", sdp: "late-offer" });
    await offer;
    expect(Peer.latest.setLocalDescription).not.toHaveBeenCalled();
    expect(qa.signal).not.toHaveBeenCalled();
  });
  it("reports one failure even if the timeout follows a connection failure", async () => {
    const qa = setup();
    Peer.latest.connectionState = "failed";
    Peer.latest.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(16000);
    expect(qa.failed).toHaveBeenCalledOnce();
    qa.viewer.close();
  });
});
