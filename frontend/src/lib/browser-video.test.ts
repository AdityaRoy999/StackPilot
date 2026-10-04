import { afterEach, describe, expect, it, vi } from "vitest";
import { annexBCodec, LiveVideoDecoder } from "./browser-video";

class Decoder {
  static instances: Decoder[] = [];
  decodeQueueSize = 0;
  state = "configured";
  chunks: unknown[] = [];
  config: unknown;
  constructor(public callbacks: { output: (frame: VideoFrame) => void; error: () => void }) {
    Decoder.instances.push(this);
  }
  configure(config: unknown) { this.config = config; }
  decode(chunk: unknown) { this.chunks.push(chunk); this.decodeQueueSize++; }
  close() { this.state = "closed"; }
}
const key = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x29, 0, 0, 0, 1, 0x65]);

function fixture() {
  Decoder.instances = [];
  vi.stubGlobal("VideoDecoder", Decoder);
  vi.stubGlobal("EncodedVideoChunk", class { constructor(public init: unknown) {} });
  const output = vi.fn(), unavailable = vi.fn();
  return { stream: new LiveVideoDecoder(output, unavailable), output, unavailable };
}
afterEach(() => vi.unstubAllGlobals());

describe("live video dependencies and backpressure", () => {
  it("reads the codec from actual SPS for different encoder profiles", () => {
    expect(annexBCodec(key)).toBe("avc1.42c029");
    expect(annexBCodec(new Uint8Array([0, 0, 1, 0x67, 0x64, 0, 0x28, 0]))).toBe("avc1.640028");
  });
  it("does not decode deltas until the first keyframe", () => {
    const { stream } = fixture();
    stream.push(key, false, 1);
    expect(Decoder.instances).toHaveLength(0);
    stream.push(key, true, 2);
    expect(Decoder.instances[0].chunks).toHaveLength(1);
  });
  it("drops an overloaded GOP, then resumes at a fresh keyframe", () => {
    const { stream } = fixture();
    stream.push(key, true, 1);
    for (let i = 2; i < 30; i++) stream.push(key, false, i);
    expect(Decoder.instances).toHaveLength(1);
    expect(Decoder.instances[0].chunks).toHaveLength(6);
    expect(Decoder.instances[0].state).toBe("configured");
    stream.push(key, true, 30);
    expect(Decoder.instances[0].state).toBe("closed");
    expect(Decoder.instances).toHaveLength(2);
    expect(Decoder.instances[1].chunks).toHaveLength(1);
  });
  it("closes late frames and ignores errors from an obsolete decoder", () => {
    const { stream, output, unavailable } = fixture();
    stream.push(key, true, 1);
    const old = Decoder.instances[0];
    stream.close();
    stream.push(key, true, 2);
    const frame = { close: vi.fn() };
    old.callbacks.output(frame as unknown as VideoFrame);
    old.callbacks.error();
    expect(frame.close).toHaveBeenCalledOnce();
    expect(output).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
    expect(Decoder.instances[1].state).toBe("configured");
  });
  it("requests an image fallback when the active decoder fails", () => {
    const { stream, unavailable } = fixture();
    stream.push(key, true, 1);
    Decoder.instances[0].callbacks.error();
    expect(unavailable).toHaveBeenCalledOnce();
    expect(Decoder.instances[0].state).toBe("closed");
  });
});
