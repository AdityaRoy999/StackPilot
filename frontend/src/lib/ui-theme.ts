"use client";

import { useSyncExternalStore } from "react";
import api from "@/lib/api";
import { injectCustomThemeStyles } from "@/lib/custom-themes";

// The theme *family* is a separate axis from light/dark (which next-themes owns
// via the `class` attribute). It lives on <html data-ui-theme="...">, and the
// CSS in globals.css keys every design token off that attribute.
export const UI_THEMES = [
  "radix",
  "shadcn",
  "apple",
  "material",
  "heroui",
  "geist",
  "catppuccin",
  "dracula",
  "nord",
  "antd",
  "browser",
  "minimal-flat",
  "terminal-phosphor",
  "high-contrast-dense",
  "material-m3",
  "aws-cloudscape",
  "ibm-carbon",
  "azure-fluent",
] as const;
export type UiTheme = (typeof UI_THEMES)[number] | (string & {});

export const DEFAULT_UI_THEME: UiTheme = "radix";
export const UI_THEME_STORAGE_KEY = "stackpilot.ui-theme";

export interface UiThemeMeta {
  id: UiTheme;
  name: string;
  description: string;
  /** Swatches for the picker preview: [background, surface, accent]. */
  swatches: [string, string, string];
}

export const UI_THEME_META: UiThemeMeta[] = [
  {
    id: "radix",
    name: "Radix UI",
    description: "Official Radix UI specification — Indigo accent (#3e63dd), Slate neutrals, and precision component geometry.",
    swatches: ["#fcfcfd", "#f0f0f3", "#3e63dd"],
  },
  {
    id: "shadcn",
    name: "Default",
    description: "The stock shadcn look — neutral greys and restrained contrast.",
    swatches: ["#ffffff", "#f4f4f5", "#18181b"],
  },
  {
    id: "apple",
    name: "Apple",
    description: "Generous radii, system typeface and systemBlue accents.",
    swatches: ["#ffffff", "#f5f5f7", "#0071e3"],
  },
  {
    id: "material",
    name: "Material",
    description: "Google-style enterprise UI — Roboto, pill buttons, layered elevation.",
    swatches: ["#ffffff", "#f1f3f4", "#1a73e8"],
  },
  {
    id: "heroui",
    name: "HeroUI",
    description: "Soft off-white canvas, white surfaces and a vivid blue accent.",
    swatches: ["#f7f7f7", "#ffffff", "#3b82f6"],
  },
  {
    id: "geist",
    name: "Geist",
    description: "Vercel-style: maximum contrast, minimal chrome, tight radii.",
    swatches: ["#ffffff", "#fafafa", "#000000"],
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    description: "Pastel Latte and Mocha palettes with gentle contrast.",
    swatches: ["#eff1f5", "#e6e9ef", "#1e66f5"],
  },
  {
    id: "dracula",
    name: "Dracula",
    description: "The classic purple-and-pink dark palette, plus a light Alucard variant.",
    swatches: ["#f8f8f2", "#ececf0", "#6c3fc9"],
  },
  {
    id: "nord",
    name: "Nord",
    description: "Cool arctic palette with muted blues and soft contrast.",
    swatches: ["#eceff4", "#e5e9f0", "#5e81ac"],
  },
  {
    id: "antd",
    name: "Ant Design",
    description: "Enterprise specification by Ant Group — Daybreak Blue, crisp borders, subtle shadows.",
    swatches: ["#ffffff", "#fafafa", "#1677ff"],
  },
  {
    id: "browser",
    name: "Browser Native",
    description: "Authentic HTML user-agent controls: 3D beveled buttons, inset fields, and zero radius.",
    swatches: ["#ffffff", "#e9e9e9", "#0000ee"],
  },
  {
    id: "minimal-flat",
    name: "Minimal Flat",
    description: "High-speed monochrome with zero shadows, zero transitions, and 1px crisp borders.",
    swatches: ["#ffffff", "#fbfbfb", "#0a0a0a"],
  },
  {
    id: "terminal-phosphor",
    name: "Terminal CRT",
    description: "Retro amber console aesthetic in pure JetBrains Mono with high-contrast text.",
    swatches: ["#0a0800", "#141000", "#ffb000"],
  },
  {
    id: "high-contrast-dense",
    name: "SRE Dense",
    description: "Pure black background, high-contrast borders, and compact high-density layout.",
    swatches: ["#000000", "#111111", "#00ff66"],
  },
  {
    id: "material-m3",
    name: "Google Cloud M3",
    description: "Google Cloud Console design: Roboto typography, pill badges, and layered tonal elevation.",
    swatches: ["#ffffff", "#f8f9fa", "#1a73e8"],
  },
  {
    id: "aws-cloudscape",
    name: "AWS Cloudscape",
    description: "AWS Management Console aesthetic: Deep navy chrome, squid ink blue, and orange accents.",
    swatches: ["#f2f3f3", "#161f2e", "#ec7211"],
  },
  {
    id: "ibm-carbon",
    name: "IBM Carbon",
    description: "IBM Carbon 11 Design System: Strict 0px radius, IBM Plex Sans, and industrial grid.",
    swatches: ["#f4f4f4", "#ffffff", "#0f62fe"],
  },
  {
    id: "azure-fluent",
    name: "Azure Fluent",
    description: "Microsoft Azure & Fluent 2 design: Segoe UI, subtle acrylic surfaces, and Azure Blue.",
    swatches: ["#ffffff", "#f3f2f1", "#0078d4"],
  },
];

export function isCustomThemeId(value: string | null): boolean {
  return typeof value === "string" && /^custom-[a-z0-9_-]+$/.test(value);
}

export function isUiTheme(value: string | null): value is UiTheme {
  if (!value) return false;
  return (UI_THEMES as readonly string[]).includes(value) || isCustomThemeId(value);
}

export function applyUiTheme(theme: UiTheme) {
  document.documentElement.setAttribute("data-ui-theme", theme);
  if (typeof window !== "undefined" && typeof theme === "string" && theme.startsWith("custom-")) {
    injectCustomThemeStyles();
  }
}

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

let hasSyncedWithDatabase = false;

export function syncUiThemeWithDatabase() {
  if (hasSyncedWithDatabase || typeof window === "undefined") return;
  hasSyncedWithDatabase = true;

  api
    .get("/auth/preferences")
    .then((res) => {
      const themeFromDb = res.data?.ui_theme;
      if (themeFromDb && isUiTheme(themeFromDb)) {
        const stored = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
        if (stored !== themeFromDb) {
          try {
            window.localStorage.setItem(UI_THEME_STORAGE_KEY, themeFromDb);
          } catch {}
          applyUiTheme(themeFromDb);
          emit();
        }
      }
    })
    .catch(() => {
      // Offline or guest
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  syncUiThemeWithDatabase();
  // Keep other tabs in sync.
  const onStorage = (event: StorageEvent) => {
    if (event.key === UI_THEME_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): UiTheme {
  try {
    const stored = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
    return isUiTheme(stored) ? stored : DEFAULT_UI_THEME;
  } catch {
    return DEFAULT_UI_THEME;
  }
}

// The server has no localStorage, so it must render the default. Returning a
// stable server snapshot is what keeps hydration from mismatching.
function getServerSnapshot(): UiTheme {
  return DEFAULT_UI_THEME;
}

export function setUiTheme(theme: UiTheme) {
  try {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, theme);
  } catch {
    // Private-mode or storage-disabled: still apply for this session.
  }
  applyUiTheme(theme);
  emit();

  // Persist permanently to PostgreSQL Database so theme follows user across devices
  api.put("/auth/preferences", { ui_theme: theme }).catch(() => {});
}

export function useUiTheme(): [UiTheme, (theme: UiTheme) => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [theme, setUiTheme];
}

export { UI_THEME_INIT_SCRIPT } from "./theme-init";

