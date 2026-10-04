"use client";

import { useSyncExternalStore } from "react";

/**
 * Theme resolution for the two places CSS cannot reach on its own: the 2D
 * canvas, which cannot inherit custom properties at all, and Recharts, which
 * takes colours as JS strings.
 *
 * The obvious shortcut — `document.documentElement.classList.contains("dark")`
 * and two hardcoded palettes — only works while light/dark are the only two
 * looks. With eight themes it is wrong six times out of eight: Dracula and
 * Catppuccin both register as "dark" and get the generic near-black canvas
 * behind their own palette.
 *
 * Reading the real variables costs one probe per colour and is correct for
 * every theme, including ones added later.
 */

/** Colours the canvas chrome needs. Resource-kind colours are deliberately not
 *  here: those encode meaning (running vs failed) and stay constant so the
 *  legend means the same thing in every theme. */
export interface CanvasTheme {
  background: string;
  grid: string;
  title: string;
  subtitle: string;
  pill: string;
  pillText: string;
  selection: string;
}

/** Used on the server, and if a variable resolves to nothing. */
const FALLBACK: CanvasTheme = {
  background: "#fafafa",
  grid: "rgba(15,23,42,0.06)",
  title: "#0f172a",
  subtitle: "rgba(51,65,85,0.72)",
  pill: "rgba(255,255,255,0.85)",
  pillText: "rgba(51,65,85,0.9)",
  selection: "#ffffff",
};

/**
 * Normalises any CSS colour the browser understands — including `oklch()`,
 * which these themes use — into `#rrggbb`.
 *
 * Assigning an unparseable value to `fillStyle` is a no-op, so the previous
 * value survives. Seeding with the fallback first turns that into the
 * behaviour we want: an unresolvable variable yields the fallback rather than
 * whatever colour happened to be set last.
 */
export function normalizeColor(
  ctx: Pick<CanvasRenderingContext2D, "fillStyle">,
  value: string,
  fallback: string
): string {
  const trimmed = value.trim();
  ctx.fillStyle = fallback;
  if (trimmed) {
    ctx.fillStyle = trimmed;
  }
  return typeof ctx.fillStyle === "string" ? ctx.fillStyle : fallback;
}

/** `#rrggbb` -> `rgba(r, g, b, alpha)`. Non-hex input is returned unchanged so
 *  a fallback that is already `rgba(...)` still works. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return color;
  const value = parseInt(hex[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

/**
 * Resolves the active theme's canvas chrome. Needs a 2D context only as a
 * colour parser; nothing is drawn.
 */
export function readCanvasTheme(ctx: Pick<CanvasRenderingContext2D, "fillStyle">): CanvasTheme {
  const background = normalizeColor(ctx, cssVar("--background"), FALLBACK.background);
  const foreground = normalizeColor(ctx, cssVar("--foreground"), FALLBACK.title);
  const muted = normalizeColor(ctx, cssVar("--muted-foreground"), "#334155");
  const card = normalizeColor(ctx, cssVar("--card"), "#ffffff");
  const border = normalizeColor(ctx, cssVar("--border"), "#0f172a");
  const ring = normalizeColor(ctx, cssVar("--ring"), FALLBACK.selection);

  return {
    background,
    // The border token is already subtle; the extra alpha keeps the grid from
    // competing with the nodes drawn on top of it.
    grid: withAlpha(border, 0.5),
    title: foreground,
    subtitle: withAlpha(muted, 0.85),
    pill: withAlpha(card, 0.82),
    pillText: withAlpha(muted, 0.95),
    selection: ring,
  };
}

// ─── change notification ────────────────────────────────────────
// Both the colour mode (`class="dark"`) and the theme (`data-ui-theme`) live
// as attributes on <html>, so one observer covers every way the palette can
// change — the Settings picker, the pre-paint init script, and another tab
// syncing through localStorage.

let version = 0;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(() => {
      version += 1;
      chartCache = null;
      listeners.forEach((notify) => notify());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-ui-theme"],
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

const getSnapshot = () => version;
// The server renders with the default theme and no observer; returning a
// constant is what keeps hydration from mismatching.
const getServerSnapshot = () => 0;

/**
 * Returns a number that changes whenever the active theme does. Include it in
 * the dependency list of a canvas draw callback so the canvas repaints on a
 * theme switch — nothing else would trigger it, since no React state changed.
 */
export function useCanvasThemeVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ─── chart chrome ───────────────────────────────────────────────
// Recharts receives colours as plain strings, so axes, gridlines and tooltips
// were pinned to a zinc palette that was wrong in light mode and wrong again
// in six of the eight themes. Series colours stay fixed: they are a legend.

export interface ChartTheme {
  axis: string;
  /** The axis rule itself, which reads heavier than the tick labels. */
  axisLine: string;
  grid: string;
  cursor: string;
  tooltipBackground: string;
  tooltipBorder: string;
  tooltipText: string;
  /** For a series that is chrome rather than a category — the "current value"
   *  line, which was white-on-dark and invisible on a light theme. */
  foreground: string;
}

const CHART_FALLBACK: ChartTheme = {
  axis: "#a1a1aa",
  axisLine: "#71717a",
  grid: "#27272a",
  cursor: "#27272a",
  tooltipBackground: "#18181b",
  tooltipBorder: "#3f3f46",
  tooltipText: "#fafafa",
  foreground: "#f4f4f5",
};

/** ECharts parses colors before its SVG renderer sees them, so resolve theme
 *  tokens to standard CSS colors first. */
function readChartTheme(): ChartTheme {
  const styles = getComputedStyle(document.documentElement);
  const context = document.createElement("canvas").getContext("2d");
  const token = (name: string, fallback: string) => {
    const value = styles.getPropertyValue(name).trim();
    return context ? normalizeColor(context, value, fallback) : value || fallback;
  };
  return {
    axis: token("--muted-foreground", CHART_FALLBACK.axis),
    axisLine: token("--border", CHART_FALLBACK.axisLine),
    grid: token("--border", CHART_FALLBACK.grid),
    foreground: token("--foreground", CHART_FALLBACK.foreground),
    cursor: token("--muted", CHART_FALLBACK.cursor),
    tooltipBackground: token("--popover", CHART_FALLBACK.tooltipBackground),
    tooltipBorder: token("--border", CHART_FALLBACK.tooltipBorder),
    tooltipText: token("--popover-foreground", CHART_FALLBACK.tooltipText),
  };
}

// useSyncExternalStore requires a referentially stable snapshot, so the
// resolved object is cached and only rebuilt when the observer fires.
let chartCache: ChartTheme | null = null;

function getChartSnapshot(): ChartTheme {
  if (chartCache === null) chartCache = readChartTheme();
  return chartCache;
}

const getChartServerSnapshot = () => CHART_FALLBACK;

/** Chart chrome for the active theme. Re-renders on a theme switch. */
export function useChartTheme(): ChartTheme {
  return useSyncExternalStore(subscribe, getChartSnapshot, getChartServerSnapshot);
}

// ─── terminal chrome ────────────────────────────────────────────
// xterm.js parses colours itself and does not understand `oklch()`, so these
// go through the same canvas normalisation as the cluster graph. The ANSI
// sixteen are deliberately not themed: when a program emits "red" it means
// red, and remapping that would misreport build output.

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  cursorAccent?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export const STACKPILOT_TERMINAL_THEME: TerminalTheme = {
  background: "#0c0c0c",
  foreground: "#f4f4f5",
  cursor: "#f4f4f5",
  cursorAccent: "#0c0c0c",
  selectionBackground: "rgba(255, 255, 255, 0.28)",
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

export function readTerminalTheme(): TerminalTheme {
  if (typeof document !== "undefined") {
    const isDark = document.documentElement.classList.contains("dark");
    if (!isDark) {
      return {
        ...STACKPILOT_TERMINAL_THEME,
        background: "#ffffff",
        foreground: "#18181b",
        cursor: "#18181b",
        cursorAccent: "#ffffff",
        selectionBackground: "rgba(0, 0, 0, 0.15)",
        white: "#18181b",
      };
    }
  }
  return STACKPILOT_TERMINAL_THEME;
}
