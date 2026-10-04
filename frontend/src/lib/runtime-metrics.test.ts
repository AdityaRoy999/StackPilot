import { describe, expect, it } from "vitest";
import { chartDataRange, chartUpperBound, formatRuntimeBytes, memoryChartUnit, metricReading, sumMetricReadings } from "./runtime-metrics";

describe("runtime metrics", () => {
  it("shows a small real working set instead of rounding it to zero GB", () => {
    expect(formatRuntimeBytes(5.039 * 1024 ** 2)).toBe("5.0 MiB");
    expect(formatRuntimeBytes(8190)).toBe("8.0 KiB");
    expect(formatRuntimeBytes(2 * 1024 ** 3)).toBe("2.0 GiB");
  });
  it("keeps unavailable readings distinct from measured zero", () => {
    for (const value of [null, undefined, NaN, Infinity, -1, "5"])
      expect(metricReading(value)).toBeNull();
    expect(metricReading(0)).toBe(0);
    expect(formatRuntimeBytes(undefined)).toBe("Unavailable");
    expect(formatRuntimeBytes(0)).toBe("0 B");
    expect(sumMetricReadings(undefined, 5)).toBeNull();
    expect(sumMetricReadings(0, 5)).toBe(5);
  });
  it("uses a nonnegative readable scale for constant small memory", () => {
    expect(memoryChartUnit([5 * 1024 ** 2, null])).toEqual({ label: "MiB", divisor: 1024 ** 2 });
    expect(chartUpperBound([5, 5])).toBe(6);
    expect(chartUpperBound([0, null])).toBeGreaterThan(0);
    expect(memoryChartUnit([2 * 1024 ** 3])).toEqual({ label: "GiB", divisor: 1024 ** 3 });
  });
  it("zooms a memory trend around measured values without inventing movement", () => {
    expect(chartDataRange([8.48, 8.48, null])).toEqual({ min: 8.23, max: 8.73 });
    expect(chartDataRange([8, 9])).toEqual({ min: 7.75, max: 9.25 });
    expect(chartDataRange([])).toEqual({ min: 0, max: 1 });
  });
});
