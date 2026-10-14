/** Screen replay is independent of the live transport and the viewer's lifetime. */
export interface RecordedFrame {
  id: number;
  blob: Blob;
  cursor: { x: number; y: number; visible: boolean; action?: string; typing?: boolean };
  ripples: Array<{ id: number; x: number; y: number; type?: string }>;
  url: string;
  pageTitle: string;
  timestamp: number;
}

export type RecordingStatus = "idle" | "recording" | "paused" | "completed" | "unverified" | "stopped";
type FrameContext = Omit<RecordedFrame, "id" | "blob" | "timestamp">;
type Capture = FrameContext & { generation: number; timestamp: number; capturedAt: number };
type SavedRecording = { sessionId: string; runId: string; status: RecordingStatus; frames: RecordedFrame[]; updatedAt: number };
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FRAMES = 1800;
const MAX_SAVED_BYTES = 64 * 1024 * 1024;
const sessions = new Map<string, BrowserRecording>();

// Blobs stay out of chat JSON/localStorage. Quota/private-mode failures preserve
// the in-memory replay and are surfaced without interrupting the agent.
async function recordingDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("stackpilot-browser-replays", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("recordings", { keyPath: "sessionId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Replay storage is blocked by another tab."));
  });
}

async function loadRecording(sessionId: string): Promise<SavedRecording | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await recordingDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("recordings").objectStore("recordings").get(sessionId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function saveRecording(value: SavedRecording): Promise<void> {
  if (typeof indexedDB === "undefined") throw new Error("Replay storage is unavailable.");
  const db = await recordingDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("recordings", "readwrite");
      const store = transaction.objectStore("recordings");
      store.put(value);
      const request = store.getAll();
      request.onsuccess = () => {
        const recordings = (request.result as SavedRecording[]).sort((a, b) => b.updatedAt - a.updatedAt);
        let bytes = 0;
        recordings.forEach((recording, index) => {
          bytes += recording.frames.reduce((sum, frame) => sum + frame.blob.size, 0);
          if (index >= 5 || bytes > MAX_SAVED_BYTES || Date.now() - recording.updatedAt > 7 * 86400000) store.delete(recording.sessionId);
        });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export class BrowserRecording {
  frames: RecordedFrame[] = [];
  status: RecordingStatus = "idle";
  runId = "";
  storageError = "";
  private listeners = new Set<() => void>();
  private generation = 0;
  private lastCapture = -Infinity;
  private intervalMs = 200;
  private bytes = 0;
  private stoppedAt = Infinity;
  private timelineStart = 0;
  private segmentStarted = 0;
  private elapsedMs = 0;
  private pending = false;
  private lastNotified = 0;
  private restored = false;
  private saveQueue = Promise.resolve();
  private surface: HTMLCanvasElement | null = null;

  constructor(readonly sessionId: string) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { this.lastNotified = Date.now(); this.listeners.forEach(listener => listener()); }
  get durationSec() { return this.frames.length ? Math.max(0, (this.frames.at(-1)!.timestamp - this.frames[0].timestamp) / 1000) : 0; }

  start(runId: string, continuation = false) {
    if (this.runId === runId && this.status === "recording") return;
    this.generation++;
    if (!continuation || !this.frames.length) {
      this.frames = [];
      this.bytes = 0;
      this.intervalMs = 200;
      this.timelineStart = Date.now();
      this.elapsedMs = 0;
    }
    this.runId = runId;
    this.status = "recording";
    this.storageError = "";
    this.lastCapture = -Infinity;
    this.stoppedAt = Infinity;
    this.segmentStarted = Date.now();
    this.notify();
  }

  finish(status: Exclude<RecordingStatus, "idle" | "recording">, runId = this.runId) {
    if (runId !== this.runId || this.status !== "recording") return;
    // Close the capture gate synchronously, before async encoding/storage. A
    // final captured frame may finish encoding; subsequent live frames cannot.
    this.stoppedAt = Date.now();
    this.elapsedMs += Math.max(0, this.stoppedAt - this.segmentStarted);
    this.status = status;
    this.surface = null;
    this.notify();
    this.persist();
  }

  private claim(context: FrameContext): Capture | null {
    const timestamp = Date.now();
    if (this.status !== "recording" || this.pending || timestamp - this.lastCapture < this.intervalMs) return null;
    this.lastCapture = timestamp;
    return { ...context, cursor: { ...context.cursor }, ripples: [...context.ripples], generation: this.generation,
      capturedAt: timestamp, timestamp: this.timelineStart + this.elapsedMs + Math.max(0, timestamp - this.segmentStarted) };
  }

  private commit(capture: Capture, blob: Blob) {
    if (capture.generation !== this.generation || capture.capturedAt > this.stoppedAt || !blob.size || blob.size > MAX_BYTES / 4) return;
    this.frames.push({ id: capture.timestamp, blob, timestamp: capture.timestamp, cursor: capture.cursor,
      ripples: capture.ripples, url: capture.url, pageTitle: capture.pageTitle });
    this.bytes += blob.size;
    // Thin older samples instead of dropping the beginning of a long test.
    // The first and latest frames are always retained; sampling slows as needed.
    while (this.frames.length > MAX_FRAMES || this.bytes > MAX_BYTES) {
      this.frames = this.frames.filter((_, index, frames) => index % 2 === 0 || index === frames.length - 1);
      this.bytes = this.frames.reduce((sum, item) => sum + item.blob.size, 0);
      this.intervalMs *= 2;
    }
    if (this.frames.length === 1 || this.status !== "recording" || Date.now() - this.lastNotified >= 1000) this.notify();
    if (this.status !== "recording") this.persist();
  }

  recordBlob(blob: Blob, context: FrameContext) {
    const capture = this.claim(context);
    if (capture) this.commit(capture, blob);
  }

  recordToolResult(result: Record<string, unknown>) {
    // A short test can end before the lazy viewer connects. Its already captured
    // tool observation supplies a replay frame without taking a post-test image.
    if (this.status !== "recording" || typeof result.frame !== "string" || result.frame.length > 8 * 1024 * 1024) return;
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(result.frame);
    if (!match) return;
    try {
      const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
      this.recordBlob(new Blob([bytes], { type: match[1] }), {
        cursor: { x: 0, y: 0, visible: false }, ripples: [],
        url: typeof result.url === "string" ? result.url : "",
        pageTitle: typeof result.title === "string" ? result.title : "",
      });
    } catch { /* A malformed observation must not fail the test. */ }
  }

  recordVisual(source: CanvasImageSource, width: number, height: number, context: FrameContext) {
    if (width <= 0 || height <= 0) return;
    const capture = this.claim(context);
    if (!capture) return;
    try {
      this.surface ??= document.createElement("canvas");
      const ratio = Math.min(1, 720 / width);
      const w = Math.round(width * ratio), h = Math.round(height * ratio);
      if (this.surface.width !== w || this.surface.height !== h) { this.surface.width = w; this.surface.height = h; }
      const ctx = this.surface.getContext("2d", { alpha: false });
      if (!ctx) return;
      ctx.drawImage(source, 0, 0, w, h);
      this.pending = true;
      this.surface.toBlob(blob => {
        this.pending = false;
        if (blob) this.commit(capture, blob);
      }, "image/jpeg", 0.65);
    } catch { this.pending = false; }
  }

  // Call only after the server has authorized this session's browser ticket.
  async restore() {
    if (this.restored) return;
    this.restored = true;
    const generation = this.generation;
    try {
      const saved = await loadRecording(this.sessionId);
      if (!saved || generation !== this.generation || this.frames.length || this.status !== "idle" || Date.now() - saved.updatedAt > 7 * 86400000) return;
      this.frames = saved.frames;
      this.bytes = this.frames.reduce((sum, frame) => sum + frame.blob.size, 0);
      this.runId = saved.runId;
      this.timelineStart = this.frames[0]?.timestamp ?? Date.now();
      this.elapsedMs = this.frames.length ? this.frames.at(-1)!.timestamp - this.timelineStart : 0;
      this.status = saved.status === "recording" ? "unverified" : saved.status;
      this.notify();
    } catch { this.storageError = "Replay is available for this tab; browser storage is unavailable."; this.notify(); }
  }

  private persist() {
    if (!this.frames.length) return;
    const generation = this.generation;
    const value: SavedRecording = { sessionId: this.sessionId, runId: this.runId, status: this.status, frames: [...this.frames], updatedAt: Date.now() };
    this.saveQueue = this.saveQueue.then(() => saveRecording(value)).catch(() => {
      if (generation === this.generation) { this.storageError = "Replay is available for this tab; browser storage is unavailable."; this.notify(); }
    });
  }
}

export function browserRecording(sessionId: string): BrowserRecording {
  let recording = sessions.get(sessionId);
  if (!recording) {
    recording = new BrowserRecording(sessionId);
    sessions.set(sessionId, recording);
    // Keep recent recordings across panel remounts without retaining unlimited RAM.
    if (sessions.size > 5) {
      for (const [key, value] of sessions) {
        if (key !== sessionId && value.status !== "recording") { sessions.delete(key); break; }
      }
    }
  }
  return recording;
}

export function recordingOutcome(status?: string, verified?: boolean, stopped?: boolean): Exclude<RecordingStatus, "idle" | "recording"> {
  if (stopped || status === "stopped") return "stopped";
  if (status === "waiting_for_permission" || status === "waiting_for_user_input") return "paused";
  if ((status === "verified" || status === "completed" || status === undefined) && verified !== false && (verified === true || status === "verified")) return "completed";
  return "unverified";
}
