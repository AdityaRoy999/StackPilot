"use client";

import React, { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  Check,
  Eye,
  BrainCircuit,
  Code2,
  Zap,
  Sparkles,
  X,
  Layers,
  ArrowRight,
  RefreshCw,
  ChevronDown,
} from "@/lib/platform-icons";
import {
  ModelCategory,
  getModelMetadata,
} from "@/lib/model-capabilities";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "./ProviderLogo";

interface ModelPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models?: Array<{ id: string; label?: string; mode?: string }>;
  availableModels?: Array<{ id: string; label?: string; mode?: string }>;
  selectedModelId: string;
  onSelectModel: (modelId: string, mode?: "fast" | "thinking") => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export function ModelPickerModal({
  open,
  onOpenChange,
  models,
  availableModels,
  selectedModelId,
  onSelectModel,
  onRefresh,
  isRefreshing,
}: ModelPickerModalProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<ModelCategory>("all");
  const [customModel, setCustomModel] = useState("");
  const [company, setCompany] = useState("all");

  const modelList = useMemo(() => availableModels || models || [], [availableModels, models]);

  // Process and memoize metadata for all models
  const enrichedModels = useMemo(() => {
    return modelList.map((m) => getModelMetadata(m.id));
  }, [modelList]);

  const companies = useMemo(() => Array.from(new Set(enrichedModels.map((model) => model.org))).sort(), [enrichedModels]);

  const effectiveCompany = companies.includes(company) ? company : "all";

  // Counts per category
  const counts = useMemo(() => {
    return {
      all: enrichedModels.length,
      vision: enrichedModels.filter((m) => m.supportsVision).length,
      reasoning: enrichedModels.filter((m) => m.supportsReasoning).length,
      coding: enrichedModels.filter((m) => m.supportsCoding).length,
      fast: enrichedModels.filter((m) => m.category === "fast" && !m.supportsVision && !m.supportsReasoning).length,
    };
  }, [enrichedModels]);

  // Filtered models by search query and category tab
  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return enrichedModels.filter((m) => {
      if (effectiveCompany !== "all" && m.org !== effectiveCompany) return false;
      // Category filter
      if (activeCategory === "vision" && !m.supportsVision) return false;
      if (activeCategory === "reasoning" && !m.supportsReasoning) return false;
      if (activeCategory === "coding" && !m.supportsCoding) return false;
      if (activeCategory === "fast" && (m.supportsVision || m.supportsReasoning || m.supportsCoding)) return false;

      // Search query filter
      if (!q) return true;
      return (
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.org.toLowerCase().includes(q) ||
        m.badges.some((b) => b.toLowerCase().includes(q))
      );
    });
  }, [enrichedModels, activeCategory, searchQuery, effectiveCompany]);

  const handleSelect = (id: string) => {
    const meta = getModelMetadata(id);
    const mode = meta.supportsReasoning ? "thinking" : "fast";
    onSelectModel(id, mode);
    onOpenChange(false);
  };

  const handleApplyCustom = () => {
    const trimmed = customModel.trim();
    if (trimmed) {
      const meta = getModelMetadata(trimmed);
      const mode = meta.supportsReasoning ? "thinking" : "fast";
      onSelectModel(trimmed, mode);
      setCustomModel("");
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl sm:max-w-5xl lg:max-w-6xl !max-w-5xl sm:!max-w-5xl lg:!max-w-6xl w-[95vw] md:w-[92vw] lg:w-[88vw] max-h-[88vh] flex flex-col p-0 overflow-hidden border border-border/70 shadow-2xl bg-background">
        {/* Modal Header */}
        <DialogHeader className="p-5 pb-3 border-b border-border/50 shrink-0">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="p-2 rounded-lg bg-primary/10 text-primary">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="text-lg font-semibold tracking-tight">Select AI Model</DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  Choose a model from your active connection. Filter by company or capability.
                </DialogDescription>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 pr-6">
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Filter models by company"
                  className="flex h-9 w-52 min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate">{effectiveCompany === "all" ? `All companies (${companies.length})` : effectiveCompany}</span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52 max-h-72 overflow-y-auto border border-border">
                  {["all", ...companies].map((name) => (
                    <DropdownMenuItem key={name} onClick={() => setCompany(name)} className="justify-between gap-2">
                      <span className="truncate">{name === "all" ? `All companies (${companies.length})` : name}</span>
                      {effectiveCompany === name && <Check className="h-4 w-4 shrink-0" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {onRefresh && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onRefresh}
                  disabled={isRefreshing}
                  className="h-9 shrink-0 gap-1.5 px-3 text-xs text-muted-foreground hover:text-foreground"
                  title="Fetch latest models from provider"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
                  <span className="hidden md:inline">Refresh Models</span>
                </Button>
              )}
            </div>
          </div>

          {/* Search Input Bar */}
          <div className="relative mt-3">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search models" placeholder={`Search ${enrichedModels.length} models by name, company, or capability…`}
              className="pl-9 pr-9 h-9 text-xs bg-muted/30 focus-visible:bg-background transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Category Tabs */}
          <div className="flex items-center gap-2 mt-3 overflow-x-auto pb-1 scrollbar-none">
            <button
              type="button"
              onClick={() => setActiveCategory("all")}
              className={cn(
                "flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all shrink-0 cursor-pointer",
                activeCategory === "all"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>All Models</span>
              <span className="opacity-70 text-[10px]">({counts.all})</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveCategory("vision")}
              className={cn(
                "flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all shrink-0 cursor-pointer",
                activeCategory === "vision"
                  ? "bg-sky-500 text-white shadow-sm"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Eye className="h-3.5 w-3.5 text-sky-400" />
              <span>Vision & Docs</span>
              <span className="opacity-70 text-[10px]">({counts.vision})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveCategory("reasoning")}
              className={cn(
                "flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all shrink-0 cursor-pointer",
                activeCategory === "reasoning"
                  ? "bg-teal-600 text-white shadow-sm"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <BrainCircuit className="h-3.5 w-3.5 text-teal-400" />
              <span>Deep Reasoning</span>
              <span className="opacity-70 text-[10px]">({counts.reasoning})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveCategory("coding")}
              className={cn(
                "flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all shrink-0 cursor-pointer",
                activeCategory === "coding"
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Code2 className="h-3.5 w-3.5 text-emerald-400" />
              <span>Code & DevOps</span>
              <span className="opacity-70 text-[10px]">({counts.coding})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveCategory("fast")}
              className={cn(
                "flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all shrink-0 cursor-pointer",
                activeCategory === "fast"
                  ? "bg-amber-500 text-white shadow-sm"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Zap className="h-3.5 w-3.5 text-amber-400" />
              <span>Fast Chat</span>
              <span className="opacity-70 text-[10px]">({counts.fast})</span>
            </button>
            <span className="ml-auto shrink-0 px-1 text-xs text-muted-foreground" aria-live="polite">
              {filteredModels.length} matching models
            </span>
          </div>
        </DialogHeader>

        {/* Scrollable Model List - 2 Columns on Wider Screens */}
        <div className="flex-1 overflow-y-auto p-4 select-none">
          {filteredModels.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground">
              <p className="text-sm font-medium">No models found</p>
              <p className="text-xs opacity-70 mt-1">Try adjusting your search query or switching categories.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {filteredModels.map((m) => {
                const isSelected = m.id === selectedModelId;
                return (
                  <div
                    role="button" tabIndex={0} aria-pressed={isSelected} aria-label={`Use ${m.name}`}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handleSelect(m.id); } }}
                    key={m.id}
                    onClick={() => handleSelect(m.id)}
                    className={cn(
                      "flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer group",
                      isSelected
                        ? "border-primary/80 bg-primary/10 shadow-sm ring-1 ring-primary/40"
                        : "border-border/50 bg-card/60 hover:bg-accent/70 hover:border-border"
                    )}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-background text-foreground">
                        <ProviderLogo provider={m.org} size={24} />
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-semibold text-sm text-foreground truncate">{m.name}</span>
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                            {m.org}
                          </Badge>
                          {m.supportsVision && (
                            <Badge className="text-[10px] px-1.5 py-0 h-4 bg-sky-500/20 text-sky-300 border-sky-500/40 hover:bg-sky-500/30">
                              <Eye className="mr-1 h-3 w-3" /> Vision & Docs
                            </Badge>
                          )}
                          {m.supportsReasoning && (
                            <Badge className="text-[10px] px-1.5 py-0 h-4 bg-teal-500/20 text-teal-300 border-teal-500/40 hover:bg-teal-500/30">
                              <BrainCircuit className="mr-1 h-3 w-3" /> Reasoning
                            </Badge>
                          )}
                          {m.supportsCoding && (
                            <Badge className="text-[10px] px-1.5 py-0 h-4 bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30">
                              <Code2 className="mr-1 h-3 w-3" /> Code
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">{m.id}</p>
                        <p className="text-[11px] text-muted-foreground/80 mt-1 line-clamp-1">{m.description}</p>
                      </div>
                    </div>

                    <div className="shrink-0 ml-2">
                      {isSelected ? (
                        <div className="flex items-center gap-1 text-xs font-semibold text-primary bg-primary/15 px-2 py-0.5 rounded-full border border-primary/30">
                          <Check className="h-3 w-3 stroke-[2.5]" />
                          <span>Active</span>
                        </div>
                      ) : (
                        <span
                          aria-hidden="true"
                          className="h-7 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity gap-1"
                        >
                          <span>Select</span>
                          <ArrowRight className="h-3 w-3" />
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Custom Model ID Footer Bar */}
        <div className="p-3 px-5 border-t border-border/50 bg-muted/20 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
            <Input
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleApplyCustom();
              }}
              placeholder="Or enter any custom model ID (e.g. meta/llama-3.2-11b-vision-instruct)..."
              className="h-8 text-xs font-mono bg-background flex-1"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs shrink-0"
              onClick={handleApplyCustom}
              disabled={!customModel.trim()}
            >
              Use Custom Model
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
