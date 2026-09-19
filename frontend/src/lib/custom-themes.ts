"use client";

import { useMemo, useSyncExternalStore } from "react";

export const CUSTOM_THEMES_STORAGE_KEY = "stackpilot.custom-themes";
export const CUSTOM_THEME_STYLE_TAG_ID = "stackpilot-custom-themes-style";

export interface CustomThemeTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  border: string;
  input: string;
  ring: string;

  // Optional sidebar tokens (auto-derived if omitted)
  sidebar?: string;
  sidebarForeground?: string;
  sidebarPrimary?: string;
  sidebarPrimaryForeground?: string;
  sidebarAccent?: string;
  sidebarAccentForeground?: string;
  sidebarBorder?: string;
  sidebarRing?: string;
}

export interface CustomThemeDefinition {
  id: string; // e.g. "custom-cyberpunk-neon"
  name: string; // e.g. "Cyberpunk Neon"
  description: string;
  author?: string;
  version?: string;
  radius: string; // e.g. "0.5rem"
  fontFamily?: string; // e.g. 'var(--font-jetbrains-mono), monospace'
  light: CustomThemeTokens;
  dark: CustomThemeTokens;
  customCss?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Pre-packaged Presets
// ---------------------------------------------------------------------------

export const PRESET_THEMES: CustomThemeDefinition[] = [
  {
    id: "custom-cyberpunk-neon",
    name: "Cyberpunk Neon",
    description: "High-contrast synthwave dark palette with electric magenta and cyber cyan accents.",
    author: "StackPilot Studio",
    version: "1.0.0",
    radius: "0.375rem",
    fontFamily: "var(--font-jetbrains-mono), monospace",
    light: {
      background: "#f8fafc",
      foreground: "#090d16",
      card: "#ffffff",
      cardForeground: "#090d16",
      popover: "#ffffff",
      popoverForeground: "#090d16",
      primary: "#d946ef",
      primaryForeground: "#ffffff",
      secondary: "#f1f5f9",
      secondaryForeground: "#0f172a",
      muted: "#f1f5f9",
      mutedForeground: "#64748b",
      accent: "#ec4899",
      accentForeground: "#ffffff",
      destructive: "#ef4444",
      border: "#e2e8f0",
      input: "#cbd5e1",
      ring: "#d946ef",
    },
    dark: {
      background: "#08090f",
      foreground: "#f8fafc",
      card: "#10121d",
      cardForeground: "#f8fafc",
      popover: "#10121d",
      popoverForeground: "#f8fafc",
      primary: "#d946ef",
      primaryForeground: "#ffffff",
      secondary: "#191c2b",
      secondaryForeground: "#f8fafc",
      muted: "#171a26",
      mutedForeground: "#94a3b8",
      accent: "#06b6d4",
      accentForeground: "#08090f",
      destructive: "#f43f5e",
      border: "#262b3d",
      input: "#32374d",
      ring: "#d946ef",
    },
    customCss: `
[data-ui-theme="custom-cyberpunk-neon"] [data-slot="button"].bg-primary {
  box-shadow: 0 0 14px rgba(217, 70, 239, 0.4);
}
[data-ui-theme="custom-cyberpunk-neon"] [data-slot="card"] {
  box-shadow: 0 0 0 1px var(--border), 0 4px 16px rgba(0, 0, 0, 0.4);
}
    `.trim(),
  },
  {
    id: "custom-tokyo-night",
    name: "Tokyo Night",
    description: "Iconic Japanese storm aesthetic — deep moody indigo, lavender primary and soft emerald accents.",
    author: "StackPilot Studio",
    version: "1.0.0",
    radius: "0.5rem",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    light: {
      background: "#f5f6fa",
      foreground: "#24283b",
      card: "#ffffff",
      cardForeground: "#24283b",
      popover: "#ffffff",
      popoverForeground: "#24283b",
      primary: "#7aa2f7",
      primaryForeground: "#ffffff",
      secondary: "#e6e8f2",
      secondaryForeground: "#24283b",
      muted: "#e9ebf5",
      mutedForeground: "#565f89",
      accent: "#73daca",
      accentForeground: "#1a1b26",
      destructive: "#f7768e",
      border: "#d5d8e8",
      input: "#c4c8dd",
      ring: "#7aa2f7",
    },
    dark: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      card: "#24283b",
      cardForeground: "#c0caf5",
      popover: "#24283b",
      popoverForeground: "#c0caf5",
      primary: "#7aa2f7",
      primaryForeground: "#1a1b26",
      secondary: "#292e42",
      secondaryForeground: "#c0caf5",
      muted: "#292e42",
      mutedForeground: "#787c99",
      accent: "#73daca",
      accentForeground: "#1a1b26",
      destructive: "#f7768e",
      border: "#3b4261",
      input: "#414868",
      ring: "#7aa2f7",
    },
    customCss: `
[data-ui-theme="custom-tokyo-night"] [data-slot="card"] {
  border-color: var(--border);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
    `.trim(),
  },
  {
    id: "custom-emerald-terminal",
    name: "Emerald Terminal",
    description: "Retro hacker terminal phosphor green on pitch carbon obsidian with monospaced typography.",
    author: "StackPilot Studio",
    version: "1.0.0",
    radius: "0.25rem",
    fontFamily: "var(--font-jetbrains-mono), monospace",
    light: {
      background: "#f0fdf4",
      foreground: "#052e16",
      card: "#ffffff",
      cardForeground: "#052e16",
      popover: "#ffffff",
      popoverForeground: "#052e16",
      primary: "#059669",
      primaryForeground: "#ffffff",
      secondary: "#dcfce7",
      secondaryForeground: "#065f46",
      muted: "#dcfce7",
      mutedForeground: "#047857",
      accent: "#10b981",
      accentForeground: "#ffffff",
      destructive: "#dc2626",
      border: "#bbf7d0",
      input: "#86efac",
      ring: "#10b981",
    },
    dark: {
      background: "#080c09",
      foreground: "#e2fee9",
      card: "#0f1611",
      cardForeground: "#e2fee9",
      popover: "#0f1611",
      popoverForeground: "#e2fee9",
      primary: "#10b981",
      primaryForeground: "#052e16",
      secondary: "#16231a",
      secondaryForeground: "#e2fee9",
      muted: "#16231a",
      mutedForeground: "#6ee7b7",
      accent: "#34d399",
      accentForeground: "#080c09",
      destructive: "#ef4444",
      border: "#1d3824",
      input: "#27482f",
      ring: "#10b981",
    },
    customCss: `
[data-ui-theme="custom-emerald-terminal"] {
  letter-spacing: -0.01em;
}
[data-ui-theme="custom-emerald-terminal"] [data-slot="button"].bg-primary {
  box-shadow: 0 0 10px rgba(16, 185, 129, 0.35);
}
    `.trim(),
  },
  {
    id: "custom-sunset-horizon",
    name: "Sunset Horizon",
    description: "Warm sunset dusk with radiant amber, coral gradients, and velvet violet dark surfaces.",
    author: "StackPilot Studio",
    version: "1.0.0",
    radius: "0.625rem",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    light: {
      background: "#fffaf5",
      foreground: "#2e1022",
      card: "#ffffff",
      cardForeground: "#2e1022",
      popover: "#ffffff",
      popoverForeground: "#2e1022",
      primary: "#f59e0b",
      primaryForeground: "#ffffff",
      secondary: "#ffedd5",
      secondaryForeground: "#7c2d12",
      muted: "#ffedd5",
      mutedForeground: "#9a3412",
      accent: "#f43f5e",
      accentForeground: "#ffffff",
      destructive: "#e11d48",
      border: "#fed7aa",
      input: "#fdba74",
      ring: "#f59e0b",
    },
    dark: {
      background: "#120e24",
      foreground: "#fdf2f8",
      card: "#1a1533",
      cardForeground: "#fdf2f8",
      popover: "#1a1533",
      popoverForeground: "#fdf2f8",
      primary: "#f59e0b",
      primaryForeground: "#120e24",
      secondary: "#261f47",
      secondaryForeground: "#fdf2f8",
      muted: "#261f47",
      mutedForeground: "#d8b4fe",
      accent: "#f43f5e",
      accentForeground: "#ffffff",
      destructive: "#fb7185",
      border: "#3b306b",
      input: "#4c3e8a",
      ring: "#f59e0b",
    },
    customCss: `
[data-ui-theme="custom-sunset-horizon"] [data-slot="card"] {
  box-shadow: 0 4px 16px rgba(245, 158, 11, 0.08);
}
    `.trim(),
  },
  {
    id: "custom-nordic-frost",
    name: "Nordic Frost",
    description: "Arctic cold minimalist design with ice cyan accents, deep fjord slate, and high legibility.",
    author: "StackPilot Studio",
    version: "1.0.0",
    radius: "0.5rem",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    light: {
      background: "#f8fafc",
      foreground: "#0f172a",
      card: "#ffffff",
      cardForeground: "#0f172a",
      popover: "#ffffff",
      popoverForeground: "#0f172a",
      primary: "#0284c7",
      primaryForeground: "#ffffff",
      secondary: "#e0f2fe",
      secondaryForeground: "#0369a1",
      muted: "#f1f5f9",
      mutedForeground: "#64748b",
      accent: "#38bdf8",
      accentForeground: "#0f172a",
      destructive: "#ef4444",
      border: "#e2e8f0",
      input: "#cbd5e1",
      ring: "#0284c7",
    },
    dark: {
      background: "#0b1120",
      foreground: "#f1f5f9",
      card: "#131c31",
      cardForeground: "#f1f5f9",
      popover: "#131c31",
      popoverForeground: "#f1f5f9",
      primary: "#38bdf8",
      primaryForeground: "#0b1120",
      secondary: "#1e293b",
      secondaryForeground: "#f1f5f9",
      muted: "#1e293b",
      mutedForeground: "#94a3b8",
      accent: "#7dd3fc",
      accentForeground: "#0b1120",
      destructive: "#f87171",
      border: "#25334d",
      input: "#334155",
      ring: "#38bdf8",
    },
    customCss: `
[data-ui-theme="custom-nordic-frost"] [data-slot="card"] {
  box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05);
}
    `.trim(),
  },
  {
    id: "custom-radix-indigo-blank",
    name: "Radix Slate & Indigo",
    description: "Official Radix UI palette starter template ready for custom color and geometry modifications.",
    author: "StackPilot Studio",
    version: "1.0.0",
    radius: "0.5rem",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    light: {
      background: "#fcfcfd",
      foreground: "#1c2024",
      card: "#ffffff",
      cardForeground: "#1c2024",
      popover: "#ffffff",
      popoverForeground: "#1c2024",
      primary: "#3e63dd",
      primaryForeground: "#ffffff",
      secondary: "#f0f0f3",
      secondaryForeground: "#1c2024",
      muted: "#f0f0f3",
      mutedForeground: "#60646c",
      accent: "#edf2fe",
      accentForeground: "#3a5bc7",
      destructive: "#e5484d",
      border: "#d9d9e0",
      input: "#cdced6",
      ring: "#3e63dd",
    },
    dark: {
      background: "#111113",
      foreground: "#edeef0",
      card: "#18191b",
      cardForeground: "#edeef0",
      popover: "#18191b",
      popoverForeground: "#edeef0",
      primary: "#3e63dd",
      primaryForeground: "#ffffff",
      secondary: "#212225",
      secondaryForeground: "#edeef0",
      muted: "#212225",
      mutedForeground: "#8b8d98",
      accent: "#182449",
      accentForeground: "#9eb1ff",
      destructive: "#e5484d",
      border: "#313235",
      input: "#3e3f43",
      ring: "#3e63dd",
    },
  },
];

// ---------------------------------------------------------------------------
// Dynamic CSS Compiler
// ---------------------------------------------------------------------------

function compileModeVariables(
  tokens: CustomThemeTokens,
  radius: string,
  fontFamily?: string
): string {
  const sidebarBg = tokens.sidebar || tokens.card;
  const sidebarFg = tokens.sidebarForeground || tokens.cardForeground;
  const sidebarPri = tokens.sidebarPrimary || tokens.primary;
  const sidebarPriFg = tokens.sidebarPrimaryForeground || tokens.primaryForeground;
  const sidebarAcc = tokens.sidebarAccent || tokens.secondary;
  const sidebarAccFg = tokens.sidebarAccentForeground || tokens.secondaryForeground;
  const sidebarBrd = tokens.sidebarBorder || tokens.border;
  const sidebarRng = tokens.sidebarRing || tokens.ring;

  const lines = [
    radius ? `  --radius: ${radius};` : "",
    fontFamily ? `  --app-font-sans: ${fontFamily};` : "",
    `  --background: ${tokens.background};`,
    `  --foreground: ${tokens.foreground};`,
    `  --card: ${tokens.card};`,
    `  --card-foreground: ${tokens.cardForeground};`,
    `  --popover: ${tokens.popover};`,
    `  --popover-foreground: ${tokens.popoverForeground};`,
    `  --primary: ${tokens.primary};`,
    `  --primary-foreground: ${tokens.primaryForeground};`,
    `  --secondary: ${tokens.secondary};`,
    `  --secondary-foreground: ${tokens.secondaryForeground};`,
    `  --muted: ${tokens.muted};`,
    `  --muted-foreground: ${tokens.mutedForeground};`,
    `  --accent: ${tokens.accent};`,
    `  --accent-foreground: ${tokens.accentForeground};`,
    `  --destructive: ${tokens.destructive};`,
    `  --border: ${tokens.border};`,
    `  --input: ${tokens.input};`,
    `  --ring: ${tokens.ring};`,

    // Sidebar variables
    `  --sidebar: ${sidebarBg};`,
    `  --sidebar-foreground: ${sidebarFg};`,
    `  --sidebar-primary: ${sidebarPri};`,
    `  --sidebar-primary-foreground: ${sidebarPriFg};`,
    `  --sidebar-accent: ${sidebarAcc};`,
    `  --sidebar-accent-foreground: ${sidebarAccFg};`,
    `  --sidebar-border: ${sidebarBrd};`,
    `  --sidebar-ring: ${sidebarRng};`,

    // Extended UI tokens for custom elements
    `  --ink: ${tokens.foreground};`,
    `  --ink-2: ${tokens.mutedForeground};`,
    `  --ink-3: ${tokens.mutedForeground};`,
    `  --line: ${tokens.border};`,
    `  --line-strong: ${tokens.input};`,
    `  --surface: ${tokens.card};`,
    `  --field: ${tokens.secondary};`,
    `  --inset: ${tokens.background};`,
    `  --hover: ${tokens.secondary};`,
    `  --hover-2: ${tokens.muted};`,
  ].filter(Boolean);

  return lines.join("\n");
}

export function compileThemeCss(theme: CustomThemeDefinition): string {
  const selector = `[data-ui-theme="${theme.id}"]`;

  const lightBlock = `${selector} {\n${compileModeVariables(
    theme.light,
    theme.radius,
    theme.fontFamily
  )}\n}`;

  const darkBlock = `${selector}.dark {\n${compileModeVariables(
    theme.dark,
    theme.radius,
    theme.fontFamily
  )}\n}`;

  let css = `${lightBlock}\n\n${darkBlock}`;

  if (theme.customCss && theme.customCss.trim()) {
    css += `\n\n${theme.customCss.trim()}`;
  }

  return css;
}

// ---------------------------------------------------------------------------
// DOM Injection
// ---------------------------------------------------------------------------

export function injectCustomThemeStyles(themes?: CustomThemeDefinition[]): void {
  if (typeof document === "undefined") return;

  let list = themes;
  if (!list) {
    list = getCustomThemes();
  }

  // Also include built-in presets so users can preview or test them without saving first
  const allThemesMap = new Map<string, CustomThemeDefinition>();
  PRESET_THEMES.forEach((preset) => allThemesMap.set(preset.id, preset));
  list.forEach((t) => allThemesMap.set(t.id, t));

  const compiled = Array.from(allThemesMap.values())
    .map((t) => compileThemeCss(t))
    .join("\n\n");

  let styleTag = document.getElementById(CUSTOM_THEME_STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!styleTag) {
    styleTag = document.createElement("style");
    styleTag.id = CUSTOM_THEME_STYLE_TAG_ID;
    document.head.appendChild(styleTag);
  }

  styleTag.textContent = compiled;
}

// ---------------------------------------------------------------------------
// Storage & Synchronization
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

let rawCachedString: string | null = null;
let cachedThemes: CustomThemeDefinition[] = PRESET_THEMES;

function readThemesFromStorage(): CustomThemeDefinition[] {
  if (typeof window === "undefined") return PRESET_THEMES;
  try {
    const raw = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
    if (raw === rawCachedString && cachedThemes) {
      return cachedThemes;
    }
    rawCachedString = raw;
    if (!raw) {
      cachedThemes = PRESET_THEMES;
      return cachedThemes;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      cachedThemes = parsed;
      return cachedThemes;
    }
    cachedThemes = PRESET_THEMES;
    return cachedThemes;
  } catch {
    cachedThemes = PRESET_THEMES;
    return cachedThemes;
  }
}

export function getCustomThemes(): CustomThemeDefinition[] {
  return readThemesFromStorage();
}

export function getCustomThemeById(id: string): CustomThemeDefinition | null {
  const themes = getCustomThemes();
  return themes.find((t) => t.id === id) || PRESET_THEMES.find((p) => p.id === id) || null;
}

export function saveCustomTheme(theme: CustomThemeDefinition): void {
  if (typeof window === "undefined") return;

  const current = getCustomThemes();
  const existingIndex = current.findIndex((t) => t.id === theme.id);

  const updatedTheme: CustomThemeDefinition = {
    ...theme,
    updatedAt: new Date().toISOString(),
    createdAt:
      existingIndex >= 0 ? current[existingIndex].createdAt : new Date().toISOString(),
  };

  let nextList: CustomThemeDefinition[];
  if (existingIndex >= 0) {
    nextList = [...current];
    nextList[existingIndex] = updatedTheme;
  } else {
    nextList = [updatedTheme, ...current];
  }

  const str = JSON.stringify(nextList);
  rawCachedString = str;
  cachedThemes = nextList;

  try {
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, str);
  } catch {}

  injectCustomThemeStyles(nextList);
  emit();
}

export function deleteCustomTheme(themeId: string): void {
  if (typeof window === "undefined") return;

  const current = getCustomThemes();
  const nextList = current.filter((t) => t.id !== themeId);

  const str = JSON.stringify(nextList);
  rawCachedString = str;
  cachedThemes = nextList;

  try {
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, str);
  } catch {}

  injectCustomThemeStyles(nextList);
  emit();
}

export function resetCustomThemesToPresets(): void {
  if (typeof window === "undefined") return;
  const str = JSON.stringify(PRESET_THEMES);
  rawCachedString = str;
  cachedThemes = PRESET_THEMES;
  try {
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, str);
  } catch {}
  injectCustomThemeStyles(PRESET_THEMES);
  emit();
}

// ---------------------------------------------------------------------------
// JSON Import / Export / Validation
// ---------------------------------------------------------------------------

export function exportThemeJson(theme: CustomThemeDefinition): void {
  const exportPayload = {
    $schema: "https://stackpilot.dev/schemas/theme-v1.json",
    ...theme,
  };
  const jsonStr = JSON.stringify(exportPayload, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${theme.id || "custom-theme"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function validateAndParseThemeJson(rawJson: string): {
  success: boolean;
  theme?: CustomThemeDefinition;
  error?: string;
} {
  try {
    const data = JSON.parse(rawJson);
    if (!data || typeof data !== "object") {
      return { success: false, error: "JSON must be a valid JSON object." };
    }

    if (!data.id || typeof data.id !== "string") {
      return { success: false, error: "Missing or invalid 'id'. Must be a string." };
    }

    // Ensure ID conforms to slug format
    const cleanedId = data.id.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const finalId = cleanedId.startsWith("custom-") ? cleanedId : `custom-${cleanedId}`;

    if (!data.name || typeof data.name !== "string") {
      return { success: false, error: "Missing or invalid 'name'. Must be a string." };
    }

    if (!data.light || typeof data.light !== "object") {
      return { success: false, error: "Missing or invalid 'light' palette object." };
    }

    if (!data.dark || typeof data.dark !== "object") {
      return { success: false, error: "Missing or invalid 'dark' palette object." };
    }

    const requiredTokens = ["background", "foreground", "card", "primary", "border"] as const;
    for (const token of requiredTokens) {
      if (!data.light[token]) {
        return {
          success: false,
          error: `Missing token 'light.${token}'. A valid color value is required.`,
        };
      }
      if (!data.dark[token]) {
        return {
          success: false,
          error: `Missing token 'dark.${token}'. A valid color value is required.`,
        };
      }
    }

    const theme: CustomThemeDefinition = {
      id: finalId,
      name: data.name,
      description: data.description || "Custom theme configuration",
      author: data.author || "Community Contributor",
      version: data.version || "1.0.0",
      radius: data.radius || "0.5rem",
      fontFamily: data.fontFamily || undefined,
      light: {
        background: data.light.background,
        foreground: data.light.foreground,
        card: data.light.card || data.light.background,
        cardForeground: data.light.cardForeground || data.light.foreground,
        popover: data.light.popover || data.light.card || data.light.background,
        popoverForeground: data.light.popoverForeground || data.light.foreground,
        primary: data.light.primary,
        primaryForeground: data.light.primaryForeground || "#ffffff",
        secondary: data.light.secondary || "#f1f5f9",
        secondaryForeground: data.light.secondaryForeground || data.light.foreground,
        muted: data.light.muted || "#f1f5f9",
        mutedForeground: data.light.mutedForeground || "#64748b",
        accent: data.light.accent || data.light.primary,
        accentForeground: data.light.accentForeground || "#ffffff",
        destructive: data.light.destructive || "#ef4444",
        border: data.light.border,
        input: data.light.input || data.light.border,
        ring: data.light.ring || data.light.primary,
        ...(data.light.sidebar ? { sidebar: data.light.sidebar } : {}),
        ...(data.light.sidebarForeground ? { sidebarForeground: data.light.sidebarForeground } : {}),
      },
      dark: {
        background: data.dark.background,
        foreground: data.dark.foreground,
        card: data.dark.card || data.dark.background,
        cardForeground: data.dark.cardForeground || data.dark.foreground,
        popover: data.dark.popover || data.dark.card || data.dark.background,
        popoverForeground: data.dark.popoverForeground || data.dark.foreground,
        primary: data.dark.primary,
        primaryForeground: data.dark.primaryForeground || "#ffffff",
        secondary: data.dark.secondary || "#1e293b",
        secondaryForeground: data.dark.secondaryForeground || data.dark.foreground,
        muted: data.dark.muted || "#1e293b",
        mutedForeground: data.dark.mutedForeground || "#94a3b8",
        accent: data.dark.accent || data.dark.primary,
        accentForeground: data.dark.accentForeground || "#ffffff",
        destructive: data.dark.destructive || "#ef4444",
        border: data.dark.border,
        input: data.dark.input || data.dark.border,
        ring: data.dark.ring || data.dark.primary,
        ...(data.dark.sidebar ? { sidebar: data.dark.sidebar } : {}),
        ...(data.dark.sidebarForeground ? { sidebarForeground: data.dark.sidebarForeground } : {}),
      },
      customCss: data.customCss || undefined,
      createdAt: data.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return { success: true, theme };
  } catch (err: any) {
    return { success: false, error: err.message || "Invalid JSON syntax." };
  }
}

// ---------------------------------------------------------------------------
// React Hook
// ---------------------------------------------------------------------------

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Storage event for other tabs
  const onStorage = (e: StorageEvent) => {
    if (e.key === CUSTOM_THEMES_STORAGE_KEY) {
      rawCachedString = null;
      readThemesFromStorage();
      injectCustomThemeStyles();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const SERVER_SNAPSHOT = PRESET_THEMES;

export function useCustomThemes(): [
  CustomThemeDefinition[],
  {
    saveTheme: (theme: CustomThemeDefinition) => void;
    deleteTheme: (themeId: string) => void;
    resetToPresets: () => void;
  }
] {
  const themes = useSyncExternalStore(subscribe, getCustomThemes, () => SERVER_SNAPSHOT);

  const actions = useMemo(
    () => ({
      saveTheme: saveCustomTheme,
      deleteTheme: deleteCustomTheme,
      resetToPresets: resetCustomThemesToPresets,
    }),
    []
  );

  return [themes, actions];
}
