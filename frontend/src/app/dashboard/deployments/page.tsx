"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import { AxiosError } from "axios";
import { Card, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Bot, Cpu, HardDrive, Loader2, Terminal, RefreshCw, CheckCircle, XCircle, Server, Maximize2, Minimize2, Pause, Play, Trash2, AlertTriangle, RotateCcw, Globe, Thermometer, Gauge, Search, SlidersHorizontal, ChevronLeft, ChevronRight, X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip as AppTooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Deployment {
  id: string;
  project_id: string;
  project_name: string;
  repo_url?: string;
  status: string;
  version: string;
  commit_hash: string;
  environment_id?: string;
  environment_name?: string;
  branch?: string;
  commit_sha?: string;
  trigger_source?: string;
  github_delivery_id?: string;
  image_name: string;
  k8s_namespace: string;
  k8s_deployment_name: string;
  k8s_service_name: string;
  k8s_ingress_name: string;
  desired_replicas: number;
  runtime_url: string;
  runtime_exposure: string;
  runtime_provider?: string;
  runtime_paused?: boolean;
  remote_container_name?: string;
  can_delete_image?: boolean;
  runtime_snapshot?: {
    image_name?: string;
    provider?: string;
    exposure_mode?: string;
  };
  created_at: string;
}

interface KubernetesRuntime {
  deployed: boolean;
  status: string;
  paused?: boolean;
  provider?: string;
  namespace?: string;
  deployment_name?: string;
  service_name?: string;
  ingress_name?: string;
  ingress_host?: string;
  exposure_mode?: string;
  desired_replicas?: number;
  ready_replicas?: number;
  runtime_url?: string;
  logs?: string;
  error?: string;
  container_name?: string;
  image?: string;
  started_at?: string;
  finished_at?: string;
  restart_count?: string;
  published_ports?: string;
}

interface RuntimeMetricSummary {
  available?: boolean;
  name?: string;
  deployment?: string;
  cpu_percent?: number | null;
  cpu_millicores?: number | null;
  memory_bytes?: number | null;
  memory_limit_bytes?: number | null;
  memory_percent?: number | null;
  network_rx_bytes?: number | null;
  network_tx_bytes?: number | null;
  block_read_bytes?: number | null;
  block_write_bytes?: number | null;
  pids?: number | null;
  container_status?: string;
  restart_count?: string;
  pod_count?: number | null;
  ready_pods?: number | null;
}

interface RuntimeMetricHost {
  cpu_name?: string;
  gpu_name?: string;
  host_memory_total_bytes?: number | null;
  sensor_scope?: string;
  cpu_temperature_celsius?: number | null;
  gpu_usage_percent?: number | null;
  gpu_memory_percent?: number | null;
  gpu_temperature_celsius?: number | null;
}

interface RuntimeMetricSeriesItem extends RuntimeMetricSummary {
  name: string;
}

interface RuntimeMetrics {
  deployment_id: string;
  provider: string;
  timestamp: string;
  available: boolean;
  message?: string;
  raw_error?: string;
  summary?: RuntimeMetricSummary;
  host?: RuntimeMetricHost;
  series?: RuntimeMetricSeriesItem[];
}

interface RuntimeMetricPoint {
  sample: number;
  time: string;
  cpu: number;
  memory: number;
  memoryBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

type RuntimeExposureMode = "ingress" | "nodeport";
type RuntimeResourcePreset = "small" | "medium" | "large";

interface RuntimeHealth {
  available: boolean;
  healthy: boolean;
  paused?: boolean;
  status_code?: number;
  response_time_ms?: number;
  runtime_url?: string;
  message?: string;
  checked_at?: string;
}

interface KubernetesEvents {
  available: boolean;
  events?: string;
  message?: string;
  checked_at?: string;
}

interface AiAnalysisResult {
  status: "ok" | "error";
  result_type: string;
  confidence?: number;
  summary?: string;
  structured_output?: Record<string, unknown>;
  warnings?: string[];
  requires_user_confirmation?: boolean;
  trace_id?: string;
  provider?: string;
  model?: string;
  latency_ms?: number;
  error?: string;
  run_id?: string;
}

interface DeploymentSocketMessage {
  type: "log" | "status" | "deployment_update" | "deployment_deleted";
  line?: string;
  status?: string;
  deployment_id?: string;
  deployment?: Deployment;
}

const STATUS_FILTER_OPTIONS = [
  { value: "queued", label: "Queued" },
  { value: "pending", label: "Pending" },
  { value: "building", label: "Building" },
  { value: "deploying", label: "Deploying" },
  { value: "built", label: "Built" },
  { value: "running", label: "Running" },
  { value: "failed", label: "Failed" },
];

const RUNTIME_FILTER_OPTIONS = [
  { value: "local_docker", label: "Local Docker" },
  { value: "remote_docker", label: "Remote Docker" },
  { value: "kubernetes", label: "Kubernetes" },
  { value: "ingress", label: "Kubernetes Ingress" },
  { value: "nodeport", label: "Kubernetes NodePort" },
];

const PAGE_SIZE_OPTIONS = [5, 10, 20];

interface DeploymentFilters {
  statuses: string[];
  runtimes: string[];
}

function getWebSocketBaseUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname;
  return process.env.NEXT_PUBLIC_WS_BASE_URL || `${protocol}//${host}:8090`;
}

function upsertDeployment(list: Deployment[], nextDeployment: Deployment) {
  const nextList = [...list];
  const index = nextList.findIndex((deployment) => deployment.id === nextDeployment.id);
  if (index >= 0) {
    const previous = nextList[index];
    nextList[index] = {
      ...previous,
      ...nextDeployment,
      project_name: nextDeployment.project_name || previous.project_name,
      repo_url: nextDeployment.repo_url || previous.repo_url,
      environment_id: nextDeployment.environment_id || previous.environment_id,
      environment_name: nextDeployment.environment_name || previous.environment_name,
      branch: nextDeployment.branch || previous.branch,
      commit_hash: nextDeployment.commit_hash || previous.commit_hash,
      commit_sha: nextDeployment.commit_sha || previous.commit_sha,
      trigger_source: nextDeployment.trigger_source || previous.trigger_source,
      github_delivery_id: nextDeployment.github_delivery_id || previous.github_delivery_id,
      created_at: nextDeployment.created_at || previous.created_at,
    };
  } else {
    nextList.unshift(nextDeployment);
  }

  return nextList.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

function formatRuntimeStatus(status: string | undefined) {
  if (!status) {
    return "-";
  }

  return status
    .split("_")
    .join(" ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeGitHubRepoUrl(repoUrl: string | undefined) {
  if (!repoUrl) {
    return "";
  }

  const trimmed = repoUrl.trim().replace(/\.git$/, "").replace(/\/$/, "");
  if (trimmed.startsWith("git@github.com:")) {
    return `https://github.com/${trimmed.slice("git@github.com:".length)}`;
  }

  return trimmed;
}

function realCommitSha(deployment: Partial<Deployment>) {
  const candidate = (deployment.commit_sha || deployment.commit_hash || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(candidate) ? candidate : "";
}

function githubCommitUrl(deployment: Partial<Deployment>) {
  const sha = realCommitSha(deployment);
  const repoUrl = normalizeGitHubRepoUrl(deployment.repo_url);
  if (!sha || !repoUrl.includes("github.com/")) {
    return "";
  }
  return `${repoUrl}/commit/${sha}`;
}

function shortCommit(sha: string) {
  return sha ? sha.slice(0, 7) : "-";
}

function normalizeRuntimeExposureMode(value: string | undefined): RuntimeExposureMode {
  return value?.toLowerCase() === "ingress" ? "ingress" : "nodeport";
}

function formatMetricNumber(value: number | null | undefined, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "Unavailable";
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)}${suffix}`;
}

function formatBytes(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "Unavailable";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(0, value);
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatGigabytes(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "Unavailable";
  }

  const gb = Math.max(0, value) / 1024 / 1024 / 1024;
  return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
}

function metricValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function truncateMiddle(value: string | undefined, maxLength = 42) {
  if (!value) {
    return "Unavailable";
  }
  if (value.length <= maxLength) {
    return value;
  }
  const keep = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function aiStringList(output: Record<string, unknown> | undefined, keys: string[]) {
  if (!output) {
    return [];
  }

  for (const key of keys) {
    const value = output[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") return JSON.stringify(item);
          return "";
        })
        .filter(Boolean)
        .slice(0, 5);
    }
    if (typeof value === "string" && value.trim()) {
      return [value.trim()];
    }
  }
  return [];
}

function aiRootCause(output: Record<string, unknown> | undefined) {
  if (!output) {
    return "";
  }
  for (const key of ["root_cause", "rootCause", "likely_root_cause", "diagnosis"]) {
    const value = output[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function detectBrowserGpuName() {
  if (typeof document === "undefined") {
    return "";
  }

  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  if (!gl || !("getExtension" in gl)) {
    return "";
  }

  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  if (!debugInfo) {
    return "";
  }

  const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
  return typeof renderer === "string" ? renderer : "";
}

function toggleListValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function hasRuntimeFilterMatch(deployment: Deployment, selectedRuntimes: string[]) {
  if (selectedRuntimes.length === 0) {
    return true;
  }

  const provider = deployment.runtime_provider?.toLowerCase() || "";
  const exposure = deployment.runtime_exposure?.toLowerCase() || "";
  const isRemoteDocker = provider === "remote_docker" || exposure === "remote_docker" || Boolean(deployment.remote_container_name);
  const isKubernetes =
    provider.includes("kubernetes") ||
    Boolean(deployment.k8s_deployment_name) ||
    exposure === "ingress" ||
    exposure === "nodeport";
  const isLocalDocker = Boolean(deployment.image_name) && !isRemoteDocker && !isKubernetes;

  return selectedRuntimes.some((runtime) => {
    switch (runtime) {
      case "local_docker":
        return isLocalDocker;
      case "remote_docker":
        return isRemoteDocker;
      case "kubernetes":
        return isKubernetes;
      case "ingress":
        return exposure === "ingress";
      case "nodeport":
        return exposure === "nodeport";
      default:
        return false;
    }
  });
}

export default function DeploymentsPage() {
  const [selectedDeployment, setSelectedDeployment] = useState<string | null>(null);
  const [runtimeDeployment, setRuntimeDeployment] = useState<Deployment | null>(null);
  const [metricsDeployment, setMetricsDeployment] = useState<Deployment | null>(null);
  const [deleteDeployment, setDeleteDeployment] = useState<Deployment | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState<DeploymentFilters>({ statuses: [], runtimes: [] });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  const queryClient = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["deployments"],
    queryFn: async () => {
      const res = await api.get("/deployments");
      return res.data;
    },
    refetchInterval: (query) => {
      const currentDeployments =
        (query.state.data as { deployments?: Deployment[] } | undefined)?.deployments || [];
      return currentDeployments.some((deployment) =>
        ["pending", "queued", "building", "deploying"].includes(deployment.status)
      )
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const deployments: Deployment[] = useMemo(() => data?.deployments || [], [data?.deployments]);
  const activeFilterCount = filters.statuses.length + filters.runtimes.length;
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredDeployments = useMemo(() => {
    return deployments.filter((deployment) => {
      const matchesSearch =
        normalizedSearchQuery.length === 0 ||
        [
          deployment.project_name,
          deployment.environment_name,
          deployment.branch,
          deployment.version,
          deployment.commit_hash,
          deployment.commit_sha,
          deployment.image_name,
          deployment.runtime_url,
          deployment.runtime_provider,
          deployment.runtime_exposure,
        ]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(normalizedSearchQuery));
      const matchesStatus =
        filters.statuses.length === 0 || filters.statuses.includes(deployment.status.toLowerCase());
      const matchesRuntime = hasRuntimeFilterMatch(deployment, filters.runtimes);

      return matchesSearch && matchesStatus && matchesRuntime;
    });
  }, [deployments, filters.runtimes, filters.statuses, normalizedSearchQuery]);
  const pageCount = Math.max(1, Math.ceil(filteredDeployments.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleDeployments = filteredDeployments.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const triggerBuildMutation = useMutation({
    mutationFn: async (deploymentId: string) => {
      const res = await api.post(`/deployments/${deploymentId}/trigger`);
      return res.data;
    },
    onSuccess: (_data, deploymentId) => {
      toast.success("Build started");
      setSelectedDeployment(deploymentId);
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      queryClient.invalidateQueries({ queryKey: ["deployment-logs", deploymentId] });
    },
    onError: (error: unknown) => {
      const maybeError = error as { response?: { data?: { error?: string } } };
      toast.error(maybeError.response?.data?.error || "Failed to start build");
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
    },
  });

  const deleteDeploymentMutation = useMutation({
    mutationFn: async ({ deploymentId, deleteImage }: { deploymentId: string; deleteImage: boolean }) => {
      const res = await api.delete(`/deployments/${deploymentId}`, {
        data: { delete_image: deleteImage },
      });
      return res.data;
    },
    onSuccess: (_data, variables) => {
      const deploymentId = variables.deploymentId;
      toast.success("Deployment deleted");
      queryClient.setQueryData(
        ["deployments"],
        (current: { deployments?: Deployment[]; count?: number } | undefined) => {
          const filtered = (current?.deployments || []).filter((deployment) => deployment.id !== deploymentId);
          return {
            deployments: filtered,
            count: filtered.length,
          };
        }
      );
      queryClient.removeQueries({ queryKey: ["deployment-logs", deploymentId] });
      queryClient.removeQueries({ queryKey: ["kubernetes-status", deploymentId] });
      queryClient.removeQueries({ queryKey: ["deployment-metrics", deploymentId] });
      if (selectedDeployment === deploymentId) {
        setSelectedDeployment(null);
      }
      if (runtimeDeployment?.id === deploymentId) {
        setRuntimeDeployment(null);
      }
      if (metricsDeployment?.id === deploymentId) {
        setMetricsDeployment(null);
      }
      setDeleteDeployment(null);
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to delete deployment"
          : "Failed to delete deployment";
      toast.error(message);
    },
  });

  useEffect(() => {
    const wsBaseUrl = getWebSocketBaseUrl();
    const socket = new WebSocket(`${wsBaseUrl}/ws/logs?stream=deployments`);

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as DeploymentSocketMessage;

        if (message.type === "deployment_update" && message.deployment) {
          queryClient.setQueryData(
            ["deployments"],
            (current: { deployments?: Deployment[]; count?: number } | undefined) => {
              const nextDeployments = upsertDeployment(current?.deployments || [], message.deployment as Deployment);
              return {
                deployments: nextDeployments,
                count: nextDeployments.length,
              };
            }
          );
          return;
        }

        if (message.type === "deployment_deleted" && message.deployment_id) {
          queryClient.setQueryData(
            ["deployments"],
            (current: { deployments?: Deployment[]; count?: number } | undefined) => {
              const filtered = (current?.deployments || []).filter(
                (deployment) => deployment.id !== message.deployment_id
              );
              return {
                deployments: filtered,
                count: filtered.length,
              };
            }
          );
          return;
        }
      } catch {
        // Ignore malformed socket messages and keep the page interactive.
      }
    };

    return () => {
      socket.close();
    };
  }, [queryClient]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "built":
        return (
          <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 gap-1">
            <CheckCircle className="w-3 h-3" /> Built
          </Badge>
        );
      case "running":
        return (
          <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 gap-1">
            <CheckCircle className="w-3 h-3" /> Running
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30 gap-1">
            <XCircle className="w-3 h-3" /> Failed
          </Badge>
        );
      case "building":
      case "queued":
      case "pending":
        return (
          <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 gap-1 capitalize">
            <Loader2 className="w-3 h-3 animate-spin" /> {status}
          </Badge>
        );
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Deployments</h1>
          <p className="text-muted-foreground mt-1">
            Complete history of your application builds and deployments.
          </p>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={isLoading}
            className="bg-card"
          >
            <RefreshCw className={cn("w-4 h-4 mr-2", isLoading && "animate-spin")} />
            Refresh
          </Button>
          <Button
            variant={isSearchOpen ? "secondary" : "outline"}
            onClick={() => setIsSearchOpen((open) => !open)}
            className="bg-card"
          >
            <Search className="mr-2 h-4 w-4" />
            Search
          </Button>
        </div>
      </div>

      {isSearchOpen && (
        <Card className="border-border bg-card p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor="deployment-search">Search deployments</Label>
              <Input
                id="deployment-search"
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Project, version, commit, image, runtime URL..."
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setIsFilterDialogOpen(true)} className="bg-card">
                <SlidersHorizontal className="mr-2 h-4 w-4" />
                Filters
                {activeFilterCount > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {activeFilterCount}
                  </Badge>
                )}
              </Button>
              {(searchQuery || activeFilterCount > 0) && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSearchQuery("");
                    setFilters({ statuses: [], runtimes: [] });
                    setPage(1);
                  }}
                >
                  <X className="mr-2 h-4 w-4" />
                  Clear
                </Button>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>
              Showing {filteredDeployments.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}-
              {Math.min(currentPage * pageSize, filteredDeployments.length)} of {filteredDeployments.length} deployments
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <span>Rows</span>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <Button
                  key={size}
                  type="button"
                  variant={pageSize === size ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => {
                    setPageSize(size);
                    setPage(1);
                  }}
                >
                  {size}
                </Button>
              ))}
            </div>
          </div>
        </Card>
      )}

      {isLoading && !deployments.length ? (
        <div className="flex h-64 items-center justify-center bg-card border border-border rounded-xl">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : deployments.length === 0 ? (
        <Card className="border-dashed border-border/80 ring-0 flex flex-col items-center justify-center py-20 bg-card">
          <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4">
            <Server className="w-6 h-6 text-muted-foreground" />
          </div>
          <CardTitle className="text-foreground">No deployments yet</CardTitle>
          <CardDescription>Trigger a build from the projects page to get started.</CardDescription>
        </Card>
      ) : filteredDeployments.length === 0 ? (
        <Card className="border-dashed border-border/80 ring-0 flex flex-col items-center justify-center py-20 bg-card">
          <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4">
            <Search className="w-6 h-6 text-muted-foreground" />
          </div>
          <CardTitle className="text-foreground">No matching deployments</CardTitle>
          <CardDescription>Adjust the search text or filters to widen the result set.</CardDescription>
        </Card>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Project</TableHead>
                <TableHead className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</TableHead>
                <TableHead className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Branch</TableHead>
                <TableHead className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Commit</TableHead>
                <TableHead className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Version</TableHead>
                <TableHead className="px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Date</TableHead>
                <TableHead className="w-px whitespace-nowrap px-6 py-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
                {visibleDeployments.map((dep) => {
                  const commitSha = realCommitSha(dep);
                  const commitUrl = githubCommitUrl(dep);
                  return (
                  <TableRow key={dep.id} className="hover:bg-muted/30 transition-colors group">
                    <TableCell className="px-6 py-4">
                      <div className="font-medium text-foreground">{dep.project_name}</div>
                      {dep.environment_name && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {dep.environment_name}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="px-6 py-4">{getStatusBadge(dep.status)}</TableCell>
                    <TableCell className="px-6 py-4">
                      <div className="font-mono text-sm text-foreground">{dep.branch || "-"}</div>
                    </TableCell>
                    <TableCell className="px-6 py-4">
                      {commitUrl ? (
                        <a
                          href={commitUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-sm text-primary hover:underline"
                          title={commitSha}
                        >
                          {shortCommit(commitSha)}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="font-mono text-sm text-muted-foreground">
                          {commitSha ? shortCommit(commitSha) : "-"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="px-6 py-4">
                      <span className="text-sm text-muted-foreground">{dep.version}</span>
                    </TableCell>
                    <TableCell className="px-6 py-4 text-sm text-muted-foreground">
                      {new Date(dep.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap">
                      <div className="ml-auto w-max max-w-full overflow-x-auto">
                        <div className="flex w-max items-center justify-end gap-2 whitespace-nowrap pb-1">
                        {(dep.status === "pending" || dep.status === "failed") && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => triggerBuildMutation.mutate(dep.id)}
                            disabled={triggerBuildMutation.isPending}
                            className="shrink-0 gap-2"
                          >
                            {triggerBuildMutation.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Play className="h-4 w-4 fill-current" />
                            )}
                            Build
                          </Button>
                        )}
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => setSelectedDeployment(dep.id)}
                          className="shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted"
                        >
                          <Terminal className="w-4 h-4 mr-2" />
                          Logs
                        </Button>
                        {dep.image_name && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRuntimeDeployment(dep)}
                            className="shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted"
                          >
                            <Server className="w-4 h-4 mr-2" />
                            Runtime
                          </Button>
                        )}
                        {dep.image_name && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setMetricsDeployment(dep)}
                            className="shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted"
                          >
                            <Activity className="w-4 h-4 mr-2" />
                            Metrics
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteDeployment(dep)}
                          className="shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Delete
                        </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                );
                })}
            </TableBody>
          </Table>

          <div className="flex flex-col gap-3 border-t border-border px-6 py-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>
              Page {currentPage} of {pageCount}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
                disabled={currentPage <= 1}
              >
                <ChevronLeft className="mr-2 h-4 w-4" />
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPage((currentPage) => Math.min(pageCount, currentPage + 1))}
                disabled={currentPage >= pageCount}
              >
                Next
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      <DeploymentFilterDialog
        key={`${isFilterDialogOpen}-${filters.statuses.join(",")}-${filters.runtimes.join(",")}`}
        open={isFilterDialogOpen}
        filters={filters}
        onOpenChange={setIsFilterDialogOpen}
        onApply={(nextFilters) => {
          setFilters(nextFilters);
          setPage(1);
        }}
      />

      {selectedDeployment && (
        <DeploymentLogsDialog 
          key={selectedDeployment}
          deploymentId={selectedDeployment} 
          onClose={() => setSelectedDeployment(null)} 
          onStartBuild={() => triggerBuildMutation.mutate(selectedDeployment)}
          isStartingBuild={triggerBuildMutation.isPending}
        />
      )}

      {runtimeDeployment && (
        <RuntimeDialog
          key={runtimeDeployment.id}
          deployment={runtimeDeployment}
          onClose={() => setRuntimeDeployment(null)}
          onViewLogs={(deploymentId) => {
            setRuntimeDeployment(null);
            setSelectedDeployment(deploymentId);
          }}
          onChanged={() => {
            queryClient.invalidateQueries({ queryKey: ["deployments"] });
            queryClient.invalidateQueries({ queryKey: ["deployment-logs", runtimeDeployment.id] });
          }}
        />
      )}

      {metricsDeployment && (
        <MetricsDialog
          key={metricsDeployment.id}
          deployment={metricsDeployment}
          onClose={() => setMetricsDeployment(null)}
        />
      )}

      {deleteDeployment && (
        <DeleteDeploymentDialog
          key={deleteDeployment.id}
          deployment={deleteDeployment}
          onClose={() => setDeleteDeployment(null)}
          onConfirm={(deleteImage) =>
            deleteDeploymentMutation.mutate({
              deploymentId: deleteDeployment.id,
              deleteImage: deleteImage === true,
            })
          }
          isDeleting={deleteDeploymentMutation.isPending}
        />
      )}
    </div>
  );
}

function DeploymentFilterDialog({
  open,
  filters,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  filters: DeploymentFilters;
  onOpenChange: (open: boolean) => void;
  onApply: (filters: DeploymentFilters) => void;
}) {
  const [draftFilters, setDraftFilters] = useState<DeploymentFilters>(filters);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5" />
            Deployment Filters
          </DialogTitle>
          <DialogDescription>
            Choose statuses and runtime types to narrow the deployment history.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <div className="space-y-3">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Status
            </Label>
            <div className="grid gap-3 sm:grid-cols-2">
              {STATUS_FILTER_OPTIONS.map((option) => (
                <Label
                  key={option.value}
                  htmlFor={`status-filter-${option.value}`}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2 font-normal"
                >
                  <Checkbox
                    id={`status-filter-${option.value}`}
                    checked={draftFilters.statuses.includes(option.value)}
                    onCheckedChange={() =>
                      setDraftFilters((current) => ({
                        ...current,
                        statuses: toggleListValue(current.statuses, option.value),
                      }))
                    }
                  />
                  <span>{option.label}</span>
                </Label>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Runtime
            </Label>
            <div className="grid gap-3 sm:grid-cols-2">
              {RUNTIME_FILTER_OPTIONS.map((option) => (
                <Label
                  key={option.value}
                  htmlFor={`runtime-filter-${option.value}`}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2 font-normal"
                >
                  <Checkbox
                    id={`runtime-filter-${option.value}`}
                    checked={draftFilters.runtimes.includes(option.value)}
                    onCheckedChange={() =>
                      setDraftFilters((current) => ({
                        ...current,
                        runtimes: toggleListValue(current.runtimes, option.value),
                      }))
                    }
                  />
                  <span>{option.label}</span>
                </Label>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setDraftFilters({ statuses: [], runtimes: [] })}
          >
            Clear
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onApply(draftFilters);
              onOpenChange(false);
            }}
          >
            Apply Filters
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeploymentLogsDialog({
  deploymentId,
  onClose,
  onStartBuild,
  isStartingBuild,
}: {
  deploymentId: string;
  onClose: () => void;
  onStartBuild: () => void;
  isStartingBuild: boolean;
}) {
  const [liveLogs, setLiveLogs] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: initialData } = useQuery({
    queryKey: ["deployment-logs", deploymentId],
    queryFn: async () => {
      const res = await api.get(`/deployments/${deploymentId}/logs`);
      return res.data;
    },
    enabled: !!deploymentId,
  });

  const initialLogs = initialData?.deployment?.logs || "";
  const initialDeployment = initialData?.deployment as Partial<Deployment> | undefined;
  const logCommitSha = initialDeployment ? realCommitSha(initialDeployment) : "";
  const logCommitUrl = initialDeployment ? githubCommitUrl(initialDeployment) : "";
  const hasCapturedFailureReason =
    initialLogs.includes("failed with exit code") ||
    initialLogs.includes("timed out after") ||
    initialLogs.includes("Failure reason") ||
    initialLogs.includes("Command exited with status");
  const displayLogs = liveLogs && liveLogs.length >= initialLogs.length ? liveLogs : initialLogs;
  const displayStatus = liveStatus ?? initialData?.deployment?.status ?? "loading";
  const displayLogTail = displayLogs.length > 5000 ? displayLogs.slice(-5000) : displayLogs;
  const buildFailureExplainPrompt = [
    "Explain this Docker/deployment build failure clearly and helpfully.",
    "",
    `Deployment ID: ${deploymentId}`,
    `Status: ${displayStatus}`,
    "",
    "Use these sections:",
    "## What happened",
    "## Why it happened",
    "## How to fix it",
    "## Next action",
    "",
    "Log excerpt:",
    "```text",
    displayLogTail,
    "```",
  ].join("\n");
  const buildAnalysisMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post(
        "/ai/chat",
        {
          message: buildFailureExplainPrompt,
          command: "explain_build_failure",
          model: "",
          model_mode: "fast",
          deployment_id: deploymentId,
          runtime: {
            status: displayStatus,
            source: "deployment_build_logs_dialog",
          },
        },
        { timeout: 60000 }
      );
      return res.data as AiAnalysisResult;
    },
    onSuccess: (result) => {
      if (result.status === "error") {
        toast.warning(result.summary || "AI analysis could not complete");
      } else {
        toast.success("AI build diagnosis ready");
      }
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "AI build analysis failed"
          : "AI build analysis failed";
      toast.error(message);
    },
  });
  const buildAnalysis = buildAnalysisMutation.data;
  const buildFixSteps = aiStringList(buildAnalysis?.structured_output, ["fix_steps", "steps", "suggested_fix", "commands"]);
  const buildRootCause = aiRootCause(buildAnalysis?.structured_output);

  useEffect(() => {
    if (!deploymentId) return;

    let isActive = true;

    const connectWebSocket = () => {
      if (!isActive) return;
      const wsBaseUrl = getWebSocketBaseUrl();
      const socket = new WebSocket(`${wsBaseUrl}/ws/logs?deploymentId=${deploymentId}`);
      
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as DeploymentSocketMessage;
          if (data.type === 'log') {
            setLiveLogs(prev => `${prev ?? initialLogs}${data.line ?? ""}\n`);
          } else if (data.type === 'status') {
            setLiveStatus(data.status ?? null);
          } else if (data.type === "deployment_deleted") {
            onClose();
          }
        } catch {
          setLiveLogs(prev => `${prev ?? initialLogs}${event.data}\n`);
        }
      };

      socket.onclose = () => {
        if (isActive) {
          reconnectTimerRef.current = setTimeout(connectWebSocket, 3000);
        }
      };

      socketRef.current = socket;
    };

    connectWebSocket();

    return () => {
      isActive = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [deploymentId, initialLogs, onClose]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayLogs]);

  return (
    <Dialog open={!!deploymentId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent 
        className={cn(
          "flex flex-col p-0 overflow-hidden border-border bg-card shadow-2xl transition-all duration-500 ease-in-out",
          isExpanded 
            ? "!max-w-[98vw] sm:!max-w-[98vw] !w-[98vw] h-[95vh] rounded-xl" 
            : "!max-w-[95vw] sm:!max-w-5xl !w-[95vw] sm:!w-auto h-[80vh] rounded-xl"
        )}
      >
        <DialogHeader className="p-6 border-b border-border bg-card relative">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <DialogTitle className="text-xl font-bold text-foreground flex items-center gap-2">
                <Terminal className="w-5 h-5 text-primary" />
                Build Logs
              </DialogTitle>
              <DialogDescription className="text-muted-foreground font-medium flex flex-wrap items-center gap-2">
                Deployment ID: <span className="font-mono text-xs">{deploymentId}</span>
                <span className="w-1 h-1 rounded-full bg-muted-foreground/40" />
                Branch: <span className="font-mono text-xs">{initialDeployment?.branch || "-"}</span>
                <span className="w-1 h-1 rounded-full bg-muted-foreground/40" />
                Commit:{" "}
                {logCommitUrl ? (
                  <a
                    href={logCommitUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                    title={logCommitSha}
                  >
                    {shortCommit(logCommitSha)}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="font-mono text-xs">{logCommitSha ? shortCommit(logCommitSha) : "-"}</span>
                )}
                <span className="w-1 h-1 rounded-full bg-muted-foreground/40" />
                Status: 
                <span className={cn(
                  "capitalize px-2 py-0.5 rounded text-xs font-semibold",
                  displayStatus === 'built' ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" :
                  displayStatus === 'failed' ? "bg-destructive/10 text-destructive" :
                  "bg-primary/10 text-primary"
                )}>
                  {displayStatus}
                </span>
              </DialogDescription>
            </div>
            
            <AppTooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="absolute top-4 right-12 z-50 h-8 w-8 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                  </Button>
                }
              />
              <TooltipContent side="top">{isExpanded ? "Shrink" : "Expand"}</TooltipContent>
            </AppTooltip>
          </div>
        </DialogHeader>
        
        <div 
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-6 font-mono text-[13px] leading-relaxed bg-background text-foreground border-t border-border scrollbar-thin"
        >
          <pre className="whitespace-pre-wrap break-all">
            {displayLogs || (
              displayStatus === "queued"
                ? "Build is queued. A background worker will start it shortly."
                : displayStatus === "pending"
                ? "Build has not started yet.\nClick Start build to clone the repository and build the Docker image."
                : "Initializing build engine...\nConnecting to logs stream..."
            )}
            {displayStatus === "failed" && displayLogs && !hasCapturedFailureReason
              ? "\n\nThis failed build does not include a complete failure summary. Re-run it to capture the exact exit code or timeout reason."
              : ""}
            {(displayStatus === 'building' || displayStatus === 'queued') && (
              <span className="inline-block w-2 h-4 ml-1 bg-primary animate-pulse align-middle" />
            )}
          </pre>
        </div>

        {buildAnalysis && (
          <div className="border-t border-border bg-card px-6 py-4">
            <div className="rounded-xl border border-border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-semibold text-foreground">
                    <Bot className="h-4 w-4 text-primary" />
                    AI build diagnosis
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap font-sans text-sm text-muted-foreground">
                    {buildAnalysis.summary || buildAnalysis.error || "No summary returned."}
                  </pre>
                </div>
                <Badge variant={buildAnalysis.status === "error" ? "destructive" : "outline"}>
                  {Math.round((buildAnalysis.confidence || 0) * 100)}% confidence
                </Badge>
              </div>
              {buildRootCause && (
                <p className="mt-3 rounded-lg border border-border bg-background/70 px-3 py-2 text-sm">
                  <span className="font-medium">Root cause: </span>
                  {buildRootCause}
                </p>
              )}
              {buildFixSteps.length > 0 && (
                <div className="mt-3 space-y-2">
                  <div className="text-xs font-semibold uppercase text-muted-foreground">Suggested fixes</div>
                  {buildFixSteps.map((step, index) => (
                    <div key={`${step}-${index}`} className="rounded-lg border border-border bg-background/70 px-3 py-2 text-sm">
                      {step}
                    </div>
                  ))}
                </div>
              )}
              {buildAnalysis.warnings && buildAnalysis.warnings.length > 0 && (
                <p className="mt-3 text-xs text-amber-600 dark:text-amber-300">{buildAnalysis.warnings[0]}</p>
              )}
            </div>
          </div>
        )}

        <div className="p-4 border-t border-border bg-muted/40 flex items-center justify-between">
          <div className="flex items-center text-xs text-muted-foreground gap-2">
            <div className={cn("w-2 h-2 rounded-full", displayStatus === 'building' || displayStatus === 'queued' ? 'bg-primary animate-pulse' : 'bg-muted-foreground/40')} />
            {displayStatus === 'building'
              ? 'Receiving real-time updates via WebSocket'
              : displayStatus === 'queued'
                ? 'Waiting for a background worker'
              : displayStatus === 'pending'
                ? 'Waiting for build trigger'
                : 'Log history loaded from database'}
          </div>
          <div className="flex items-center gap-2">
            {displayStatus === "failed" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => buildAnalysisMutation.mutate()}
                disabled={buildAnalysisMutation.isPending}
              >
                {buildAnalysisMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Bot className="mr-2 h-4 w-4" />}
                Diagnose
              </Button>
            )}
            {displayStatus === "pending" && (
              <Button size="sm" onClick={onStartBuild} disabled={isStartingBuild}>
                {isStartingBuild ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4 fill-current" />}
                Start build
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RuntimeDialog({
  deployment,
  onClose,
  onViewLogs,
  onChanged,
}: {
  deployment: Deployment;
  onClose: () => void;
  onViewLogs: (deploymentId: string) => void;
  onChanged: () => void;
}) {
  const [namespaceInput, setNamespaceInput] = useState(deployment.k8s_namespace || "dokscp-apps");
  const [replicasDraft, setReplicasDraft] = useState<string | null>(null);
  const [portInput, setPortInput] = useState("3000");
  const [resourcePreset, setResourcePreset] = useState<RuntimeResourcePreset>("small");
  const [healthPath, setHealthPath] = useState("/");
  const [eventsOpen, setEventsOpen] = useState(false);
  const [exposureMode, setExposureMode] = useState<RuntimeExposureMode>(
    normalizeRuntimeExposureMode(deployment.runtime_exposure)
  );
  const socketRef = useRef<WebSocket | null>(null);
  const queryClient = useQueryClient();
  const wantsLocalDocker =
    deployment.runtime_provider === "local_docker" ||
    deployment.runtime_exposure === "local_docker" ||
    deployment.runtime_snapshot?.provider === "local_docker" ||
    deployment.runtime_snapshot?.exposure_mode === "local_docker";

  const runtimeQuery = useQuery({
    queryKey: ["kubernetes-status", deployment.id],
    queryFn: async () => {
      const res = await api.get(`/deployments/${deployment.id}/kubernetes/status`);
      return res.data;
    },
    enabled: !!deployment.id,
  });

  const healthQuery = useQuery({
    queryKey: ["runtime-health", deployment.id],
    queryFn: async () => {
      const res = await api.get(`/deployments/${deployment.id}/runtime/health`);
      return res.data as RuntimeHealth;
    },
    enabled: !!deployment.id,
    refetchInterval: 7000,
  });

  const eventsQuery = useQuery({
    queryKey: ["kubernetes-events", deployment.id],
    queryFn: async () => {
      const res = await api.get(`/deployments/${deployment.id}/kubernetes/events`);
      return res.data as KubernetesEvents;
    },
    enabled: eventsOpen && !!deployment.id,
  });

  const deployMutation = useMutation({
    mutationFn: async () => {
      const containerPort = Number.parseInt(portInput, 10) || 3000;
      const res = wantsLocalDocker
        ? await api.post(`/deployments/${deployment.id}/docker/deploy`, {
            container_port: containerPort,
          })
        : await api.post(`/deployments/${deployment.id}/kubernetes/deploy`, {
            namespace: namespaceInput.trim(),
            exposure_mode: exposureMode,
            replicas: requestedReplicas,
            container_port: containerPort,
            resource_preset: resourcePreset,
            health_path: healthPath.trim() || "/",
          });
      return res.data;
    },
    onSuccess: () => {
      setReplicasDraft(null);
      toast.success(wantsLocalDocker ? "Local Docker runtime started" : "Kubernetes deployment started");
      runtimeQuery.refetch();
      onChanged();
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to deploy runtime"
          : "Failed to deploy runtime";
      toast.error(message);
    },
  });

  const scaleMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post(`/deployments/${deployment.id}/kubernetes/scale`, {
        replicas: requestedReplicas,
      });
      return res.data;
    },
    onSuccess: () => {
      setReplicasDraft(null);
      toast.success(`Runtime scaled to ${requestedReplicas} replicas`);
      runtimeQuery.refetch();
      onChanged();
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to scale runtime"
          : "Failed to scale runtime";
      toast.error(message);
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post(`/deployments/${deployment.id}/kubernetes/rollback`);
      return res.data;
    },
    onSuccess: () => {
      toast.success("Runtime rolled back");
      runtimeQuery.refetch();
      onChanged();
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to rollback runtime"
          : "Failed to rollback runtime";
      toast.error(message);
    },
  });

  const pauseResumeMutation = useMutation({
    mutationFn: async () => {
      const action = isPaused ? "resume" : "pause";
      const res = await api.post(`/deployments/${deployment.id}/runtime/${action}`);
      return res.data;
    },
    onSuccess: () => {
      toast.success(isPaused ? "Runtime resumed" : "Runtime paused");
      runtimeQuery.refetch();
      healthQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      onChanged();
    },
    onError: (error: unknown) => {
      const fallback = isPaused ? "Failed to resume runtime" : "Failed to pause runtime";
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || fallback
          : fallback;
      toast.error(message);
    },
  });

  const runtime: KubernetesRuntime | undefined = runtimeQuery.data?.runtime;
  const isRemoteDocker =
    runtime?.provider === "remote_docker" ||
    deployment.runtime_provider === "remote_docker" ||
    deployment.runtime_exposure === "remote_docker";
  const isLocalDocker =
    runtime?.provider === "local_docker" ||
    deployment.runtime_provider === "local_docker" ||
    deployment.runtime_exposure === "local_docker" ||
    wantsLocalDocker;
  const isPaused = Boolean(
    runtime?.paused ||
    deployment.runtime_paused ||
    runtime?.status === "paused" ||
    deployment.status === "paused" ||
    healthQuery.data?.paused
  );
  const isDeployed = runtime?.deployed || Boolean(deployment.k8s_deployment_name);
  const currentDesiredReplicas = runtime?.desired_replicas ?? deployment.desired_replicas ?? 1;
  const currentReadyReplicas = runtime?.ready_replicas ?? 0;
  const activeExposureMode =
    runtime?.exposure_mode ||
    deployment.runtime_exposure ||
    (runtime?.ingress_name || deployment.k8s_ingress_name ? "ingress" : "service");
  const replicasInput = replicasDraft ?? String(currentDesiredReplicas);
  const requestedReplicas = Math.max(1, Number.parseInt(replicasInput, 10) || 1);
  const canScale = isDeployed && !isPaused && requestedReplicas !== currentDesiredReplicas;
  const canPauseResume =
    isRemoteDocker ||
    runtime?.provider === "remote_kubernetes" ||
    runtime?.provider === "kubernetes" ||
    Boolean(deployment.k8s_deployment_name);
  const runtimeAnalysisMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post(`/deployments/${deployment.id}/ai/analyze-runtime`, {
        runtime: {
          runtime,
          health: healthQuery.data,
          events: eventsQuery.data,
          current_desired_replicas: currentDesiredReplicas,
          current_ready_replicas: currentReadyReplicas,
          paused: isPaused,
        },
      });
      return res.data as AiAnalysisResult;
    },
    onSuccess: (result) => {
      if (result.status === "error") {
        toast.warning(result.summary || "AI runtime analysis could not complete");
      } else {
        toast.success("AI runtime diagnosis ready");
      }
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "AI runtime analysis failed"
          : "AI runtime analysis failed";
      toast.error(message);
    },
  });
  const runtimeAnalysis = runtimeAnalysisMutation.data;
  const runtimeRootCause = aiRootCause(runtimeAnalysis?.structured_output);
  const runtimeFixSteps = aiStringList(runtimeAnalysis?.structured_output, [
    "fix_steps",
    "safe_remediations",
    "remediations",
    "steps",
    "recommendations",
  ]);
  const commitSha = realCommitSha(deployment);
  const commitUrl = githubCommitUrl(deployment);

  useEffect(() => {
    const wsBaseUrl = getWebSocketBaseUrl();
    const socket = new WebSocket(`${wsBaseUrl}/ws/logs?deploymentId=${deployment.id}`);
    socketRef.current = socket;

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as DeploymentSocketMessage;
        if (message.type === "status" || message.type === "deployment_update") {
          runtimeQuery.refetch();
          queryClient.invalidateQueries({ queryKey: ["deployments"] });
        }
        if (message.type === "deployment_deleted") {
          onClose();
        }
      } catch {
        // Ignore malformed messages and let the UI keep running.
      }
    };

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [deployment.id, onClose, queryClient, runtimeQuery]);

  return (
    <Dialog open={!!deployment} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="!flex !w-[min(92vw,48rem)] !max-w-[min(92vw,48rem)] !max-h-[86dvh] !flex-col overflow-hidden rounded-xl border-border bg-card p-0 sm:!w-[min(90vw,48rem)] sm:!max-w-[min(90vw,48rem)]">
        <DialogHeader className="shrink-0 px-5 pt-5">
          <div className="flex items-start justify-between gap-4 pr-10">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2">
                <Server className="h-5 w-5 text-primary" />
                {isRemoteDocker ? "Remote Runtime" : isLocalDocker ? "Local Docker Runtime" : "Kubernetes Runtime"}
              </DialogTitle>
              <DialogDescription className="mt-2">
                {isRemoteDocker
                  ? `Monitor the live remote Docker runtime for ${deployment.project_name}.`
                  : isLocalDocker
                    ? `Run and monitor the local Docker container for ${deployment.project_name}.`
                  : `Manage the live runtime for ${deployment.project_name}.`}
              </DialogDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => onViewLogs(deployment.id)} className="shrink-0">
              <Terminal className="mr-2 h-4 w-4" />
              View logs
            </Button>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-0">
          {!isRemoteDocker && !isLocalDocker && (
            <>
              <div className="grid shrink-0 gap-4 md:grid-cols-3">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="runtime-namespace">Namespace</Label>
                  <Input
                    id="runtime-namespace"
                    value={namespaceInput}
                    onChange={(event) => setNamespaceInput(event.target.value)}
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="runtime-replicas">Replicas</Label>
                  <Input
                    id="runtime-replicas"
                    type="number"
                    min={1}
                    value={replicasInput}
                    onChange={(event) => setReplicasDraft(event.target.value)}
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="runtime-port">Container Port</Label>
                  <Input
                    id="runtime-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={portInput}
                    onChange={(event) => setPortInput(event.target.value)}
                    disabled={isDeployed}
                  />
                </div>
              </div>

              <div className="mt-4 shrink-0 space-y-2">
                <Label>Exposure Mode</Label>
                <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-muted/30 p-1">
                  <Button
                    type="button"
                    variant={exposureMode === "ingress" ? "default" : "ghost"}
                    className="justify-center rounded-lg"
                    disabled={isDeployed}
                    onClick={() => setExposureMode("ingress")}
                  >
                    <Globe className="mr-2 h-4 w-4" />
                    Ingress
                  </Button>
                  <Button
                    type="button"
                    variant={exposureMode === "nodeport" ? "default" : "ghost"}
                    className="justify-center rounded-lg"
                    disabled={isDeployed}
                    onClick={() => setExposureMode("nodeport")}
                  >
                    <Server className="mr-2 h-4 w-4" />
                    NodePort
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {isDeployed
                    ? "This runtime is already live. To change exposure mode safely, remove the runtime and deploy again with a different mode."
                    : exposureMode === "ingress"
                      ? "Ingress gives you hostname-based routing and is the production-friendly option."
                      : "NodePort exposes the runtime directly on a host port, which is handy for local testing."}
                </p>
              </div>

              {!isDeployed && (
                <div className="mt-4 grid shrink-0 gap-4 md:grid-cols-[1fr_1.4fr]">
                  <div className="space-y-2">
                    <Label>Resource Preset</Label>
                    <div className="grid grid-cols-3 gap-2 rounded-xl border border-border bg-muted/30 p-1">
                      {(["small", "medium", "large"] as RuntimeResourcePreset[]).map((preset) => (
                        <Button
                          key={preset}
                          type="button"
                          variant={resourcePreset === preset ? "default" : "ghost"}
                          className="rounded-lg capitalize"
                          onClick={() => setResourcePreset(preset)}
                        >
                          {preset}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="runtime-health-path">Health Check Path</Label>
                    <Input
                      id="runtime-health-path"
                      value={healthPath}
                      onChange={(event) => setHealthPath(event.target.value)}
                      placeholder="/"
                    />
                  </div>
                </div>
              )}
            </>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto py-5 pr-1">
            <div className="grid gap-4">
              <div className="min-w-0 rounded-xl border border-border bg-muted/30 p-4 text-sm">
                <div className="grid gap-3.5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="min-w-0">
                      <span className="text-muted-foreground">Branch</span>
                      <div className="font-mono text-xs text-foreground">{deployment.branch || "-"}</div>
                    </div>
                    <div className="min-w-0">
                      <span className="text-muted-foreground">Commit</span>
                      <div className="min-w-0 break-all">
                        {commitUrl ? (
                          <a
                            href={commitUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                            title={commitSha}
                          >
                            {shortCommit(commitSha)}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="font-mono text-xs text-foreground">{commitSha ? shortCommit(commitSha) : "-"}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <span className="text-muted-foreground">Version</span>
                    <div className="break-all font-mono text-xs text-foreground">{deployment.version || "-"}</div>
                  </div>
                  <div className="min-w-0">
                    <span className="text-muted-foreground">Build image</span>
                    <div className="break-all font-mono text-xs text-foreground">{deployment.image_name || "-"}</div>
                  </div>
                  <div className="min-w-0">
                    <span className="text-muted-foreground">Runtime status</span>
                    <div className="font-medium capitalize text-foreground">
                      {runtimeQuery.isLoading ? "Checking..." : formatRuntimeStatus(runtime?.status || "not_deployed")}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <span className="text-muted-foreground">Health check</span>
                    <div className={cn(
                      "font-medium",
                      isPaused
                        ? "text-amber-300"
                        :
                      healthQuery.data?.healthy ? "text-emerald-400" : healthQuery.data?.available ? "text-amber-300" : "text-muted-foreground"
                    )}>
                      {isPaused
                        ? "Paused"
                        : healthQuery.isLoading
                        ? "Checking..."
                        : healthQuery.data?.healthy
                          ? `${healthQuery.data.status_code || 200} OK`
                          : healthQuery.data?.available
                            ? `${healthQuery.data.status_code || 0} not ready`
                            : "Unavailable"}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <span className="text-muted-foreground">{isRemoteDocker ? "Runtime provider" : "Exposure"}</span>
                    <div className="flex items-center gap-2 text-foreground">
                      <Globe className="h-3.5 w-3.5 text-primary" />
                      {formatRuntimeStatus(isRemoteDocker ? "remote_docker" : isLocalDocker ? "local_docker" : activeExposureMode)}
                    </div>
                  </div>
                  {!isRemoteDocker && !isLocalDocker && (
                    <div className="min-w-0">
                      <span className="text-muted-foreground">Deployment</span>
                      <div className="break-all font-mono text-xs text-foreground">{runtime?.deployment_name || deployment.k8s_deployment_name || "-"}</div>
                    </div>
                  )}
                  {!isRemoteDocker && !isLocalDocker && (
                    <div className="min-w-0">
                      <span className="text-muted-foreground">Service</span>
                      <div className="break-all font-mono text-xs text-foreground">{runtime?.service_name || deployment.k8s_service_name || "-"}</div>
                    </div>
                  )}
                  {!isRemoteDocker && !isLocalDocker && (runtime?.ingress_name || deployment.k8s_ingress_name) && (
                    <div className="min-w-0">
                      <span className="text-muted-foreground">Ingress</span>
                      <div className="break-all font-mono text-xs text-foreground">{runtime?.ingress_name || deployment.k8s_ingress_name}</div>
                    </div>
                  )}
                  {!isRemoteDocker && !isLocalDocker && runtime?.ingress_host && (
                    <div className="min-w-0">
                      <span className="text-muted-foreground">Ingress host</span>
                      <div className="break-all font-mono text-xs text-foreground">{runtime.ingress_host}</div>
                    </div>
                  )}
                  {(isRemoteDocker || isLocalDocker) && (
                    <div className="min-w-0">
                      <span className="text-muted-foreground">Container</span>
                      <div className="break-all font-mono text-xs text-foreground">{runtime?.container_name || deployment.remote_container_name || "-"}</div>
                    </div>
                  )}
                  {(isRemoteDocker || isLocalDocker) && runtime?.image && (
                    <div className="min-w-0">
                      <span className="text-muted-foreground">{isLocalDocker ? "Local image" : "Remote image"}</span>
                      <div className="break-all font-mono text-xs text-foreground">{runtime.image}</div>
                    </div>
                  )}
                  {(isRemoteDocker || isLocalDocker) && runtime?.published_ports && (
                    <div className="min-w-0">
                      <span className="text-muted-foreground">Published ports</span>
                      <div className="break-all font-mono text-xs text-foreground">{runtime.published_ports}</div>
                    </div>
                  )}
                  <div className="min-w-0">
                    <span className="text-muted-foreground">{isRemoteDocker || isLocalDocker ? "Container health" : "Ready replicas"}</span>
                    <div className="text-foreground">
                      {isRemoteDocker || isLocalDocker
                        ? isPaused
                          ? "paused"
                          : `${runtime?.status === "running" ? "running" : "not ready"}`
                        : `${currentReadyReplicas} / ${currentDesiredReplicas}`}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <span className="text-muted-foreground">Runtime URL</span>
                    <div className="min-w-0 break-all">
                      {runtime?.runtime_url || deployment.runtime_url ? (
                        <a
                          href={runtime?.runtime_url || deployment.runtime_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          {runtime?.runtime_url || deployment.runtime_url}
                        </a>
                      ) : (
                        <span className="text-foreground">-</span>
                      )}
                    </div>
                  </div>
                </div>
                {runtime?.error && (
                  <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
                    {runtime.error}
                  </p>
                )}
                {healthQuery.data?.message && (
                  <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                    {healthQuery.data.message}
                  </p>
                )}
                {runtimeAnalysis && (
                  <div className="mt-4 rounded-lg border border-border bg-background/70 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-medium text-foreground">
                        <Bot className="h-4 w-4 text-primary" />
                        AI runtime diagnosis
                      </div>
                      <Badge variant={runtimeAnalysis.status === "error" ? "destructive" : "outline"}>
                        {Math.round((runtimeAnalysis.confidence || 0) * 100)}% confidence
                      </Badge>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {runtimeAnalysis.summary || runtimeAnalysis.error || "No summary returned."}
                    </p>
                    {runtimeRootCause && (
                      <p className="mt-3 text-sm">
                        <span className="font-medium">Root cause: </span>
                        {runtimeRootCause}
                      </p>
                    )}
                    {runtimeFixSteps.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {runtimeFixSteps.map((step, index) => (
                          <div key={`${step}-${index}`} className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                            {step}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {!isRemoteDocker && !isLocalDocker && isDeployed && (
                  <div className="mt-4 rounded-lg border border-border bg-background/60 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="font-medium text-foreground">Kubernetes events</div>
                        <div className="text-xs text-muted-foreground">Pod scheduling, rollout, probe, and ingress diagnostics.</div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEventsOpen(true);
                          eventsQuery.refetch();
                        }}
                        disabled={eventsQuery.isFetching}
                      >
                        {eventsQuery.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Activity className="mr-2 h-4 w-4" />}
                        Events
                      </Button>
                    </div>
                  </div>
                )}
                <div className="mt-4 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
                  {isRemoteDocker
                    ? "This runtime is running on the connected remote host. The container lifecycle is managed over SSH/Tailscale, while build and deployment logs still stay visible in DOKSCP."
                    : `Current target: ${currentDesiredReplicas} replica${currentDesiredReplicas === 1 ? "" : "s"}.${isDeployed ? ` Ready now: ${currentReadyReplicas}.` : ""} ${activeExposureMode === "ingress" ? "Requests should flow through the ingress layer." : "Requests are currently exposed directly through the Kubernetes service."}`}
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="!mx-5 !mb-5 mt-0 shrink-0 rounded-xl border border-border bg-muted/40 p-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => runtimeQuery.refetch()}
                disabled={runtimeQuery.isFetching}
          >
            {runtimeQuery.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Refresh
          </Button>
          {canPauseResume && isDeployed && (
            <Button
              type="button"
              variant="outline"
              onClick={() => pauseResumeMutation.mutate()}
              disabled={pauseResumeMutation.isPending}
            >
              {pauseResumeMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : isPaused ? (
                <Play className="mr-2 h-4 w-4" />
              ) : (
                <Pause className="mr-2 h-4 w-4" />
              )}
              {isPaused ? "Resume Runtime" : "Pause Runtime"}
            </Button>
          )}
          {isDeployed && (
            <Button
              type="button"
              variant="outline"
              onClick={() => runtimeAnalysisMutation.mutate()}
              disabled={runtimeAnalysisMutation.isPending}
            >
              {runtimeAnalysisMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Bot className="mr-2 h-4 w-4" />}
              Diagnose
            </Button>
          )}
          {!isRemoteDocker && !isDeployed && (
            <Button
              type="button"
              onClick={() => deployMutation.mutate()}
              disabled={deployMutation.isPending || !deployment.image_name}
            >
              {deployMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Server className="mr-2 h-4 w-4" />}
              {wantsLocalDocker ? "Deploy to Docker" : "Deploy to Kubernetes"}
            </Button>
          )}
          {!isRemoteDocker && !isLocalDocker && isDeployed && (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => rollbackMutation.mutate()}
                disabled={rollbackMutation.isPending || isPaused}
              >
                {rollbackMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                Rollback
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => scaleMutation.mutate()}
                disabled={scaleMutation.isPending || !canScale}
              >
                {scaleMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Scale to {requestedReplicas}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
      <Dialog open={eventsOpen} onOpenChange={setEventsOpen}>
        <DialogContent className="!flex !w-[min(92vw,56rem)] !max-w-[min(92vw,56rem)] !max-h-[82dvh] !flex-col overflow-hidden rounded-xl border-border bg-card p-0">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-5">
            <DialogTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              Kubernetes Events
            </DialogTitle>
            <DialogDescription>
              Pod scheduling, rollout, probe, and ingress diagnostics for {deployment.project_name}.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto p-6">
            <pre className="min-h-[22rem] whitespace-pre-wrap break-words rounded-xl bg-background p-4 font-mono text-xs text-foreground">
              {eventsQuery.isFetching
                ? "Loading Kubernetes events..."
                : eventsQuery.data?.events || eventsQuery.data?.message || "No Kubernetes events available yet."}
            </pre>
          </div>
          <DialogFooter className="!mx-0 !mb-0 shrink-0 border-t border-border px-6 pt-4 pb-14">
            <Button type="button" variant="outline" onClick={() => eventsQuery.refetch()} disabled={eventsQuery.isFetching}>
              {eventsQuery.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEventsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function MetricsDialog({
  deployment,
  onClose,
}: {
  deployment: Deployment;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<RuntimeMetricPoint[]>([]);
  const [browserGpuName] = useState(() => detectBrowserGpuName());

  const metricsQuery = useQuery({
    queryKey: ["deployment-metrics", deployment.id],
    queryFn: async () => {
      const res = await api.get(`/deployments/${deployment.id}/metrics`);
      const nextMetrics = res.data as RuntimeMetrics;
      if (nextMetrics.timestamp) {
        const point: RuntimeMetricPoint = {
          sample: Date.now(),
          time: new Date().toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" }),
          cpu: metricValue(nextMetrics.summary?.cpu_percent),
          memory: metricValue(nextMetrics.summary?.memory_percent),
          memoryBytes: metricValue(nextMetrics.summary?.memory_bytes),
          networkRxBytes: metricValue(nextMetrics.summary?.network_rx_bytes),
          networkTxBytes: metricValue(nextMetrics.summary?.network_tx_bytes),
        };

        setHistory((current) => {
          if (current[current.length - 1]?.sample === point.sample) {
            return current;
          }
          const next = [...current, point];
          return next.slice(Math.max(0, next.length - 30));
        });
      }
      return nextMetrics;
    },
    enabled: !!deployment.id,
    refetchInterval: 3000,
  });

  const metrics = metricsQuery.data;
  const summary = metrics?.summary;
  const host = metrics?.host;
  const series = metrics?.series || [];
  const memoryPercent = summary?.memory_percent;
  const cpuName = host?.cpu_name || "Unavailable";
  const gpuName = host?.gpu_name || browserGpuName || "Unavailable";
  const memoryLimitBytes = summary?.memory_limit_bytes;
  const networkTotalBytes = metricValue(summary?.network_rx_bytes) + metricValue(summary?.network_tx_bytes);
  const diskTotalBytes = metricValue(summary?.block_read_bytes) + metricValue(summary?.block_write_bytes);
  const readyUnits = summary?.ready_pods ?? series.length;
  const totalUnits = summary?.pod_count ?? series.length;
  const sensorHint =
    !host?.cpu_temperature_celsius && !host?.gpu_usage_percent
      ? "Docker Desktop is not exposing host sensors to the backend container."
      : "";
  const chartHistory = history.length >= 2
      ? history
      : [
        {
          sample: 0,
          time: "previous",
          cpu: metricValue(summary?.cpu_percent),
          memory: metricValue(summary?.memory_percent),
          memoryBytes: metricValue(summary?.memory_bytes),
          networkRxBytes: metricValue(summary?.network_rx_bytes),
          networkTxBytes: metricValue(summary?.network_tx_bytes),
        },
        {
          sample: 1,
          time: "now",
          cpu: metricValue(summary?.cpu_percent),
          memory: metricValue(summary?.memory_percent),
          memoryBytes: metricValue(summary?.memory_bytes),
          networkRxBytes: metricValue(summary?.network_rx_bytes),
          networkTxBytes: metricValue(summary?.network_tx_bytes),
        },
      ];
  const memoryChart = chartHistory.map((point) => ({
    ...point,
    memoryGb: point.memoryBytes / 1024 / 1024 / 1024,
  }));

  return (
    <Dialog open={!!deployment} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="!flex !w-[min(94vw,64rem)] !max-w-[min(94vw,64rem)] !max-h-[82dvh] !flex-col overflow-hidden rounded-xl border-border bg-card p-0">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-5">
          <div className="flex items-start justify-between gap-4 pr-10">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-primary" />
                Runtime Metrics
              </DialogTitle>
              <DialogDescription className="mt-2">
                Live usage for {deployment.project_name}. Updates every few seconds.
              </DialogDescription>
            </div>
            <Badge variant="outline" className="shrink-0 capitalize">
              {formatRuntimeStatus(metrics?.provider || deployment.runtime_provider || deployment.runtime_exposure || "runtime")}
            </Badge>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="grid gap-4 md:grid-cols-4">
            <MetricCard
              icon={<Cpu className="h-4 w-4" />}
              label="CPU"
              value={metricsQuery.isLoading ? "Checking..." : formatMetricNumber(summary?.cpu_percent, "%")}
              detail={summary?.cpu_millicores ? `${summary.cpu_millicores}m cores` : truncateMiddle(cpuName, 34)}
            />
            <MetricCard
              icon={<HardDrive className="h-4 w-4" />}
              label="Memory"
              value={metricsQuery.isLoading ? "Checking..." : formatGigabytes(summary?.memory_bytes)}
              detail={
                typeof memoryPercent === "number"
                  ? `${memoryPercent.toFixed(1)}% of limit`
                  : summary?.memory_limit_bytes
                    ? `Limit ${formatGigabytes(summary.memory_limit_bytes)}`
                    : "Current working set"
              }
            />
            <MetricCard
              icon={<Thermometer className="h-4 w-4" />}
              label="CPU Temp"
              value={formatMetricNumber(host?.cpu_temperature_celsius, " C")}
              detail={host?.cpu_temperature_celsius ? truncateMiddle(cpuName, 34) : "Host sensor hidden"}
            />
            <MetricCard
              icon={<Gauge className="h-4 w-4" />}
              label="GPU"
              value={formatMetricNumber(host?.gpu_usage_percent, "%")}
              detail={
                typeof host?.gpu_memory_percent === "number"
                  ? `${host.gpu_memory_percent.toFixed(1)}% VRAM`
                  : truncateMiddle(gpuName, 34)
              }
            />
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-4">
            <MetricCard
              icon={<Server className="h-4 w-4" />}
              label="Ready"
              value={`${readyUnits || 0}/${totalUnits || 0}`}
              detail="Runtime units"
            />
            <MetricCard
              icon={<HardDrive className="h-4 w-4" />}
              label="Limit"
              value={formatGigabytes(memoryLimitBytes)}
              detail="Configured memory cap"
            />
            <MetricCard
              icon={<Activity className="h-4 w-4" />}
              label="Network"
              value={formatBytes(networkTotalBytes)}
              detail={`Rx ${formatBytes(summary?.network_rx_bytes)} / Tx ${formatBytes(summary?.network_tx_bytes)}`}
            />
            <MetricCard
              icon={<Gauge className="h-4 w-4" />}
              label="Disk I/O"
              value={formatGigabytes(diskTotalBytes)}
              detail={`Read ${formatGigabytes(summary?.block_read_bytes)} / Write ${formatGigabytes(summary?.block_write_bytes)}`}
            />
          </div>

          {sensorHint && (
            <div className="mt-4 rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              CPU and GPU names are best-effort. Temperature and GPU usage require host sensor access; {sensorHint}
            </div>
          )}

          {!metrics?.available && !metricsQuery.isLoading && (
            <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              {metrics?.message || "Metrics are not available for this runtime yet."}
              {metrics?.raw_error ? (
                <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-amber-100/80">
                  {metrics.raw_error}
                </pre>
              ) : null}
            </div>
          )}

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border bg-muted/20 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-foreground">CPU Trend</h3>
                  <p className="text-xs text-muted-foreground">Percent over the live sampling window</p>
                </div>
                {metricsQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
              </div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartHistory} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="cpuGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
                    <XAxis dataKey="sample" tickFormatter={() => ""} tickLine={false} axisLine={{ stroke: "#71717a" }} />
                    <YAxis tick={{ fill: "#a1a1aa", fontSize: 11 }} width={36} axisLine={{ stroke: "#71717a" }} domain={[0, "dataMax + 5"]} />
                    <Tooltip
                      contentStyle={{
                        background: "#18181b",
                        border: "1px solid #3f3f46",
                        borderRadius: 8,
                        color: "#f4f4f5",
                      }}
                      labelFormatter={(_label, payload) => payload?.[0]?.payload?.time || ""}
                      labelStyle={{ color: "#f4f4f5" }}
                      itemStyle={{ color: "#f4f4f5" }}
                    />
                    <Area type="monotone" dataKey="cpu" stroke="#f4f4f5" fill="url(#cpuGradient)" name="CPU %" dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-muted/20 p-4">
              <div className="mb-3">
                <h3 className="font-semibold text-foreground">Memory Trend</h3>
                <p className="text-xs text-muted-foreground">Memory usage in gigabytes</p>
              </div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={memoryChart} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="memoryGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#22c55e" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
                    <XAxis dataKey="sample" tickFormatter={() => ""} tickLine={false} axisLine={{ stroke: "#71717a" }} />
                    <YAxis tick={{ fill: "#a1a1aa", fontSize: 11 }} width={44} axisLine={{ stroke: "#71717a" }} domain={["dataMin - 2", "dataMax + 2"]} />
                    <Tooltip
                      contentStyle={{
                        background: "#18181b",
                        border: "1px solid #3f3f46",
                        borderRadius: 8,
                        color: "#f4f4f5",
                      }}
                      labelFormatter={(_label, payload) => payload?.[0]?.payload?.time || ""}
                      formatter={(value) => [`${Number(value).toFixed(2)} GB`, "Memory"]}
                      labelStyle={{ color: "#f4f4f5" }}
                      itemStyle={{ color: "#22c55e" }}
                    />
                    <Area type="monotone" dataKey="memoryGb" stroke="#22c55e" fill="url(#memoryGradient)" name="Memory GB" dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-border bg-muted/20 p-4">
            <div className="mb-3">
              <h3 className="font-semibold text-foreground">Runtime Units</h3>
              <p className="text-xs text-muted-foreground">Containers or pods currently backing this deployment</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">CPU</th>
                    <th className="py-2 pr-4">Memory</th>
                    <th className="py-2 pr-4">Network</th>
                    <th className="py-2 pr-4">Disk</th>
                    <th className="py-2 pr-4">PIDs</th>
                    <th className="py-2 pr-4">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {series.length > 0 ? (
                    series.map((item) => (
                      <tr key={item.name} className="border-b border-border/60 last:border-0">
                        <td className="max-w-[20rem] break-all py-2 pr-4 font-mono text-xs">{item.name}</td>
                        <td className="py-2 pr-4">{formatMetricNumber(item.cpu_percent, "%")}</td>
                        <td className="py-2 pr-4">{formatGigabytes(item.memory_bytes)} / {formatGigabytes(item.memory_limit_bytes)}</td>
                        <td className="py-2 pr-4">{formatBytes(metricValue(item.network_rx_bytes) + metricValue(item.network_tx_bytes))}</td>
                        <td className="py-2 pr-4">{formatGigabytes(metricValue(item.block_read_bytes) + metricValue(item.block_write_bytes))}</td>
                        <td className="py-2 pr-4">{item.pids ?? "-"}</td>
                        <td className="py-2 pr-4 capitalize">{item.container_status || "running"}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="py-4 text-muted-foreground" colSpan={7}>
                        Runtime units will appear once metrics are available.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <DialogFooter className="mx-6 mb-5 shrink-0 rounded-xl border border-border bg-muted/30 px-4 py-4">
          <Button type="button" variant="outline" onClick={() => metricsQuery.refetch()} disabled={metricsQuery.isFetching}>
            {metricsQuery.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="mb-3 flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-2xl font-semibold text-foreground">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function DeleteDeploymentDialog({
  deployment,
  onClose,
  onConfirm,
  isDeleting,
}: {
  deployment: Deployment;
  onClose: () => void;
  onConfirm: (deleteImage: boolean) => void;
  isDeleting: boolean;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [deleteImage, setDeleteImage] = useState(false);
  const isRemoteDocker =
    deployment.runtime_provider === "remote_docker" ||
    deployment.runtime_exposure === "remote_docker" ||
    Boolean(deployment.remote_container_name);
  const isRemoteKubernetes = deployment.runtime_provider === "remote_kubernetes";
  const savedImageName =
    deployment.image_name?.trim() ||
    deployment.runtime_snapshot?.image_name?.trim() ||
    "";
  const hasBuildImage = Boolean(deployment.can_delete_image);
  const canDeleteBuildImage = hasBuildImage;
  const deleteImageTitle = isRemoteDocker || isRemoteKubernetes
    ? "Delete saved remote Docker image too"
    : "Delete saved Docker image too";
  const deleteImageHint = isRemoteDocker || isRemoteKubernetes
    ? "Unchecked only removes the runtime resources and database record. Checked also removes the image from the remote host."
    : "Unchecked only removes the runtime resources and database record. Checked also removes the image from this host.";
  const expectedText = deployment.project_name;
  const canDelete = confirmation.trim() === expectedText && !isDeleting;

  return (
    <Dialog open={!!deployment} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-[420px]">
        <DialogHeader className="gap-2">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <DialogTitle className="text-center text-lg font-bold text-foreground">Delete Deployment?</DialogTitle>
          <DialogDescription className="text-center text-sm">
            This removes the deployment record from the database. If a live runtime exists, it will be removed first.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Project</span>
            <span className="max-w-[13rem] truncate text-right font-medium text-foreground">{deployment.project_name}</span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Version</span>
            <span className="font-medium text-foreground">{deployment.version}</span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Status</span>
            <span className="font-medium text-foreground">{formatRuntimeStatus(deployment.status)}</span>
          </div>
          {hasBuildImage && (
            <div className="mt-2 flex items-start justify-between gap-4">
              <span className="text-muted-foreground">Image</span>
              <span className="max-w-[13rem] break-all text-right font-mono text-xs text-foreground">
                {savedImageName}
              </span>
            </div>
          )}
        </div>

        {canDeleteBuildImage && (
          <div className="rounded-xl border border-border bg-muted/20 p-3 text-sm">
            <div className="flex items-start gap-3">
              <Checkbox
                id="delete-deployment-image"
                checked={deleteImage}
                onCheckedChange={(checked) => setDeleteImage(checked === true)}
                className="mt-1"
              />
              <Label htmlFor="delete-deployment-image" className="min-w-0 cursor-pointer text-sm font-normal">
                <span className="block font-medium text-foreground">{deleteImageTitle}</span>
                <span className="block text-xs text-muted-foreground">{deleteImageHint}</span>
              </Label>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="delete-deployment-confirm" className="text-sm">
            Type <span className="font-semibold text-foreground">{expectedText}</span> to confirm
          </Label>
          <Input
            id="delete-deployment-confirm"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={expectedText}
            autoComplete="off"
          />
        </div>

        <DialogFooter className="flex gap-2 sm:justify-center">
          <Button type="button" variant="ghost" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => onConfirm(deleteImage === true)}
            disabled={!canDelete}
            className="flex-1"
          >
            {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
