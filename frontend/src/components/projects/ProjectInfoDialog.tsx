"use client";

import { useState } from "react";
import { Info, RefreshCw } from "@/lib/platform-icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { environmentBranchLabel, type ProjectStackDetails } from "@/lib/project-stack";
import { StackInspection, useProjectStack } from "./ProjectStack";

function Configuration({ details }: { details?: ProjectStackDetails }) {
  if (!details) return <p className="text-sm text-muted-foreground">Configuration details could not be loaded.</p>;
  const rows = [
    ["Workspace", details.workspace], ["Source", details.source_type === "application" ? "Application preset" : details.source_type === "ssh" ? "Server folder" : details.source_type === "local" ? "Local folder" : "GitHub"],
    ["Repository", details.repo_url], ["Source folder", details.source_path], ["Source server", details.source_server],
    ["Preset", details.preset], ["Image", details.image], ["Port", details.port], ["Host port", details.host_port], ["Container port", details.container_port],
    ...(details.application_fields || []).map(field => [field.label, field.value]),
    ["Runtime", `${details.execution_mode === "remote_host" ? "Remote" : "Local"} ${details.remote_runtime_type === "kubernetes" ? "Kubernetes" : "Docker"}`],
    ["Runtime server", details.runtime_server], ["Protocol", details.runtime_scheme?.toUpperCase()],
    ["Kubernetes exposure", details.remote_runtime_type === "kubernetes" ? details.remote_k8s_exposure : undefined],
    ["Shared variables", `${details.variables ?? 0} configured · values private`],
    ["Created", details.created_at ? new Date(details.created_at).toLocaleString() : undefined],
    ["Updated", details.updated_at ? new Date(details.updated_at).toLocaleString() : undefined],
  ].filter(([, value]) => value);
  return <dl className="divide-y divide-border text-sm">{rows.map(([label, value]) => <div key={label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-3 sm:grid-cols-[9rem_minmax(0,1fr)]"><dt className="text-muted-foreground">{label}</dt><dd className="break-words font-medium [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>;
}

function ProjectInfoContent({ id, updatedAt, tab }: { id: string; updatedAt?: string; tab: string }) {
  const query = useProjectStack(id, updatedAt);
  if (tab === "Stack") return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground">{query.data?.cache?.inspected_at ? `Saved ${new Date(query.data.cache.inspected_at).toLocaleString()}` : "Detected from source manifests"}</p>
      <Button type="button" variant="ghost" size="sm" disabled={query.isFetching || query.isRefreshing} onClick={() => query.refresh()}><RefreshCw className={cn("mr-1.5 size-3.5", query.isRefreshing && "animate-spin")} />Refresh stack</Button>
    </div>
    {(query.refreshFailed || query.data?.cache?.refresh_error) && <p role="status" className="text-xs text-muted-foreground">{query.refreshFailed ? "Could not refresh the stack. Your saved result is still available." : query.data?.cache?.refresh_error}</p>}
    <StackInspection stack={query.data?.stack} loading={query.isPending} failed={query.isError} onRetry={() => query.refresh()} />
  </div>;
  if (query.isPending) return <p role="status" className="text-sm text-muted-foreground">Loading configuration…</p>;
  if (query.isError) return <div className="space-y-3 text-sm"><p>Project details could not be loaded.</p><Button variant="outline" size="sm" onClick={() => void query.refetch()}>Retry</Button></div>;
  if (tab === "Configuration") return <Configuration details={query.data?.details} />;
  const environments = query.data?.details?.environments;
  return <div className="space-y-3">{environments?.length ? environments.map(env => <article key={env.name} className="rounded-lg border border-border p-4 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">{env.name}</h4><span className="font-mono text-xs text-muted-foreground">{environmentBranchLabel(env.branch)}</span></div><p className="mt-2 text-muted-foreground">{env.auto_deploy ? "Deploy on push" : "Manual deployment"} · {env.require_ci ? "CI required" : "CI gate off"}</p><p className="mt-1 text-xs text-muted-foreground">{env.variables ?? 0} variables · {env.cleanup_previous_on_success ? "Previous release cleaned up after success" : "Previous releases retained"}</p></article>) : <p className="text-sm text-muted-foreground">No environments configured.</p>}<p className="text-xs text-muted-foreground">Secret values are kept private.</p></div>;
}

export function ProjectInfoDialog({ project }: { project: { id: string; name: string; updated_at?: string } }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("Stack");
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger render={<Button variant="ghost" size="icon" />} aria-label={`Project information for ${project.name}`} title="Project information"><Info className="h-4 w-4" /></DialogTrigger>
    <DialogContent resizeKey={tab} className="!flex max-h-[85dvh] flex-col gap-4 overflow-hidden sm:max-w-5xl sm:p-6">
      <DialogHeader className="pr-8"><DialogTitle className="break-words">{project.name}</DialogTitle><DialogDescription>Application stack and saved configuration.</DialogDescription></DialogHeader>
      <nav className="flex flex-wrap items-center gap-1 border-b border-border pb-2" aria-label="Project information sections">{["Stack", "Configuration", "Environments"].map(label => <Button key={label} aria-pressed={tab === label} variant="ghost" size="sm" onClick={() => setTab(label)} className={cn(tab === label && "bg-muted text-foreground")}>{label}</Button>)}</nav>
      <section data-dialog-scroll aria-label={`${tab} details`} className="min-h-0 overflow-y-auto overflow-x-hidden pr-1">{open && <ProjectInfoContent id={project.id} updatedAt={project.updated_at} tab={tab} />}</section>
    </DialogContent>
  </Dialog>;
}
