export interface LivePageIdentity {
  url: string;
  title?: string;
  session_id?: string;
  stream_id?: string;
  state_seq?: number;
}

/** A frame or a delayed DOM scan must never rewind the live address bar. */
export class LivePageState {
  private stream: string | undefined;
  private sequence = -1;

  constructor(private session: string) {}

  reset() { this.stream = undefined; this.sequence = -1; }

  accept(value: unknown): LivePageIdentity | null {
    if (!value || typeof value !== "object") return null;
    const page = value as LivePageIdentity;
    if (typeof page.url !== "string" || !page.url || page.url.startsWith("chrome-error://")) return null;
    if (page.session_id && page.session_id !== this.session) return null;
    if (page.stream_id) {
      if (this.stream && page.stream_id !== this.stream) return null;
      this.stream = page.stream_id;
    }
    if (typeof page.state_seq === "number") {
      if (!Number.isSafeInteger(page.state_seq) || page.state_seq < this.sequence) return null;
      this.sequence = page.state_seq;
    } else if (this.sequence >= 0) {
      return null;
    }
    return page;
  }
}
