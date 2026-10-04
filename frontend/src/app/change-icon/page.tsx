"use client";

import { useState, useMemo, useRef } from "react";
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
  Search,
  Sparkles,
  Upload,
  UploadCloud,
  Zap,
} from "@/lib/platform-icons";
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
import {
  AppIcon,
  ICON_DEFINITIONS,
  ICON_MAP,
  adaptSvgColors,
  useIconSettings,
  type IconDefinition,
  type IconMode,
  type IconPack,
  type IconCategory,
} from "@/lib/custom-icons";
import { cn } from "@/lib/utils";
import { sanitizeIconSvg } from "@/lib/svg-safety";

const CATEGORIES: { id: string; label: string }[] = [
  { id: "all", label: "All Icons" },
  { id: "navigation", label: "Navigation" },
  { id: "actions", label: "Actions" },
  { id: "infrastructure", label: "Infrastructure" },
  { id: "devops", label: "DevOps & Cloud" },
  { id: "ai", label: "AI & Copilot" },
  { id: "observability", label: "Observability" },
  { id: "status", label: "Status & Health" },
  { id: "security", label: "Security" },
  { id: "team", label: "Team" },
  { id: "theme", label: "Themes" },
  { id: "arrows", label: "Arrows & Nav" },
];

const PACK_OPTIONS: { id: IconPack; label: string; description: string; badge: string }[] = [
  {
    id: "minimal",
    label: "Solar Linear",
    description: "Quiet, thin outline icons like the reference sidebar.",
    badge: "Recommended",
  },
  {
    id: "duotone",
    label: "Solar Bold Duotone",
    description: "Layered shapes with restrained translucent fills.",
    badge: "Layered",
  },
  {
    id: "neon",
    label: "Phosphor Filled",
    description: "Solid interface glyphs with strong contrast at small sizes.",
    badge: "Solid",
  },
  {
    id: "carbon",
    label: "Carbon Design",
    description: "Precise, structured IBM interface line icons.",
    badge: "Structured",
  },
  {
    id: "iconoir",
    label: "Iconoir",
    description: "Light editorial outlines with open geometry.",
    badge: "Airy",
  },
  {
    id: "fluent",
    label: "Fluent Filled",
    description: "Friendly, compact solid icons from Microsoft.",
    badge: "Friendly",
  },
];

const sanitizeSvg = sanitizeIconSvg;

export default function ChangeIconPage() {
  const [settings, actions] = useIconSettings();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [editingIcon, setEditingIcon] = useState<IconDefinition | null>(null);
  const [customSvgInput, setCustomSvgInput] = useState<string>("");
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importJsonInput, setImportJsonInput] = useState("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  const modalFileInputRef = useRef<HTMLInputElement | null>(null);
  const batchFileInputRef = useRef<HTMLInputElement | null>(null);
  const cardFileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const filteredIcons = useMemo(() => {
    return ICON_DEFINITIONS.filter((icon) => {
      const matchesCategory = selectedCategory === "all" || icon.category === selectedCategory;
      const matchesSearch =
        icon.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        icon.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        icon.description.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [searchQuery, selectedCategory]);

  // Counts of customized vs default icons
  const stats = useMemo(() => {
    let customCount = 0;
    let defaultCount = 0;
    ICON_DEFINITIONS.forEach((icon) => {
      const hasOverride = Boolean(settings.overrides[icon.id]);
      const individualMode = settings.iconModes?.[icon.id];
      const isCustom = settings.mode === "custom"
        ? individualMode !== "default"
        : (individualMode === "custom");
      if (isCustom) {
        customCount++;
      } else {
        defaultCount++;
      }
    });
    return {
      total: ICON_DEFINITIONS.length,
      custom: customCount,
      default: defaultCount,
      overrides: Object.keys(settings.overrides).filter((k) => k !== "__icon_modes__").length,
    };
  }, [settings]);

  const openEditModal = (icon: IconDefinition) => {
    setEditingIcon(icon);
    setCustomSvgInput(settings.overrides[icon.id] || "");
  };

  const handleSaveSvg = () => {
    if (!editingIcon) return;
    if (!customSvgInput.trim()) {
      actions.resetIcon(editingIcon.id);
      toast.success(`Reset ${editingIcon.name} to default vector`);
      setEditingIcon(null);
      return;
    }

    const sanitized = sanitizeSvg(customSvgInput);
    if (!sanitized.includes("<svg") || !sanitized.includes("</svg>")) {
      toast.error("Invalid SVG code. Please provide valid SVG markup starting with <svg> and ending with </svg>.");
      return;
    }

    actions.setOverride(editingIcon.id, sanitized);
    toast.success(`Custom SVG applied to ${editingIcon.name}`);
    setEditingIcon(null);
  };

  const processUploadedSvgFile = async (file: File, targetIconId?: string) => {
    if (!file.name.toLowerCase().endsWith(".svg") && file.type !== "image/svg+xml") {
      toast.error(`"${file.name}" is not an SVG file.`);
      return;
    }

    try {
      const text = await file.text();
      const sanitized = sanitizeSvg(text);

      if (!sanitized.includes("<svg") || !sanitized.includes("</svg>")) {
        toast.error(`"${file.name}" does not contain valid SVG markup.`);
        return;
      }

      const iconId = targetIconId || editingIcon?.id;
      if (iconId) {
        setCustomSvgInput(sanitized);
        if (targetIconId) actions.setOverride(iconId, sanitized);
        const iconDef = ICON_MAP.get(iconId);
        toast.success(targetIconId ? `Custom SVG applied to ${iconDef?.name || iconId}` : "SVG ready to preview");
      }
    } catch {
      toast.error(`Failed to read "${file.name}".`);
    }
  };

  const handleBatchFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    let successCount = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const baseName = file.name.replace(/\.svg$/i, "").toLowerCase();

      // Find matching icon definition by ID or keyword
      const matched = ICON_DEFINITIONS.find(
        (def) =>
          def.id.toLowerCase() === baseName ||
          def.name.toLowerCase().replace(/[^a-z0-9]/g, "") === baseName.replace(/[^a-z0-9]/g, "")
      );

      if (matched) {
        try {
          const text = await file.text();
          const sanitized = sanitizeSvg(text);
          if (sanitized.includes("<svg") && sanitized.includes("</svg>")) {
            actions.setOverride(matched.id, sanitized);
            successCount++;
          }
        } catch {
          // ignore error and continue
        }
      }
    }

    if (successCount > 0) {
      toast.success(`Batch updated ${successCount} icon(s) from uploaded SVG files!`);
    } else {
      toast.info("No matching icon names found. Name SVG files matching icon IDs (e.g., layout-dashboard.svg, server.svg).");
    }
  };

  const handleExport = () => {
    const jsonStr = JSON.stringify(settings, null, 2);
    navigator.clipboard.writeText(jsonStr);
    toast.success("Icon configuration copied to clipboard!");
  };

  const handleImport = () => {
    try {
      const parsed = JSON.parse(importJsonInput);
      if (typeof parsed !== "object" || !parsed) {
        throw new Error("Invalid format");
      }
      if (parsed.mode) actions.setMode(parsed.mode);
      if (parsed.pack) actions.setPack(parsed.pack);
      if (parsed.iconModes && typeof parsed.iconModes === "object") {
        Object.entries(parsed.iconModes).forEach(([id, mode]) => {
          if (mode === "default" || mode === "custom") {
            actions.setIconMode(id, mode);
          }
        });
      }
      if (parsed.overrides && typeof parsed.overrides === "object") {
        Object.entries(parsed.overrides).forEach(([id, svg]) => {
          if (id !== "__icon_modes__") {
            actions.setOverride(id, String(svg));
          }
        });
      }
      toast.success("Icon configuration imported successfully!");
      setImportDialogOpen(false);
    } catch {
      toast.error("Failed to parse icon configuration JSON.");
    }
  };

  return (
    <div data-mobile-surface className="min-h-screen min-w-0 bg-background text-foreground">
      {/* Hidden batch file input */}
      <input
        ref={batchFileInputRef}
        type="file"
        accept=".svg,image/svg+xml"
        multiple
        className="hidden"
        onChange={(e) => {
          handleBatchFileUpload(e.target.files);
          e.target.value = "";
        }}
      />

      {/* Top Banner & Navigation */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur px-3 py-3 sm:px-6 sm:py-4">
        <div className="mx-auto flex min-w-0 max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm" className="gap-2">
                <AppIcon name="arrow-left" fallback={ArrowLeft} className="h-4 w-4" />
                <span>Dashboard</span>
              </Button>
            </Link>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <AppIcon name="sparkles" fallback={Sparkles} className="h-3.5 w-3.5" />
              </div>
              <h1 className="text-sm font-semibold tracking-tight">Platform Icon Studio</h1>
            </div>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => batchFileInputRef.current?.click()}
              className="gap-1.5 text-xs border-primary/40 hover:bg-primary/10 text-foreground"
            >
              <AppIcon name="folder-up" fallback={FolderUp} className="h-3.5 w-3.5 text-primary" />
              <span>Batch Upload SVGs</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setExportDialogOpen(true)} className="gap-1.5 text-xs">
              <AppIcon name="download" fallback={Download} className="h-3.5 w-3.5" />
              <span>Export</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)} className="gap-1.5 text-xs">
              <AppIcon name="upload" fallback={Upload} className="h-3.5 w-3.5" />
              <span>Import</span>
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                actions.resetAll();
                toast.success("All icons restored to defaults");
              }}
              className="gap-1.5 text-xs"
            >
              <AppIcon name="rotate-ccw" fallback={RotateCcw} className="h-3.5 w-3.5" />
              <span>Reset All</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto min-w-0 max-w-7xl space-y-4 p-3 sm:space-y-6 sm:p-6">
        {/* Global Master Switch Card */}
        <Card className="border-primary/20 bg-card shadow-sm">
          <CardHeader className="p-4 sm:p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <span>Icon Customization System</span>
                  <Badge variant="outline" className="text-xs font-mono font-normal">
                    {stats.total} Platform Icons
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs mt-1">
                  Individually toggle any icon between default Lucide and custom vector, or upload custom SVGs. Changes apply instantly across the entire platform.
                </CardDescription>
              </div>

              {/* Master Actions & Quick Toggles */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    actions.setAllIconModes("default");
                    toast.success("All platform icons switched to Default Lucide");
                  }}
                  className="text-xs h-8 gap-1.5"
                >
                  <AppIcon name="layout-dashboard" size={14} />
                  <span>Set All Default</span>
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => {
                    actions.setAllIconModes("custom");
                    toast.success("All platform icons switched to Custom Vectors");
                  }}
                  className="text-xs h-8 gap-1.5"
                >
                  <AppIcon name="sparkles" fallback={Sparkles} size={14} />
                  <span>Set All Custom</span>
                </Button>
                <div className="h-4 w-px bg-border hidden sm:block" />
                <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 px-3 py-1.5 rounded-lg border border-border/70">
                  <span className="flex items-center gap-1 font-medium text-foreground">
                    <span className="h-2 w-2 rounded-full bg-primary inline-block" />
                    {stats.custom} Custom
                  </span>
                  <span>•</span>
                  <span>{stats.default} Default</span>
                  {stats.overrides > 0 && (
                    <>
                      <span>•</span>
                      <span className="text-emerald-500 font-medium">{stats.overrides} SVGs</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardHeader>

          {/* Global Mode & Vector Pack Selection */}
          <CardContent className="border-t border-border/50 p-4 sm:p-5 pt-4 space-y-5">
            {/* Global Icon Mode Toggle: Default vs Custom */}
            <div className="space-y-2.5">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Active Platform Icon Mode
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => {
                    actions.setMode("default");
                    toast.success("All platform icons switched to Default Lucide");
                  }}
                  className={cn(
                    "flex flex-col gap-2 rounded-xl border p-4 text-left transition-all",
                    settings.mode === "default"
                      ? "border-primary bg-accent/40 ring-2 ring-primary/30"
                      : "border-border hover:border-primary/40 hover:bg-accent/20"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm">Default Icons</span>
                    {settings.mode === "default" && (
                      <Badge variant="secondary" className="text-[10px]">Active</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">Standard clean Lucide stroke icons across the entire platform.</p>
                  <div className="mt-1 flex items-center gap-3 text-foreground">
                    <AppIcon name="layout-dashboard" size={18} forceMode="default" />
                    <AppIcon name="server" size={18} forceMode="default" />
                    <AppIcon name="activity" size={18} forceMode="default" />
                    <AppIcon name="star" size={18} forceMode="default" />
                    <AppIcon name="settings" size={18} forceMode="default" />
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    actions.setMode("custom");
                    toast.success("All platform icons switched to Custom Vectors");
                  }}
                  className={cn(
                    "flex flex-col gap-2 rounded-xl border p-4 text-left transition-all",
                    settings.mode === "custom"
                      ? "border-primary bg-primary/10 ring-2 ring-primary/30"
                      : "border-border hover:border-primary/40 hover:bg-accent/20"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm flex items-center gap-1.5">
                      <span>Custom Icons</span>
                      <AppIcon name="sparkles" fallback={Sparkles} className="h-3.5 w-3.5 text-primary" />
                    </span>
                    {settings.mode === "custom" && (
                      <Badge className="text-[10px]">Active</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">Automatically makes every icon across the platform custom, with custom SVG support.</p>
                  <div className="mt-1 flex items-center gap-3 text-primary">
                    <AppIcon name="layout-dashboard" size={18} forceMode="custom" />
                    <AppIcon name="server" size={18} forceMode="custom" />
                    <AppIcon name="activity" size={18} forceMode="custom" />
                    <AppIcon name="star" size={18} forceMode="custom" />
                    <AppIcon name="settings" size={18} forceMode="custom" />
                  </div>
                </button>
              </div>
            </div>

            {/* Vector Pack Selection */}
            <div className="space-y-3 pt-1">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Select Custom Vector Pack Style
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {PACK_OPTIONS.map((pack) => {
                  const isSelected = settings.pack === pack.id;
                  return (
                    <button
                      key={pack.id}
                      type="button"
                      onClick={() => {
                        actions.setPack(pack.id);
                        toast.success(`Active pack: ${pack.label}`);
                      }}
                      className={cn(
                        "relative flex flex-col rounded-xl border p-3.5 text-left transition-all",
                        isSelected
                          ? "border-primary bg-primary/10 shadow-sm ring-1 ring-primary"
                          : "border-border bg-card/50 hover:border-primary/40 hover:bg-card"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-xs">{pack.label}</span>
                        <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">
                          {pack.badge}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                        {pack.description}
                      </p>
                      <div className="mt-2.5 flex items-center gap-3 border-t border-border/40 pt-2 text-foreground">
                        <AppIcon name="layout-dashboard" size={16} forceMode="custom" packOverride={pack.id} />
                        <AppIcon name="server" size={16} forceMode="custom" packOverride={pack.id} />
                        <AppIcon name="activity" size={16} forceMode="custom" packOverride={pack.id} />
                        <AppIcon name="star" size={16} forceMode="custom" packOverride={pack.id} />
                        <AppIcon name="settings" size={16} forceMode="custom" packOverride={pack.id} />
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Solar © 480 Design (CC BY 4.0); Phosphor, Iconoir and Fluent System Icons (MIT); Carbon Design (Apache 2.0). Collections:{" "}
                <a href="https://www.svgrepo.com/collection/solar-linear-icons/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">Solar</a>,{" "}
                <a href="https://www.svgrepo.com/collection/phosphor-filled-icons/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">Phosphor</a>,{" "}
                <a href="https://www.svgrepo.com/collection/carbon-design-line-icons/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">Carbon</a>,{" "}
                <a href="https://www.svgrepo.com/collection/iconoir-icons/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">Iconoir</a>,{" "}
                <a href="https://www.svgrepo.com/collection/fluent-ui-icons-filled/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">Fluent</a>.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Search, Category Filter & Icon Cards Grid */}
        <div className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            {/* Category Tabs */}
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((cat) => {
                const count =
                  cat.id === "all"
                    ? ICON_DEFINITIONS.length
                    : ICON_DEFINITIONS.filter((i) => i.category === cat.id).length;

                return (
                  <Button
                    key={cat.id}
                    variant={selectedCategory === cat.id ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedCategory(cat.id)}
                    className="text-xs h-8 gap-1"
                  >
                    <span>{cat.label}</span>
                    <span className={cn(
                      "text-[10px] px-1 py-0 rounded",
                      selectedCategory === cat.id ? "bg-primary-foreground/20 text-primary-foreground" : "text-muted-foreground"
                    )}>
                      {count}
                    </span>
                  </Button>
                );
              })}
            </div>

            {/* Search Box with proper spacing and pl-10 padding */}
            <div className="relative w-full sm:w-72">
              <AppIcon
                name="search"
                fallback={Search}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
              />
              <Input
                placeholder="Search platform icons..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 text-xs h-9"
              />
            </div>
          </div>

          {/* Icon Cards Grid */}
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {filteredIcons.map((icon) => {
              const hasOverride = Boolean(settings.overrides[icon.id]);
              const individualMode = settings.iconModes?.[icon.id];
              const isCustom = settings.mode === "custom"
                ? individualMode !== "default"
                : (individualMode === "custom");

              const DefaultIconComponent = icon.defaultIcon;

              return (
                <Card
                  key={icon.id}
                  className={cn(
                    "group relative flex flex-col justify-between border transition-all hover:shadow-md overflow-hidden",
                    isCustom
                      ? "border-primary/40 bg-card/90"
                      : "border-border hover:border-muted-foreground/30 bg-card"
                  )}
                >
                  {/* Hidden file input for this specific icon card */}
                  <input
                    ref={(el) => {
                      cardFileInputRefs.current[icon.id] = el;
                    }}
                    type="file"
                    accept=".svg,image/svg+xml"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        processUploadedSvgFile(file, icon.id);
                      }
                      e.target.value = "";
                    }}
                  />

                  <CardHeader className="p-4 pb-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="text-sm font-semibold truncate">{icon.name}</CardTitle>
                        <span className="text-[10px] font-mono text-muted-foreground block truncate">{icon.id}</span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {hasOverride && (
                          <Badge className="bg-emerald-500/20 text-emerald-500 text-[10px] border-emerald-500/30 px-1.5 py-0">
                            SVG
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-[10px] capitalize px-1.5 py-0">
                          {icon.category}
                        </Badge>
                      </div>
                    </div>
                    <CardDescription className="text-xs line-clamp-1 mt-1 text-muted-foreground">{icon.description}</CardDescription>
                  </CardHeader>

                  <CardContent className="p-4 pt-0 space-y-3">
                    {/* Visual Comparison: Default vs Custom */}
                    <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/60 bg-muted/20 p-2 text-center">
                      <div
                        onClick={() => {
                          actions.setIconMode(icon.id, "default");
                          toast.success(`${icon.name} set to Default icon across platform`);
                        }}
                        className={cn(
                          "flex flex-col items-center gap-1.5 p-2 rounded cursor-pointer transition-all",
                          !isCustom
                            ? "bg-card border border-primary/40 shadow-sm ring-1 ring-primary/30"
                            : "border border-transparent hover:bg-muted/40 opacity-70 hover:opacity-100"
                        )}
                        title="Click to set Default icon"
                      >
                        <span className={cn("text-[10px] font-medium", !isCustom ? "text-primary font-semibold" : "text-muted-foreground")}>
                          Default {!isCustom && "✓"}
                        </span>
                        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-card border border-border p-1.5">
                          <DefaultIconComponent size={20} className="text-foreground shrink-0" />
                        </div>
                      </div>

                      <div
                        onClick={() => {
                          actions.setIconMode(icon.id, "custom");
                          toast.success(`${icon.name} set to Custom icon across platform`);
                        }}
                        className={cn(
                          "flex flex-col items-center gap-1.5 p-2 rounded cursor-pointer transition-all",
                          isCustom
                            ? "bg-primary/10 border border-primary/50 shadow-sm ring-1 ring-primary/30"
                            : "border border-transparent hover:bg-muted/40 opacity-70 hover:opacity-100"
                        )}
                        title="Click to set Custom icon"
                      >
                        <span className={cn("text-[10px] font-medium", isCustom ? "text-primary font-semibold" : "text-muted-foreground")}>
                          Custom {isCustom && "✓"}
                        </span>
                        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-card border border-primary/30 shadow-sm text-foreground p-1.5">
                          <AppIcon name={icon.id} size={20} forceMode="custom" className="text-foreground shrink-0" />
                        </div>
                      </div>
                    </div>

                    {/* Fine-grained Individual Default / Custom Mode Toggle */}
                    <div className="flex items-center rounded-lg border border-border/80 bg-muted/40 p-1">
                      <button
                        type="button"
                        onClick={() => {
                          actions.setIconMode(icon.id, "default");
                          toast.success(`${icon.name} set to Default icon across platform`);
                        }}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-1 py-1 px-2 rounded-md text-xs font-medium transition-all",
                          !isCustom
                            ? "bg-card text-foreground shadow-sm ring-1 ring-border font-semibold"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <span>Default</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          actions.setIconMode(icon.id, "custom");
                          toast.success(`${icon.name} set to Custom icon across platform`);
                        }}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-1 py-1 px-2 rounded-md text-xs font-medium transition-all",
                          isCustom
                            ? "bg-primary text-primary-foreground shadow-sm font-semibold"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <AppIcon name="sparkles" fallback={Sparkles} className="h-3 w-3" />
                        <span>Custom</span>
                      </button>
                    </div>

                    {/* Live Platform Rendering Indicator */}
                    <div className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-muted/30 border border-border/40 text-xs">
                      <span className="text-[11px] text-muted-foreground">Platform Rendering:</span>
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <AppIcon name={icon.id} size={16} />
                        <span className={cn(
                          "text-[10px] font-mono capitalize font-semibold",
                          isCustom ? "text-primary" : "text-muted-foreground"
                        )}>
                          {isCustom ? "custom" : "default"}
                        </span>
                      </div>
                    </div>

                    {/* Action buttons: Upload SVG, Edit & Reset */}
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => cardFileInputRefs.current[icon.id]?.click()}
                        className="flex-1 gap-1 text-[11px] h-7 hover:border-primary hover:text-primary transition-colors px-2"
                        title="Directly upload and apply .svg file"
                      >
                        <AppIcon name="upload-cloud" fallback={UploadCloud} className="h-3 w-3 text-primary" />
                        <span>Upload SVG</span>
                      </Button>

                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openEditModal(icon)}
                        className="gap-1 text-[11px] h-7 px-2"
                        title="Edit SVG code and visual preview"
                      >
                        <AppIcon name="code" fallback={Code} className="h-3 w-3" />
                        <span>Edit</span>
                      </Button>

                      {(hasOverride || individualMode !== undefined) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            actions.resetIcon(icon.id);
                            toast.success(`Reset ${icon.name} to default settings`);
                          }}
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          title="Reset custom preferences"
                        >
                          <AppIcon name="rotate-ccw" fallback={RotateCcw} className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </main>

      {/* Customize Icon Modal */}
      {editingIcon && (
        <Dialog open={Boolean(editingIcon)} onOpenChange={(open) => !open && setEditingIcon(null)}>
          <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-5xl gap-5">
            {/* Hidden file input in modal */}
            <input
              ref={modalFileInputRef}
              type="file"
              accept=".svg,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  processUploadedSvgFile(file);
                }
                e.target.value = "";
              }}
            />

            <DialogHeader>
              <div className="flex items-center gap-2">
                <AppIcon name="sparkles" fallback={Sparkles} className="h-5 w-5 text-primary" />
                <DialogTitle>Customize: {editingIcon.name}</DialogTitle>
              </div>
              <DialogDescription>
                Upload an SVG file or edit the SVG code directly for{" "}
                <span className="font-mono text-xs text-foreground font-semibold">{editingIcon.id}</span>.
              </DialogDescription>
            </DialogHeader>

            <div className="grid min-h-0 gap-5 md:grid-cols-2">
              {/* Drag & Drop Upload Zone */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDraggingFile(true);
                }}
                onDragLeave={() => setIsDraggingFile(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDraggingFile(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) processUploadedSvgFile(file);
                }}
                role="button" tabIndex={0} aria-label="Upload custom SVG"
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); modalFileInputRef.current?.click(); } }}
                onClick={() => modalFileInputRef.current?.click()}
                className={cn(
                  "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 text-center cursor-pointer transition-all",
                  isDraggingFile
                    ? "border-primary bg-primary/10"
                    : "border-border/80 hover:border-primary/50 hover:bg-muted/20"
                )}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <AppIcon name="upload-cloud" fallback={UploadCloud} className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-foreground">
                    Click to browse or drag & drop your <span className="text-primary font-mono">.svg</span> file here
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Preview your SVG, then choose Apply & Save to update the icon
                  </p>
                </div>
              </div>

              {/* Preview Cards */}
              <div className="grid grid-cols-2 gap-3 md:col-start-1">
                <div className="rounded-xl border border-border bg-slate-950 p-4 text-center text-white shadow-inner">
                  <span className="text-xs font-medium text-slate-400">Dark Theme</span>
                  <div className="mt-2 flex h-20 items-center justify-center text-white">
                    {customSvgInput.trim().startsWith("<svg") ? (
                      <span
                        className="inline-flex h-12 w-12 items-center justify-center text-white p-1 [&_svg]:max-h-full [&_svg]:max-w-full [&_svg]:w-auto [&_svg]:h-auto"
                        dangerouslySetInnerHTML={{ __html: sanitizeSvg(customSvgInput) }}
                      />
                    ) : (
                      <AppIcon name={editingIcon.id} size={32} forceMode="custom" className="text-white" />
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-white p-4 text-center text-slate-900 shadow-inner">
                  <span className="text-xs font-medium text-slate-500">Light Theme</span>
                  <div className="mt-2 flex h-20 items-center justify-center text-slate-950">
                    {customSvgInput.trim().startsWith("<svg") ? (
                      <span
                        className="inline-flex h-12 w-12 items-center justify-center text-slate-950 p-1 [&_svg]:max-h-full [&_svg]:max-w-full [&_svg]:w-auto [&_svg]:h-auto"
                        dangerouslySetInnerHTML={{ __html: sanitizeSvg(customSvgInput) }}
                      />
                    ) : (
                      <AppIcon name={editingIcon.id} size={32} forceMode="custom" className="text-slate-950" />
                    )}
                  </div>
                </div>
              </div>

              {/* Raw SVG Code Editor */}
              <div className="flex flex-col gap-2 md:col-start-2 md:row-start-1 md:row-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="custom-icon-code" className="text-xs font-semibold">SVG Vector Code</Label>
                  <span className="text-[11px] text-muted-foreground">Auto-populates when SVG file is uploaded</span>
                </div>
                <textarea id="custom-icon-code"
                  value={customSvgInput}
                  onChange={(e) => setCustomSvgInput(e.target.value)}
                  placeholder={`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">\n  ...\n</svg>`}
                  rows={10}
                  className="min-h-48 flex-1 w-full font-mono text-xs p-3 rounded-lg border border-border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                variant="ghost"
                onClick={() => {
                  setCustomSvgInput("");
                }}
                className="text-xs"
              >
                Clear SVG
              </Button>
              <Button onClick={handleSaveSvg} className="gap-1.5 text-xs">
                <AppIcon name="check" fallback={Check} className="h-4 w-4" />
                <span>Apply & Save</span>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Export Dialog */}
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Export Icon Configuration</DialogTitle>
            <DialogDescription>Save or share your customized icon setup.</DialogDescription>
          </DialogHeader>
          <textarea
            readOnly
            value={JSON.stringify(settings, null, 2)}
            rows={10}
            className="min-h-48 flex-1 w-full font-mono text-xs p-3 rounded-lg border border-border bg-muted/40"
          />
          <DialogFooter>
            <Button onClick={handleExport} className="gap-1.5 text-xs w-full">
              <AppIcon name="copy" fallback={Copy} className="h-4 w-4" />
              <span>Copy to Clipboard</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Import Icon Configuration</DialogTitle>
            <DialogDescription>Paste an exported icon configuration JSON.</DialogDescription>
          </DialogHeader>
          <textarea
            value={importJsonInput}
            onChange={(e) => setImportJsonInput(e.target.value)}
            placeholder={`{\n  "mode": "custom",\n  "pack": "duotone",\n  "overrides": {},\n  "iconModes": {}\n}`}
            rows={10}
            className="min-h-48 flex-1 w-full font-mono text-xs p-3 rounded-lg border border-border bg-muted/40"
          />
          <DialogFooter>
            <Button onClick={handleImport} className="gap-1.5 text-xs w-full">
              <AppIcon name="upload" fallback={Upload} className="h-4 w-4" />
              <span>Import Configuration</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
