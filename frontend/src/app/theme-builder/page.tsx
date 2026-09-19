"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  Code,
  Copy,
  Download,
  Eye,
  FileCode,
  FolderUp,
  Layers,
  LayoutDashboard,
  Palette,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Upload,
  UploadCloud,
  Zap,
  Trash2,
  Moon,
  Sun,
  ExternalLink,
  Plus,
  Sliders,
  CheckCircle2,
  AlertCircle,
  Wand2,
  ChevronRight,
  Monitor,
  CheckSquare,
  Flame,
  Activity,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useCustomThemes,
  PRESET_THEMES,
  exportThemeJson,
  validateAndParseThemeJson,
  type CustomThemeDefinition,
  type CustomThemeTokens,
} from "@/lib/custom-themes";
import { useUiTheme, type UiTheme } from "@/lib/ui-theme";
import { AppIcon } from "@/lib/custom-icons";
import { cn } from "@/lib/utils";

const RADIUS_OPTIONS = [
  { label: "Sharp (0px)", value: "0px" },
  { label: "Compact (4px)", value: "0.25rem" },
  { label: "Standard (6px)", value: "0.375rem" },
  { label: "Medium (8px)", value: "0.5rem" },
  { label: "Generous (10px)", value: "0.625rem" },
  { label: "Round (14px)", value: "0.875rem" },
];

const FONT_OPTIONS = [
  { label: "Plus Jakarta Sans (Default)", value: "var(--font-plus-jakarta), sans-serif" },
  { label: "JetBrains Mono (Monospace)", value: "var(--font-jetbrains-mono), monospace" },
  { label: "System UI (Apple / Fluent)", value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  { label: "Inter Clean Sans", value: "Inter, -apple-system, BlinkMacSystemFont, sans-serif" },
];

const COLOR_KEYS: { key: keyof CustomThemeTokens; label: string; desc: string }[] = [
  { key: "primary", label: "Primary (Brand Accent)", desc: "Main CTA buttons, active tabs, and focus rings" },
  { key: "primaryForeground", label: "Primary Foreground", desc: "Text and icon color on primary buttons" },
  { key: "background", label: "Canvas Background", desc: "Base viewport and page background" },
  { key: "foreground", label: "Text Foreground", desc: "Primary text and titles" },
  { key: "card", label: "Card / Surface", desc: "Cards, modals, tables, and raised containers" },
  { key: "cardForeground", label: "Card Text", desc: "Text inside card containers" },
  { key: "secondary", label: "Secondary / Subtle", desc: "Secondary buttons, subtle pill badges" },
  { key: "secondaryForeground", label: "Secondary Text", desc: "Text on secondary elements" },
  { key: "muted", label: "Muted Background", desc: "Disabled states, table headers, chip backgrounds" },
  { key: "mutedForeground", label: "Muted Text", desc: "Subtitles, secondary labels, and metadata" },
  { key: "accent", label: "Accent Highlight", desc: "Hover states, selection highlights, active chips" },
  { key: "accentForeground", label: "Accent Text", desc: "Text rendered over accent highlights" },
  { key: "destructive", label: "Destructive / Error", desc: "Error messages, delete buttons, critical alerts" },
  { key: "border", label: "Border & Divider", desc: "1px hairline borders for cards and tables" },
  { key: "input", label: "Input Border", desc: "Field outlines, input borders, control edges" },
  { key: "ring", label: "Focus Ring", desc: "Accessibility outline on active focus" },
];

export default function ThemeBuilderPage() {
  const [activeGlobalTheme, setGlobalTheme] = useUiTheme();
  const [customThemes, { saveTheme, deleteTheme, resetToPresets }] = useCustomThemes();

  // Selected or working draft theme
  const [draftTheme, setDraftTheme] = useState<CustomThemeDefinition>(() => {
    // If active global theme is in custom themes, start from it
    const found = customThemes.find((t) => t.id === activeGlobalTheme);
    return found || PRESET_THEMES[0];
  });

  const [jsonText, setJsonText] = useState<string>(() =>
    JSON.stringify(draftTheme, null, 2)
  );
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Editor modes & views
  const [activeTab, setActiveTab] = useState<"json" | "visual" | "css">("json");
  const [visualMode, setVisualMode] = useState<"dark" | "light">("dark");
  const [previewMode, setPreviewMode] = useState<"dark" | "light">("dark");

  // Modals
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [savedThemesDialogOpen, setSavedThemesDialogOpen] = useState(false);
  const [importJsonInput, setImportJsonInput] = useState("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Keep JSON text synced when draftTheme changes via visual editor or preset load
  const syncDraftToJson = (updated: CustomThemeDefinition) => {
    setDraftTheme(updated);
    setJsonText(JSON.stringify(updated, null, 2));
    setJsonError(null);
  };

  // Handle direct JSON typing
  const handleJsonChange = (val: string) => {
    setJsonText(val);
    const parsed = validateAndParseThemeJson(val);
    if (parsed.success && parsed.theme) {
      setDraftTheme(parsed.theme);
      setJsonError(null);
    } else {
      setJsonError(parsed.error || "Invalid JSON syntax");
    }
  };

  // Format / Prettify JSON
  const handleFormatJson = () => {
    try {
      const obj = JSON.parse(jsonText);
      setJsonText(JSON.stringify(obj, null, 2));
      toast.success("JSON formatted cleanly");
    } catch {
      toast.error("Cannot format invalid JSON. Please fix syntax errors first.");
    }
  };

  // Visual Palette updater
  const updateToken = (
    mode: "light" | "dark",
    tokenKey: keyof CustomThemeTokens,
    value: string
  ) => {
    const nextDraft: CustomThemeDefinition = {
      ...draftTheme,
      [mode]: {
        ...draftTheme[mode],
        [tokenKey]: value,
      },
    };
    syncDraftToJson(nextDraft);
  };

  // Metadata updater
  const updateMetadata = (field: keyof CustomThemeDefinition, value: any) => {
    const nextDraft: CustomThemeDefinition = {
      ...draftTheme,
      [field]: value,
    };
    syncDraftToJson(nextDraft);
  };

  // Apply Theme globally
  const handleApplyGlobal = () => {
    if (jsonError) {
      toast.error("Please resolve JSON syntax errors before applying the theme.");
      return;
    }
    saveTheme(draftTheme);
    setGlobalTheme(draftTheme.id as UiTheme);
    toast.success(`Theme "${draftTheme.name}" is now active globally across StackPilot!`);
  };

  // Download JSON Config
  const handleDownload = () => {
    if (jsonError) {
      toast.error("Cannot export invalid JSON. Please fix syntax errors first.");
      return;
    }
    exportThemeJson(draftTheme);
    toast.success(`Exported ${draftTheme.id}.json`);
  };

  // Copy JSON to clipboard
  const handleCopyJson = () => {
    navigator.clipboard.writeText(jsonText);
    toast.success("Theme JSON configuration copied to clipboard!");
  };

  // Load a Preset
  const handleLoadPreset = (preset: CustomThemeDefinition) => {
    syncDraftToJson(preset);
    setPresetDialogOpen(false);
    toast.success(`Loaded preset: ${preset.name}`);
  };

  // Import JSON File
  const handleProcessImport = (content: string) => {
    const result = validateAndParseThemeJson(content);
    if (!result.success || !result.theme) {
      toast.error(result.error || "Failed to parse theme configuration file.");
      return;
    }
    syncDraftToJson(result.theme);
    setImportDialogOpen(false);
    setImportJsonInput("");
    toast.success(`Successfully imported "${result.theme.name}"!`);
  };

  const handleFileUpload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".json") && file.type !== "application/json") {
      toast.error("Please upload a .json configuration file.");
      return;
    }
    try {
      const text = await file.text();
      handleProcessImport(text);
    } catch {
      toast.error("Failed to read file.");
    }
  };

  // Compute live CSS variables for the sandbox preview
  const sandboxTokens = previewMode === "dark" ? draftTheme.dark : draftTheme.light;
  const sandboxStyle = useMemo(() => {
    return {
      "--radius": draftTheme.radius || "0.5rem",
      "--app-font-sans": draftTheme.fontFamily || "inherit",
      "--background": sandboxTokens.background,
      "--foreground": sandboxTokens.foreground,
      "--card": sandboxTokens.card,
      "--card-foreground": sandboxTokens.cardForeground,
      "--popover": sandboxTokens.popover,
      "--popover-foreground": sandboxTokens.popoverForeground,
      "--primary": sandboxTokens.primary,
      "--primary-foreground": sandboxTokens.primaryForeground,
      "--secondary": sandboxTokens.secondary,
      "--secondary-foreground": sandboxTokens.secondaryForeground,
      "--muted": sandboxTokens.muted,
      "--muted-foreground": sandboxTokens.mutedForeground,
      "--accent": sandboxTokens.accent,
      "--accent-foreground": sandboxTokens.accentForeground,
      "--destructive": sandboxTokens.destructive,
      "--border": sandboxTokens.border,
      "--input": sandboxTokens.input,
      "--ring": sandboxTokens.ring,
    } as React.CSSProperties;
  }, [draftTheme, previewMode, sandboxTokens]);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header Bar */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-md px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard/settings"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Settings</span>
            </Link>
            <span className="text-muted-foreground/50">/</span>
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Palette className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-sm font-semibold sm:text-base flex items-center gap-2">
                  <span>Theme Studio & Builder</span>
                  <Badge variant="outline" className="text-[10px] py-0 px-1.5 h-4 font-mono">
                    JSON v1
                  </Badge>
                </h1>
              </div>
            </div>
          </div>

          {/* Action Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPresetDialogOpen(true)}
              className="gap-1.5 text-xs h-8"
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span>Presets</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setSavedThemesDialogOpen(true)}
              className="gap-1.5 text-xs h-8"
            >
              <Layers className="h-3.5 w-3.5" />
              <span>My Themes ({customThemes.length})</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setImportDialogOpen(true)}
              className="gap-1.5 text-xs h-8"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>Import</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleDownload}
              className="gap-1.5 text-xs h-8"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export</span>
            </Button>

            <Button
              size="sm"
              onClick={handleApplyGlobal}
              className="gap-1.5 text-xs h-8 shadow-sm font-medium"
            >
              <Check className="h-3.5 w-3.5" />
              <span>Apply to App</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Main Split-Screen Workspace */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
        {/* Left Column: Editor (JSON & Visual) */}
        <div className="lg:col-span-6 border-b lg:border-b-0 lg:border-r border-border/70 flex flex-col bg-card/40">
          <div className="border-b border-border/70 px-4 py-2.5 flex items-center justify-between bg-muted/20">
            <div className="flex items-center gap-2">
              <Tabs
                value={activeTab}
                onValueChange={(v) => setActiveTab(v as any)}
                className="w-auto"
              >
                <TabsList className="h-8 p-0.5 bg-muted/60">
                  <TabsTrigger value="json" className="text-xs px-3 h-7 gap-1.5">
                    <Code className="h-3.5 w-3.5" />
                    <span>JSON Editor</span>
                  </TabsTrigger>
                  <TabsTrigger value="visual" className="text-xs px-3 h-7 gap-1.5">
                    <Sliders className="h-3.5 w-3.5" />
                    <span>Visual Palette</span>
                  </TabsTrigger>
                  <TabsTrigger value="css" className="text-xs px-3 h-7 gap-1.5">
                    <FileCode className="h-3.5 w-3.5" />
                    <span>Custom CSS</span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* Quick Editor Actions */}
            <div className="flex items-center gap-1.5">
              {activeTab === "json" && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleFormatJson}
                    className="h-7 text-xs px-2 gap-1"
                    title="Format / Prettify JSON"
                  >
                    <Wand2 className="h-3 w-3" />
                    <span className="hidden sm:inline">Prettify</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyJson}
                    className="h-7 text-xs px-2 gap-1"
                    title="Copy JSON to Clipboard"
                  >
                    <Copy className="h-3 w-3" />
                    <span className="hidden sm:inline">Copy</span>
                  </Button>
                </>
              )}

              {jsonError ? (
                <Badge variant="destructive" className="text-[10px] gap-1 px-1.5 h-6">
                  <AlertCircle className="h-3 w-3" />
                  <span>Invalid JSON</span>
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px] gap-1 px-1.5 h-6 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800">
                  <CheckCircle2 className="h-3 w-3" />
                  <span>Schema Valid</span>
                </Badge>
              )}
            </div>
          </div>

          {/* Validation Alert if JSON syntax error */}
          {jsonError && (
            <div className="bg-destructive/10 border-b border-destructive/20 px-4 py-2 text-xs text-destructive flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span className="font-mono text-[11px]">{jsonError}</span>
              </div>
            </div>
          )}

          {/* TAB 1: JSON Code Editor */}
          {activeTab === "json" && (
            <div className="flex-1 flex flex-col p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <span>Configuration File:</span>
                  <span className="font-mono font-medium text-foreground">{draftTheme.id}.json</span>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Changes compile to live preview in real-time
                </div>
              </div>

              <textarea
                value={jsonText}
                onChange={(e) => handleJsonChange(e.target.value)}
                spellCheck={false}
                className={cn(
                  "flex-1 w-full font-mono text-xs p-4 rounded-xl border bg-background/90 text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/40 leading-relaxed",
                  jsonError ? "border-destructive/60" : "border-border/80"
                )}
                placeholder="Paste or write theme JSON configuration here..."
              />
            </div>
          )}

          {/* TAB 2: Visual Designer */}
          {activeTab === "visual" && (
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {/* Metadata Configuration */}
              <div className="space-y-4 rounded-xl border border-border/70 p-4 bg-muted/10">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Theme Properties
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Theme Name</Label>
                    <Input
                      value={draftTheme.name}
                      onChange={(e) => updateMetadata("name", e.target.value)}
                      placeholder="e.g. Cyberpunk Neon"
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Theme ID (slug)</Label>
                    <Input
                      value={draftTheme.id}
                      onChange={(e) => updateMetadata("id", e.target.value)}
                      placeholder="custom-theme-id"
                      className="h-8 text-xs font-mono"
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label className="text-xs">Description</Label>
                    <Input
                      value={draftTheme.description}
                      onChange={(e) => updateMetadata("description", e.target.value)}
                      placeholder="Theme description and aesthetic style"
                      className="h-8 text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border/40">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Corner Radius</Label>
                    <select
                      value={draftTheme.radius}
                      onChange={(e) => updateMetadata("radius", e.target.value)}
                      className="w-full h-8 text-xs rounded-md border border-input bg-background px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {RADIUS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Typography</Label>
                    <select
                      value={draftTheme.fontFamily || FONT_OPTIONS[0].value}
                      onChange={(e) => updateMetadata("fontFamily", e.target.value)}
                      className="w-full h-8 text-xs rounded-md border border-input bg-background px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {FONT_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Palette Token Pickers */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Color Palette Tokens
                  </h3>
                  <div className="flex items-center rounded-lg border border-border/70 p-0.5 bg-muted/40">
                    <button
                      type="button"
                      onClick={() => setVisualMode("dark")}
                      className={cn(
                        "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md font-medium transition-colors",
                        visualMode === "dark"
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <Moon className="h-3 w-3" />
                      <span>Dark Mode</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setVisualMode("light")}
                      className={cn(
                        "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md font-medium transition-colors",
                        visualMode === "light"
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <Sun className="h-3 w-3" />
                      <span>Light Mode</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {COLOR_KEYS.map(({ key, label, desc }) => {
                    const currentColor = draftTheme[visualMode][key] || "#000000";
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between gap-3 p-2.5 rounded-lg border border-border/60 bg-background/60 hover:bg-muted/30 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-foreground truncate">{label}</div>
                          <div className="text-[10px] text-muted-foreground truncate">{desc}</div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {/* Native color picker square */}
                          <div className="relative h-7 w-7 rounded-md border border-border overflow-hidden shadow-xs shrink-0 cursor-pointer">
                            <input
                              type="color"
                              value={currentColor.startsWith("#") ? currentColor : "#3e63dd"}
                              onChange={(e) => updateToken(visualMode, key, e.target.value)}
                              className="absolute -top-2 -left-2 w-12 h-12 cursor-pointer opacity-0"
                            />
                            <div
                              className="w-full h-full"
                              style={{ backgroundColor: currentColor }}
                            />
                          </div>

                          {/* Raw text input for hex / oklch */}
                          <input
                            type="text"
                            value={currentColor}
                            onChange={(e) => updateToken(visualMode, key, e.target.value)}
                            className="w-20 h-7 text-xs font-mono px-1.5 rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Custom CSS */}
          {activeTab === "css" && (
            <div className="flex-1 flex flex-col p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-muted-foreground">
                  Optional custom CSS rules appended to this theme:
                </div>
                <Badge variant="outline" className="text-[10px]">
                  Scoped to [data-ui-theme="{draftTheme.id}"]
                </Badge>
              </div>

              <textarea
                value={draftTheme.customCss || ""}
                onChange={(e) => updateMetadata("customCss", e.target.value)}
                spellCheck={false}
                className="flex-1 w-full font-mono text-xs p-4 rounded-xl border border-border/80 bg-background/90 text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/40 leading-relaxed"
                placeholder={`/* Example custom CSS */\n[data-ui-theme="${draftTheme.id}"] [data-slot="card"] {\n  backdrop-filter: blur(12px);\n}`}
              />
            </div>
          )}
        </div>

        {/* Right Column: Live Interactive Sandbox */}
        <div className="lg:col-span-6 flex flex-col bg-muted/10 overflow-y-auto">
          {/* Sandbox Controls Bar */}
          <div className="border-b border-border/70 px-4 py-2.5 flex items-center justify-between bg-muted/20">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5 text-primary" />
                <span>Live Component Sandbox</span>
              </span>
              <Badge variant="outline" className="text-[10px] h-5 font-mono">
                {previewMode.toUpperCase()}
              </Badge>
            </div>

            {/* Light / Dark Preview Switcher */}
            <div className="flex items-center rounded-lg border border-border/70 p-0.5 bg-background shadow-2xs">
              <button
                type="button"
                onClick={() => setPreviewMode("dark")}
                className={cn(
                  "flex items-center gap-1 px-2.5 py-1 text-xs rounded-md font-medium transition-colors",
                  previewMode === "dark"
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Moon className="h-3 w-3" />
                <span>Dark</span>
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode("light")}
                className={cn(
                  "flex items-center gap-1 px-2.5 py-1 text-xs rounded-md font-medium transition-colors",
                  previewMode === "light"
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Sun className="h-3 w-3" />
                <span>Light</span>
              </button>
            </div>
          </div>

          {/* Sandbox Showcase Canvas */}
          <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
            {/* Scoped Island styled with the draft theme tokens */}
            <div
              style={sandboxStyle}
              className={cn(
                "p-5 sm:p-6 rounded-2xl border shadow-lg space-y-6 transition-all",
                previewMode === "dark" ? "dark bg-background text-foreground" : "bg-background text-foreground"
              )}
            >
              {/* Sandbox Header Element */}
              <div className="flex items-center justify-between pb-4 border-b border-border">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-xl bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm shadow-sm">
                    SP
                  </div>
                  <div>
                    <div className="text-sm font-semibold tracking-tight">{draftTheme.name}</div>
                    <div className="text-xs text-muted-foreground">{draftTheme.description}</div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Badge className="bg-primary text-primary-foreground text-[10px]">
                    Draft Mode
                  </Badge>
                  <Button size="sm" variant="outline" className="h-7 text-xs">
                    Telemetry
                  </Button>
                </div>
              </div>

              {/* 1. Metric / Telemetry KPI Cards */}
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">
                  KPI & Analytics Cards
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="p-3.5 rounded-xl border border-border bg-card text-card-foreground shadow-xs">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>API Latency</span>
                      <Activity className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="mt-1 text-xl font-bold font-mono">24.6 ms</div>
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald-500 font-medium">
                      <span>↑ 12% faster</span>
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl border border-border bg-card text-card-foreground shadow-xs">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Test Pass Rate</span>
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    </div>
                    <div className="mt-1 text-xl font-bold font-mono">99.8%</div>
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span>1,420 tests passed</span>
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl border border-border bg-card text-card-foreground shadow-xs">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Active Nodes</span>
                      <Zap className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="mt-1 text-xl font-bold font-mono">48 / 48</div>
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-primary font-medium">
                      <span>100% capacity</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* 2. Interactive Buttons */}
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">
                  Action Buttons & States
                </div>
                <div className="flex flex-wrap gap-2.5 items-center">
                  <Button size="sm" className="bg-primary text-primary-foreground hover:opacity-90">
                    Primary Button
                  </Button>
                  <Button size="sm" variant="secondary">
                    Secondary
                  </Button>
                  <Button size="sm" variant="outline">
                    Outline
                  </Button>
                  <Button size="sm" variant="ghost">
                    Ghost
                  </Button>
                  <Button size="sm" variant="destructive">
                    Destructive
                  </Button>
                  <Button size="sm" disabled>
                    Disabled
                  </Button>
                </div>
              </div>

              {/* 3. Form Controls & Inputs */}
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">
                  Form Controls & Inputs
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Deployment Endpoint</Label>
                    <Input
                      defaultValue="https://api.stackpilot.dev/v1/sessions"
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Environment Cluster</Label>
                    <select className="w-full h-8 text-xs rounded-md border border-input bg-background px-2.5 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
                      <option>Production (us-east-1)</option>
                      <option>Staging (eu-central-1)</option>
                      <option>Local Edge Runner</option>
                    </select>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label className="text-xs">Agent Instructions / Prompt</Label>
                    <textarea
                      rows={2}
                      defaultValue="Navigate to /checkout, add item to cart, verify payment modal opens."
                      className="w-full text-xs p-2.5 rounded-md border border-input bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                    />
                  </div>
                </div>
              </div>

              {/* 4. Badges & Status Indicators */}
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">
                  Badges & Status Chips
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <Badge className="bg-primary text-primary-foreground">Primary</Badge>
                  <Badge variant="secondary">Secondary</Badge>
                  <Badge variant="outline">Outline</Badge>
                  <Badge variant="destructive">Destructive</Badge>
                  <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
                    Live Stream 60 FPS
                  </Badge>
                  <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30">
                    Warning (Quiescence)
                  </Badge>
                </div>
              </div>

              {/* 5. Surface & Elevation Box */}
              <div className="p-4 rounded-xl border border-border bg-card text-card-foreground shadow-md space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-xs flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-primary" />
                    <span>Scaffold Terminal Session</span>
                  </div>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    bash 5.2
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Container successfully provisioned with headless Chromium CDP screencast bridge.
                </p>
                <div className="p-2 rounded-lg bg-muted text-muted-foreground font-mono text-[11px]">
                  $ stackpilot run --spec=e2e --stream=instant
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Preset Library Dialog */}
      <Dialog open={presetDialogOpen} onOpenChange={setPresetDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" />
              <span>Theme Preset Starters</span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              Select a professionally crafted base theme to fork and customize.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-3">
            {PRESET_THEMES.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleLoadPreset(preset)}
                className="group flex flex-col gap-2.5 rounded-xl border border-border p-3.5 text-left hover:border-primary/50 hover:bg-muted/30 transition-all cursor-pointer"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-xs text-foreground group-hover:text-primary transition-colors">
                    {preset.name}
                  </span>
                  <Badge variant="secondary" className="text-[10px] h-4 px-1">
                    {preset.radius}
                  </Badge>
                </div>

                {/* Swatches strip */}
                <div className="flex h-12 w-full overflow-hidden rounded-lg border border-border/80">
                  <span
                    className="w-1/3 flex items-center justify-center text-[9px] font-mono"
                    style={{ backgroundColor: preset.dark.background, color: preset.dark.foreground }}
                  >
                    BG
                  </span>
                  <span
                    className="w-1/3 flex items-center justify-center text-[9px] font-mono"
                    style={{ backgroundColor: preset.dark.card, color: preset.dark.cardForeground }}
                  >
                    Card
                  </span>
                  <span
                    className="w-1/3 flex items-center justify-center text-[9px] font-mono font-bold"
                    style={{ backgroundColor: preset.dark.primary, color: preset.dark.primaryForeground }}
                  >
                    Accent
                  </span>
                </div>

                <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">
                  {preset.description}
                </p>
              </button>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPresetDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Upload className="h-4 w-4 text-primary" />
              <span>Import Theme Configuration</span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              Upload a <code className="font-mono text-primary">.json</code> theme file or paste raw JSON code.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Drag and drop zone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingFile(true);
              }}
              onDragLeave={() => setIsDraggingFile(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDraggingFile(false);
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                  handleFileUpload(e.dataTransfer.files[0]);
                }
              }}
              className={cn(
                "border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer flex flex-col items-center justify-center gap-2",
                isDraggingFile
                  ? "border-primary bg-primary/10"
                  : "border-border/80 hover:border-primary/50 hover:bg-muted/20"
              )}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    handleFileUpload(e.target.files[0]);
                  }
                }}
              />
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                <UploadCloud className="h-5 w-5" />
              </div>
              <div>
                <div className="text-xs font-semibold text-foreground">
                  Drop your theme .json file here
                </div>
                <div className="text-[11px] text-muted-foreground">or click to browse files</div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Or paste JSON directly:</Label>
              <textarea
                value={importJsonInput}
                onChange={(e) => setImportJsonInput(e.target.value)}
                rows={5}
                placeholder={`{\n  "id": "my-theme",\n  "name": "My Theme",\n  "light": { ... },\n  "dark": { ... }\n}`}
                className="w-full font-mono text-xs p-3 rounded-lg border border-input bg-background text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!importJsonInput.trim()}
              onClick={() => handleProcessImport(importJsonInput)}
            >
              Load Theme
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Saved Themes Dialog */}
      <Dialog open={savedThemesDialogOpen} onOpenChange={setSavedThemesDialogOpen}>
        <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Layers className="h-4 w-4 text-primary" />
              <span>My Saved Themes</span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              Themes stored in your browser and synced across tabs.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2.5 py-2">
            {customThemes.map((theme) => {
              const isSelected = draftTheme.id === theme.id;
              const isGloballyActive = activeGlobalTheme === theme.id;
              return (
                <div
                  key={theme.id}
                  className={cn(
                    "flex items-center justify-between gap-3 p-3 rounded-xl border transition-all",
                    isSelected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/20"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-xs text-foreground truncate">
                        {theme.name}
                      </span>
                      {isGloballyActive && (
                        <Badge className="text-[10px] h-4 px-1.5 bg-emerald-500">Active App</Badge>
                      )}
                      <span className="font-mono text-[10px] text-muted-foreground">{theme.id}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                      {theme.description}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs px-2"
                      onClick={() => {
                        syncDraftToJson(theme);
                        setSavedThemesDialogOpen(false);
                        toast.success(`Loaded "${theme.name}" into editor`);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => exportThemeJson(theme)}
                      title="Download JSON"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      onClick={() => {
                        deleteTheme(theme.id);
                        toast.success(`Deleted "${theme.name}"`);
                      }}
                      title="Delete Theme"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={resetToPresets}
              className="text-xs text-muted-foreground"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset to Stock Presets
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSavedThemesDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
