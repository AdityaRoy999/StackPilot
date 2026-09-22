// Server-safe theme and icon init scripts (NO "use client" directive)
// Safe to import in Server Components like layout.tsx

export const UI_THEME_STORAGE_KEY = "stackpilot.ui-theme";
export const DEFAULT_UI_THEME = "radix";

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
  "stackpilot-web",
] as const;

export type UiTheme = (typeof UI_THEMES)[number];

export const ICON_STORAGE_KEY = "stackpilot.icon-settings";

/**
 * Runs before first paint (injected in <head>) so a non-default theme does not
 * flash the default palette on load, and dark mode is applied immediately to prevent FOUC.
 */
export const UI_THEME_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem("theme");if(m==="dark"||((!m||m==="system")&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add("dark");}else{document.documentElement.classList.remove("dark");}}catch(e){}try{var t=localStorage.getItem(${JSON.stringify(
  UI_THEME_STORAGE_KEY
)});var allowed=${JSON.stringify(UI_THEMES)};if(allowed.indexOf(t)>-1){document.documentElement.setAttribute('data-ui-theme',t);}else if(t&&/^custom-[a-z0-9_-]+$/.test(t)){document.documentElement.setAttribute('data-ui-theme',t);}else{document.documentElement.setAttribute('data-ui-theme',${JSON.stringify(
  DEFAULT_UI_THEME
)});} }catch(e){try{document.documentElement.setAttribute('data-ui-theme',${JSON.stringify(
  DEFAULT_UI_THEME
)});}catch(err){}}})();`;

/**
 * Script injected into <head> to prevent icon layout shifts before hydration
 */
export const ICON_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(
  ICON_STORAGE_KEY
)});if(s){var p=JSON.parse(s);if(p.mode)document.documentElement.setAttribute('data-icon-mode',p.mode);if(p.pack)document.documentElement.setAttribute('data-icon-pack',p.pack);}}catch(e){}})();`;
