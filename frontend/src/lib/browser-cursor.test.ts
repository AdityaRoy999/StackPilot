import { describe, expect, it } from "vitest";
import { BrowserCursorMotion } from "./browser-cursor";

describe("browser cursor continuity", () => {
  it("interpolates by elapsed time and reaches the exact endpoint", () => {
    const cursor = new BrowserCursorMotion();
    cursor.move(1000, 200, 100, 100);
    expect(cursor.position(100)).toEqual({ x: 640, y: 360 });
    expect(cursor.position(150)).toEqual({ x: 910, y: 240 });
    expect(cursor.position(200)).toEqual({ x: 1000, y: 200 });
    expect(cursor.active(200)).toBe(false);
  });
  it("replaces an interrupted movement without replaying stale targets", () => {
    const cursor = new BrowserCursorMotion();
    cursor.move(1000, 200, 0, 100);
    cursor.move(80, 600, 50, 100);
    expect(cursor.position(50)).toEqual({ x: 910, y: 240 });
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
    expect(cursor.position(160)).toEqual({ x: 0, y: 720 });
    cursor.move(Number.NaN, 100, 200, 0);
    expect(cursor.position(200)).toEqual({ x: 0, y: 720 });
  });
});
