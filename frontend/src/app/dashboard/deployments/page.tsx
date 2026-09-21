"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import { AxiosError } from "axios";
import { Card, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Bot, Cpu, HardDrive, Loader2, Terminal, RefreshCw, CheckCircle, XCircle, Server, Maximize2, Minimize2, Pause, Play, Trash2, AlertTriangle, RotateCcw, Globe, Thermometer, Gauge, Search, SlidersHorizontal, ChevronLeft, ChevronRight, X, ExternalLink, Copy, Wand2, ArrowDown, Smartphone, Zap, Sparkles } from "lucide-react";
import { AppIcon } from "@/lib/custom-icons";
import { Button } from "@/components/ui/button";
import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { MobileSimulatorDialog } from "@/components/deployments/MobileSimulatorDialog";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/context/WorkspaceContext";

import { useChartTheme } from "@/lib/canvas-theme";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip as AppTooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AnimatedStreamingText } from "@/components/ui/animated-streaming-text";
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
  logs?: string;
  port_adjustments?: Array<{ key?: string; from?: string; to?: string }>;
  runtime_snapshot?: {
    image_name?: string;
    provider?: string;
    exposure_mode?: string;
    container_port?: number;
    runtime_url?: string;
    archetype?: string;
    archetype_details?: string;
    detected_subservices?: string[];
    [key: string]: any;
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

// Must cover every status the backend can emit. Statuses missing from this list
// are unreachable by filter and fall through to an unlabelled grey chip:
// paused/blocked/superseded/retired/failed_ci/canceled were all absent.
const STATUS_FILTER_OPTIONS = [
  { value: "queued", label: "Queued" },
  { value: "pending", label: "Pending" },
  { value: "building", label: "Building" },
  { value: "deploying", label: "Deploying" },
  { value: "built", label: "Built" },
  { value: "running", label: "Running" },
  { value: "paused", label: "Paused" },
  { value: "blocked", label: "Blocked" },
  { value: "failed", label: "Failed" },
  { value: "failed_ci", label: "CI failed" },
  { value: "canceled", label: "Canceled" },
  { value: "superseded", label: "Superseded" },
  { value: "retired", label: "Retired" },
];

// Statuses that mean work is still in flight, so the list should keep polling.
// `blocked` is included: a deployment waiting on GitHub checks can still change.
const IN_FLIGHT_STATUSES = ["pending", "queued", "building", "deploying", "blocked"];

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

function getAuthToken(): string {
  if (typeof window === "undefined") return "";
  const localToken = localStorage.getItem("token");
  if (localToken) return localToken;
  const match = document.cookie.match(/(?:^|;\s*)token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
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

function humanizeApplicationName(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function deploymentDisplayName(deployment: Pick<Deployment, "project_name">) {
  const rawName = deployment.project_name || "Deployment";
  const legacyAiName = rawName.match(/^AI\s+(.+?)\s+\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/i);
  if (legacyAiName?.[1]) {
    return humanizeApplicationName(legacyAiName[1]);
  }
  return rawName;
}

function deploymentRuntimeUrl(deployment: Deployment, runtime?: KubernetesRuntime) {
  return runtime?.runtime_url || deployment.runtime_url || deployment.runtime_snapshot?.runtime_url || "";
}

const MOBILE_ARCHETYPES = new Set([
  "expo_react_native",
  "expo_mobile",
  "flutter_mobile",
  "native_ios",
  "ios_xcode",
  "native_android",
  "android_gradle",
]);

function isMobileDeployment(deployment: Deployment): boolean {
  const archetype = deployment.runtime_snapshot?.archetype?.toLowerCase();
  return Boolean(archetype && MOBILE_ARCHETYPES.has(archetype));
}

function defaultRuntimePortForDeployment(deployment: Deployment) {
  const name = deploymentDisplayName(deployment).toLowerCase();
  const image = `${deployment.image_name || ""} ${deployment.runtime_snapshot?.image_name || ""}`.toLowerCase();
  const combined = `${name} ${image}`;

  if (combined.includes("minio")) return 9001;
  if (combined.includes("grafana")) return 3000;
  if (combined.includes("prometheus")) return 9090;
  if (combined.includes("rabbitmq")) return 15672;
  if (combined.includes("adminer")) return 8080;
  if (combined.includes("mongo")) return 27017;
  if (combined.includes("mariadb") || combined.includes("mysql")) return 3306;
  if (combined.includes("postgres")) return 5432;
  if (combined.includes("redis")) return 6379;
  if (combined.includes("nginx") || combined.includes("caddy")) return 80;

  return deployment.runtime_snapshot?.container_port || 3000;
}

function normalizeRuntimeExposureMode(value: string | undefined): RuntimeExposureMode {
  return value?.toLowerCase() === "ingress" ? "ingress" : "nodeport";
}

function portAdjustmentMessages(deployment: Deployment) {
  const labels: Record<string, string> = {
    APP_PUBLIC_PORT: "application port",
    APP_PUBLIC_UI_PORT: "application UI port",
    STACKPILOT_HTTP_PORT: "HTTP port",
    STACKPILOT_HTTPS_PORT: "HTTPS port",
  };
  const structured = deployment.port_adjustments || [];
  if (structured.length > 0) {
    return structured
      .filter((adjustment) => adjustment.key && adjustment.to)
      .map((adjustment) => ({
        id: `${adjustment.key}:${adjustment.from || ""}:${adjustment.to}`,
        message: `${labels[adjustment.key || ""] || adjustment.key} ${adjustment.from || "default"} was occupied, so StackPilot moved it to ${adjustment.to}.`,
      }));
  }
  if (!deployment.logs) return [];
  return Array.from(deployment.logs.matchAll(/__STACKPILOT_PORT_ADJUSTED__=([A-Z0-9_]+):([^:\n]*):([^\s\n]+)/g)).map(
    ([raw, key, oldPort, newPort]) => ({
      id: raw,
      message: `${labels[key] || key} ${oldPort || "default"} was occupied, so StackPilot moved it to ${newPort}.`,
    })
  );
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
  const router = useRouter();
  const { activeWorkspaceId } = useWorkspace();
  const [selectedDeployment, setSelectedDeployment] = useState<string | null>(null);
  const [runtimeDeployment, setRuntimeDeployment] = useState<Deployment | null>(null);
  const [metricsDeployment, setMetricsDeployment] = useState<Deployment | null>(null);
  const [deleteDeployment, setDeleteDeployment] = useState<Deployment | null>(null);
  const [mobileSimulatorDeployment, setMobileSimulatorDeployment] = useState<Deployment | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState<DeploymentFilters>({ statuses: [], runtimes: [] });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  const shownPortAdjustmentToasts = useRef<Set<string>>(new Set());
  const shownHealedToasts = useRef<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["deployments", activeWorkspaceId],
    queryFn: async () => {
      const res = await api.get("/deployments");
      return res.data;
    },
    refetchInterval: (query) => {
      const currentDeployments =
        (query.state.data as { deployments?: Deployment[] } | undefined)?.deployments || [];
      return currentDeployments.some((deployment) =>
        IN_FLIGHT_STATUSES.includes(deployment.status)
      )
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const deployments: Deployment[] = useMemo(() => data?.deployments || [], [data?.deployments]);

  useEffect(() => {
    if (deployments.length > 0) {
      for (const dep of deployments) {
        if (dep.trigger_source === "ai_repair" && dep.status === "running") {
          const key = `${dep.id}:healed`;
          if (!shownHealedToasts.current.has(key)) {
            shownHealedToasts.current.add(key);
            toast.success("Deployment successful and deployed", {
              description: `${deploymentDisplayName(dep)} was automatically repaired and is now live!`,
            });
          }
        }
      }
    }
  }, [deployments]);
  const activeFilterCount = filters.statuses.length + filters.runtimes.length;
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredDeployments = useMemo(() => {
    return deployments.filter((deployment) => {
      const matchesSearch =
        normalizedSearchQuery.length === 0 ||
        [
          deployment.project_name,
          deploymentDisplayName(deployment),
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
      const responseData = (error as { response?: { data?: { error?: string; hint?: string; details?: string } } })?.response?.data;
      const message = responseData?.error || "Failed to start build";
      toast.error(message, {
        description: responseData?.hint || responseData?.details,
      });
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
    },
  });

  const cancelDeploymentMutation = useMutation({
    mutationFn: async (deploymentId: string) => {
      const res = await api.post(`/deployments/${deploymentId}/cancel`);
      return res.data;
    },
    onSuccess: (_data, deploymentId) => {
      toast.success("Deployment canceled");
      setSelectedDeployment(deploymentId);
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      queryClient.invalidateQueries({ queryKey: ["deployment-logs", deploymentId] });
    },
    onError: (error: unknown) => {
      const responseData = (error as { response?: { data?: { error?: string; hint?: string; details?: string } } })?.response?.data;
      const message = responseData?.error || "Failed to cancel deployment";
      toast.error(message, {
        description: responseData?.hint || responseData?.details,
      });
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
    },
  });

  const repairDeploymentMutation = useMutation({
    mutationFn: async (deploymentId: string) => {
      const res = await api.post(`/deployments/${deploymentId}/ai/repair`, {
        model: "",
        model_mode: "thinking",
      });
      return res.data;
    },
    onSuccess: (data) => {
      if (data.status === "error") {
        toast.warning(data.summary || "AI repair could not complete");
      } else {
        toast.success(data.summary || "AI repaired the project and queued a new build!");
        queryClient.invalidateQueries({ queryKey: ["deployments"] });
        if (data.new_deployment_id) {
          setSelectedDeployment(data.new_deployment_id);
        }
      }
    },
    onError: (error: unknown) => {
      const maybeError = error as { response?: { data?: { error?: string } } };
      toast.error(maybeError.response?.data?.error || "AI project repair failed");
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: async (deploymentId: string) => {
      const res = await api.post(`/api/v1/deployments/${deploymentId}/rollback`);
      return res.data;
    },
    onSuccess: (data: any) => {
      toast.success(data?.message || "Successfully rolled back to healthy checkpoint!");
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
    },
    onError: (error: unknown) => {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error || "Rollback failed";
      toast.error(message);
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
      queryClient.setQueriesData(
        { queryKey: ["deployments"] },
        (current: { deployments?: Deployment[]; count?: number } | undefined) => {
          const filtered = (current?.deployments || []).filter((deployment) => deployment.id !== deploymentId);
          return {
            deployments: filtered,
            count: filtered.length,
          };
        }
      );
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
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
    let isUnmounted = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;
    let backoffDelay = 1000;

    const connect = () => {
      if (isUnmounted) return;
      const wsBaseUrl = getWebSocketBaseUrl();
      const token = getAuthToken();
      socket = new WebSocket(`${wsBaseUrl}/ws/logs?stream=deployments${token ? `&token=${encodeURIComponent(token)}` : ""}`);

      socket.onopen = () => {
        backoffDelay = 1000;
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as DeploymentSocketMessage;

          if (message.type === "deployment_update" && message.deployment) {
            const deployment = message.deployment as Deployment;
            if (deployment.trigger_source === "ai_repair" && deployment.status === "running") {
              const healedKey = `${deployment.id}:healed`;
              if (!shownHealedToasts.current.has(healedKey)) {
                shownHealedToasts.current.add(healedKey);
                toast.success("Deployment successful and deployed", {
                  description: "AI SRE auto-healing completed successfully",
                });
              }
            }
            for (const adjustment of portAdjustmentMessages(deployment)) {
              const toastKey = `${deployment.id}:${adjustment.id}`;
              if (!shownPortAdjustmentToasts.current.has(toastKey)) {
                shownPortAdjustmentToasts.current.add(toastKey);
                toast.info(adjustment.message);
              }
            }
            queryClient.setQueriesData(
              { queryKey: ["deployments"] },
              (current: { deployments?: Deployment[]; count?: number } | undefined) => {
                const nextDeployments = upsertDeployment(current?.deployments || [], deployment);
                return {
                  deployments: nextDeployments,
                  count: nextDeployments.length,
                };
              }
            );
            return;
          }

          if (message.type === "deployment_deleted" && message.deployment_id) {
            queryClient.setQueriesData(
              { queryKey: ["deployments"] },
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

      socket.onclose = () => {
        if (!isUnmounted) {
          reconnectTimeout = setTimeout(() => {
            connect();
          }, backoffDelay);
          backoffDelay = Math.min(backoffDelay * 1.5, 15000);
        }
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      isUnmounted = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (socket) {
        socket.close();
      }
    };
  }, [queryClient]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "built":
        return (
          <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 gap-1">
            <AppIcon name="check-circle" fallback={CheckCircle} className="w-3 h-3"  /> Built
          </Badge>
        );
      case "running":
        return (
          <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 gap-1">
            <AppIcon name="check-circle" fallback={CheckCircle} className="w-3 h-3"  /> Running
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30 gap-1">
            <AppIcon name="x-circle" fallback={XCircle} className="w-3 h-3"  /> Failed
          </Badge>
        );
      case "building":
      case "queued":
      case "pending":
        return (
          <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 gap-1 capitalize">
            <AppIcon name="loader2" fallback={Loader2} className="w-3 h-3 animate-spin"  /> {status}
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
        <div className="flex flex-row items-center gap-2">
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={isLoading}
            className="bg-card"
          >
            <AppIcon name="refresh-cw" fallback={RefreshCw} className={cn("w-4 h-4 mr-2", isLoading && "animate-spin")}  />
            Refresh
          </Button>
          <Button
            variant={isSearchOpen ? "secondary" : "outline"}
            onClick={() => setIsSearchOpen((open) => !open)}
            className="bg-card"
          >
            <AppIcon name="search" fallback={Search} className="mr-2 h-4 w-4"  />
            Search
          </Button>
        </div>
      </div>

      {isSearchOpen && (
        <Card className="border-border bg-card p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor="deployment-search">Search deployments</Label>
              <div className="relative">
                <AppIcon name="search" fallback={Search} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="deployment-search"
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Project, version, commit, image, runtime URL..."
                  className="pl-10"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setIsFilterDialogOpen(true)} className="bg-card">
                <AppIcon name="sliders-horizontal" fallback={SlidersHorizontal} className="mr-2 h-4 w-4"  />
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
                  <AppIcon name="x" fallback={X} className="mr-2 h-4 w-4"  />
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
          <AppIcon name="loader2" fallback={Loader2} className="h-8 w-8 animate-spin text-primary"  />
        </div>
      ) : deployments.length === 0 ? (
        <Card className="border-dashed border-border/80 ring-0 flex flex-col items-center justify-center py-20 bg-card">
          <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4">
            <AppIcon name="server" fallback={Server} className="w-6 h-6 text-muted-foreground"  />
          </div>
          <CardTitle className="text-foreground">No deployments yet</CardTitle>
          <CardDescription>Trigger a build from the projects page to get started.</CardDescription>
        </Card>
      ) : filteredDeployments.length === 0 ? (
        <Card className="border-dashed border-border/80 ring-0 flex flex-col items-center justify-center py-20 bg-card">
          <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4">
            <AppIcon name="search" fallback={Search} className="w-6 h-6 text-muted-foreground"  />
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
                  const displayName = deploymentDisplayName(dep);
                  const liveUrl = deploymentRuntimeUrl(dep);
                  return (
                  <TableRow key={dep.id} className="hover:bg-muted/30 transition-colors group">
                    <TableCell className="px-6 py-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        {liveUrl ? (
                          <a
                            href={liveUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-w-0 max-w-[24rem] items-center gap-1 font-medium text-foreground hover:text-primary hover:underline"
                            title={`Open runtime: ${liveUrl}`}
                          >
                            <span className="min-w-0 truncate">{displayName}</span>
                            <AppIcon name="external-link" fallback={ExternalLink} className="h-3.5 w-3.5 shrink-0"  />
                          </a>
                        ) : (
                          <div className="max-w-[24rem] truncate font-medium text-foreground" title={displayName}>
                            {displayName}
                          </div>
                        )}
                        {liveUrl?.includes("trycloudflare.com") && (
                          <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px] px-1.5 py-0 flex items-center gap-1">
                            <AppIcon name="zap" fallback={Zap} className="h-2.5 w-2.5 text-amber-400" />
                            Cloudflare
                          </Badge>
                        )}
                        {liveUrl?.includes(".localhost") && (
                          <Badge variant="outline" className="border-blue-500/40 bg-blue-500/10 text-blue-300 text-[10px] px-1.5 py-0 flex items-center gap-1">
                            <AppIcon name="globe" fallback={Globe} className="h-2.5 w-2.5 text-blue-400" />
                            Portless
                          </Badge>
                        )}
                        {dep.runtime_snapshot?.archetype === "native_ios" && (
                          <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-rose-400 text-[10px] px-1.5 py-0">iOS Xcode</Badge>
                        )}
                        {dep.runtime_snapshot?.archetype === "native_android" && (
                          <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-400 text-[10px] px-1.5 py-0">Android</Badge>
                        )}
                        {dep.runtime_snapshot?.archetype === "expo_react_native" && (
                          <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-400 text-[10px] px-1.5 py-0">Expo PWA</Badge>
                        )}
                        {dep.runtime_snapshot?.archetype === "flutter_mobile" && (
                          <Badge variant="outline" className="border-cyan-500/40 bg-cyan-500/10 text-cyan-400 text-[10px] px-1.5 py-0">Flutter Web</Badge>
                        )}
                        {dep.runtime_snapshot?.archetype === "library" && (
                          <Badge variant="outline" className="border-violet-500/40 bg-violet-500/10 text-violet-400 text-[10px] px-1.5 py-0">Library</Badge>
                        )}
                        {dep.runtime_snapshot?.archetype === "monorepo" && (
                          <Badge variant="outline" className="border-blue-500/40 bg-blue-500/10 text-blue-400 text-[10px] px-1.5 py-0">Monorepo</Badge>
                        )}
                      </div>
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
                          <AppIcon name="external-link" fallback={ExternalLink} className="h-3 w-3"  />
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
                        {dep.trigger_source === "ai_repair" && (dep.status === "queued" || dep.status === "building") && (
                          <span className="flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary">
                            <AppIcon name="loader2" fallback={Loader2} className="h-3 w-3 animate-spin" />
                            Auto-Healing
                          </span>
                        )}
                        {isMobileDeployment(dep) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => window.open(`/preview/${dep.id}`, "_blank")}
                            className="shrink-0 gap-1.5 border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 font-medium"
                            title="Open Interactive Mobile Device Studio in New Tab"
                          >
                            <AppIcon name="smartphone" fallback={Smartphone} className="w-4 h-4 mr-1 text-primary"  />
                            Mobile Studio ↗
                          </Button>
                        )}
                        {(dep.status === "pending" || dep.status === "failed") && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => triggerBuildMutation.mutate(dep.id)}
                            disabled={triggerBuildMutation.isPending}
                            className="shrink-0 gap-2"
                          >
                            {triggerBuildMutation.isPending ? (
                              <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  />
                            ) : (
                              <AppIcon name="play" fallback={Play} className="h-4 w-4 fill-current"  />
                            )}
                            Build
                          </Button>
                        )}
                        {(dep.status === "building" || dep.status === "queued") && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => cancelDeploymentMutation.mutate(dep.id)}
                            disabled={cancelDeploymentMutation.isPending && cancelDeploymentMutation.variables === dep.id}
                            className="shrink-0 gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:border-destructive"
                          >
                            {cancelDeploymentMutation.isPending && cancelDeploymentMutation.variables === dep.id ? (
                              <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin" />
                            ) : (
                              <AppIcon name="x-circle" fallback={XCircle} className="h-4 w-4" />
                            )}
                            Cancel
                          </Button>
                        )}
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => setSelectedDeployment(dep.id)}
                          className="shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted"
                        >
                          <AppIcon name="terminal" fallback={Terminal} className="w-4 h-4 mr-2"  />
                          Logs
                        </Button>
                        {dep.image_name && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRuntimeDeployment(dep)}
                            className="shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted"
                          >
                            <AppIcon name="server" fallback={Server} className="w-4 h-4 mr-2"  />
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
                            <AppIcon name="activity" fallback={Activity} className="w-4 h-4 mr-2"  />
                            Metrics
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => rollbackMutation.mutate(dep.id)}
                          disabled={rollbackMutation.isPending}
                          className="shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted"
                          title="Rollback to previous healthy deployment checkpoint"
                        >
                          <AppIcon name="rotate-ccw" fallback={RotateCcw} className="w-4 h-4 mr-1.5"  />
                          Rollback
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteDeployment(dep)}
                          className="shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        >
                          <AppIcon name="trash2" fallback={Trash2} className="w-4 h-4 mr-2"  />
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
                <AppIcon name="chevron-left" fallback={ChevronLeft} className="mr-2 h-4 w-4"  />
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
                <AppIcon name="chevron-right" fallback={ChevronRight} className="ml-2 h-4 w-4"  />
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
          onCancelBuild={() => cancelDeploymentMutation.mutate(selectedDeployment)}
          isCancellingBuild={cancelDeploymentMutation.isPending && cancelDeploymentMutation.variables === selectedDeployment}
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

      <MobileSimulatorDialog
        open={!!mobileSimulatorDeployment}
        onClose={() => setMobileSimulatorDeployment(null)}
        deploymentTitle={mobileSimulatorDeployment ? deploymentDisplayName(mobileSimulatorDeployment) : ""}
        runtimeUrl={mobileSimulatorDeployment ? deploymentRuntimeUrl(mobileSimulatorDeployment) : ""}
        archetype={mobileSimulatorDeployment?.runtime_snapshot?.archetype}
        deploymentId={mobileSimulatorDeployment?.id}
      />
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
      <DialogContent className="sm:max-w-3xl md:max-w-4xl max-w-[95vw] p-6">
        <DialogHeader className="pb-2">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <AppIcon name="sliders-horizontal" fallback={SlidersHorizontal} className="h-5 w-5 text-primary" />
            Deployment Filters
          </DialogTitle>
          <DialogDescription>
            Choose statuses and runtime types to narrow the deployment history.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Status
              </Label>
              {draftFilters.statuses.length > 0 && (
                <span className="text-xs text-primary font-medium">
                  {draftFilters.statuses.length} selected
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
              {STATUS_FILTER_OPTIONS.map((option) => {
                const isChecked = draftFilters.statuses.includes(option.value);
                return (
                  <Label
                    key={option.value}
                    htmlFor={`status-filter-${option.value}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm font-normal transition-colors select-none",
                      isChecked
                        ? "border-primary/50 bg-primary/10 text-foreground font-medium"
                        : "border-border/70 bg-card hover:bg-muted/40 text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Checkbox
                      id={`status-filter-${option.value}`}
                      checked={isChecked}
                      onCheckedChange={() =>
                        setDraftFilters((current) => ({
                          ...current,
                          statuses: toggleListValue(current.statuses, option.value),
                        }))
                      }
                    />
                    <span className="truncate">{option.label}</span>
                  </Label>
                );
              })}
            </div>
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Runtime
              </Label>
              {draftFilters.runtimes.length > 0 && (
                <span className="text-xs text-primary font-medium">
                  {draftFilters.runtimes.length} selected
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
              {RUNTIME_FILTER_OPTIONS.map((option) => {
                const isChecked = draftFilters.runtimes.includes(option.value);
                return (
                  <Label
                    key={option.value}
                    htmlFor={`runtime-filter-${option.value}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm font-normal transition-colors select-none",
                      isChecked
                        ? "border-primary/50 bg-primary/10 text-foreground font-medium"
                        : "border-border/70 bg-card hover:bg-muted/40 text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Checkbox
                      id={`runtime-filter-${option.value}`}
                      checked={isChecked}
                      onCheckedChange={() =>
                        setDraftFilters((current) => ({
                          ...current,
                          runtimes: toggleListValue(current.runtimes, option.value),
                        }))
                      }
                    />
                    <span className="truncate">{option.label}</span>
                  </Label>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter className="pt-2 gap-2 sm:gap-0">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setDraftFilters({ statuses: [], runtimes: [] })}
          >
            Clear
          </Button>
          <div className="flex items-center gap-2">
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
          </div>
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
  onCancelBuild,
  isCancellingBuild,
}: {
  deploymentId: string;
  onClose: () => void;
  onStartBuild: () => void;
  isStartingBuild: boolean;
  onCancelBuild?: () => void;
  isCancellingBuild?: boolean;
}) {
  const [logs, setLogs] = useState<string>("");
  const hasReceivedWsLog = useRef(false);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isWsConnected, setIsWsConnected] = useState(false);
  const [isWsConnecting, setIsWsConnecting] = useState(false);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const isUserScrolledUpRef = useRef(false);
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
    refetchInterval: (query) => {
      const status = query.state.data?.deployment?.status;
      return (status === "running" || status === "failed" || status === "built" || status === "canceled")
        ? false
        : 2000;
    },
  });

  useEffect(() => {
    setLogs("");
    hasReceivedWsLog.current = false;
    setIsUserScrolledUp(false);
    isUserScrolledUpRef.current = false;
  }, [deploymentId]);

  useEffect(() => {
    const historicalLogs = initialData?.deployment?.logs;
    if (historicalLogs) {
      setLogs((currentLogs) => {
        if (!currentLogs || historicalLogs.length > currentLogs.length) {
          return historicalLogs;
        }
        return currentLogs;
      });
    }
  }, [initialData]);

  const initialLogs = initialData?.deployment?.logs || "";
  const initialDeployment = initialData?.deployment as Partial<Deployment> | undefined;
  const logCommitSha = initialDeployment ? realCommitSha(initialDeployment) : "";
  const logCommitUrl = initialDeployment ? githubCommitUrl(initialDeployment) : "";
  const displayLogs = logs || initialLogs;
  const displayStatus = liveStatus ?? initialData?.deployment?.status ?? "loading";
  const hasCapturedFailureReason =
    displayLogs.includes("failed with exit code") ||
    displayLogs.includes("timed out after") ||
    displayLogs.includes("Failure reason") ||
    displayLogs.includes("Command exited with status");
  const queryClient = useQueryClient();
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
  const buildRepairMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post(
        `/deployments/${deploymentId}/ai/repair`,
        {
          model: "",
          model_mode: "thinking",
        },
        { timeout: 90000 }
      );
      return res.data;
    },
    onSuccess: (result) => {
      if (result.status === "error") {
        toast.warning(result.summary || "AI repair could not complete");
      } else {
        toast.success(result.summary || "AI repaired the project and queued a new build!");
        queryClient.invalidateQueries({ queryKey: ["deployments"] });
        if (result.new_deployment_id) {
          onCloseRef.current();
        }
      }
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "AI project repair failed"
          : "AI project repair failed";
      toast.error(message);
    },
  });

  const buildAnalysis = buildAnalysisMutation.data;
  const buildFixSteps = aiStringList(buildAnalysis?.structured_output, ["fix_steps", "steps", "suggested_fix", "commands"]);
  const buildRootCause = aiRootCause(buildAnalysis?.structured_output);

  // Kept in refs so a changing `onClose` identity does not retrigger the socket effect below.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const displayStatusRef = useRef(displayStatus);
  useEffect(() => {
    displayStatusRef.current = displayStatus;
  });

  useEffect(() => {
    if (!deploymentId) return;

    let isActive = true;

    const connectWebSocket = () => {
      if (!isActive) return;
      setIsWsConnecting(true);
      const wsBaseUrl = getWebSocketBaseUrl();
      const token = getAuthToken();
      const wsUrl = `${wsBaseUrl}/ws/logs?deploymentId=${deploymentId}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
      const socket = new WebSocket(wsUrl);
      let pingTimer: NodeJS.Timeout | null = null;
      
      socket.onopen = () => {
        if (isActive) {
          setIsWsConnected(true);
          setIsWsConnecting(false);
          pingTimer = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "ping" }));
            }
          }, 15000);
        }
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as DeploymentSocketMessage;
          if (data.type === 'log') {
            hasReceivedWsLog.current = true;
            setLogs((prev) => `${prev}${data.line ?? ""}\n`);
          } else if (data.type === 'status') {
            setLiveStatus(data.status ?? null);
          } else if (data.type === "deployment_deleted") {
            onCloseRef.current();
          }
        } catch {
          hasReceivedWsLog.current = true;
          setLogs((prev) => `${prev}${event.data}\n`);
        }
      };

      socket.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (isActive) {
          setIsWsConnected(false);
          const currentStatus = displayStatusRef.current;
          if (currentStatus !== "built" && currentStatus !== "failed") {
            setIsWsConnecting(true);
            reconnectTimerRef.current = setTimeout(connectWebSocket, 3000);
          } else {
            setIsWsConnecting(false);
          }
        }
      };

      socket.onerror = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (isActive) {
          setIsWsConnected(false);
        }
      };

      socketRef.current = socket;
    };

    connectWebSocket();

    return () => {
      isActive = false;
      setIsWsConnected(false);
      setIsWsConnecting(false);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [deploymentId]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 60;
    const scrolledUp = !isNearBottom;
    setIsUserScrolledUp(scrolledUp);
    isUserScrolledUpRef.current = scrolledUp;
  };

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setIsUserScrolledUp(false);
      isUserScrolledUpRef.current = false;
    }
  };

  // Smart auto-scroll to bottom only if user hasn't scrolled up
  useEffect(() => {
    if (scrollRef.current && !isUserScrolledUpRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayLogs]);

  return (
    <Dialog open={!!deploymentId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent 
        showCloseButton={false}
        className={cn(
          "flex flex-col p-0 overflow-hidden border border-zinc-800 bg-[#0c0c0c] text-[#cccccc] shadow-2xl transition-all duration-300 ease-in-out rounded-md",
          isExpanded 
            ? "!max-w-[96vw] sm:!max-w-[96vw] !w-[96vw] h-[92vh]" 
            : "!max-w-[95vw] sm:!max-w-4xl !w-[95vw] sm:!w-auto max-h-[85vh] h-auto min-h-[260px]"
        )}
      >
        <div className="h-8 border-b border-zinc-800 bg-[#18181b] px-2 flex items-center justify-between select-none shrink-0">
          <div className="flex min-w-0 items-center gap-2 text-xs text-white/90">
            <svg className="h-3.5 w-3.5 shrink-0 text-sky-400" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 14.5 2h-13zm0 1h13a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5z"/>
              <path d="m3.854 5.146 2.5 2.5a.5.5 0 0 1 0 .708l-2.5 2.5a.5.5 0 0 1-.708-.708L5.293 8 3.146 5.854a.5.5 0 1 1 .708-.708zm3 5.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5z"/>
            </svg>
            <span className="font-normal font-sans text-xs text-white/90 truncate">
              Windows PowerShell - Deployments: {deploymentId.slice(0, 8)} ({displayStatus})
            </span>
          </div>

          {/* Windows-style Header caption controls: Maximize and Close */}
          <div className="flex shrink-0 items-center h-full">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setIsExpanded(!isExpanded)}
              className="h-full w-10 rounded-none text-white/70 hover:bg-white/10 hover:text-white"
              title={isExpanded ? "Restore" : "Maximize"}
            >
              {isExpanded ? (
                <span className="text-xs font-mono select-none">❐</span>
              ) : (
                <span className="text-xs font-mono select-none">□</span>
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-full w-10 rounded-none text-white/70 hover:bg-[#e81123] hover:text-white transition-colors"
              title="Close"
            >
              <span className="text-xs font-mono select-none">✕</span>
            </Button>
          </div>
        </div>
        
        <div className="relative flex-1 min-h-0 flex flex-col bg-[#0c0c0c]">
          <div 
            ref={scrollRef}
            onScroll={handleScroll}
            className={cn(
              "overflow-y-auto px-4 py-2.5 font-mono text-[13px] font-normal leading-relaxed bg-[#0c0c0c] text-[#cccccc] scrollbar-thin select-text",
              isExpanded ? "flex-1" : "max-h-[55vh] min-h-[140px]"
            )}
          >
            <div className="mb-2 text-[#cccccc] text-xs font-normal select-none leading-relaxed">
              Windows PowerShell<br />
              Copyright (C) Microsoft Corporation. All rights reserved.<br />
              <br />
              PS C:\stackpilot\deployments\{deploymentId.slice(0, 8)}&gt; (streaming build logs...)
            </div>
            <pre className="whitespace-pre-wrap break-all text-[#cccccc] font-mono font-normal m-0 p-0 leading-relaxed">
              {displayLogs ? (
                displayLogs
              ) : (
                displayStatus === "queued"
                  ? "Build is queued. A background worker will start it shortly."
                  : displayStatus === "pending"
                  ? "Build has not started yet.\nClick 'Start build' to clone the repository and build the Docker image."
                  : "Initializing build engine...\nConnecting to logs stream..."
              )}
              {displayStatus === "failed" && displayLogs && !hasCapturedFailureReason
                ? "\n\nThis failed build does not include a complete failure summary. Re-run it to capture the exact exit code or timeout reason."
                : ""}
              {(displayStatus === 'building' || displayStatus === 'queued' || displayStatus === 'running') && (
                <span className="inline-block w-2 h-4 ml-1 bg-white animate-pulse align-middle" />
              )}
            </pre>
          </div>

          {isUserScrolledUp && (
            <Button
              variant="secondary"
              size="sm"
              onClick={scrollToBottom}
              className="absolute bottom-3 right-5 shadow-lg border border-zinc-700 bg-zinc-900/90 hover:bg-zinc-800 text-zinc-100 text-xs gap-1.5 backdrop-blur-sm z-10 animate-in fade-in"
            >
              <AppIcon name="arrow-down" fallback={ArrowDown} className="h-3.5 w-3.5" />
              Scroll to bottom
            </Button>
          )}
        </div>

        {buildAnalysis && (
          <div className="border-t border-zinc-800 bg-zinc-950/90 px-4 py-3">
            <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-semibold text-zinc-100 text-xs">
                    <AppIcon name="bot" fallback={Bot} className="h-4 w-4 text-sky-400"  />
                    AI build diagnosis
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-zinc-300">
                    {buildAnalysis.summary || buildAnalysis.error || "No summary returned."}
                  </pre>
                </div>
                <Badge variant={buildAnalysis.status === "error" ? "destructive" : "outline"} className="border-zinc-700 text-zinc-200">
                  {Math.round((buildAnalysis.confidence || 0) * 100)}% confidence
                </Badge>
              </div>
              {buildRootCause && (
                <p className="mt-2 rounded border border-zinc-700/60 bg-zinc-900/80 px-2.5 py-1.5 text-xs text-zinc-200">
                  <span className="font-semibold text-sky-400">Root cause: </span>
                  {buildRootCause}
                </p>
              )}
              {buildFixSteps.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-sky-400">Suggested fixes</div>
                  {buildFixSteps.map((step, index) => (
                    <div key={`${step}-${index}`} className="rounded border border-zinc-700/60 bg-zinc-900/80 px-2.5 py-1.5 text-xs text-zinc-200">
                      {step}
                    </div>
                  ))}
                </div>
              )}
              {buildAnalysis.warnings && buildAnalysis.warnings.length > 0 && (
                <p className="mt-2 text-xs text-amber-300">{buildAnalysis.warnings[0]}</p>
              )}
            </div>
          </div>
        )}

        <div className="px-4 py-2 border-t border-sky-900/50 bg-[#0c1d3b] flex items-center justify-between text-xs text-sky-200/90 shrink-0">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "w-2 h-2 rounded-full",
                displayStatus === "built" || displayStatus === "failed"
                  ? "bg-sky-400/40"
                  : isWsConnected
                  ? "bg-emerald-400 animate-pulse"
                  : isWsConnecting
                  ? "bg-amber-400 animate-pulse"
                  : "bg-sky-400/40"
              )}
            />
            <span>
              {displayStatus === "built" || displayStatus === "failed"
                ? "Log history loaded from database"
                : isWsConnected
                ? "Receiving real-time updates via WebSocket"
                : isWsConnecting
                ? "Reconnecting to live stream..."
                : displayStatus === "queued"
                ? "Waiting for a background worker"
                : displayStatus === "pending"
                ? "Waiting for build trigger"
                : "Log history loaded from database"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {displayStatus === "failed" && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => buildAnalysisMutation.mutate()}
                  disabled={buildAnalysisMutation.isPending}
                  className="h-7 text-xs border-sky-700 bg-sky-950/60 text-sky-100 hover:bg-sky-800/60"
                >
                  {buildAnalysisMutation.isPending ? <AppIcon name="loader2" fallback={Loader2} className="mr-1.5 h-3.5 w-3.5 animate-spin"  /> : <AppIcon name="bot" fallback={Bot} className="mr-1.5 h-3.5 w-3.5"  />}
                  Diagnose
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs bg-[#0078d4] hover:bg-[#106ebe] text-white font-medium shadow-sm gap-1.5"
                  onClick={() => buildRepairMutation.mutate()}
                  disabled={buildRepairMutation.isPending}
                >
                  {buildRepairMutation.isPending ? <AppIcon name="loader2" fallback={Loader2} className="mr-1.5 h-3.5 w-3.5 animate-spin"  /> : <AppIcon name="wand2" fallback={Wand2} className="mr-1.5 h-3.5 w-3.5"  />}
                  Auto-Fix & Deploy
                </Button>
              </>
            )}
            {displayStatus === "pending" && (
              <Button size="sm" onClick={onStartBuild} disabled={isStartingBuild} className="h-7 text-xs bg-[#0078d4] hover:bg-[#106ebe] text-white">
                {isStartingBuild ? <AppIcon name="loader2" fallback={Loader2} className="mr-1.5 h-3.5 w-3.5 animate-spin"  /> : <AppIcon name="play" fallback={Play} className="mr-1.5 h-3.5 w-3.5 fill-current"  />}
                Start build
              </Button>
            )}
            {(displayStatus === "building" || displayStatus === "queued") && onCancelBuild && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs border-red-500/50 bg-red-950/50 text-red-300 hover:bg-red-900/60 gap-1.5"
                onClick={onCancelBuild}
                disabled={isCancellingBuild}
              >
                {isCancellingBuild ? (
                  <AppIcon name="loader2" fallback={Loader2} className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <AppIcon name="x-circle" fallback={XCircle} className="mr-1.5 h-3.5 w-3.5" />
                )}
                Cancel build
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={onClose}
              className="h-7 text-xs border-sky-700 bg-sky-950/60 text-sky-100 hover:bg-sky-800/60"
            >
              Close
            </Button>
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
  const displayName = deploymentDisplayName(deployment);
  const [namespaceInput, setNamespaceInput] = useState(deployment.k8s_namespace || "stackpilot-apps");
  const [replicasDraft, setReplicasDraft] = useState<string | null>(null);
  const [portInput, setPortInput] = useState(() => String(defaultRuntimePortForDeployment(deployment)));
  const [resourcePreset, setResourcePreset] = useState<RuntimeResourcePreset>("small");
  const [healthPath, setHealthPath] = useState("/");
  const [eventsOpen, setEventsOpen] = useState(false);
  const canUseIngress =
    deployment.runtime_provider === "remote_kubernetes" ||
    deployment.runtime_snapshot?.provider === "remote_kubernetes" ||
    Boolean(deployment.k8s_ingress_name);
  const [exposureMode, setExposureMode] = useState<RuntimeExposureMode>(
    canUseIngress ? normalizeRuntimeExposureMode(deployment.runtime_exposure) : "nodeport"
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
      const requestedExposureMode = canUseIngress ? exposureMode : "nodeport";
      const res = wantsLocalDocker
        ? await api.post(`/deployments/${deployment.id}/docker/deploy`, {
            container_port: containerPort,
          })
        : await api.post(`/deployments/${deployment.id}/kubernetes/deploy`, {
            namespace: namespaceInput.trim(),
            exposure_mode: requestedExposureMode,
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
      const responseData =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string; hint?: string; details?: string } | undefined)
          : (error as { response?: { data?: { error?: string; hint?: string; details?: string } } })?.response?.data;
      const message = responseData?.error || "Failed to deploy runtime";
      toast.error(message, {
        description: responseData?.hint || responseData?.details,
      });
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
  const [activeRuntimeUrl, setActiveRuntimeUrl] = useState<string | null>(null);
  const liveRuntimeUrl = activeRuntimeUrl || deploymentRuntimeUrl(deployment, runtime);
  const isRemoteDocker =
    runtime?.provider === "remote_docker" ||
    deployment.runtime_provider === "remote_docker" ||
    deployment.runtime_exposure === "remote_docker";
  const isLocalDocker =
    runtime?.provider === "local_docker" ||
    deployment.runtime_provider === "local_docker" ||
    deployment.runtime_exposure === "local_docker" ||
    deployment.runtime_exposure === "portless_local" ||
    deployment.runtime_exposure === "cloudflare_tunnel" ||
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

  const [localExposureMode, setLocalExposureMode] = useState<"direct" | "portless" | "cloudflare_tunnel">(() => {
    if (deployment.runtime_exposure === "cloudflare_tunnel" || deployment.runtime_url?.includes("trycloudflare.com")) {
      return "cloudflare_tunnel";
    }
    if (deployment.runtime_exposure === "portless_local" || deployment.runtime_url?.includes(".localhost")) {
      return "portless";
    }
    return "direct";
  });
  const [tunnelToken, setTunnelToken] = useState("");
  const [isUpdatingExposure, setIsUpdatingExposure] = useState(false);

  const updateExposureMutation = useMutation({
    mutationFn: async (mode: "direct" | "portless" | "cloudflare_tunnel") => {
      setIsUpdatingExposure(true);
      try {
        const res = await api.post(`/deployments/${deployment.id}/exposure`, {
          exposure_mode: mode,
          tunnel_token: tunnelToken,
          project_name: deployment.project_name,
          port: Number.parseInt(portInput, 10) || 3000,
        });
        return res.data as { runtime_url: string; runtime_exposure: string };
      } finally {
        setIsUpdatingExposure(false);
      }
    },
    onSuccess: (data) => {
      if (data?.runtime_url) {
        setActiveRuntimeUrl(data.runtime_url);
      }
      toast.success("Exposure mode updated", {
        description: `Deployment is now available at ${data.runtime_url}`,
        action: {
          label: "Copy URL",
          onClick: () => {
            navigator.clipboard.writeText(data.runtime_url);
            toast.info("Copied to clipboard");
          },
        },
      });
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      runtimeQuery.refetch();
      onChanged();
    },
    onError: (error: any) => {
      toast.error(error?.message || "Failed to update exposure mode");
    },
  });

  const runtimeQueryRef = useRef(runtimeQuery);
  runtimeQueryRef.current = runtimeQuery;

  useEffect(() => {
    const wsBaseUrl = getWebSocketBaseUrl();
    const token = getAuthToken();
    const socket = new WebSocket(`${wsBaseUrl}/ws/logs?deploymentId=${deployment.id}${token ? `&token=${encodeURIComponent(token)}` : ""}`);
    socketRef.current = socket;

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as DeploymentSocketMessage;
        if (message.type === "status" || message.type === "deployment_update") {
          runtimeQueryRef.current.refetch();
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
  }, [deployment.id, onClose, queryClient]);

  return (
    <Dialog open={!!deployment} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="!flex !w-[min(96vw,64rem)] !max-w-[64rem] !max-h-[92dvh] !flex-col overflow-hidden rounded-xl border-border bg-card p-0">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
          <div className="flex items-start justify-between gap-4 pr-10">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2">
                <AppIcon name="server" fallback={Server} className="h-5 w-5 text-primary"  />
                {isRemoteDocker ? "Remote Runtime" : isLocalDocker ? "Local Docker Runtime" : "Kubernetes Runtime"}
              </DialogTitle>
              <DialogDescription className="mt-2">
                {isRemoteDocker
                  ? `Monitor the live remote Docker runtime for ${displayName}.`
                  : isLocalDocker
                    ? `Run and monitor the local Docker container for ${displayName}.`
                  : `Manage the live runtime for ${displayName}.`}
              </DialogDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => onViewLogs(deployment.id)} className="shrink-0">
              <AppIcon name="terminal" fallback={Terminal} className="mr-2 h-4 w-4"  />
              View logs
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {isLocalDocker && (
            <div className="space-y-4 rounded-xl border border-border/80 bg-muted/20 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Local URL & Public Ingress
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Switch exposure anytime without restarting or rebuilding the container.
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px] uppercase font-semibold",
                    localExposureMode === "cloudflare_tunnel"
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                      : localExposureMode === "portless"
                      ? "border-blue-500/40 bg-blue-500/10 text-blue-300"
                      : "border-border text-muted-foreground"
                  )}
                >
                  {localExposureMode === "cloudflare_tunnel"
                    ? "Cloudflare Tunnel"
                    : localExposureMode === "portless"
                    ? "Portless Local"
                    : "Direct Port"}
                </Badge>
              </div>

              <div className="grid grid-cols-3 gap-2 rounded-xl border border-border bg-muted/30 p-1">
                <Button
                  type="button"
                  variant={localExposureMode === "direct" ? "default" : "ghost"}
                  className="rounded-lg text-xs justify-center"
                  onClick={() => {
                    setLocalExposureMode("direct");
                    updateExposureMutation.mutate("direct");
                  }}
                  disabled={isUpdatingExposure}
                >
                  <AppIcon name="server" fallback={Server} className="mr-1.5 h-3.5 w-3.5" />
                  Direct Port
                </Button>
                <Button
                  type="button"
                  variant={localExposureMode === "portless" ? "default" : "ghost"}
                  className="rounded-lg text-xs justify-center"
                  onClick={() => {
                    setLocalExposureMode("portless");
                    updateExposureMutation.mutate("portless");
                  }}
                  disabled={isUpdatingExposure}
                >
                  <AppIcon name="globe" fallback={Globe} className="mr-1.5 h-3.5 w-3.5" />
                  Portless Local
                </Button>
                <Button
                  type="button"
                  variant={localExposureMode === "cloudflare_tunnel" ? "default" : "ghost"}
                  className="rounded-lg text-xs justify-center"
                  onClick={() => {
                    setLocalExposureMode("cloudflare_tunnel");
                    updateExposureMutation.mutate("cloudflare_tunnel");
                  }}
                  disabled={isUpdatingExposure}
                >
                  <AppIcon name="zap" fallback={Zap} className="mr-1.5 h-3.5 w-3.5 text-amber-400" />
                  Cloudflare Tunnel
                </Button>
              </div>

              {localExposureMode === "direct" && (
                <div className="rounded-lg border border-border bg-background/50 p-2.5 text-xs text-muted-foreground">
                  <strong>Direct Port (localhost)</strong>: Container publishes directly to loopback address (e.g. <code>http://localhost:18080</code>).
                </div>
              )}

              {localExposureMode === "portless" && (
                <div className="rounded-lg border border-border bg-background/50 p-2.5 text-xs text-muted-foreground space-y-1">
                  <div>
                    <strong>Portless Domain</strong>: Clean loopback hostname (e.g. <code>http://{deployment.project_name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.localhost</code>) via RFC 6761 loopback.
                  </div>
                  <p className="text-[11px] text-muted-foreground/80">
                    Accessible locally without needing to specify or remember port numbers.
                  </p>
                </div>
              )}

              {localExposureMode === "cloudflare_tunnel" && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 space-y-2 text-xs">
                  <div className="flex items-center gap-2 text-amber-400 font-medium">
                    <AppIcon name="zap" fallback={Zap} className="h-4 w-4" />
                    Public HTTPS URL (Cloudflare Quick Tunnel)
                  </div>
                  <p className="text-muted-foreground">
                    Exposes your local deployment publicly to the internet with HTTPS without opening firewall ports.
                  </p>
                  <div className="flex gap-2 items-center pt-1">
                    <Input
                      value={tunnelToken}
                      onChange={(e) => setTunnelToken(e.target.value)}
                      placeholder="Custom Tunnel Token (optional, leave empty for free Quick Tunnel)"
                      className="h-8 bg-muted/40 text-xs"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isUpdatingExposure}
                      onClick={() => updateExposureMutation.mutate("cloudflare_tunnel")}
                      className="shrink-0 h-8"
                    >
                      {isUpdatingExposure ? (
                        <AppIcon name="refresh-cw" fallback={RefreshCw} className="h-3.5 w-3.5 animate-spin mr-1.5" />
                      ) : null}
                      Re-Tunnel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {!isRemoteDocker && !isLocalDocker && (
            <div className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor="runtime-namespace">Namespace</Label>
                  <Input
                    id="runtime-namespace"
                    value={namespaceInput}
                    onChange={(event) => setNamespaceInput(event.target.value)}
                  />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor="runtime-replicas">Replicas</Label>
                  <Input
                    id="runtime-replicas"
                    type="number"
                    min={1}
                    value={replicasInput}
                    onChange={(event) => setReplicasDraft(event.target.value)}
                  />
                </div>
                <div className="min-w-0 space-y-1.5">
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

              <div className="space-y-1.5">
                <Label>Exposure Mode</Label>
                <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-muted/30 p-1">
                  <Button
                    type="button"
                    variant={exposureMode === "ingress" ? "default" : "ghost"}
                    className="justify-center rounded-lg"
                    disabled={isDeployed || !canUseIngress}
                    title={!canUseIngress ? "Ingress is available only for prepared remote Kubernetes runtimes" : undefined}
                    onClick={() => setExposureMode("ingress")}
                  >
                    <AppIcon name="globe" fallback={Globe} className="mr-2 h-4 w-4"  />
                    Ingress
                  </Button>
                  <Button
                    type="button"
                    variant={exposureMode === "nodeport" ? "default" : "ghost"}
                    className="justify-center rounded-lg"
                    disabled={isDeployed}
                    onClick={() => setExposureMode("nodeport")}
                  >
                    <AppIcon name="server" fallback={Server} className="mr-2 h-4 w-4"  />
                    NodePort
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {isDeployed
                    ? "This runtime is already live. To change exposure mode safely, remove the runtime and deploy again with a different mode."
                    : !canUseIngress
                      ? "Local Kubernetes uses NodePort by default. Use a prepared remote Kubernetes runtime for ingress and public TLS."
                    : exposureMode === "ingress"
                      ? "Ingress gives you hostname-based routing and is the production-friendly option."
                      : "NodePort exposes the runtime directly on a host port, which is handy for local testing."}
                </p>
              </div>

              {!isDeployed && (
                <div className="grid gap-3 md:grid-cols-[1fr_1.4fr]">
                  <div className="space-y-1.5">
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
                  <div className="space-y-1.5">
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
            </div>
          )}

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
                            <AppIcon name="external-link" fallback={ExternalLink} className="h-3 w-3"  />
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
                      <AppIcon name="globe" fallback={Globe} className="h-3.5 w-3.5 text-primary"  />
                      {formatRuntimeStatus(isRemoteDocker ? "remote_docker" : isLocalDocker ? (localExposureMode === "cloudflare_tunnel" ? "cloudflare_tunnel" : localExposureMode === "portless" ? "portless_local" : "local_docker") : activeExposureMode)}
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
                      {liveRuntimeUrl ? (
                        <a
                          href={liveRuntimeUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          {liveRuntimeUrl}
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
                        <AppIcon name="bot" fallback={Bot} className="h-4 w-4 text-primary"  />
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
                        {eventsQuery.isFetching ? <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  /> : <AppIcon name="activity" fallback={Activity} className="mr-2 h-4 w-4"  />}
                        Events
                      </Button>
                    </div>
                  </div>
                )}
                <div className="mt-4 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
                  {isRemoteDocker
                    ? "This runtime is running on the connected remote host. The container lifecycle is managed over SSH/Tailscale, while build and deployment logs still stay visible in StackPilot."
                    : `Current target: ${currentDesiredReplicas} replica${currentDesiredReplicas === 1 ? "" : "s"}.${isDeployed ? ` Ready now: ${currentReadyReplicas}.` : ""} ${activeExposureMode === "ingress" ? "Requests should flow through the ingress layer." : "Requests are currently exposed directly through the Kubernetes service."}`}
                </div>
              </div>
            </div>

        <DialogFooter className="shrink-0 border-t border-border bg-muted/30 px-6 py-3.5 flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => runtimeQuery.refetch()}
                disabled={runtimeQuery.isFetching}
          >
            {runtimeQuery.isFetching ? <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  /> : null}
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
                <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />
              ) : isPaused ? (
                <AppIcon name="play" fallback={Play} className="mr-2 h-4 w-4"  />
              ) : (
                <AppIcon name="pause" fallback={Pause} className="mr-2 h-4 w-4"  />
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
              {runtimeAnalysisMutation.isPending ? <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  /> : <AppIcon name="bot" fallback={Bot} className="mr-2 h-4 w-4"  />}
              Diagnose
            </Button>
          )}
          {!isRemoteDocker && !isDeployed && (
            <Button
              type="button"
              onClick={() => deployMutation.mutate()}
              disabled={deployMutation.isPending || !deployment.image_name}
            >
              {deployMutation.isPending ? <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  /> : <AppIcon name="server" fallback={Server} className="mr-2 h-4 w-4"  />}
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
                {rollbackMutation.isPending ? <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  /> : <AppIcon name="rotate-ccw" fallback={RotateCcw} className="mr-2 h-4 w-4"  />}
                Rollback
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => scaleMutation.mutate()}
                disabled={scaleMutation.isPending || !canScale}
              >
                {scaleMutation.isPending ? <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  /> : null}
                Scale to {requestedReplicas}
              </Button>
            </>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
      <Dialog open={eventsOpen} onOpenChange={setEventsOpen}>
        <DialogContent className="!flex !w-[min(92vw,56rem)] !max-w-[min(92vw,56rem)] !max-h-[82dvh] !flex-col overflow-hidden rounded-xl border-border bg-card p-0">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-5">
            <DialogTitle className="flex items-center gap-2">
              <AppIcon name="activity" fallback={Activity} className="h-5 w-5 text-primary"  />
              Kubernetes Events
            </DialogTitle>
            <DialogDescription>
              Pod scheduling, rollout, probe, and ingress diagnostics for {displayName}.
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
              {eventsQuery.isFetching ? <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  /> : <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4"  />}
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
  // Axis, grid and tooltip chrome follow the active theme; the memory series
  // keeps its green because it is a category, not chrome.
  const chart = useChartTheme();

  const [history, setHistory] = useState<RuntimeMetricPoint[]>([]);
  const displayName = deploymentDisplayName(deployment);

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
  const gpuName = host?.gpu_name || (typeof host?.gpu_usage_percent === "number" ? "Host GPU" : "No host GPU detected");
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
                <AppIcon name="activity" fallback={Activity} className="h-5 w-5 text-primary"  />
                Runtime Metrics
              </DialogTitle>
              <DialogDescription className="mt-2">
                Live usage for {displayName}. Updates every few seconds.
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
              icon={<AppIcon name="cpu" fallback={Cpu} className="h-4 w-4"  />}
              label="CPU"
              value={metricsQuery.isLoading ? "Checking..." : formatMetricNumber(summary?.cpu_percent, "%")}
              detail={summary?.cpu_millicores ? `${summary.cpu_millicores}m cores` : truncateMiddle(cpuName, 34)}
            />
            <MetricCard
              icon={<AppIcon name="hard-drive" fallback={HardDrive} className="h-4 w-4"  />}
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
              icon={<AppIcon name="thermometer" fallback={Thermometer} className="h-4 w-4"  />}
              label="CPU Temp"
              value={formatMetricNumber(host?.cpu_temperature_celsius, " C")}
              detail={host?.cpu_temperature_celsius ? truncateMiddle(cpuName, 34) : "Host sensor hidden"}
            />
            <MetricCard
              icon={<AppIcon name="gauge" fallback={Gauge} className="h-4 w-4"  />}
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
              icon={<AppIcon name="server" fallback={Server} className="h-4 w-4"  />}
              label="Ready"
              value={`${readyUnits || 0}/${totalUnits || 0}`}
              detail="Runtime units"
            />
            <MetricCard
              icon={<AppIcon name="hard-drive" fallback={HardDrive} className="h-4 w-4"  />}
              label="Limit"
              value={formatGigabytes(memoryLimitBytes)}
              detail="Configured memory cap"
            />
            <MetricCard
              icon={<AppIcon name="activity" fallback={Activity} className="h-4 w-4"  />}
              label="Network"
              value={formatBytes(networkTotalBytes)}
              detail={`Rx ${formatBytes(summary?.network_rx_bytes)} / Tx ${formatBytes(summary?.network_tx_bytes)}`}
            />
            <MetricCard
              icon={<AppIcon name="gauge" fallback={Gauge} className="h-4 w-4"  />}
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
                {metricsQuery.isFetching ? <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin text-muted-foreground"  /> : null}
              </div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                  <AreaChart data={chartHistory} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="cpuGradient" x1="0" y1="0" x2="0" y2="1">
                        {/* Was hsl(var(--primary)). Every theme defines --primary
                            as oklch(...) or a hex literal, so hsl() wrapped a value
                            it could not parse and the gradient never rendered. */}
                        <stop offset="5%" stopColor={chart.foreground} stopOpacity={0.4} />
                        <stop offset="95%" stopColor={chart.foreground} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
                    <XAxis dataKey="sample" tickFormatter={() => ""} tickLine={false} axisLine={{ stroke: chart.axisLine }} />
                    <YAxis tick={{ fill: chart.axis, fontSize: 11 }} width={36} axisLine={{ stroke: chart.axisLine }} domain={[0, "dataMax + 5"]} />
                    <Tooltip
                      contentStyle={{
                        background: chart.tooltipBackground,
                        border: `1px solid ${chart.tooltipBorder}`,
                        borderRadius: 8,
                        color: chart.tooltipText,
                      }}
                      labelFormatter={(_label, payload) => payload?.[0]?.payload?.time || ""}
                      labelStyle={{ color: chart.tooltipText }}
                      itemStyle={{ color: chart.tooltipText }}
                    />
                    <Area type="monotone" dataKey="cpu" stroke={chart.foreground} fill="url(#cpuGradient)" name="CPU %" dot={false} isAnimationActive={false} />
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
                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                  <AreaChart data={memoryChart} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="memoryGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#22c55e" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
                    <XAxis dataKey="sample" tickFormatter={() => ""} tickLine={false} axisLine={{ stroke: chart.axisLine }} />
                    <YAxis tick={{ fill: chart.axis, fontSize: 11 }} width={44} axisLine={{ stroke: chart.axisLine }} domain={["dataMin - 2", "dataMax + 2"]} />
                    <Tooltip
                      contentStyle={{
                        background: chart.tooltipBackground,
                        border: `1px solid ${chart.tooltipBorder}`,
                        borderRadius: 8,
                        color: chart.tooltipText,
                      }}
                      labelFormatter={(_label, payload) => payload?.[0]?.payload?.time || ""}
                      formatter={(value) => [`${Number(value).toFixed(2)} GB`, "Memory"]}
                      labelStyle={{ color: chart.tooltipText }}
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
                    series.map((item, index) => (
                      <tr key={`${item.name || "metric"}-${index}`} className="border-b border-border/60 last:border-0">
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

        <DialogFooter className="shrink-0 border-t border-border bg-muted/30 px-6 py-3.5 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => metricsQuery.refetch()} disabled={metricsQuery.isFetching}>
            {metricsQuery.isFetching ? <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  /> : <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4"  />}
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
  const displayName = deploymentDisplayName(deployment);
  const canDelete =
    (confirmation.trim() === expectedText ||
      confirmation.trim().toLowerCase() === expectedText.trim().toLowerCase() ||
      confirmation.trim().toLowerCase() === displayName.trim().toLowerCase()) &&
    !isDeleting;
  const copyConfirmationText = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(expectedText);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = expectedText;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      toast.success("Confirmation text copied to clipboard");
    } catch {
      toast.error("Unable to copy confirmation text");
    }
  };

  return (
    <Dialog open={!!deployment} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="!w-[min(94vw,720px)] !max-w-[720px] max-h-[calc(100vh-2rem)] overflow-x-hidden overflow-y-auto p-0">
        <div className="min-w-0 space-y-4 px-5 pt-5">
          <DialogHeader className="gap-1.5">
            <div className="mx-auto mb-1 flex h-10 w-10 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10">
              <AppIcon name="alert-triangle" fallback={AlertTriangle} className="h-5 w-5 text-destructive"  />
            </div>
            <DialogTitle className="text-center text-base font-bold text-foreground">Delete Deployment?</DialogTitle>
            <DialogDescription className="mx-auto max-w-[58ch] text-center text-xs leading-relaxed">
              This removes the deployment record from the database. If a live runtime exists, it will be removed first.
            </DialogDescription>
          </DialogHeader>

        <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm">
          <div className="grid grid-cols-[72px,minmax(0,1fr)] items-start gap-3">
            <span className="text-muted-foreground">Project</span>
            <span className="min-w-0 break-words text-right font-medium text-foreground">{displayName}</span>
          </div>
          <div className="mt-1.5 grid grid-cols-[72px,minmax(0,1fr)] items-start gap-3">
            <span className="text-muted-foreground">Version</span>
            <span className="min-w-0 break-words text-right font-medium text-foreground">{deployment.version}</span>
          </div>
          <div className="mt-1.5 grid grid-cols-[72px,minmax(0,1fr)] items-start gap-3">
            <span className="text-muted-foreground">Status</span>
            <span className="min-w-0 break-words text-right font-medium text-foreground">{formatRuntimeStatus(deployment.status)}</span>
          </div>
          {hasBuildImage && (
            <div className="mt-1.5 grid grid-cols-[72px,minmax(0,1fr)] items-start gap-3">
              <span className="text-muted-foreground">Image</span>
              <span className="min-w-0 break-all text-right font-mono text-xs text-foreground">
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
              <Label htmlFor="delete-deployment-image" className="grid min-w-0 flex-1 cursor-pointer gap-2 text-sm font-normal md:grid-cols-[minmax(220px,0.85fr),minmax(0,1.15fr)] md:gap-6">
                <span className="font-medium text-foreground">{deleteImageTitle}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">{deleteImageHint}</span>
              </Label>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="delete-deployment-confirm" className="min-w-0 text-sm leading-relaxed">
              Type <span className="break-words font-semibold text-foreground">{expectedText}</span> to confirm
            </Label>
            <Button type="button" variant="outline" size="sm" onClick={copyConfirmationText} className="shrink-0">
              <AppIcon name="copy" fallback={Copy} className="mr-2 h-3.5 w-3.5"  />
              Copy
            </Button>
          </div>
          <Input
            id="delete-deployment-confirm"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canDelete) {
                e.preventDefault();
                onConfirm(deleteImage === true);
              }
            }}
            placeholder={expectedText}
            autoComplete="off"
          />
        </div>
        </div>

        <DialogFooter className="mt-4 grid grid-cols-2 gap-3 border-t border-border bg-muted/30 px-5 py-4 sm:flex-row sm:justify-center">
          <Button type="button" variant="ghost" onClick={onClose} className="w-full min-w-0">
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => onConfirm(deleteImage === true)}
            disabled={!canDelete}
            className="w-full min-w-0"
          >
            {isDeleting ? <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  /> : <AppIcon name="trash2" fallback={Trash2} className="mr-2 h-4 w-4"  />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Force Next.js recompile

