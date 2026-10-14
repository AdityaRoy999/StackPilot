"use client";

import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Search, Check, RefreshCw, ChevronDown, Eye, BrainCircuit } from "@/lib/platform-icons";
import { getModelMetadata, type ModelCategory } from "@/lib/model-capabilities";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "./ProviderLogo";

type Model = { id: string; label?: string; mode?: string };
interface ModelPickerModalProps {
  open: boolean; onOpenChange: (open: boolean) => void; models?: Model[]; availableModels?: Model[];
  selectedModelId: string; onSelectModel: (id: string, mode?: "fast" | "thinking") => void;
  onRefresh?: () => void; isRefreshing?: boolean;
}
const categories: { id: ModelCategory; label: string }[] = [
  { id: "all", label: "All capabilities" }, { id: "vision", label: "Vision" },
  { id: "reasoning", label: "Reasoning" }, { id: "coding", label: "Code" }, { id: "fast", label: "Fast" },
];
const emptyModels: Model[] = [];

export function ModelPickerModal({ open, onOpenChange, models, availableModels, selectedModelId, onSelectModel, onRefresh, isRefreshing }: ModelPickerModalProps) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<ModelCategory>("all");
  const [company, setCompany] = useState("all");
  const [limit, setLimit] = useState(24);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const list = availableModels || models || emptyModels;
  const enriched = useMemo(() => list.map(model => ({ ...getModelMetadata(model.id), label: model.label })), [list]);
  const companies = useMemo(() => [...new Set(enriched.map(model => model.org))].sort(), [enriched]);
  const effectiveCompany = companies.includes(company) ? company : "all";
  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    return enriched.filter(model => (effectiveCompany === "all" || model.org === effectiveCompany)
      && (category === "all" || category === "vision" && model.supportsVision || category === "reasoning" && model.supportsReasoning
        || category === "coding" && model.supportsCoding || category === "fast" && !model.supportsVision && !model.supportsReasoning && !model.supportsCoding)
      && (!query || [model.id, model.name, model.label, model.org, ...model.badges].filter(Boolean).join(" ").toLowerCase().includes(query)))
      .sort((a, b) => Number(b.id === selectedModelId) - Number(a.id === selectedModelId) || a.name.localeCompare(b.name));
  }, [enriched, search, category, effectiveCompany, selectedModelId]);
  const choose = (id: string) => { onSelectModel(id, getModelMetadata(id).supportsReasoning ? "thinking" : "fast"); onOpenChange(false); };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent overlayClassName="sm:backdrop-blur-none" className="!flex max-h-[85dvh] flex-col gap-3 overflow-hidden sm:max-w-2xl">
      <DialogHeader className="pr-8"><DialogTitle>Choose a model</DialogTitle><DialogDescription>Models from your connected provider.</DialogDescription></DialogHeader>
      <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
        <Input autoFocus aria-label="Search models" placeholder="Search models…" value={search} onChange={e => { setSearch(e.target.value); setLimit(24); }} className="h-9 pl-9" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="outline" size="sm" />} aria-label="Filter models by company">
          <span className="max-w-40 truncate">{effectiveCompany === "all" ? "All companies" : effectiveCompany}</span><ChevronDown className="size-3.5" />
        </DropdownMenuTrigger><DropdownMenuContent className="max-h-64 overflow-y-auto">{["all", ...companies].map(name =>
          <DropdownMenuItem key={name} onClick={() => { setCompany(name); setLimit(24); }}>{name === "all" ? "All companies" : name}{name === effectiveCompany && <Check className="ml-auto size-3.5" />}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="outline" size="sm" />} aria-label="Filter models by capability">
          {categories.find(item => item.id === category)?.label}<ChevronDown className="size-3.5" />
        </DropdownMenuTrigger><DropdownMenuContent>{categories.map(item => <DropdownMenuItem key={item.id} onClick={() => { setCategory(item.id); setLimit(24); }}>{item.label}{category === item.id && <Check className="ml-auto size-3.5" />}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">{matches.length} models</span>
        {onRefresh && <Button variant="ghost" size="icon-sm" title="Refresh models" aria-label="Refresh models" disabled={isRefreshing} onClick={onRefresh}><RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} /></Button>}
      </div>
      <div className="min-h-0 overflow-y-auto rounded-lg border border-border" aria-label="Available models">
        {matches.length ? <div className="divide-y divide-border">{matches.slice(0, limit).map(model => <button key={model.id} type="button" aria-label={`Use ${model.name}`} aria-pressed={model.id === selectedModelId} onClick={() => choose(model.id)}
          className={cn("flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", model.id === selectedModelId && "bg-muted")}>
          <ProviderLogo provider={model.org} size={20} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{model.label || model.name}</span><span className="block truncate font-mono text-xs text-muted-foreground">{model.id}</span></span>
          {model.supportsVision && <Eye aria-label="Vision" className="size-3.5 shrink-0 text-muted-foreground" />}{model.supportsReasoning && <BrainCircuit aria-label="Reasoning" className="size-3.5 shrink-0 text-muted-foreground" />}
          {model.id === selectedModelId && <Check aria-label="Selected" className="size-4 shrink-0" />}
        </button>)}{matches.length > limit && <Button variant="ghost" className="w-full rounded-none" onClick={() => setLimit(value => value + 24)}>Show more models</Button>}</div>
        : <p className="px-4 py-8 text-center text-sm text-muted-foreground">No models match your search.</p>}
      </div>
      <div className="border-t border-border pt-2">
        {customOpen ? <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); if (custom.trim()) choose(custom.trim()); }}>
          <Input aria-label="Custom model ID" placeholder="provider/model-id" value={custom} onChange={e => setCustom(e.target.value)} className="min-w-0 font-mono text-xs" autoFocus />
          <Button type="submit" size="sm" disabled={!custom.trim()}>Use model</Button>
        </form> : <Button variant="ghost" size="sm" onClick={() => setCustomOpen(true)}>Use a custom model ID</Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
