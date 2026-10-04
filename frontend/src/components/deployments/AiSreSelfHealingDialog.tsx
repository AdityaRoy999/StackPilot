"use client";

import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Bot,
  Sparkles,
  Wand2,
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  FileCode2,
  ShieldAlert,
  Loader2,
  MessageSquare,
  FolderGit2,
  Layers,
  Zap,
} from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

interface AiSreSelfHealingDialogProps {
  open: boolean;
  onClose: () => void;
  deployment: {
    id: string;
    project_id: string;
    project_name?: string;
    version?: string;
    status: string;
    branch?: string;
    runtime_snapshot?: {
      archetype?: string;
      archetype_details?: string;
      detected_subservices?: string[];
      [key: string]: unknown;
    };
  } | null;
}

export function AiSreSelfHealingDialog({
  open,
  onClose,
  deployment,
}: AiSreSelfHealingDialogProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: rcaResponse, isLoading, isError, refetch } = useQuery({
    queryKey: ["deployment-rca", deployment?.id],
    queryFn: async () => {
      if (!deployment?.id) return null;
      const res = await api.get(`/deployments/${deployment.id}/rca`);
      return res.data;
    },
    enabled: !!deployment?.id && open,
    staleTime: 10000,
  });

  const repairMutation = useMutation({
    mutationFn: async () => {
      if (!deployment?.id) return;
      const res = await api.post(`/deployments/${deployment.id}/ai/repair`);
      return res.data;
    },
    onSuccess: () => {
      toast.success("Autonomous AI SRE repair rebuild queued!");
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      onClose();
    },
    onError: (err: unknown) => {
      const message =
        err && typeof err === "object" && "response" in err
          ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
          : undefined;
      toast.error(message || "Failed to trigger AI repair");
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: async () => {
      if (!deployment?.id) return;
      const res = await api.post(`/deployments/${deployment.id}/rollback`);
      return res.data;
    },
    onSuccess: (data: { message?: string } | undefined) => {
      toast.success(data?.message || "Successfully rolled back to healthy checkpoint!");
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      onClose();
    },
    onError: (err: unknown) => {
      const message =
        err && typeof err === "object" && "response" in err
          ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
          : undefined;
      toast.error(message || "Rollback failed");
    },
  });

  if (!deployment) return null;

  const rca = rcaResponse?.rca;
  const archetype = rcaResponse?.archetype || deployment.runtime_snapshot?.archetype;
  const subservices: string[] =
    rcaResponse?.detected_subservices ||
    deployment.runtime_snapshot?.detected_subservices ||
    [];

  const getCategoryColor = (category?: string) => {
    switch (category) {
      case "UNSUPPORTED_ARCHETYPE":
        return "border-rose-500/40 bg-rose-500/10 text-rose-400";
      case "MISSING_DEPENDENCY":
        return "border-amber-500/40 bg-amber-500/10 text-amber-400";
      case "PORT_BIND_CONFLICT":
        return "border-orange-500/40 bg-orange-500/10 text-orange-400";
      case "OOM_KILL":
        return "border-red-500/40 bg-red-500/10 text-red-400";
      case "LOCKFILE_CONFLICT":
        return "border-yellow-500/40 bg-yellow-500/10 text-yellow-400";
      case "MOBILE_DIVERSION":
        return "border-sky-500/40 bg-sky-500/10 text-sky-400";
      default:
        return "border-primary/40 bg-primary/10 text-primary";
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="!flex !w-[min(96vw,56rem)] !max-w-[56rem] !max-h-[92vh] !flex-col overflow-hidden rounded-2xl border-border bg-card p-0 shadow-2xl">
        {/* Header with AI SRE branding */}
        <DialogHeader className="shrink-0 border-b border-border/80 bg-gradient-to-r from-primary/10 via-muted/30 to-background px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/20 text-primary ring-1 ring-primary/40 shadow-inner">
                <AppIcon name="bot" fallback={Bot} className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="flex items-center gap-2 text-lg font-bold">
                  Autonomous AI SRE Incident Control
                  <Badge variant="outline" className="border-primary/40 bg-primary/15 text-primary text-[11px]">
                    <Sparkles className="h-3 w-3 mr-1" />
                    Self-Healing Loop
                  </Badge>
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  Deployment {deployment.id.slice(0, 8)} • Project: {deployment.project_name || "Workspace"}
                </DialogDescription>
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Scrollable Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
              <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary animate-pulse">
                <Loader2 className="h-7 w-7 animate-spin text-primary" />
              </div>
              <h4 className="text-sm font-semibold text-foreground">AI SRE Ingesting Incident & Logs...</h4>
              <p className="text-xs text-muted-foreground max-w-sm">
                Running deterministic compiler AST pattern matching, dependency graph inspection, and archetype classification.
              </p>
            </div>
          ) : isError || !rca ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-center">
              <AlertTriangle className="h-8 w-8 text-destructive mx-auto mb-2" />
              <p className="text-sm font-medium text-destructive">Failed to generate Root Cause Analysis</p>
              <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-3 text-xs">
                Retry Analysis
              </Button>
            </div>
          ) : (
            <>
              {/* Incident Summary Card */}
              <div className="rounded-xl border border-border bg-muted/20 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={`font-mono text-xs uppercase px-2 py-0.5 ${getCategoryColor(rca.category)}`}>
                      {rca.category?.replace(/_/g, " ") || "INCIDENT"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">•</span>
                    <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {rca.confidence || 95}% Match Confidence
                    </span>
                  </div>
                  {rca.culprit_file && (
                    <div className="flex items-center gap-1.5 text-xs text-zinc-400 font-mono bg-background/80 px-2 py-1 rounded-md border border-border">
                      <FileCode2 className="h-3.5 w-3.5 text-primary" />
                      {rca.culprit_file}
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="text-base font-bold text-foreground">{rca.title}</h3>
                  <p className="text-xs leading-relaxed text-muted-foreground mt-1.5">{rca.summary}</p>
                </div>

                {/* Remediation Plan */}
                {rca.remediation_steps && rca.remediation_steps.length > 0 && (
                  <div className="rounded-lg border border-border/80 bg-background/60 p-3.5 space-y-2">
                    <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <Wand2 className="h-3.5 w-3.5 text-primary" />
                      Recommended Remediation Action Plan
                    </span>
                    <ul className="space-y-1.5">
                      {rca.remediation_steps.map((step: string, idx: number) => (
                        <li key={idx} className="text-xs text-muted-foreground flex items-start gap-2">
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
                            {idx + 1}
                          </span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Monorepo Sub-Services Discovery Card */}
              {subservices.length > 0 && (
                <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-sky-400 flex items-center gap-1.5">
                      <FolderGit2 className="h-4 w-4" />
                      Discovered Runnable Sub-Services in Repository
                    </span>
                    <Badge variant="outline" className="text-[10px] border-sky-500/40 text-sky-400">
                      Monorepo Target
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    This repository contains modular sub-directories that can be independently deployed as containerized web services:
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {subservices.map((svc) => (
                      <Badge
                        key={svc}
                        variant="secondary"
                        className="font-mono text-xs px-2.5 py-1 bg-sky-500/15 text-sky-300 border border-sky-500/30 flex items-center gap-1.5"
                      >
                        <Layers className="h-3 w-3" />
                        {svc}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Unsupported Archetype Alert (iOS / Android / Library) */}
              {archetype && (archetype === "native_ios" || archetype === "native_android" || archetype === "library") && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-rose-400 font-semibold text-xs">
                    <ShieldAlert className="h-4 w-4" />
                    Architecture Advisory
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Native mobile apps (Xcode / Android SDK) or pure libraries cannot execute as standalone Linux web daemons.
                    StackPilot has prevented wasteful compilation cycles. To deploy web endpoints, specify a server entrypoint or target a monorepo sub-service.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer with Action Buttons */}
        <DialogFooter className="shrink-0 border-t border-border bg-muted/20 px-6 py-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/dashboard/ai?deploymentId=${deployment.id}&command=repair`)}
              className="text-xs gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Chat with SRE Agent
            </Button>
          </div>

          <div className="flex items-center gap-2">
            {/* Rollback Button */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => rollbackMutation.mutate()}
              disabled={rollbackMutation.isPending}
              className="text-xs gap-1.5 border-border bg-background hover:bg-muted"
            >
              {rollbackMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Rollback Checkpoint
            </Button>

            {/* Accept & Auto-Redeploy Button */}
            <Button
              variant="default"
              size="sm"
              onClick={() => repairMutation.mutate()}
              disabled={repairMutation.isPending || !rca?.can_auto_repair}
              className="text-xs gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 shadow-md font-semibold"
            >
              {repairMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5 fill-current" />
              )}
              Accept & Auto-Redeploy
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
