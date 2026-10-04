"use client";
import { remoteRuntimeHref } from "@/lib/remote-platform";
import { useRemotePlatform } from "@/lib/use-remote-platform";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Database,
  ExternalLink,
  Gauge,
  Loader2,
  RefreshCw,
  Server,
  Star,
} from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { ModernChart } from "@/components/ui/modern-chart";

import { useChartTheme } from "@/lib/canvas-theme";
import { useMutation, useQuery } from "@tanstack/react-query";

import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type CountMap = Record<string, number>;

interface LoggingMonitoringSummary {
  status: "ok" | "degraded";
  service: string;
  timestamp: string;
  database_connected: boolean;
  stack: {
    prometheus_url: string;
    grafana_url: string;
    loki_url: string;
    metrics_endpoint: string;
    prometheus_available?: boolean;
    grafana_available?: boolean;
    loki_available?: boolean;
  };
  projects: {
    active: number;
  };
  deployments: {
    total: number;
    running: number;
    failed_current: number;
    failed_last_24h: number;
    by_status: CountMap;
    by_runtime: CountMap;
  };
  jobs: {
    by_status: CountMap;
  };
  recent_failures: Array<{
    deployment_id: string;
    project_name: string;
    version: string;
    status: string;
    created_at: string;
    log_excerpt: string;
  }>;
}

interface DeploymentListItem {
  id: string;
  status: string;
}

type RecentFailure = LoggingMonitoringSummary["recent_failures"][number];

const chartColors = [
  "#22c55e",
  "#3b82f6",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
];

function countMapToRows(map?: CountMap) {
  return Object.entries(map || {})
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([name, value]) => ({
      name: name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      value,
      key: name.toLowerCase(),
    }))
    .sort((a, b) => b.value - a.value);
}

function totalCount(map?: CountMap) {
  return Object.values(map || {}).reduce((sum, value) => sum + value, 0);
}

function metricColor(name: string, index: number) {
  const normalized = name.toLowerCase();
  if (["running", "built", "completed", "healthy", "success"].some((value) => normalized.includes(value))) return "#22c55e";
  if (["failed", "error", "unhealthy"].some((value) => normalized.includes(value))) return "#ef4444";
  if (["queued", "pending", "waiting"].some((value) => normalized.includes(value))) return "#f59e0b";
  if (["building", "processing", "active"].some((value) => normalized.includes(value))) return "#3b82f6";
  return chartColors[index % chartColors.length];
}

function ChartEmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-52 flex-col items-center justify-center rounded-md border border-dashed border-border/70 bg-muted/15 px-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm">
        <AppIcon name="bar-chart-3" fallback={BarChart3} className="size-5" />
      </span>
      <p className="mt-3 text-sm font-medium">No metrics yet</p>
      <p className="mt-1 max-w-56 text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

function ChartLegend({ rows }: { rows: ReturnType<typeof countMapToRows> }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5" aria-label="Chart legend">
      {rows.map((row, index) => (
        <div key={row.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-2 rounded-full" style={{ backgroundColor: metricColor(row.key, index) }} />
          <span>{row.name}</span>
          <span className="font-medium tabular-nums text-foreground">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function statusVariant(status: string): "default" | "destructive" | "outline" {
  if (["running", "built", "completed", "ok"].includes(status)) return "default";
  if (["failed", "degraded"].includes(status)) return "destructive";
  return "outline";
}

function tailText(value: string, limit = 5000) {
  if (!value || value.length <= limit) return value || "";
  return value.slice(-limit);
}

function buildFailureExplainPrompt(failure: RecentFailure) {
  return [
    "Explain this deployment failure clearly and helpfully.",
    "",
    `Project: ${failure.project_name}`,
    `Version: ${failure.version || "-"}`,
    `Status: ${failure.status || "failed"}`,
    `Deployment ID: ${failure.deployment_id}`,
    "",
    "Use these sections:",
    "## What happened",
    "## Why it happened",
    "## How to fix it",
    "## Next action",
    "",
    "Log excerpt:",
    "```text",
    tailText(failure.log_excerpt),
    "```",
  ].join("\n");
}

function StackCard({
  title,
  description,
  href,
  available,
  icon: Icon,
}: {
  title: string;
  description: string;
  href: string;
  available?: boolean;
  icon: typeof Activity;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
        <div className={cn("mt-1 text-xs", available === undefined ? "text-muted-foreground" : available ? "text-emerald-500" : "text-destructive")}>{available === undefined ? "Status not checked" : available ? "Service ready" : "Service unavailable"}</div>
        <CardAction>
          <a
            href={available === false ? undefined : href}
            aria-disabled={available === false}
            tabIndex={available === false ? -1 : undefined}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5", available === false && "pointer-events-none opacity-50")}
          >
            <AppIcon name="external-link" fallback={ExternalLink} className="h-4 w-4"  />
            <span>{available === false ? "Unavailable" : "Open"}</span>
          </a>
        </CardAction>
      </CardHeader>
    </Card>
  );
}

export default function LoggingMonitoringPage() {
  const remotePlatform = useRemotePlatform();
  // Axes, gridlines and tooltips follow the active theme. The series colours
  // below stay fixed: they are a legend, not chrome.
  const {
    axis: chartAxisColor,
    grid: chartGridColor,
    tooltipBackground: chartTooltipBackground,
    tooltipBorder: chartTooltipBorder,
    tooltipText: chartTooltipText,
  } = useChartTheme();

  const [mounted, setMounted] = useState(false);
  const [failureExplanationOpen, setFailureExplanationOpen] = useState(false);
  const [failureExplanation, setFailureExplanation] = useState<{
    failure: RecentFailure;
    content: string;
    model?: string;
  } | null>(null);
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["logging-monitoring-summary"],
    queryFn: async () => {
      const response = await api.get<LoggingMonitoringSummary>("/logging-monitoring/summary");
      return response.data;
    },
    refetchInterval: 5000,
  });
  const deploymentsQuery = useQuery({
    // Namespaced under "deployments" so the existing
    // invalidateQueries({queryKey:["deployments"]}) calls reach this entry too;
    // as a standalone key it silently went stale after every mutation.
    queryKey: ["deployments", "logging-fallback"],
    queryFn: async () => {
      const response = await api.get<{ deployments: DeploymentListItem[] }>("/deployments");
      if (!Array.isArray(response.data?.deployments)) {
        throw new Error("The deployments response did not contain a list");
      }
      return response.data.deployments;
    },
    refetchInterval: 5000,
  });

  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const deploymentStatusRows = useMemo(
    () => countMapToRows(data?.deployments.by_status),
    [data?.deployments.by_status]
  );
  const runtimeRows = useMemo(
    () => countMapToRows(data?.deployments.by_runtime),
    [data?.deployments.by_runtime]
  );
  const jobRows = useMemo(() => countMapToRows(data?.jobs.by_status), [data?.jobs.by_status]);
  const queuedJobs = data?.jobs.by_status?.queued || 0;
  const activeJobs =
    (data?.jobs.by_status?.running || 0) +
    (data?.jobs.by_status?.building || 0) +
    (data?.jobs.by_status?.processing || 0);
  const failedDeployments = useMemo(() => {
    const summaryFailed = data
      ? Math.max(
          data.deployments.failed_current ?? 0,
          data.deployments.failed_last_24h ?? 0,
          data.deployments.by_status?.failed ?? 0,
          data.recent_failures?.length ?? 0
        )
      : 0;
    const fallbackFailed = (Array.isArray(deploymentsQuery.data) ? deploymentsQuery.data : []).filter(
      (deployment) => deployment.status?.toLowerCase() === "failed"
    ).length;
    return Math.max(summaryFailed, fallbackFailed);
  }, [data, deploymentsQuery.data]);

  const explainFailureMutation = useMutation({
    mutationFn: async (failure: RecentFailure) => {
      const response = await api.post(
        "/ai/chat",
        {
          message: buildFailureExplainPrompt(failure),
          command: "explain_failure",
          model: "",
          model_mode: "fast",
          deployment_id: failure.deployment_id,
          runtime: {
            status: failure.status || "failed",
            source: "logging_monitoring_recent_failure",
          },
        },
        { timeout: 60000 }
      );
      return {
        failure,
        content: response.data?.summary || response.data?.error || "AI did not return an explanation.",
        model: response.data?.model as string | undefined,
      };
    },
    onMutate: (failure) => {
      setFailureExplanation({
        failure,
        content: "Preparing a fast AI explanation...",
        model: "fast model",
      });
      setFailureExplanationOpen(true);
    },
    onSuccess: (result) => {
      setFailureExplanation(result);
      setFailureExplanationOpen(true);
    },
    onError: (error, failure) => {
      setFailureExplanation({
        failure,
        content: error instanceof Error ? error.message : "AI explanation failed.",
        model: "AI",
      });
      setFailureExplanationOpen(true);
    },
  });

  return (
    <div className="space-y-3">
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight">Logs & Monitoring</h1>
          <p className="mt-2 max-w-3xl text-lg text-muted-foreground">
            Monitor deployments, queues, runtime health, logs, and platform signals.
          </p>
        </div>
        <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <AppIcon name="refresh-cw" fallback={RefreshCw} className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"}  />
          Refresh
        </Button>
      </section>

      {isError && (
        <Card size="sm" className="border-destructive/30 bg-destructive/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AppIcon name="alert-triangle" fallback={AlertTriangle} className="h-5 w-5"  />
              Logs & Monitoring summary unavailable
            </CardTitle>
            <CardDescription>
              The backend summary endpoint could not be reached. Check the backend container and session.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AppIcon name="check-circle2" fallback={CheckCircle2} className="h-4 w-4 text-primary"  />
              Platform
            </CardTitle>
            <CardDescription>{data?.service || "stackpilot-backend"}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{isLoading ? "-" : data?.status || "degraded"}</div>
            <Badge className="mt-3" variant={statusVariant(data?.status || "degraded")}>
              {data?.database_connected ? "Database connected" : "Database degraded"}
            </Badge>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AppIcon name="server" fallback={Server} className="h-4 w-4 text-muted-foreground"  />
              Runtimes
            </CardTitle>
            <CardDescription>Live deployments</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{data?.deployments.running ?? "-"}</div>
            <p className="mt-2 text-sm text-muted-foreground">
              {data?.deployments.total ?? 0} total deployments tracked
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AppIcon name="activity" fallback={Activity} className="h-4 w-4 text-muted-foreground"  />
              Jobs
            </CardTitle>
            <CardDescription>Queue pressure</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{queuedJobs}</div>
            <p className="mt-2 text-sm text-muted-foreground">{activeJobs} currently active</p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AppIcon name="alert-triangle" fallback={AlertTriangle} className="h-4 w-4 text-muted-foreground"  />
              Errors
            </CardTitle>
            <CardDescription>Tracked failures</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{isLoading ? "-" : failedDeployments}</div>
            <p className="mt-2 text-sm text-muted-foreground">Failed deployments</p>
          </CardContent>
        </Card>
      </section>

      {data && (
        <section className="grid gap-3 lg:grid-cols-3">
          <StackCard
            title="Prometheus"
            description="Scrapes backend and container metrics."
            href={remoteRuntimeHref(data.stack.prometheus_url, undefined, remotePlatform)}
            available={data.stack.prometheus_available}
            icon={Gauge}
          />
          <StackCard
            title="Grafana"
            description="Dashboards for metrics and logs."
            href={remoteRuntimeHref(data.stack.grafana_url, undefined, remotePlatform)}
            available={data.stack.grafana_available}
            icon={BarChart3}
          />
          <StackCard
            title="Loki"
            description="Stores Docker service logs."
            href={remoteRuntimeHref(data.stack.loki_url, undefined, remotePlatform)}
            available={data.stack.loki_available}
            icon={Database}
          />
        </section>
      )}

      <section className="grid gap-3 xl:grid-cols-3">
        <Card size="sm" className="overflow-hidden xl:col-span-1">
          <CardHeader>
            <CardTitle>Deployment Status</CardTitle>
            <CardDescription>{totalCount(data?.deployments.by_status)} deployments</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            {!mounted ? null : deploymentStatusRows.length === 0 ? (
              <ChartEmptyState message="Deployment status appears as soon as the first release is created." />
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="relative min-h-0 flex-1">
                  <ModernChart option={{
                    animationDuration: 250,
                    tooltip: { trigger: "item", backgroundColor: chartTooltipBackground, borderColor: chartTooltipBorder, textStyle: { color: chartTooltipText } },
                    series: [{ type: "pie", radius: ["60%", "84%"], center: ["50%", "50%"], avoidLabelOverlap: true, label: { show: false },
                      itemStyle: { borderRadius: 6, borderColor: "transparent" },
                      data: deploymentStatusRows.map((entry, index) => ({ name: entry.name, value: entry.value, itemStyle: { color: metricColor(entry.key, index) } })) }],
                  }} />
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-3xl font-semibold tabular-nums">{totalCount(data?.deployments.by_status)}</span>
                    <span className="text-[11px] text-muted-foreground">Deployments</span>
                  </div>
                </div>
                <ChartLegend rows={deploymentStatusRows} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card size="sm" className="overflow-hidden">
          <CardHeader>
            <CardTitle>Runtime Providers</CardTitle>
            <CardDescription>Docker, Kubernetes, local, and remote targets</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            {!mounted ? null : runtimeRows.length === 0 ? (
              <ChartEmptyState message="Runtime distribution will populate when a deployment starts." />
            ) : (
              <div className="h-full w-full min-w-0">
                <ModernChart option={{
                    animationDuration: 250,
                    grid: { left: 100, right: 20, top: 16, bottom: 32 },
                    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: chartTooltipBackground, borderColor: chartTooltipBorder, textStyle: { color: chartTooltipText } },
                    xAxis: { type: "value", minInterval: 1, axisLabel: { color: chartAxisColor }, splitLine: { lineStyle: { color: chartGridColor, type: "dashed" } } },
                    yAxis: { type: "category", data: runtimeRows.map((row) => row.name), axisLabel: { color: chartAxisColor }, axisLine: { show: false }, axisTick: { show: false } },
                    series: [{ type: "bar", name: "Deployments", data: runtimeRows.map((row) => row.value), barMaxWidth: 30,
                      itemStyle: { borderRadius: [0, 6, 6, 0], color: { type: "linear", x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: "#2563eb" }, { offset: 1, color: "#22c55e" }] } } }],
                  }} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card size="sm" className="overflow-hidden">
          <CardHeader>
            <CardTitle>Job Queue</CardTitle>
            <CardDescription>Build queue and worker health</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            {!mounted ? null : jobRows.length === 0 ? (
              <ChartEmptyState message="Queue activity will appear when a build or background job is submitted." />
            ) : (
              <div className="h-full w-full min-w-0">
                <ModernChart option={{
                    animationDuration: 250,
                    grid: { left: 42, right: 12, top: 16, bottom: 34 },
                    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: chartTooltipBackground, borderColor: chartTooltipBorder, textStyle: { color: chartTooltipText } },
                    xAxis: { type: "category", data: jobRows.map((row) => row.name), axisLabel: { color: chartAxisColor }, axisLine: { show: false }, axisTick: { show: false } },
                    yAxis: { type: "value", minInterval: 1, axisLabel: { color: chartAxisColor }, splitLine: { lineStyle: { color: chartGridColor, type: "dashed" } } },
                    series: [{ type: "bar", name: "Jobs", barMaxWidth: 42, data: jobRows.map((row, index) => ({ value: row.value, itemStyle: { color: metricColor(row.key, index), borderRadius: [6, 6, 2, 2] } })) }],
                  }} />
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Recent Failures</CardTitle>
          <CardDescription>Latest failed deployments with the final log excerpt.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Log excerpt</TableHead>
                <TableHead className="w-36 text-right">AI</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.recent_failures || []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No failed deployments in the recent failure window.
                  </TableCell>
                </TableRow>
              ) : (
                data?.recent_failures.map((failure) => (
                  <TableRow key={failure.deployment_id}>
                    <TableCell className="font-medium">{failure.project_name}</TableCell>
                    <TableCell>{failure.version || "-"}</TableCell>
                    <TableCell>{formatDate(failure.created_at)}</TableCell>
                    <TableCell className="max-w-xl whitespace-normal font-mono text-xs text-muted-foreground">
                      {failure.log_excerpt || "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => explainFailureMutation.mutate(failure)}
                        disabled={explainFailureMutation.isPending}
                      >
                        {explainFailureMutation.isPending ? (
                          <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  />
                        ) : (
                          <AppIcon name="star" fallback={Star} className="h-4 w-4" fill="currentColor" strokeWidth={2.4}  />
                        )}
                        Explain
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={failureExplanationOpen} onOpenChange={setFailureExplanationOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>AI Failure Explanation</DialogTitle>
            <DialogDescription>
              {failureExplanation
                ? `${failureExplanation.failure.project_name} ${failureExplanation.failure.version || ""} | ${
                    failureExplanation.model || "AI"
                  }`
                : "Deployment failure explanation"}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-muted/30 p-4 text-sm leading-relaxed">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
                h2: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
                h3: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
                p: ({ children }) => <p className="mb-2 text-muted-foreground last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="mb-2 ml-5 list-disc space-y-1 text-muted-foreground">{children}</ul>,
                ol: ({ children }) => <ol className="mb-2 ml-5 list-decimal space-y-1 text-muted-foreground">{children}</ol>,
                strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                code: ({ children }) => (
                  <code className="rounded bg-background px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>
                ),
                pre: ({ children }) => (
                  <pre className="my-2 max-h-48 overflow-y-auto rounded-md bg-background p-3 text-xs text-foreground">
                    {children}
                  </pre>
                ),
              }}
            >
              {failureExplanation?.content || "No explanation loaded."}
            </ReactMarkdown>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
