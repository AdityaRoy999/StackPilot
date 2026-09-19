import { beforeEach, describe, expect, it } from "vitest";
import {
  PRESET_THEMES,
  compileThemeCss,
  validateAndParseThemeJson,
  injectCustomThemeStyles,
  getCustomThemes,
  CUSTOM_THEME_STYLE_TAG_ID,
  type CustomThemeDefinition,
} from "./custom-themes";

describe("compileThemeCss", () => {
  const sampleTheme: CustomThemeDefinition = {
    id: "custom-test-theme",
    name: "Test Theme",
    description: "Testing CSS compilation",
    radius: "0.5rem",
    fontFamily: "Inter, sans-serif",
    light: {
      background: "#ffffff",
      foreground: "#000000",
      card: "#f9f9f9",
      cardForeground: "#000000",
      popover: "#ffffff",
      popoverForeground: "#000000",
      primary: "#3b82f6",
      primaryForeground: "#ffffff",
      secondary: "#f3f4f6",
      secondaryForeground: "#111827",
      muted: "#f3f4f6",
      mutedForeground: "#6b7280",
      accent: "#60a5fa",
      accentForeground: "#ffffff",
      destructive: "#ef4444",
      border: "#e5e7eb",
      input: "#d1d5db",
      ring: "#3b82f6",
    },
    dark: {
      background: "#0f172a",
      foreground: "#f8fafc",
      card: "#1e293b",
      cardForeground: "#f8fafc",
      popover: "#1e293b",
      popoverForeground: "#f8fafc",
      primary: "#38bdf8",
      primaryForeground: "#0f172a",
      secondary: "#334155",
      secondaryForeground: "#f8fafc",
      muted: "#334155",
      mutedForeground: "#94a3b8",
      accent: "#7dd3fc",
      accentForeground: "#0f172a",
      destructive: "#f87171",
      border: "#334155",
      input: "#475569",
      ring: "#38bdf8",
    },
    customCss: ".test-custom-class { display: block; }",
  };

  it("generates scoped selectors for light and dark modes", () => {
    const css = compileThemeCss(sampleTheme);
    expect(css).toContain('[data-ui-theme="custom-test-theme"] {');
    expect(css).toContain('[data-ui-theme="custom-test-theme"].dark {');
  });

  it("compiles design tokens into css variables", () => {
    const css = compileThemeCss(sampleTheme);
    expect(css).toContain("--radius: 0.5rem;");
    expect(css).toContain("--app-font-sans: Inter, sans-serif;");
    expect(css).toContain("--primary: #3b82f6;");
    expect(css).toContain("--background: #ffffff;");
    expect(css).toContain("--primary: #38bdf8;");
    expect(css).toContain("--background: #0f172a;");
  });

  it("appends customCss if provided", () => {
    const css = compileThemeCss(sampleTheme);
    expect(css).toContain(".test-custom-class { display: block; }");
  });
});

describe("validateAndParseThemeJson", () => {
  it("successfully parses and sanitizes a valid theme config", () => {
    const raw = JSON.stringify({
      id: "my-super-theme",
      name: "My Super Theme",
      description: "A super theme",
      radius: "0.25rem",
      light: {
        background: "#ffffff",
        foreground: "#000000",
        card: "#ffffff",
        primary: "#ff0077",
        border: "#cccccc",
      },
      dark: {
        background: "#000000",
        foreground: "#ffffff",
        card: "#111111",
        primary: "#ff0077",
        border: "#333333",
      },
    });

    const result = validateAndParseThemeJson(raw);
    expect(result.success).toBe(true);
    expect(result.theme).toBeDefined();
    expect(result.theme?.id).toBe("custom-my-super-theme");
    expect(result.theme?.name).toBe("My Super Theme");
    expect(result.theme?.light.primary).toBe("#ff0077");
    expect(result.theme?.dark.primary).toBe("#ff0077");
  });

  it("rejects invalid JSON syntax", () => {
    const result = validateAndParseThemeJson("{ not valid json }");
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects JSON missing required tokens", () => {
    const raw = JSON.stringify({
      id: "broken-theme",
      name: "Broken",
      light: {
        background: "#ffffff",
      },
      dark: {
        background: "#000000",
      },
    });
    const result = validateAndParseThemeJson(raw);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing token");
  });
});

describe("PRESET_THEMES", () => {
  it("contains at least 5 rich preset themes", () => {
    expect(PRESET_THEMES.length).toBeGreaterThanOrEqual(5);
  });

  it("ensures each preset compiles without error", () => {
    for (const preset of PRESET_THEMES) {
      expect(preset.id.startsWith("custom-")).toBe(true);
      const css = compileThemeCss(preset);
      expect(css).toContain(`[data-ui-theme="${preset.id}"]`);
      expect(css).toContain(`[data-ui-theme="${preset.id}"].dark`);
    }
  });
});

describe("injectCustomThemeStyles", () => {
  beforeEach(() => {
    const old = document.getElementById(CUSTOM_THEME_STYLE_TAG_ID);
    if (old) old.remove();
  });

  it("injects a style element into head", () => {
    injectCustomThemeStyles(PRESET_THEMES);
    const tag = document.getElementById(CUSTOM_THEME_STYLE_TAG_ID);
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toContain('[data-ui-theme="custom-cyberpunk-neon"]');
  });
});

describe("getCustomThemes memoization & referential stability", () => {
  it("returns the exact same array reference across multiple calls when storage has not changed", () => {
    const first = getCustomThemes();
    const second = getCustomThemes();
    expect(first).toBe(second);
  });
});

