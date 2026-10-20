"use client";

import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import api from "@/lib/api";
import { ChevronDown, FileCode, Loader2, RefreshCw } from "@/lib/platform-icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { stackComponentLabel, stackIconComponents, stackRoleLabels, type ProjectStack, type ProjectStackResponse, type StackComponent, type StackSource } from "@/lib/project-stack";
import { TechnologyIcon } from "./TechnologyIcon";

export function useProjectStack(projectId: string, updatedAt?: string) {
  const client = useQueryClient();
  const options = queryOptions({
    queryKey: ["project-stack", projectId, updatedAt],
    queryFn: async ({ signal }) => (await api.get<ProjectStackResponse>(`/projects/${projectId}/stack`, { signal })).data,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  const query = useQuery(options);
  const refresh = useMutation({
    mutationFn: async () => (await api.get<ProjectStackResponse>(`/projects/${projectId}/stack?refresh=1`)).data,
    onSuccess: data => client.setQueryData(options.queryKey, data),
  });
  return { ...query, refresh: refresh.mutate, isRefreshing: refresh.isPending, refreshFailed: refresh.isError };
}

function StackSymbol({ component }: { component: StackComponent }) {
  return <TechnologyIcon id={component.id} name={component.name} />;
}

export function ProjectStackIcons({ projectId, updatedAt }: { projectId: string; updatedAt?: string }) {
  const query = useProjectStack(projectId, updatedAt);
  const components = stackIconComponents(query.data?.stack);
  if (query.isPending) return <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status"><Loader2 className="h-3 w-3 animate-spin" />Inspecting stack…</p>;
  if (!components.length) return <p className="text-xs text-muted-foreground">{query.isError || query.data?.stack?.status === "unavailable" ? "Stack inspection unavailable" : "Stack not detected"}</p>;
  return <TooltipProvider><div className="flex flex-wrap items-center gap-1.5" aria-label="Application stack">
    {components.map(component => <Tooltip key={component.id}>
      <TooltipTrigger render={<span tabIndex={0} role="img" />} aria-label={stackComponentLabel(component)} className="technology-hover inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/30 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <StackSymbol component={component} />
      </TooltipTrigger>
      <TooltipContent>{stackComponentLabel(component)}</TooltipContent>
    </Tooltip>)}
  </div></TooltipProvider>;
}

export function StackInspection({ stack, loading, failed, onRetry }: { stack?: ProjectStack; loading?: boolean; failed?: boolean; onRetry?: () => void }) {
  if (loading) return <p role="status" className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Inspecting source manifests…</p>;
  if (!stack || failed || !stack.components.length) return <div className="space-y-3 text-sm text-muted-foreground"><p>{stack?.message || "Stack inspection is unavailable. Your project can still be created."}</p>{onRetry && <Button type="button" size="sm" variant="outline" onClick={onRetry}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Retry inspection</Button>}</div>;
  const roles = [...new Set(stack.components.map(item => item.role))];
  return <div className="space-y-4">
    <div className="grid items-start gap-5 sm:grid-cols-2 lg:grid-cols-3">{roles.map(role => <div key={role} className="min-w-0"><p className="mb-2 text-xs font-medium text-muted-foreground">{stackRoleLabels[role] || role}</p><ul className="space-y-2">{stack.components.filter(item => item.role === role).map(item => <li key={`${item.id}-${item.kind}`} className="min-w-0 rounded-lg border border-border">
      <details className="group" aria-label={`${item.name} source files`}>
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2.5 rounded-lg p-3 text-sm outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <StackSymbol component={item} /><span className="min-w-0 flex-1 font-medium">{item.name}{item.kind === "client" && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">Client dependency</span>}</span><ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <ul className="mx-3 mb-3 space-y-2 border-l border-border pl-3" aria-label="Source files">{[...new Set(item.evidence)].map(file => <li key={file} className="flex items-start gap-2 text-xs text-muted-foreground"><FileCode className="mt-0.5 size-3.5 shrink-0" /><span className="break-words font-mono [overflow-wrap:anywhere]">{file}</span></li>)}</ul>
      </details>
    </li>)}</ul></div>)}</div>
  </div>;
}

export function DraftStackInspection({ source }: { source: StackSource }) {
  // Credentials stay in the request body, never in query keys or persistent
  // caches. Remounting after editing the source starts a fresh inspection.
  const [attempt, setAttempt] = useState(0);
  const query = useQuery({
    queryKey: ["draft-stack", source.source_type, source.repo_url, source.source_path, source.ssh_connection_id, source.branch, source.application_template_id, source.application_config?.image, attempt],
    queryFn: async ({ signal }) => (await api.post<ProjectStackResponse>("/projects/inspect-stack", source, { signal })).data,
    staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false,
  });
  return <section className="rounded-lg border border-border p-4" aria-label="Detected application stack"><h4 className="mb-3 text-sm font-semibold">Application stack</h4><StackInspection stack={query.data?.stack} loading={query.isPending} failed={query.isError} onRetry={() => setAttempt(value => value + 1)} /></section>;
}
