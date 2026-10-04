import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// SVG Repo lists these Solar, Phosphor, Carbon, Iconoir and Fluent collections.
// Their upstream Iconify JSON distributions provide the vector paths in a
// reproducible build-time format; do not ship entire catalogs to browsers.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const solar = JSON.parse(readFileSync(join(root, "node_modules/@iconify-json/solar/icons.json"), "utf8"));
const phosphor = JSON.parse(readFileSync(join(root, "node_modules/@iconify-json/ph/icons.json"), "utf8"));
const carbon = JSON.parse(readFileSync(join(root, "node_modules/@iconify-json/carbon/icons.json"), "utf8"));
const iconoir = JSON.parse(readFileSync(join(root, "node_modules/@iconify-json/iconoir/icons.json"), "utf8"));
const fluent = JSON.parse(readFileSync(join(root, "node_modules/@iconify-json/fluent/icons.json"), "utf8"));
const customSource = readFileSync(join(root, "src/lib/custom-icons.tsx"), "utf8");
const platformSource = readFileSync(join(root, "src/lib/platform-icon-map.ts"), "utf8");
const curated = [...customSource.matchAll(/^\s*id: "([^"]+)",/gm)].map((match) => match[1]);
const registry = platformSource.split("export const PLATFORM_LUCIDE_ICONS = {")[1]?.split("};")[0] || "";
const supplemental = registry.split(",").map((part) => part.trim()).filter((name) => /^[A-Za-z][A-Za-z0-9]*$/.test(name))
  .map((name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase());
const ids = [...new Set([...curated, ...supplemental])];

const solarNames = {
  "layout-dashboard": "widget-2", "boxes": "box", "activity": "pulse-2", "gauge": "speedometer",
  "network": "globus", "building-2": "buildings-2", "bot": "chat-round-dots", "brain-circuit": "brain",
  "settings": "settings", "settings-2": "settings-minimalistic", "sliders-horizontal": "tuning-2",
  "sliders": "tuning-2", "layers": "layers", "terminal-square": "code-square",
  "terminal-icon": "code", "file-code": "file-code", "file-code-2": "file-code",
  "file-text": "document-text", "file-edit": "document-add", "edit-2": "pen",
  "clipboard-copy": "clipboard-list", "folder-tree": "folder-with-files", "folder-up": "folder-path-connect",
  "folder-git-2": "folder", "git-fork": "branching-paths-up", "git-pull-request": "branching-paths-up",
  "git-branch": "branching-paths-up", "git-commit": "branching-paths-up", "hard-drive": "server",
  "help-circle": "question-circle", "alert-circle": "danger-circle", "circle-alert": "danger-circle",
  "alert-triangle": "danger-triangle", "triangle-alert-icon": "danger-triangle",
  "check-circle": "check-circle", "check-circle-2": "check-circle", "circle-check-icon": "check-circle",
  "x-circle": "close-circle", "octagon-x-icon": "close-circle", "x-icon": "close-circle",
  "shield-alert": "shield-warning", "shield-check": "shield-check", "brain": "brain",
  "refresh-cw": "refresh", "rotate-ccw": "restart", "rotate-cw": "restart",
  "loader-2": "refresh", "loader-2-icon": "refresh", "more-horizontal": "menu-dots",
  "more-vertical": "menu-dots", "chevrons-up-down": "sort-vertical", "arrow-up-down": "sort-vertical",
  "bar-chart-3": "chart-2", "qr-code": "qr-code", "mic": "microphone", "mic-off": "microphone-slash",
  "message-square": "chat-square", "mail-check": "letter-opened", "log-in": "login-2",
  "log-out": "logout-2", "user-plus": "user-plus", "user-minus": "user-minus",
  "battery-charging": "battery-charge", "corner-down-left": "turn-left-down",
  "panel-left-open": "sidebar-minimalistic", "panel-left-close": "sidebar-minimalistic",
  "layout-dashboard-icon": "widget-2", "image": "gallery", "link-2": "link",
  "focus": "focus", "eye-off": "eye-closed", "external-link": "square-top-down",
  "maximize-2": "maximize", "minimize-2": "minimize", "upload-cloud": "cloud-upload",
  "upload": "upload", "download": "download", "key-round": "key",
  "history": "history", "workflow": "branching-paths-up", "wand-2": "magic-stick-3",
  "sparkles": "stars", "zap": "bolt", "sun": "sun", "moon": "moon", "wifi": "wi-fi-router",
  "menu": "hamburger-menu", "trash-2": "trash-bin-trash", "edit": "pen", "send": "send-square",
  "search": "magnifer", "save": "diskette", "undo2": "undo-left", "memory-stick": "server",
  "plug": "plug-circle", "unplug": "plug-circle", "columns": "columns-2", "terminal": "code",
  "wrench": "tuning", "wand2": "magic-stick-3", "clock": "clock-circle", "scroll-text": "document-text",
  "square": "stop", "unlock": "lock-unlocked", "users": "users-group-rounded", "mail": "letter",
  "info": "info-circle", "chevron-down": "alt-arrow-down", "chevron-up": "alt-arrow-up",
  "chevron-left": "alt-arrow-left", "chevron-right": "alt-arrow-right", "pencil": "pen",
  "bar-chart3": "chart-2", "building2": "buildings-2", "check-circle2": "check-circle",
  "clock3": "clock-circle", "code2": "code", "edit2": "pen", "file-code2": "file-code",
  "film": "video-frame", "folder-git2": "folder", "hash": "hashtag", "link2": "link",
  "loader2": "refresh", "maximize2": "maximize", "mic-off": "microphone-slash",
  "minimize2": "minimize", "octagon-xicon": "close-circle", "settings2": "settings-minimalistic",
  "skip-back": "rewind-back", "skip-forward": "rewind-forward", "trash2": "trash-bin-trash",
  "xcircle": "close-circle", "xicon": "close-circle", "network": "globus",
};
const phosphorNames = {
  "layout-dashboard": "squares-four", "boxes": "cubes", "activity": "pulse", "gauge": "gauge",
  "network": "graph", "building-2": "buildings", "bot": "robot", "brain-circuit": "brain",
  "settings": "gear", "settings-2": "gear-six", "sliders-horizontal": "sliders-horizontal",
  "layers": "stack", "terminal-square": "terminal-window", "terminal-icon": "terminal",
  "file-code": "file-code", "file-code-2": "file-code", "file-edit": "file-text",
  "edit-2": "pencil", "clipboard-copy": "clipboard-text", "folder-tree": "folders",
  "folder-up": "folder-open", "folder-git-2": "folder", "git-fork": "git-fork",
  "help-circle": "question", "alert-circle": "warning-circle", "circle-alert": "warning-circle",
  "alert-triangle": "warning", "triangle-alert-icon": "warning", "check-circle-2": "check-circle",
  "circle-check-icon": "check-circle", "x-circle": "x-circle", "octagon-x-icon": "x-circle",
  "shield-alert": "shield-warning", "shield-check": "shield-check",
  "refresh-cw": "arrows-clockwise", "rotate-ccw": "arrow-counter-clockwise", "rotate-cw": "arrow-clockwise",
  "loader-2": "spinner", "loader-2-icon": "spinner", "more-horizontal": "dots-three",
  "more-vertical": "dots-three-vertical", "chevrons-up-down": "arrows-down-up", "arrow-up-down": "arrows-down-up",
  "bar-chart-3": "chart-bar", "qr-code": "qr-code", "mic": "microphone", "mic-off": "microphone-slash",
  "message-square": "chat-square", "mail-check": "envelope-simple", "log-in": "sign-in",
  "log-out": "sign-out", "user-plus": "user-plus", "user-minus": "user-minus",
  "battery-charging": "battery-charging", "corner-down-left": "arrow-elbow-down-left",
  "panel-left-open": "sidebar", "panel-left-close": "sidebar", "image": "image", "link-2": "link",
  "focus": "crosshair", "eye-off": "eye-slash", "external-link": "arrow-square-out",
  "maximize-2": "arrows-out", "minimize-2": "arrows-in", "upload-cloud": "cloud-arrow-up",
  "key-round": "key", "history": "clock-counter-clockwise", "workflow": "git-branch",
  "wand-2": "magic-wand", "sparkles": "sparkle", "zap": "lightning", "wifi": "wifi-high",
  "server": "hard-drives", "boxes": "cube", "menu": "list", "edit": "pencil",
  "send": "paper-plane-right", "search": "magnifying-glass", "filter": "funnel", "save": "floppy-disk",
  "undo2": "arrow-counter-clockwise", "memory-stick": "memory", "unplug": "plug",
  "blocks": "squares-four", "wand2": "magic-wand", "scroll-text": "file-text", "unlock": "lock-open",
  "mail": "envelope", "chevron-down": "caret-down", "chevron-up": "caret-up",
  "chevron-left": "caret-left", "chevron-right": "caret-right", "bar-chart3": "chart-bar",
  "building2": "buildings", "check-circle2": "check-circle", "clock3": "clock",
  "code2": "code", "edit2": "pencil", "file-code2": "file-code", "film": "film-strip",
  "folder-git2": "folder", "grip-vertical": "dots-six-vertical", "link2": "link",
  "loader2": "spinner", "maximize2": "arrows-out", "minimize2": "arrows-in",
  "octagon-xicon": "x-circle", "settings2": "gear-six", "smartphone": "device-mobile",
  "tablet": "device-tablet", "trash2": "trash", "xcircle": "x-circle", "xicon": "x",
};
const carbonNames = {
  "layout-dashboard": "dashboard", "boxes": "boxes", "gauge": "meter", "network": "network-4",
  "building-2": "building", "bot": "bot", "brain-circuit": "machine-learning",
  "terminal-square": "terminal", "terminal-icon": "terminal", "settings-2": "settings-adjust",
  "alert-circle": "warning", "circle-alert": "warning", "alert-triangle": "warning-alt",
  "check-circle": "checkmark-outline", "check-circle-2": "checkmark-outline",
  "x-circle": "close-outline", "shield-alert": "security", "shield-check": "security",
  "refresh-cw": "renew", "loader-2": "renew", "more-horizontal": "overflow-menu-horizontal",
  "more-vertical": "overflow-menu-vertical", "bar-chart-3": "chart-bar",
  "mic": "microphone", "mic-off": "microphone-off", "message-square": "chat",
  "hard-drive": "data-base", "server": "server-dns", "layers": "layers",
  "sparkles": "sparkle", "wand-2": "magic-wand", "wand2": "magic-wand",
  "panel-left-close": "side-panel-close", "panel-left-open": "side-panel-open",
  "log-out": "logout", "log-in": "login", "plus": "add", "trash-2": "trash-can",
  "clipboard": "copy-to-clipboard", "clipboard-copy": "copy-to-clipboard",
  "check": "checkmark", "check-icon": "checkmark", "check-square": "checkbox-checked",
  "eye": "view", "eye-off": "view-off", "external-link": "launch",
  "sliders-horizontal": "settings-adjust", "sliders": "settings-adjust", "undo2": "undo",
  "focus": "center-to-fit", "cpu": "chip", "database": "data-base",
  "memory-stick": "chip", "thermometer": "temperature", "columns": "column",
  "git-branch": "branch", "git-commit": "commit", "git-pull-request": "branch",
  "git-fork": "fork", "code-2": "code", "file-code": "document-code",
  "file-text": "document", "scroll-text": "document", "blocks": "application",
  "file-code": "repo-source-code", "file-code2": "repo-source-code", "sparkles": "magic-wand",
  "brain": "brainstorm", "clock": "time", "clock3": "time", "flame": "fire",
  "minus": "subtract", "lock": "locked", "unlock": "unlocked", "shield": "security",
  "users": "user-multiple", "user-plus": "user-follow", "user-check": "user-role",
  "mail": "email", "mail-check": "email-new", "bell": "notification",
  "help-circle": "help", "info": "information", "palette": "color-palette",
  "arrow-up-down": "arrows-vertical", "chevrons-up-down": "caret-sort",
  "corner-down-left": "arrow-down-left", "film": "video", "grip-vertical": "drag-vertical",
  "monitor": "screen", "octagon-xicon": "close-outline", "paperclip": "attachment",
  "smartphone": "mobile", "trash2": "trash-can", "workflow": "workflow-automation",
  "xcircle": "close-outline", "circle-check-icon": "checkmark-outline",
};
const iconoirNames = {
  "layout-dashboard": "dashboard", "boxes": "box-3d-center", "gauge": "dashboard-speed",
  "network": "network", "building-2": "city", "bot": "robot", "brain-circuit": "brain",
  "terminal-square": "terminal-tag", "terminal-icon": "terminal-tag", "settings-2": "settings",
  "alert-circle": "warning-circle", "circle-alert": "warning-circle", "alert-triangle": "warning-triangle",
  "check-circle": "check-circle", "check-circle-2": "check-circle", "x-circle": "cancel",
  "shield-alert": "shield-warning", "shield-check": "shield-check",
  "refresh-cw": "refresh-double", "loader-2": "refresh-double", "bar-chart-3": "stats-report",
  "mic": "microphone", "mic-off": "microphone-mute", "message-square": "chat-bubble",
  "hard-drive": "hard-drive", "layers": "stack", "sparkles": "spark",
  "panel-left-close": "sidebar-collapse", "panel-left-open": "sidebar-expand",
  "trash-2": "trash", "clipboard": "paste-clipboard", "clipboard-copy": "paste-clipboard",
  "external-link": "open-new-window", "more-horizontal": "more-horiz", "more-vertical": "more-vert",
  "sliders-horizontal": "control-slider", "sliders": "control-slider", "undo2": "undo",
  "focus": "scanning", "radio": "antenna-signal", "plug": "ev-plug", "unplug": "ev-plug-xmark",
  "power": "switch-on", "thermometer": "temperature-high", "columns": "view-columns-2",
  "code-2": "code", "folder-tree": "folder", "folder-up": "folder-plus",
  "file-code": "code-brackets-square", "file-code2": "code-brackets-square", "file-text": "page", "layers": "box-3d-center",
  "blocks": "box-3d-center", "bot": "cpu", "history": "clock-rotate-right",
  "flame": "fire-flame", "scroll-text": "page", "zap": "flash", "unlock": "lock-slash",
  "users": "group", "user-minus": "user-xmark", "user-check": "user-badge-check",
  "mail-check": "mail-open", "sun": "sun-light", "moon": "half-moon",
  "arrow-up-down": "arrow-union-vertical", "chevrons-up-down": "arrow-union-vertical",
  "chevron-down": "nav-arrow-down", "chevron-up": "nav-arrow-up",
  "chevron-left": "nav-arrow-left", "chevron-right": "nav-arrow-right",
  "minimize-2": "reduce", "pencil": "edit-pencil", "corner-down-left": "arrow-down-left",
  "edit2": "edit-pencil", "file-edit": "page-edit", "film": "video-camera",
  "grip-vertical": "drag", "image": "media-image", "info-icon": "info-circle", "monitor": "computer",
  "octagon-xicon": "cancel", "paperclip": "attachment", "skip-back": "skip-prev",
  "skip-forward": "skip-next", "smartphone": "smartphone-device", "tablet": "pen-tablet",
  "tag": "label", "target": "one-point-circle", "triangle-alert-icon": "warning-triangle",
  "xcircle": "cancel",
};
const fluentNames = {
  "layout-dashboard": "apps", "boxes": "cube", "activity": "pulse", "gauge": "gauge",
  "network": "globe", "building-2": "building", "bot": "bot", "brain-circuit": "brain-circuit",
  "terminal-square": "window-console", "terminal-icon": "window-console", "settings-2": "settings",
  "alert-circle": "error-circle", "circle-alert": "error-circle", "alert-triangle": "warning",
  "check-circle": "checkmark-circle", "check-circle-2": "checkmark-circle", "x-circle": "dismiss-circle",
  "shield-alert": "shield-error", "shield-check": "shield-checkmark",
  "refresh-cw": "arrow-clockwise", "loader-2": "arrow-clockwise", "more-horizontal": "more-horizontal",
  "more-vertical": "more-vertical", "bar-chart-3": "data-bar-vertical",
  "mic": "mic", "mic-off": "mic-off", "message-square": "chat",
  "hard-drive": "hard-drive", "layers": "layer", "sparkles": "sparkle",
  "panel-left-close": "panel-left-contract", "panel-left-open": "panel-left-expand",
  "log-in": "arrow-enter", "plus": "add", "trash-2": "delete", "download": "arrow-download",
  "x": "dismiss", "rotate-ccw": "arrow-rotate-counterclockwise",
  "external-link": "open", "sliders-horizontal": "options", "sliders": "options",
  "undo2": "arrow-undo", "focus": "scan", "cpu": "developer-board", "wifi": "wifi-4",
  "radio": "radio-button", "plug": "plug-connected", "unplug": "plug-disconnected",
  "thermometer": "temperature", "columns": "column", "git-branch": "branch",
  "git-commit": "branch", "git-pull-request": "branch-compare", "git-fork": "branch-fork",
  "code-2": "code", "folder-tree": "folder", "file-code": "clipboard-code", "file-code2": "clipboard-code",
  "blocks": "cube-multiple", "flame": "fire", "minus": "subtract", "zap": "flash",
  "users": "people", "user": "person", "user-plus": "person-add",
  "user-minus": "person-delete", "user-check": "person-available",
  "mail-check": "mail-checkmark", "bell": "alert", "sun": "weather-sunny",
  "moon": "weather-moon", "palette": "color",
  "arrow-up-down": "arrow-bidirectional-up-down", "chevrons-up-down": "arrow-sort",
  "check-square": "checkbox-checked", "corner-down-left": "arrow-enter-left",
  "film": "filmstrip", "grip-vertical": "re-order-dots-vertical",
  "hash": "number-symbol", "monitor": "desktop", "octagon-xicon": "dismiss-circle",
  "paperclip": "attach", "skip-back": "rewind", "skip-forward": "fast-forward",
  "smartphone": "phone", "trash2": "delete", "workflow": "flowchart",
  "xcircle": "dismiss-circle", "xicon": "dismiss", "circle-check-icon": "checkmark-circle",
};

function findIcon(catalog, slug, suffix, aliases) {
  const canonical = slug.replace(/-icon$/, "");
  const preferred = aliases[slug] || aliases[canonical] || slug;
  const numericSlug=slug.replace(/([a-z])([0-9])/g, "$1-$2");
  const candidates = [preferred, slug, numericSlug, slug.replace(/-?icon$/, ""), numericSlug.replace(/-?icon$/, "")];
  for (const candidate of candidates) {
    const icon = catalog.icons[`${candidate}-${suffix}`];
    if (icon) return { ...icon, width: icon.width || catalog.width, height: icon.height || catalog.height };
  }
  return null;
}

function findCatalogIcon(catalog, slug, aliases, suffixes = [""]) {
  const numeric = slug.replace(/([a-z])([0-9])/g, "$1-$2");
  const canonical = slug.replace(/-?icon$/, "");
  const numericCanonical = numeric.replace(/-?icon$/, "");
  const candidates = [...new Set([
    aliases[slug], aliases[canonical], aliases[numeric], aliases[numericCanonical],
    slug, canonical, numeric, numericCanonical,
    solarNames[slug], solarNames[numeric], phosphorNames[slug], phosphorNames[numeric],
  ].filter(Boolean))];
  for (const candidate of candidates) for (const suffix of suffixes) {
    const name = `${candidate}${suffix}`;
    let icon = catalog.icons[name];
    if (!icon && catalog.aliases?.[name]) icon = catalog.icons[catalog.aliases[name].parent];
    if (icon) return { ...icon, width: icon.width || catalog.width, height: icon.height || catalog.height };
  }
  return null;
}

const result = {};
const missing = { linear: [], duotone: [], filled: [], carbon: [], iconoir: [], fluent: [] };
for (const id of ids) {
  const line = findIcon(solar, id, "linear", solarNames) || findIcon(phosphor, id, "light", phosphorNames);
  const duo = findIcon(solar, id, "bold-duotone", solarNames) || findIcon(phosphor, id, "duotone", phosphorNames);
  const filled = findIcon(phosphor, id, "fill", phosphorNames) || findIcon(solar, id, "bold", solarNames);
  const carbonIcon = findCatalogIcon(carbon, id, carbonNames);
  const iconoirIcon = findCatalogIcon(iconoir, id, iconoirNames);
  const fluentIcon = findCatalogIcon(fluent, id, fluentNames, ["-24-filled", "-20-filled", "-28-filled"]);
  result[id] = {
    ...(line ? { minimal: { viewBox: `0 0 ${line.width} ${line.height}`, body: line.body } } : {}),
    ...(duo ? { duotone: { viewBox: `0 0 ${duo.width} ${duo.height}`, body: duo.body } } : {}),
    ...(filled ? { neon: { viewBox: `0 0 ${filled.width} ${filled.height}`, body: filled.body } } : {}),
    ...(carbonIcon ? { carbon: { viewBox: `0 0 ${carbonIcon.width} ${carbonIcon.height}`, body: carbonIcon.body } } : {}),
    ...(iconoirIcon ? { iconoir: { viewBox: `0 0 ${iconoirIcon.width} ${iconoirIcon.height}`, body: iconoirIcon.body } } : {}),
    ...(fluentIcon ? { fluent: { viewBox: `0 0 ${fluentIcon.width} ${fluentIcon.height}`, body: fluentIcon.body } } : {}),
  };
  if (!line) missing.linear.push(id);
  if (!duo) missing.duotone.push(id);
  if (!filled) missing.filled.push(id);
  if (!carbonIcon) missing.carbon.push(id);
  if (!iconoirIcon) missing.iconoir.push(id);
  if (!fluentIcon) missing.fluent.push(id);
}
const output = "// Generated by scripts/generate-icon-packs.mjs from Solar, Phosphor, Carbon, Iconoir and Fluent vector paths.\n" +
  "// Solar: CC BY 4.0. Phosphor, Iconoir and Fluent System Icons: MIT. Carbon: Apache 2.0.\n" +
  `export const VECTOR_PACKS: Record<string, Partial<Record<"minimal" | "duotone" | "neon" | "carbon" | "iconoir" | "fluent", { viewBox: string; body: string }>>> = ${JSON.stringify(result)};\n`;
writeFileSync(join(root, "src/lib/generated-icon-packs.ts"), output);
for (const pack of ["minimal", "duotone", "neon", "carbon", "iconoir", "fluent"]) {
  const vectors = Object.fromEntries(Object.entries(result).map(([id, packs]) => [id, packs[pack]]));
  writeFileSync(join(root, `src/lib/generated-icon-pack-${pack}.ts`),
    `// Generated by scripts/generate-icon-packs.mjs. Loaded only when this pack is selected.\nexport default ${JSON.stringify(vectors)} as Record<string, { viewBox: string; body: string }>;\n`);
}
console.log(`Generated ${ids.length} icons; coverage: ${Object.entries(missing).map(([style,names])=>`${style} ${ids.length-names.length}`).join(", ")}`);
for (const [style, names] of Object.entries(missing)) console.log(`${style} missing: ${names.join(", ")}`);
