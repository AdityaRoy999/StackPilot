export interface VoiceRecording {
  dataUrl: string;
  mimeType: string;
  durationMs: number;
  size: number;
}

export const MAX_VOICE_BYTES = 8 * 1024 * 1024;
const MAX_VOICE_DURATION_MS = 2 * 60 * 1000;

/** One microphone capture, with an idempotent stop and explicit disposal. */
export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private cancelled = false;
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resolve!: (recording: VoiceRecording | null) => void;
  private reject!: (error: Error) => void;
  private result = new Promise<VoiceRecording | null>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });

  constructor(private onAutoStop?: () => void) {
    // Capture can fail or be discarded before the caller asks for its result.
    void this.result.catch(() => {});
  }

  async start(): Promise<boolean> {
    if (this.cancelled || this.stopping) return false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.cancelled || this.stopping) {
        this.release();
        this.resolve(null);
        return false;
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find(candidate => MediaRecorder.isTypeSupported(candidate));
      const recorder = mimeType ? new MediaRecorder(this.stream, { mimeType }) : new MediaRecorder(this.stream);
      this.recorder = recorder;
      const chunks: Blob[] = [];
      const startedAt = Date.now();
      let bytes = 0;
      recorder.ondataavailable = event => {
        if (!event.data.size || this.cancelled) return;
        bytes += event.data.size;
        chunks.push(event.data);
        if (bytes > MAX_VOICE_BYTES) this.autoStop();
      };
      recorder.onerror = () => {
        this.reject(new Error("Microphone recording failed. Please try again."));
        this.discard();
        this.onAutoStop?.();
      };
      recorder.onstop = () => {
        this.release();
        if (this.cancelled || !bytes) {
          this.resolve(null);
          return;
        }
        if (bytes > MAX_VOICE_BYTES) {
          this.reject(new Error("That recording exceeds 8 MB. Please record a shorter message."));
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        const durationMs = Math.min(MAX_VOICE_DURATION_MS, Math.max(0, Date.now() - startedAt));
        const reader = new FileReader();
        reader.onerror = () => this.reject(new Error("The recording could not be prepared for playback."));
        reader.onload = () => this.resolve(this.cancelled ? null : {
          dataUrl: String(reader.result), mimeType: blob.type, durationMs, size: blob.size,
        });
        reader.readAsDataURL(blob);
      };
      recorder.start(250);
      this.timer = setTimeout(() => this.autoStop(), MAX_VOICE_DURATION_MS);
      return true;
    } catch (error) {
      this.release();
      this.resolve(null);
      throw error;
    }
  }

  stop(): Promise<VoiceRecording | null> {
    if (!this.stopping) {
      this.stopping = true;
      if (this.recorder && this.recorder.state !== "inactive") {
        try { this.recorder.stop(); }
        catch {
          this.release();
          this.resolve(null);
        }
      } else if (!this.recorder) {
        // A pending permission prompt may resolve later; start() will release it.
        this.resolve(null);
      }
    }
    return this.result;
  }

  discard(): void {
    this.cancelled = true;
    void this.stop();
    this.release();
    this.resolve(null);
  }

  private autoStop(): void {
    if (this.stopping) return;
    void this.stop();
    this.onAutoStop?.();
  }

  private release(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
  }
}
