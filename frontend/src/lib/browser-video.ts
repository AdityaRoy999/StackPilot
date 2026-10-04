/** A bounded H.264 decoder. Resetting drops dependencies until a fresh keyframe. */
export function annexBCodec(data: Uint8Array): string {
  for (let i = 0; i + 7 < data.length; i++) {
    if (data[i] || data[i + 1]) continue;
    const header = data[i + 2] === 1 ? i + 3 : data[i + 2] === 0 && data[i + 3] === 1 ? i + 4 : -1;
    if (header >= 0 && (data[header] & 31) === 7) {
      return "avc1." + Array.from(data.slice(header + 1, header + 4), n => n.toString(16).padStart(2, "0")).join("");
    }
  }
  return "avc1.42c029";
}

export class LiveVideoDecoder {
  get queueSize() { return this.decoder?.decodeQueueSize ?? 0; }
  private decoder: VideoDecoder | null = null;
  private needsKeyframe = true;
  private lastTimestamp = 0;
  private generation = 0;

  constructor(private output: (frame: VideoFrame) => void, private unavailable: () => void) {}

  push(data: Uint8Array<ArrayBuffer>, keyframe: boolean, timestamp: number): void {
    if (this.decoder && this.decoder.decodeQueueSize >= 6) this.needsKeyframe = true;
    if (this.needsKeyframe && !keyframe) return;
    // Let already queued frames finish. Closing immediately on overload can
    // cancel every first frame on a busy client and starve presentation forever.
    if (this.needsKeyframe && keyframe && this.decoder) this.close();
    try {
      if (!this.decoder) {
        const generation = this.generation;
        this.decoder = new VideoDecoder({
          output: frame => {
            if (generation !== this.generation) frame.close();
            else this.output(frame);
          },
          error: () => {
            if (generation !== this.generation) return;
            this.close();
            this.unavailable();
          },
        });
        this.decoder.configure({ codec: annexBCodec(data), optimizeForLatency: true });
      }
      const ts = Math.max(Math.round(timestamp), this.lastTimestamp + 1);
      this.lastTimestamp = ts;
      this.decoder.decode(new EncodedVideoChunk({ type: keyframe ? "key" : "delta", timestamp: ts, data }));
      this.needsKeyframe = false;
    } catch {
      this.close();
      this.unavailable();
    }
  }

  close(): void {
    this.generation++;
    if (this.decoder?.state !== "closed") this.decoder?.close();
    this.decoder = null;
    this.needsKeyframe = true;
    this.lastTimestamp = 0;
  }
}
