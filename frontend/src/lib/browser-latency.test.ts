import { describe, expect, it } from "vitest";
import { BrowserLatency } from "./browser-latency";

describe("browser interaction timing", () => {
  it("waits for acknowledgment and a following presentation", () => {
    const latency = new BrowserLatency();
    latency.input("click", 100);
    latency.presented(120);
    expect(latency.snapshot().samples).toBe(0);
    latency.applied("click", 8);
    latency.presented(160);
    expect(latency.snapshot()).toMatchObject({ samples: 1, inputP95: 60, dispatch: 8 });
    latency.presented(180);
    expect(latency.snapshot().samples).toBe(1);
  });
  it("ignores unsolicited acknowledgments and expires stale inputs", () => {
    const latency = new BrowserLatency();
    latency.applied("unknown", 10);
    latency.input("stale", 1);
    latency.applied("stale", 4);
    latency.presented(11000);
    expect(latency.snapshot().samples).toBe(0);
  });
  it("measures RTT on one clock and computes presentation gaps", () => {
    const latency = new BrowserLatency();
    latency.ping("probe", 100);
    latency.pong("probe", 130);
    latency.presented(100);
    latency.presented(133);
    latency.presented(166);
    expect(latency.snapshot(166)).toMatchObject({ rtt: 30, gapP90: 33 });
  });
  it("does not classify a steady lower source cadence as client congestion", () => {
    const latency = new BrowserLatency();
    for (let i = 1; i <= 20; i++) latency.presented(i * 125);
    expect(latency.snapshot(2500)).toMatchObject({ intervalMs: 125, gapP90: 125, jitterP90: 0 });
  });
  it("reports variable excess gaps and forgets pauses on static pages", () => {
    const latency = new BrowserLatency();
    for (const timestamp of [100, 133, 166, 199, 399, 432, 632]) latency.presented(timestamp);
    expect(latency.snapshot(632)).toMatchObject({ intervalMs: 33, gapP90: 200, jitterP90: 167 });
    expect(latency.snapshot(3000)).toMatchObject({ intervalMs: 0, gapP90: 0, jitterP90: 0 });
    latency.presented(3100);
    latency.presented(3133);
    expect(latency.snapshot(3133)).toMatchObject({ intervalMs: 33, gapP90: 33, jitterP90: 0 });
  });
});
