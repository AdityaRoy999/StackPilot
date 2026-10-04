/** One interruptible cursor target; animation never queues old browser actions. */
export class BrowserCursorMotion {
  private from = { x: 640, y: 360 };
  private target = { x: 640, y: 360 };
  private started = 0;
  private duration = 0;

  move(x: number, y: number, now: number, duration = 48) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.from = this.position(now);
    this.target = { x: Math.max(0, Math.min(1280, x)), y: Math.max(0, Math.min(720, y)) };
    this.started = now;
    this.duration = Number.isFinite(duration) ? Math.max(0, Math.min(160, duration)) : 48;
  }

  position(now: number) {
    const progress = this.duration ? Math.max(0, Math.min(1, (now - this.started) / this.duration)) : 1;
    const eased = progress * (2 - progress);
    return { x: this.from.x + (this.target.x - this.from.x) * eased,
      y: this.from.y + (this.target.y - this.from.y) * eased };
  }

  active(now: number) { return now < this.started + this.duration; }
}
