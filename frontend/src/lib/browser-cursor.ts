/** One interruptible cursor target; animation never queues old browser actions. */
export class BrowserCursorMotion {
  private from = { x: 640, y: 360 };
  private target = { x: 640, y: 360 };
  private started = 0;
  private duration = 0;
  private path: Array<{ x: number; y: number }> = [];

  move(x: number, y: number, now: number, duration = 140, samples?: unknown) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.from = this.position(now);
    this.target = { x: Math.max(0, Math.min(1280, x)), y: Math.max(0, Math.min(720, y)) };
    this.started = now;
    this.duration = Number.isFinite(duration) ? Math.max(0, Math.min(240, duration)) : 140;
    this.path = [];
    if (Array.isArray(samples) && samples.length >= 2 && samples.length <= 32 && samples.every(point =>
      Array.isArray(point) && point.length === 2 && point.every(value => typeof value === "number" && Number.isFinite(value)))) {
      this.path = samples.map(([px, py]) => ({ x: Math.max(0, Math.min(1280, px)), y: Math.max(0, Math.min(720, py)) }));
      // Keep continuity if an old gesture is interrupted by a new target.
      this.path[0] = this.from;
      this.path[this.path.length - 1] = this.target;
    }
  }

  position(now: number) {
    const progress = this.duration ? Math.max(0, Math.min(1, (now - this.started) / this.duration)) : 1;
    if (progress >= 1) return { ...this.target };
    if (progress <= 0) return { ...this.from };
    if (this.path.length) {
      // Smooth the driver's bounded native trajectory locally at display refresh.
      const offset = progress * (this.path.length - 1), index = Math.floor(offset), t = offset - index;
      const p0 = this.path[Math.max(0, index - 1)], p1 = this.path[index];
      const p2 = this.path[index + 1], p3 = this.path[Math.min(this.path.length - 1, index + 2)];
      const spline = (a: number, b: number, c: number, d: number) =>
        .5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
      return { x: Math.max(0, Math.min(1280, spline(p0.x, p1.x, p2.x, p3.x))),
        y: Math.max(0, Math.min(720, spline(p0.y, p1.y, p2.y, p3.y))) };
    }
    const eased = progress * progress * (3 - 2 * progress);
    const dx = this.target.x - this.from.x, dy = this.target.y - this.from.y;
    const distance = Math.hypot(dx, dy), bend = Math.min(18, distance * .04) * Math.sin(Math.PI * eased);
    return { x: Math.max(0, Math.min(1280, this.from.x + dx * eased - dy / (distance || 1) * bend)),
      y: Math.max(0, Math.min(720, this.from.y + dy * eased + dx / (distance || 1) * bend)) };
  }

  tilt(now: number) {
    const progress = this.duration ? Math.max(0, Math.min(1, (now - this.started) / this.duration)) : 1;
    return Math.sign(this.target.x - this.from.x) * 8 * Math.sin(Math.PI * progress);
  }

  active(now: number) { return now < this.started + this.duration; }
}
