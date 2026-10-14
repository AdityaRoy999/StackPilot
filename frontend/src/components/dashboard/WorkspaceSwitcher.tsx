"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronsUpDown, Plus, Users } from "@/lib/platform-icons";
import { useWorkspace } from "@/context/WorkspaceContext";
import { Badge } from "@/components/ui/badge";
import { AppIcon } from "@/lib/custom-icons";
import { cn } from "@/lib/utils";

export function WorkspaceSwitcher({ isCollapsed }: { isCollapsed: boolean }) {
  const router = useRouter();
  const { organizations, activeWorkspaceId, activeWorkspace, setActiveWorkspaceId } = useWorkspace();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const currentLabel = activeWorkspace ? activeWorkspace.name : "All Workspaces";

  const handleSelect = (id: string | null) => {
    setActiveWorkspaceId(id);
    setIsOpen(false);
  };

  const handleNavigate = (path: string) => {
    setIsOpen(false);
    router.push(path);
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-label={`Workspace: ${currentLabel}`}
        className="grid h-9 w-full grid-cols-[36px_148px] items-center gap-2 overflow-hidden rounded-md text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="flex size-9 items-center justify-center">
          <AppIcon name="building-2" fallback={Building2} size={18} />
        </span>
        <span aria-hidden={isCollapsed} className={cn("flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap transition-opacity duration-150", isCollapsed ? "opacity-0" : "opacity-100")}>
          <span className="truncate font-semibold text-foreground">{currentLabel}</span>
          <AppIcon name="chevrons-up-down" fallback={ChevronsUpDown} size={14} className="ml-auto mr-2 shrink-0" />
        </span>
      </button>

      {isOpen && (
        <div className={cn("absolute z-50 w-56 rounded-xl border border-border/80 bg-popover p-1.5 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95", isCollapsed ? "left-full top-0 ml-2" : "left-0 top-full mt-1.5")}>
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Workspaces
          </p>
          <button
            type="button"
            onClick={() => handleSelect(null)}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground text-left"
          >
            <span className="flex items-center gap-2 truncate">
              <AppIcon name="users" fallback={Users} size={14} className="text-muted-foreground" />
              <span className="font-medium">All Workspaces</span>
            </span>
            {activeWorkspaceId === null && <AppIcon name="check" fallback={Check} size={14} className="text-primary" />}
          </button>

          <div className="my-1 border-t border-border/60" />

          <div className="max-h-48 overflow-y-auto space-y-0.5 scrollbar-thin">
            {organizations.map((org) => (
              <button
                key={org.id}
                type="button"
                onClick={() => handleSelect(org.id)}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground text-left"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-foreground">{org.name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {org.is_personal ? "Personal" : `${org.member_count} members`}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge variant="outline" className="text-[10px] px-1 py-0 capitalize">
                    {org.role}
                  </Badge>
                  {activeWorkspaceId === org.id && <AppIcon name="check" fallback={Check} size={14} className="text-primary" />}
                </div>
              </button>
            ))}
          </div>

          <div className="my-1 border-t border-border/60" />

          <button
            type="button"
            onClick={() => handleNavigate("/dashboard/organization")}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 transition-colors text-left"
          >
            <AppIcon name="plus" fallback={Plus} size={14} />
            <span>Manage Organizations</span>
          </button>
        </div>
      )}
    </div>
  );
}
