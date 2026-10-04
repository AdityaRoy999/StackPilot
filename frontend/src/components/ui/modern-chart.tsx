"use client";

import { useEffect, useRef } from "react";
import type { EChartsOption } from "echarts";

/** Loads the chart renderer only for pages that actually show charts. */
export function ModernChart({ option, className = "h-full w-full" }: { option: EChartsOption; className?: string }) {
  const elementRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<import("echarts/core").ECharts | null>(null);
  const optionRef = useRef(option);

  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    import("./chart-engine").then(({ createChart }) => {
      if (cancelled || !elementRef.current) return;
      const chart = createChart(elementRef.current);
      chartRef.current = chart;
      chart.setOption(optionRef.current);
      observer = new ResizeObserver(() => {
        if (!chart.isDisposed()) chart.resize();
      });
      observer.observe(elementRef.current);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    optionRef.current = option;
    if (chartRef.current && !chartRef.current.isDisposed()) {
      chartRef.current.setOption(option, { notMerge: true });
    }
  }, [option]);

  return <div ref={elementRef} className={className} role="img" aria-label="Interactive data chart" />;
}
