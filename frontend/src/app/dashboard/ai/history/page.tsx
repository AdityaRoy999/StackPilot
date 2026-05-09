"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  Loader2,
  Star,
  XCircle,
  Zap,
} from "lucide-react";

import api from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface AiRun {
  id: string;
  workflow_type: string;
  provider: string;
  model: string;
  status: string;
  confidence: number;
  summary: string;
  trace_id: string;
  latency_ms: number;
  created_at: string;
  project_id?: string;
  deployment_id?: string;
}

const workflowLabels: Record<string, { label: string; color: string }> = {
  agent_chat: { label: "Agent Chat", color: "bg-blue-500/15 text-blue-700 dark:text-blue-400" },
  project_analysis: { label: "Project Analysis", color: "bg-purple-500/15 text-purple-700 dark:text-purple-400" },
  project_chat: { label: "Project Chat", color: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400" },
  dockerfile_generation: { label: "Dockerfile", color: "bg-green-500/15 text-green-700 dark:text-green-400" },
  build_failure_analysis: { label: "Build Failure", color: "bg-orange-500/15 text-orange-700 dark:text-orange-400" },
  analyze_build_failure: { label: "Build Failure", color: "bg-orange-500/15 text-orange-700 dark:text-orange-400" },
  runtime_troubleshooting: { label: "Runtime", color: "bg-red-500/15 text-red-700 dark:text-red-400" },
  analyze_runtime_failure: { label: "Runtime Failure", color: "bg-red-500/15 text-red-700 dark:text-red-400" },
};

const pageSize = 8;

function confidenceColor(confidence: number) {
  if (confidence >= 0.8) return "text-green-600 dark:text-green-400";
  if (confidence >= 0.5) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

function formatDate(dateString: string) {
  try {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return dateString;
  }
}

function formatLatency(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function AiHistoryPage() {
  const [workflowFilter, setWorkflowFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  const runsQuery = useQuery({
    queryKey: ["ai-runs"],
    queryFn: async () => {
      const res = await api.get("/ai/runs");
      const data = res.data as { runs?: AiRun[] };
      return data.runs || [];
    },
    refetchInterval: 15000,
  });

  const runs = runsQuery.data || [];

  const filteredRuns = runs.filter((run) => {
    if (workflowFilter !== "all" && run.workflow_type !== workflowFilter) return false;
    if (statusFilter !== "all" && run.status !== statusFilter) return false;
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(filteredRuns.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedRuns = filteredRuns.slice((safePage - 1) * pageSize, safePage * pageSize);

  const uniqueWorkflows = [...new Set(runs.map((r) => r.workflow_type))];
  const uniqueStatuses = [...new Set(runs.map((r) => r.status))];

  const totalRuns = runs.length;
  const avgLatency = runs.length > 0 ? Math.round(runs.reduce((acc, r) => acc + r.latency_ms, 0) / runs.length) : 0;
  const avgConfidence =
    runs.length > 0 ? Math.round((runs.reduce((acc, r) => acc + r.confidence, 0) / runs.length) * 100) : 0;
  const failedRuns = runs.filter((r) => r.status === "failed").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/ai">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold">AI Run History</h1>
            <p className="text-sm text-muted-foreground">All AI agent workflow executions</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => runsQuery.refetch()} disabled={runsQuery.isFetching}>
          {runsQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Refresh"}
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Star className="h-4 w-4" />
            Total Runs
          </div>
          <p className="mt-1 text-2xl font-bold">{totalRuns}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            Avg Latency
          </div>
          <p className="mt-1 text-2xl font-bold">{formatLatency(avgLatency)}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <BrainCircuit className="h-4 w-4" />
            Avg Confidence
          </div>
          <p className={cn("mt-1 text-2xl font-bold", confidenceColor(avgConfidence / 100))}>{avgConfidence}%</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <XCircle className="h-4 w-4" />
            Failed
          </div>
          <p className={cn("mt-1 text-2xl font-bold", failedRuns > 0 ? "text-red-500" : "text-green-500")}>
            {failedRuns}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Filter className="h-4 w-4" />
          Filters:
        </div>
        <label className="relative inline-flex">
          <select
            value={workflowFilter}
            onChange={(event) => {
              setWorkflowFilter(event.target.value || "all");
              setPage(1);
            }}
            className="h-8 w-[180px] appearance-none rounded-lg border border-border bg-card px-3 pr-8 text-sm text-foreground outline-none transition-colors hover:bg-accent focus:ring-2 focus:ring-ring"
            aria-label="Workflow filter"
          >
            <option value="all">All workflows</option>
            {uniqueWorkflows.map((wf) => (
              <option key={wf} value={wf}>
                {workflowLabels[wf]?.label || wf}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </label>
        <label className="relative inline-flex">
          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value || "all");
              setPage(1);
            }}
            className="h-8 w-[150px] appearance-none rounded-lg border border-border bg-card px-3 pr-8 text-sm text-foreground outline-none transition-colors hover:bg-accent focus:ring-2 focus:ring-ring"
            aria-label="Status filter"
          >
            <option value="all">All statuses</option>
            {uniqueStatuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </label>
        <span className="text-xs text-muted-foreground">
          {filteredRuns.length} of {runs.length} runs
        </span>
      </div>

      {/* Runs Table */}
      {runsQuery.isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading AI runs...
        </div>
      ) : filteredRuns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-12 text-center">
          <Star className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {runs.length === 0
              ? "No AI runs yet. Use the Agent Playground to start analyzing projects and deployments."
              : "No runs match the current filters."}
          </p>
          {runs.length === 0 && (
            <Link href="/dashboard/ai">
              <Button variant="outline" size="sm" className="mt-4">
                Open Agent Playground
              </Button>
            </Link>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">Workflow</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="w-24 text-center">Status</TableHead>
                <TableHead className="w-28 text-center">Confidence</TableHead>
                <TableHead className="w-24 text-right">Latency</TableHead>
                <TableHead className="hidden w-64 lg:table-cell">Summary</TableHead>
                <TableHead className="w-36 text-right">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedRuns.map((run) => {
                const wf = workflowLabels[run.workflow_type] || {
                  label: run.workflow_type,
                  color: "bg-muted text-muted-foreground",
                };
                const confidence = Math.round(run.confidence * 100);

                return (
                  <TableRow key={run.id} className="group">
                    <TableCell>
                      <Badge variant="outline" className={cn("text-xs", wf.color)}>
                        {wf.label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Zap className="h-3 w-3 text-muted-foreground" />
                        <span className="max-w-48 truncate text-xs">{run.model || "-"}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      {run.status === "completed" ? (
                        <Badge variant="outline" className="bg-green-500/10 text-green-600 dark:text-green-400">
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          OK
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="text-xs">
                          <XCircle className="mr-1 h-3 w-3" />
                          Fail
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <span className={cn("text-sm font-medium", confidenceColor(run.confidence))}>
                        {confidence}%
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="text-xs text-muted-foreground">{formatLatency(run.latency_ms)}</span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <p className="max-w-xs truncate text-xs text-muted-foreground" title={run.summary}>
                        {run.summary || "-"}
                      </p>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="text-xs text-muted-foreground">{formatDate(run.created_at)}</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {filteredRuns.length > pageSize && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-muted-foreground">
            Page {safePage} of {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={safePage === 1}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={safePage === totalPages}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
