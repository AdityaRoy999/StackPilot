export function metricReading(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function formatRuntimeBytes(value: unknown): string {
  const bytes = metricReading(value);
  if (bytes === null) return "Unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = bytes === 0 ? 0 : Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  const size = bytes / 1024 ** Math.max(0, index);
  return `${size.toFixed(index <= 0 || size >= 100 ? 0 : 1)} ${units[Math.max(0, index)]}`;
}

export function sumMetricReadings(...values: unknown[]): number | null {
  const readings = values.map(metricReading);
  return readings.some((value) => value === null) ? null : readings.reduce<number>((total, value) => total + value!, 0);
}

// Keep charts legible for both a 5 MiB website and a multi-GiB application.
export function memoryChartUnit(values: Array<number | null>) {
  const largest = Math.max(0, ...values.filter((value): value is number => value !== null));
  return largest >= 1024 ** 3 ? { label: "GiB", divisor: 1024 ** 3 } : { label: "MiB", divisor: 1024 ** 2 };
}

export function chartUpperBound(values: Array<number | null>, minimum = 1): number {
  const largest = Math.max(minimum, ...values.filter((value): value is number => value !== null));
  const scale = 10 ** Math.floor(Math.log10(largest));
  return Math.ceil((largest * 1.2) / scale) * scale;
}

export function chartDataRange(values: Array<number | null>, minimumPadding = 0.25): { min: number; max: number } {
  const measured = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (measured.length === 0) return { min: 0, max: 1 };
  const lowest = Math.min(...measured);
  const highest = Math.max(...measured);
  const padding = Math.max(minimumPadding, (highest - lowest) * 0.2);
  return { min: Math.max(0, lowest - padding), max: highest + padding };
}
