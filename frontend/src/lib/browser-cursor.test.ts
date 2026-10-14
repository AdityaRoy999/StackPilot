import { describe, expect, it } from "vitest";
import { BrowserCursorMotion } from "./browser-cursor";

describe("browser cursor continuity", () => {
  it("interpolates by elapsed time and reaches the exact endpoint", () => {
    const cursor = new BrowserCursorMotion();
    cursor.move(1000, 200, 100, 100);
    expect(cursor.position(100)).toEqual({ x: 640, y: 360 });
    const midpoint = cursor.position(150);
    expect(midpoint.x).toBeGreaterThan(820);
    expect(midpoint.y).toBeGreaterThan(280);
    expect(cursor.position(200)).toEqual({ x: 1000, y: 200 });
    expect(cursor.active(200)).toBe(false);
  });
  it("replaces an interrupted movement without replaying stale targets", () => {
    const cursor = new BrowserCursorMotion();
    cursor.move(1000, 200, 0, 100);
    const interrupted = cursor.position(50);
    cursor.move(80, 600, 50, 100);
    expect(cursor.position(50)).toEqual(interrupted);
    expect(cursor.position(150)).toEqual({ x: 80, y: 600 });
    for (let i = 0; i < 500; i++) cursor.move(i, i, 200, 48);
    expect(cursor.position(248)).toEqual({ x: 499, y: 499 });
  });
  it("snaps applied actions and reduced motion to accurate coordinates", () => {
    const cursor = new BrowserCursorMotion();
    cursor.move(80, 90, 0, 150);
    cursor.move(80, 90, 10, 0);
    expect(cursor.position(10)).toEqual({ x: 80, y: 90 });
    expect(cursor.active(10)).toBe(false);
  });
  it("bounds malformed targets and durations", () => {
    const cursor = new BrowserCursorMotion();
    cursor.move(-900, 8000, 0, 5000);
    expect(cursor.position(240)).toEqual({ x: 0, y: 720 });
    cursor.move(Number.NaN, 100, 300, 0);
    expect(cursor.position(300)).toEqual({ x: 0, y: 720 });
  });
  it("follows the dispatched path, settles its lean and ignores malformed paths", () => {
    const cursor = new BrowserCursorMotion();
    cursor.move(800, 360, 0, 180, [[640, 360], [700, 310], [760, 320], [800, 360]]);
    expect(cursor.position(60)).toEqual({ x: 700, y: 310 });
    expect(cursor.position(120)).toEqual({ x: 760, y: 320 });
    expect(cursor.tilt(90)).toBe(8);
    expect(cursor.tilt(180)).toBeCloseTo(0);
    expect(cursor.position(180)).toEqual({ x: 800, y: 360 });
    cursor.move(80, 90, 200, 100, [[NaN, 0], [80, 90]]);
    expect(Number.isFinite(cursor.position(250).x)).toBe(true);
    expect(cursor.position(300)).toEqual({ x: 80, y: 90 });
  });
});
