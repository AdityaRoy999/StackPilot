/** Client-clock measurements. A following frame is not proof of visual correctness. */
export class BrowserLatency {
  private inputs = new Map<string, { started: number; applied: boolean }>();
  private pings = new Map<string, number>();
  private samples: number[] = [];
  private gaps: number[] = [];
  private lastFrame = 0;
  rtt = 0;
  dispatch = 0;

  input(id: string, now = performance.now()) {
    if (this.inputs.size >= 16) this.inputs.delete(this.inputs.keys().next().value!);
    this.inputs.set(id, { started: now, applied: false });
  }
  applied(id: string, dispatch: number) {
    const input = this.inputs.get(id);
    if (input) { input.applied = true; this.dispatch = Math.max(0, dispatch); }
  }
  ping(id: string, now = performance.now()) {
    if (this.pings.size >= 8) this.pings.delete(this.pings.keys().next().value!);
    this.pings.set(id, now);
  }
  pong(id: string, now = performance.now()) {
    const started = this.pings.get(id);
    if (started !== undefined) { this.rtt = Math.max(0, now - started); this.pings.delete(id); }
  }
  presented(now = performance.now()) {
    if (this.lastFrame && now - this.lastFrame >= 2000) this.gaps = [];
    if (this.lastFrame && now - this.lastFrame < 2000) {
      this.gaps.push(now - this.lastFrame);
      if (this.gaps.length > 120) this.gaps.shift();
    }
    this.lastFrame = now;
    for (const [id, input] of this.inputs) {
      if (now - input.started > 10000) this.inputs.delete(id);
      else if (input.applied) {
        this.samples.push(now - input.started);
        if (this.samples.length > 60) this.samples.shift();
        this.inputs.delete(id);
      }
    }
  }
  snapshot(now = performance.now()) {
    const percentile = (values: number[], fraction: number) => values.length ?
      Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]) : 0;
    const recent = now - this.lastFrame >= 2000 ? [] : this.gaps.slice(-60);
    const interval = percentile(recent, .50);
    const gap = percentile(recent, .90);
    return { rtt: Math.round(this.rtt), inputP95: percentile(this.samples, .95),
      gapP90: gap, intervalMs: interval, jitterP90: Math.max(0, gap - interval),
      samples: this.samples.length, dispatch: this.dispatch };
  }
}
