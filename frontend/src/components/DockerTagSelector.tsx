"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tag, RefreshCw, Check, Search, Sparkles, ChevronDown } from "lucide-react";
import { AppIcon } from "@/lib/custom-icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface DockerHubTagItem {
  name: string;
  last_updated?: string;
  full_size?: number;
  is_latest?: boolean;
}

interface DockerTagSelectorProps {
  imageName: string; // e.g. "mysql" or "nginx" or "bitnami/postgresql"
  value: string; // current tag e.g. "latest" or "mysql:latest"
  onChange: (tag: string, fullImage: string) => void;
  className?: string;
  disabled?: boolean;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let val = bytes;
  let unitIndex = 0;
  while (val >= 1024 && unitIndex < units.length - 1) {
    val /= 1024;
    unitIndex++;
  }
  return `${val.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatRelativeTime(dateStr?: string): string {
  if (!dateStr) return "";
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths}mo ago`;
    return `${Math.floor(diffDays / 365)}y ago`;
  } catch {
    return "";
  }
}

export function DockerTagSelector({
  imageName,
  value,
  onChange,
  className,
  disabled = false,
}: DockerTagSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Extract base image repository without tag
  const baseImage = useMemo(() => {
    const raw = (imageName || "").trim();
    if (!raw) return "";
    return raw.includes(":") ? raw.split(":")[0] : raw;
  }, [imageName]);

  // Extract pure tag from value (e.g. "mysql:8.4" -> "8.4")
  const currentTag = useMemo(() => {
    const v = (value || "").trim();
    if (!v) return "latest";
    return v.includes(":") ? v.split(":")[1] : v;
  }, [value]);

  const {
    data,
    isLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["dockerhub-tags", baseImage],
    queryFn: async () => {
      if (!baseImage) return { results: [] };
      const res = await fetch(`/api/dockerhub/tags?image=${encodeURIComponent(baseImage)}`);
      if (!res.ok) throw new Error("Failed to fetch Docker tags");
      const json = await res.json();
      return json as { results: DockerHubTagItem[] };
    },
    enabled: Boolean(baseImage),
    staleTime: 1000 * 60 * 10, // 10 minutes cache
  });

  const tags = useMemo(() => data?.results || [], [data?.results]);

  // Filter tags based on search
  const filteredTags = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, searchFilter]);

  // Handle clicking outside to close
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const handleSelectTag = (selectedTag: string) => {
    const full = baseImage ? `${baseImage}:${selectedTag}` : selectedTag;
    onChange(selectedTag, full);
    setIsOpen(false);
    setSearchFilter("");
  };

  const hasExactMatch = filteredTags.some(
    (t) => t.name.toLowerCase() === searchFilter.trim().toLowerCase()
  );

  return (
    <div className={cn("relative w-full", className)} ref={dropdownRef}>
      <div className="flex gap-2">
        {/* Trigger Button showing currently selected tag */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => setIsOpen((prev) => !prev)}
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-left text-sm transition-colors hover:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary",
            isOpen && "border-primary ring-1 ring-primary"
          )}
        >
          <div className="flex items-center gap-2 truncate">
            <AppIcon name="tag" fallback={Tag} className="h-4 w-4 shrink-0 text-primary" />
            <span className="font-mono font-medium text-foreground truncate">
              {baseImage}:{currentTag}
            </span>
            {currentTag === "latest" && (
              <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-semibold uppercase text-emerald-400 border-emerald-500/30 bg-emerald-500/10">
                Recommended
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0 ml-2">
            {isFetching && (
              <AppIcon name="refresh-cw" fallback={RefreshCw} className="h-3.5 w-3.5 animate-spin text-primary" />
            )}
            <AppIcon name="chevron-down" fallback={ChevronDown} className={cn("h-4 w-4 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
          </div>
        </button>

        {/* Refresh button */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || isFetching}
          onClick={(e) => {
            e.stopPropagation();
            refetch();
          }}
          title="Refresh tags from Docker Hub"
          className="shrink-0 h-9 px-2.5"
        >
          <AppIcon name="refresh-cw" fallback={RefreshCw} className={cn("h-3.5 w-3.5", isFetching && "animate-spin text-primary")} />
        </Button>
      </div>

      {/* Tags Dropdown Menu */}
      {isOpen && (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-full min-w-[280px] max-w-md rounded-xl border border-border bg-card p-2 shadow-xl animate-in fade-in-50 zoom-in-95">
          {/* Search bar inside dropdown */}
          <div className="relative mb-2">
            <AppIcon name="search" fallback={Search} className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              autoFocus
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Search available tags (e.g. latest, 8.4, alpine)..."
              className="h-8 pl-8 pr-3 text-xs bg-muted/30"
            />
          </div>

          {/* Tag header */}
          <div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Docker Hub Tags {tags.length > 0 && `(${tags.length})`}</span>
            {isFetching && <span className="text-primary flex items-center gap-1"><AppIcon name="refresh-cw" fallback={RefreshCw} className="h-2.5 w-2.5 animate-spin" /> Fetching...</span>}
          </div>

          {/* Tags list */}
          <div className="max-h-60 overflow-y-auto space-y-1 pr-1 scrollbar-thin">
            {/* If search filter has no exact match, allow typing a custom tag */}
            {searchFilter.trim() && !hasExactMatch && (
              <button
                type="button"
                onClick={() => handleSelectTag(searchFilter.trim())}
                className="w-full flex items-center justify-between rounded-lg border border-dashed border-primary/40 bg-primary/5 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-primary/15"
              >
                <div className="flex items-center gap-2 truncate">
                  <AppIcon name="tag" fallback={Tag} className="h-3.5 w-3.5 text-primary shrink-0" />
                  <span className="font-mono text-foreground font-medium truncate">
                    Use tag: <strong className="text-primary">{searchFilter.trim()}</strong>
                  </span>
                </div>
                <Badge variant="outline" className="text-[9px] uppercase tracking-wider border-primary/40 text-primary">
                  Custom
                </Badge>
              </button>
            )}

            {isLoading ? (
              <div className="flex items-center justify-center py-6 text-xs text-muted-foreground gap-2">
                <AppIcon name="refresh-cw" fallback={RefreshCw} className="h-4 w-4 animate-spin text-primary" />
                Querying Docker Hub tags for {baseImage}...
              </div>
            ) : filteredTags.length > 0 ? (
              filteredTags.map((tag) => {
                const isSelected = currentTag === tag.name;
                const sizeStr = formatBytes(tag.full_size);
                const relTime = formatRelativeTime(tag.last_updated);

                return (
                  <button
                    key={tag.name}
                    type="button"
                    onClick={() => handleSelectTag(tag.name)}
                    className={cn(
                      "w-full flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                      isSelected && "bg-accent/80 font-medium"
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isSelected ? (
                        <AppIcon name="check" fallback={Check} className="h-3.5 w-3.5 text-primary shrink-0" />
                      ) : (
                        <div className="w-3.5 shrink-0" />
                      )}
                      <span className="font-mono text-foreground truncate font-medium">
                        {tag.name}
                      </span>
                      {tag.is_latest && (
                        <Badge variant="outline" className="h-4 px-1.5 text-[8px] font-semibold uppercase text-emerald-400 border-emerald-500/30 bg-emerald-500/10 shrink-0">
                          <AppIcon name="sparkles" fallback={Sparkles} className="h-2.5 w-2.5 mr-0.5" />
                          Recommended
                        </Badge>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono shrink-0 ml-2">
                      {sizeStr && <span>{sizeStr}</span>}
                      {relTime && <span>• {relTime}</span>}
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="py-4 text-center text-xs text-muted-foreground">
                No tags matching &quot;{searchFilter}&quot;
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
