import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_UI_THEME,
  UI_THEMES,
  UI_THEME_INIT_SCRIPT,
  UI_THEME_META,
  UI_THEME_STORAGE_KEY,
  applyUiTheme,
  setUiTheme,
  type UiTheme,
} from "./ui-theme";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-ui-theme");
  document.documentElement.classList.remove("dark");
});

describe("theme registry", () => {
  it("has metadata for every theme, and no metadata for a theme that does not exist", () => {
    // A theme in UI_THEMES with no metadata renders no picker card, so the
    // theme becomes unreachable from Settings without any error.
    const themes = [...UI_THEMES].sort();
    const documented = UI_THEME_META.map((meta) => meta.id).sort();
    expect(documented).toEqual(themes);
  });

  it("has no duplicate ids", () => {
    expect(new Set(UI_THEME_META.map((m) => m.id)).size).toBe(UI_THEME_META.length);
  });

  it("gives every theme a name, a description and three swatches", () => {
    // The picker card renders all four; a missing swatch renders as an
    // invisible chip rather than an error.
    for (const meta of UI_THEME_META) {
      expect(meta.name.trim(), `${meta.id} name`).not.toBe("");
      expect(meta.description.trim(), `${meta.id} description`).not.toBe("");
      expect(meta.swatches, `${meta.id} swatches`).toHaveLength(3);
      for (const swatch of meta.swatches) {
        expect(swatch, `${meta.id} swatch`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it("defaults to a theme that actually exists", () => {
    expect(UI_THEMES).toContain(DEFAULT_UI_THEME);
  });
});

describe("applyUiTheme", () => {
  it("writes the theme onto the root element", () => {
    applyUiTheme("apple" as UiTheme);
    expect(document.documentElement.getAttribute("data-ui-theme")).toBe("apple");
  });

  it("replaces the previous theme rather than accumulating", () => {
    applyUiTheme("apple" as UiTheme);
    applyUiTheme("material" as UiTheme);
    expect(document.documentElement.getAttribute("data-ui-theme")).toBe("material");
  });
});

describe("setUiTheme", () => {
  it("persists the choice and applies it in the same call", () => {
    setUiTheme("material" as UiTheme);
    expect(window.localStorage.getItem(UI_THEME_STORAGE_KEY)).toBe("material");
    expect(document.documentElement.getAttribute("data-ui-theme")).toBe("material");
  });

  it("still applies the theme when localStorage throws", () => {
    // Safari private mode throws on setItem. The theme must still change for
    // the current session instead of the click appearing to do nothing.
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      expect(() => setUiTheme("apple" as UiTheme)).not.toThrow();
      expect(document.documentElement.getAttribute("data-ui-theme")).toBe("apple");
    } finally {
      window.localStorage.setItem = original;
    }
  });
});

describe("UI_THEME_INIT_SCRIPT", () => {
  // This script is assembled by string concatenation and injected into <head>,
  // so TypeScript never checks it. It is also the only thing standing between
  // the user and a flash of the wrong palette on every page load.

  const runInitScript = () => {
    new Function(UI_THEME_INIT_SCRIPT)();
  };

  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(UI_THEME_INIT_SCRIPT)).not.toThrow();
  });

  it("applies the stored theme before paint", () => {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, "material");
    runInitScript();
    expect(document.documentElement.getAttribute("data-ui-theme")).toBe("material");
  });

  it("falls back to the default when nothing is stored", () => {
    runInitScript();
    expect(document.documentElement.getAttribute("data-ui-theme")).toBe(DEFAULT_UI_THEME);
  });

  it("rejects a value that is not a known theme", () => {
    // localStorage is attacker-writable from any script on the origin; an
    // unvalidated value would land straight in a DOM attribute.
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, "\" onload=\"alert(1)");
    runInitScript();
    expect(document.documentElement.getAttribute("data-ui-theme")).toBe(DEFAULT_UI_THEME);
  });

  it("never throws, whatever storage returns", () => {
    const original = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error("storage disabled");
    };
    try {
      expect(runInitScript).not.toThrow();
    } finally {
      window.localStorage.getItem = original;
    }
  });

  it("knows about every theme in the registry", () => {
    // The script embeds its own copy of the allow-list. If a theme is added to
    // UI_THEMES but the script is regenerated from a stale constant, that
    // theme silently reverts to the default on every reload.
    for (const theme of UI_THEMES) {
      expect(UI_THEME_INIT_SCRIPT).toContain(JSON.stringify(theme));
    }
  });

  it("adds dark class if theme is stored as dark", () => {
    window.localStorage.setItem("theme", "dark");
    runInitScript();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("adds dark class if no theme is stored but system prefers dark", () => {
    const origMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    try {
      runInitScript();
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    } finally {
      window.matchMedia = origMatchMedia;
    }
  });

  it("does not add dark class if theme is stored as light", () => {
    window.localStorage.setItem("theme", "light");
    runInitScript();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("applies a custom theme stored in localStorage", () => {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, "custom-neon-matrix");
    runInitScript();
    expect(document.documentElement.getAttribute("data-ui-theme")).toBe("custom-neon-matrix");
  });
});

