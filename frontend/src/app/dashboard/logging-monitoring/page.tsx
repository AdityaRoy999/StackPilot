"use client";

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
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useMutation, useQuery } from "@tanstack/react-query";

import api from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
const chartAxisColor = "#a1a1aa";
const chartGridColor = "#27272a";
const chartTooltipBackground = "#18181b";
const chartTooltipBorder = "#3f3f46";
const chartTooltipText = "#fafafa";
const chartCursorColor = "#27272a";

function countMapToRows(map?: CountMap) {
  return Object.entries(map || {}).map(([name, value]) => ({
    name,
    value,
  }));
}

function totalCount(map?: CountMap) {
  return Object.values(map || {}).reduce((sum, value) => sum + value, 0);
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
  icon: Icon,
}: {
  title: string;
  description: string;
  href: string;
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
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            render={
              <a href={href} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              Open
              </a>
            }
          />
        </CardAction>
      </CardHeader>
    </Card>
  );
}

export default function LoggingMonitoringPage() {
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
    queryKey: ["logging-monitoring-deployments-fallback"],
    queryFn: async () => {
      const response = await api.get<{ deployments: DeploymentListItem[] }>("/deployments");
      return response.data.deployments || [];
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
    const fallbackFailed = (deploymentsQuery.data || []).filter(
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
          <RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Refresh
        </Button>
      </section>

      {isError && (
        <Card size="sm" className="border-destructive/30 bg-destructive/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
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
              <CheckCircle2 className="h-4 w-4 text-primary" />
              Platform
            </CardTitle>
            <CardDescription>{data?.service || "dokscp-backend"}</CardDescription>
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
              <Server className="h-4 w-4 text-muted-foreground" />
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
              <Activity className="h-4 w-4 text-muted-foreground" />
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
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
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
            href={data.stack.prometheus_url}
            icon={Gauge}
          />
          <StackCard
            title="Grafana"
            description="Dashboards for metrics and logs."
            href={data.stack.grafana_url}
            icon={BarChart3}
          />
          <StackCard
            title="Loki"
            description="Stores Docker service logs."
            href={data.stack.loki_url}
            icon={Database}
          />
        </section>
      )}

      <section className="grid gap-3 xl:grid-cols-3">
        <Card size="sm" className="xl:col-span-1">
          <CardHeader>
            <CardTitle>Deployment Status</CardTitle>
            <CardDescription>{totalCount(data?.deployments.by_status)} deployments</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            {mounted ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={deploymentStatusRows} dataKey="value" nameKey="name" innerRadius={62} outerRadius={96}>
                  {deploymentStatusRows.map((entry, index) => (
                    <Cell key={entry.name} fill={chartColors[index % chartColors.length]} />
                  ))}
                </Pie>
                <RechartsTooltip
                  contentStyle={{
                    background: chartTooltipBackground,
                    border: `1px solid ${chartTooltipBorder}`,
                    color: chartTooltipText,
                  }}
                  itemStyle={{ color: chartTooltipText }}
                  labelStyle={{ color: chartTooltipText }}
                />
              </PieChart>
            </ResponsiveContainer>
            ) : null}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Runtime Providers</CardTitle>
            <CardDescription>Docker, Kubernetes, local, and remote targets</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            {mounted ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={runtimeRows}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} />
                <XAxis dataKey="name" tick={{ fill: chartAxisColor }} />
                <YAxis allowDecimals={false} tick={{ fill: chartAxisColor }} />
                <RechartsTooltip
                  cursor={{ fill: chartCursorColor, fillOpacity: 0.35 }}
                  contentStyle={{
                    background: chartTooltipBackground,
                    border: `1px solid ${chartTooltipBorder}`,
                    color: chartTooltipText,
                  }}
                  itemStyle={{ color: chartTooltipText }}
                  labelStyle={{ color: chartTooltipText }}
                />
                <Bar dataKey="value" fill="#3b82f6" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            ) : null}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Job Queue</CardTitle>
            <CardDescription>Build queue and worker health</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            {mounted ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={jobRows}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} />
                <XAxis dataKey="name" tick={{ fill: chartAxisColor }} />
                <YAxis allowDecimals={false} tick={{ fill: chartAxisColor }} />
                <RechartsTooltip
                  cursor={{ fill: chartCursorColor, fillOpacity: 0.35 }}
                  contentStyle={{
                    background: chartTooltipBackground,
                    border: `1px solid ${chartTooltipBorder}`,
                    color: chartTooltipText,
                  }}
                  itemStyle={{ color: chartTooltipText }}
                  labelStyle={{ color: chartTooltipText }}
                />
                <Bar dataKey="value" fill="#f59e0b" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            ) : null}
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
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Star className="h-4 w-4" fill="currentColor" strokeWidth={2.4} />
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
