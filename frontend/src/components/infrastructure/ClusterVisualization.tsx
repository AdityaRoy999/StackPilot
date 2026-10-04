"use client";

import Link from "next/link";
import { type PointerEvent, type WheelEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";

import { readCanvasTheme, useCanvasThemeVersion } from "@/lib/canvas-theme";
import {
  Activity,
  Boxes,
  Code2,
  Cpu,
  Eye,
  Gauge,
  GitBranch,
  Loader2,
  Focus,
  Maximize2,
  Minimize2,
  Minus,
  Network,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  type LucideIcon,
} from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { toast } from "sonner";

import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface BaseResource {
  managed_by_stackpilot: boolean;
  claimed_by_StackPilot: boolean;
  claim_id: string;
  ownership_state: string;
  provider_type: "docker" | "kubernetes";
  resource_type: string;
  resource_key: string;
}

interface DockerContainer extends BaseResource {
  provider_type: "docker";
  resource_type: "container";
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  compose_project?: string;
  compose_service?: string;
  networks?: string;
}

interface DockerStats {
  name: string;
  cpu: string;
  cpu_percent?: number | null;
  memory: string;
  memory_percent?: number | null;
  pids: string;
}

interface KubernetesNode extends BaseResource {
  provider_type: "kubernetes";
  resource_type: "node";
  name: string;
  ready: boolean;
  version: string;
  os_image: string;
  container_runtime: string;
  architecture: string;
  kernel_version: string;
  capacity: Record<string, string>;
  allocatable: Record<string, string>;
  conditions: Array<{ type: string; status: string; reason: string; message: string }>;
}

interface KubernetesPod extends BaseResource {
  provider_type: "kubernetes";
  resource_type: "pod";
  namespace: string;
  name: string;
  node: string;
  phase: string;
  pod_ip: string;
  restart_count: number;
  containers_ready: number;
  container_count: number;
}

interface KubernetesDeployment extends BaseResource {
  provider_type: "kubernetes";
  resource_type: "deployment";
  namespace: string;
  name: string;
  replicas: number;
  desired_replicas: number;
  ready_replicas: number;
  available_replicas: number;
  updated_replicas: number;
  generation: number;
  observed_generation: number;
  conditions: Array<{ type: string; status: string; reason: string; message: string }>;
}

interface KubernetesService extends BaseResource {
  provider_type: "kubernetes";
  resource_type: "service";
  namespace: string;
  name: string;
  type: string;
  cluster_ip: string;
  ports: Array<{ name: string; protocol: string; port: number; target_port: string | number; node_port: number }>;
}

interface KubernetesEvent {
  namespace: string;
  name: string;
  type: string;
  reason: string;
  message: string;
  count: number;
  involved_kind: string;
  involved_name: string;
  first_timestamp: string;
  last_timestamp: string;
}

interface KubernetesMetric {
  name: string;
  namespace?: string;
  cpu: string;
  cpu_percent?: number | null;
  memory: string;
  memory_percent?: number | null;
}

interface InfrastructureInventory {
  status: string;
  mode: string;
  timestamp: string;
  docker: {
    available: boolean;
    container_count: number;
    image_count: number;
    containers: DockerContainer[];
    stats?: DockerStats[];
  };
  kubernetes: {
    available: boolean;
    namespace_count: number;
    node_count: number;
    pod_count: number;
    deployment_count: number;
    service_count: number;
    event_count: number;
    nodes: KubernetesNode[];
    pods: KubernetesPod[];
    deployments: KubernetesDeployment[];
    services: KubernetesService[];
    events: KubernetesEvent[];
    node_metrics?: KubernetesMetric[];
    pod_metrics?: KubernetesMetric[];
  };
  warnings: string[];
}

const EMPTY_VISUAL_INVENTORY: InfrastructureInventory = {
  status: "unknown",
  mode: "local",
  timestamp: "",
  docker: {
    available: false,
    container_count: 0,
    image_count: 0,
    containers: [],
    stats: [],
  },
  kubernetes: {
    available: false,
    namespace_count: 0,
    node_count: 0,
    pod_count: 0,
    deployment_count: 0,
    service_count: 0,
    event_count: 0,
    nodes: [],
    pods: [],
    deployments: [],
    services: [],
    events: [],
    node_metrics: [],
    pod_metrics: [],
  },
  warnings: [],
};

function normalizeVisualInventory(data?: Partial<InfrastructureInventory> | null): InfrastructureInventory {
  const docker = data?.docker || EMPTY_VISUAL_INVENTORY.docker;
  const kubernetes = data?.kubernetes || EMPTY_VISUAL_INVENTORY.kubernetes;
  return {
    ...EMPTY_VISUAL_INVENTORY,
    ...data,
    docker: {
      ...EMPTY_VISUAL_INVENTORY.docker,
      ...docker,
      containers: Array.isArray(docker.containers) ? docker.containers : [],
      stats: Array.isArray(docker.stats) ? docker.stats : [],
    },
    kubernetes: {
      ...EMPTY_VISUAL_INVENTORY.kubernetes,
      ...kubernetes,
      nodes: Array.isArray(kubernetes.nodes) ? kubernetes.nodes : [],
      pods: Array.isArray(kubernetes.pods) ? kubernetes.pods : [],
      deployments: Array.isArray(kubernetes.deployments) ? kubernetes.deployments : [],
      services: Array.isArray(kubernetes.services) ? kubernetes.services : [],
      events: Array.isArray(kubernetes.events) ? kubernetes.events : [],
      node_metrics: Array.isArray(kubernetes.node_metrics) ? kubernetes.node_metrics : [],
      pod_metrics: Array.isArray(kubernetes.pod_metrics) ? kubernetes.pod_metrics : [],
    },
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  };
}

interface SshConnection {
  id: string;
  name: string;
  connection_type: string;
  host: string;
  port: number;
  username: string;
}

type GraphResource = DockerContainer | KubernetesNode | KubernetesPod | KubernetesDeployment | KubernetesService;
type GraphKind = "cluster" | "node" | "pod" | "deployment" | "service" | "container";

interface GraphNode {
  id: string;
  kind: GraphKind;
  label: string;
  sublabel: string;
  status: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  resource?: GraphResource;
}

interface GraphEdge {
  from: string;
  to: string;
  color: string;
}

interface ActionResponse {
  action?: string;
  dry_run?: boolean;
  output?: string;
  restart_output?: string;
  status?: string;
  error?: string;
}

interface YamlResponse {
  mode: string;
  resource_type: string;
  namespace: string;
  name: string;
  yaml: string;
}

interface AiResponse {
  status: "ok" | "error";
  summary?: string;
  error?: string;
  model?: string;
}

const KIND_COLORS: Record<GraphKind, string> = {
  cluster: "#e5e7eb",
  node: "#22c55e",
  pod: "#38bdf8",
  deployment: "#60a5fa",
  service: "#f59e0b",
  container: "#fb7185",
};

function apiErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError<{ error?: string }>(error)) return error.response?.data?.error || fallback;
  return fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseCpuUnits(value?: string) {
  if (!value) return 0;
  const trimmed = value.trim();
  if (trimmed.endsWith("m")) return Number(trimmed.slice(0, -1)) / 1000;
  return Number(trimmed) || 0;
}

function parseMemoryGi(value?: string) {
  if (!value) return 0;
  const trimmed = value.trim().toLowerCase();
  const amount = Number.parseFloat(trimmed.replace(/[a-z]+/g, ""));
  if (!Number.isFinite(amount)) return 0;
  if (trimmed.endsWith("ki")) return amount / 1024 / 1024;
  if (trimmed.endsWith("mi")) return amount / 1024;
  if (trimmed.endsWith("gi")) return amount;
  if (trimmed.endsWith("ti")) return amount * 1024;
  return amount / 1024 / 1024 / 1024;
}

function formatNumber(value: number, suffix = "") {
  if (!Number.isFinite(value)) return "-";
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}${suffix}`;
}

function shortText(value: string, max = 22) {
  if (!value) return "-";
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function resourceDisplayName(resource?: GraphResource) {
  if (!resource) return "StackPilot Cluster";
  if ("namespace" in resource && resource.namespace) return `${resource.namespace}/${resource.name}`;
  return resource.name;
}

function resourceSubtitle(resource?: GraphResource) {
  if (!resource) return "Live cluster topology";
  if (resource.provider_type === "docker") return `${resource.image} - ${resource.status}`;
  if (resource.resource_type === "node") return `${resource.ready ? "Ready" : "Not ready"} - ${resource.version}`;
  if (resource.resource_type === "pod") return `${resource.phase} - ${resource.containers_ready}/${resource.container_count} containers`;
  if (resource.resource_type === "deployment") return `${resource.ready_replicas}/${resource.desired_replicas} ready replicas`;
  if (resource.resource_type === "service") return `${resource.type} - ${resource.cluster_ip || "no cluster IP"}`;
  return (resource as BaseResource).resource_type;
}

function statusTone(status: string) {
  const normalized = status.toLowerCase();
  if (["ready", "running", "active", "ok", "true", "healthy"].includes(normalized)) return "text-emerald-400";
  if (["not_ready", "failed", "error", "crashed", "pending", "unknown", "degraded", "exited"].includes(normalized)) return "text-red-400";
  return "text-muted-foreground";
}

function graphHit(node: GraphNode, x: number, y: number) {
  return x >= node.x - node.width / 2 &&
    x <= node.x + node.width / 2 &&
    y >= node.y - node.height / 2 &&
    y <= node.y + node.height / 2;
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function colorWithAlpha(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  if (value.length !== 6) return `rgba(255,255,255,${alpha})`;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function claimPayload(resource: GraphResource) {
  const payload: Record<string, unknown> = {
    claim_id: resource.claim_id,
    provider_type: resource.provider_type,
    resource_type: resource.resource_type,
    resource_key: resource.resource_key,
    name: resource.name,
  };
  if ("namespace" in resource) payload.namespace = resource.namespace;
  if (resource.provider_type === "docker") {
    payload.external_id = resource.id;
    payload.image = resource.image;
    payload.status = resource.status;
  }
  return payload;
}

function kubernetesYamlPayload(resource: GraphResource) {
  return {
    resource_type: resource.resource_type,
    namespace: "namespace" in resource ? resource.namespace : "",
    name: "namespace" in resource && resource.namespace ? resource.name : resourceDisplayName(resource),
  };
}

function monitorHref(resource?: GraphResource) {
  if (!resource) return "/dashboard/logging-monitoring/infrastructure";
  const params = new URLSearchParams({
    provider_type: resource.provider_type,
    resource_type: resource.resource_type,
    resource_key: resource.resource_key,
  });
  return `/dashboard/logging-monitoring/infrastructure?${params.toString()}`;
}

function extractYamlFromAi(value: string) {
  const text = (value || "").trim();
  const fenced = text.match(/```(?:yaml|yml)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

export function ClusterVisualization() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  // Set on a fullscreen transition, consumed by the ResizeObserver once the
  // shell has actually been remeasured at its new size.
  const pendingFullscreenFitRef = useRef(false);
  const graphNodesRef = useRef<GraphNode[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: 1180, height: 640 });
  const [view, setView] = useState({ x: 80, y: 40, scale: 0.78 });
  const [drag, setDrag] = useState<{ pointerId: number; x: number; y: number; originX: number; originY: number; moved: boolean } | null>(null);
  const pendingPanViewRef = useRef<{ x: number; y: number; scale: number } | null>(null);
  const panFrameRef = useRef<number | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [resourceSearch, setResourceSearch] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("cluster");
  const [replicaDraft, setReplicaDraft] = useState("1");
  const [yamlDraft, setYamlDraft] = useState("");
  const [yamlResourceKey, setYamlResourceKey] = useState("");
  const [actionOutput, setActionOutput] = useState("");
  const [targetConnectionId, setTargetConnectionId] = useState("local");
  const targetQueryValue = targetConnectionId === "local" ? "" : `?connection_id=${encodeURIComponent(targetConnectionId)}`;
  const withTarget = <T extends Record<string, unknown>>(payload: T) => ({
    ...payload,
    target_connection_id: targetConnectionId === "local" ? "" : targetConnectionId,
  });

  const connectionsQuery = useQuery({
    queryKey: ["ssh-connections"],
    queryFn: async () => {
      // Shape must match every other consumer of the ["ssh-connections"] key —
      // React Query caches per key, so a divergent shape here crashes whichever
      // component reads the cache entry it didn't write.
      const response = await api.get<{ connections?: SshConnection[]; count?: number }>("/ssh/connections");
      return response.data;
    },
  });
  const sshConnections = Array.isArray(connectionsQuery.data?.connections)
    ? connectionsQuery.data.connections
    : [];

  const inventoryQuery = useQuery({
    queryKey: ["infrastructure-inventory-visualization", targetConnectionId],
    queryFn: async () => {
      const response = await api.get<InfrastructureInventory>(`/infrastructure/inventory${targetQueryValue}`);
      return normalizeVisualInventory(response.data);
    },
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });

  const inventory = inventoryQuery.data;
  const nodeMetricsByName = useMemo(() => {
    const map = new Map<string, KubernetesMetric>();
    for (const metric of inventory?.kubernetes.node_metrics || []) map.set(metric.name, metric);
    return map;
  }, [inventory?.kubernetes.node_metrics]);

  const podMetricsByKey = useMemo(() => {
    const map = new Map<string, KubernetesMetric>();
    for (const metric of inventory?.kubernetes.pod_metrics || []) map.set(`${metric.namespace}/${metric.name}`, metric);
    return map;
  }, [inventory?.kubernetes.pod_metrics]);

  const dockerStatsByName = useMemo(() => {
    const map = new Map<string, DockerStats>();
    for (const metric of inventory?.docker.stats || []) map.set(metric.name, metric);
    return map;
  }, [inventory?.docker.stats]);

  const graph = useMemo(() => {
    // Tidy left-to-right tree. Every node is placed relative to its parent and
    // each subtree owns a vertical band, so edges stay short and never cross.
    // Columns are fixed depths; only the vertical cursor advances as we lay out.
    const compact = canvasSize.width < 720;
    const medium = canvasSize.width < 1160;
    const COL = compact
      ? { cluster: 0, group: 190, leaf: 390 }
      : medium
        ? { cluster: 0, group: 220, leaf: 390 }
        : { cluster: 0, group: 310, leaf: 620 };
    const LEAF_COLUMNS = compact
      ? 2
      : medium
        ? canvasSize.width >= 840 ? 3 : 2
        : canvasSize.width >= 1210 ? 3 : 2;
    const LEAF_WIDTH = compact ? 164 : medium ? 180 : 210;
    const LEAF_COLUMN_GAP = compact ? 185 : medium ? 180 : 240;
    const LEAF_ROW_GAP = 12;
    const GROUP_GAP = 44;

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const k8sNodes = inventory?.kubernetes.nodes || [];
    const pods = inventory?.kubernetes.pods || [];
    const deployments = inventory?.kubernetes.deployments || [];
    const services = inventory?.kubernetes.services || [];
    const containers = inventory?.docker.containers || [];

    let cursorY = 0;

    // Lays out one branch: a group anchor in the middle column with its leaves
    // stacked in the outer column, then centers the anchor on its own leaves.
    const addBranch = (
      anchor: { id: string; label: string; sublabel: string; status: string; color: string; kind: GraphKind; resource?: GraphResource },
      leaves: Array<{ id: string; label: string; sublabel: string; status: string; color: string; kind: GraphKind; resource?: GraphResource }>,
      edgeColor: string,
      collapsed = false
    ) => {
      const leafH = 42;
      const startY = cursorY;
      const visibleLeaves = collapsed ? [] : leaves;
      const rowCount = Math.ceil(visibleLeaves.length / LEAF_COLUMNS);

      visibleLeaves.forEach((leaf, index) => {
        const column = index % LEAF_COLUMNS;
        const row = Math.floor(index / LEAF_COLUMNS);
        nodes.push({
          ...leaf,
          x: COL.leaf + column * LEAF_COLUMN_GAP,
          y: startY + row * (leafH + LEAF_ROW_GAP),
          width: LEAF_WIDTH,
          height: leafH,
        });
      });

      const span = rowCount > 0 ? (rowCount - 1) * (leafH + LEAF_ROW_GAP) : 0;
      const anchorY = startY + span / 2;
      nodes.push({ ...anchor, sublabel: `${leaves.length} resources - ${collapsed ? "click to expand" : "click to collapse"}`, x: COL.group, y: anchorY, width: compact ? 154 : medium ? 170 : 190, height: 54 });

      for (const leaf of visibleLeaves) {
        edges.push({ from: anchor.id, to: leaf.id, color: edgeColor });
      }
      edges.push({ from: "cluster", to: anchor.id, color: "rgba(148,163,184,0.30)" });

      cursorY = startY + Math.max(span + leafH, 54) + GROUP_GAP;
      return anchorY;
    };

    const podsByNode = new Map<string, KubernetesPod[]>();
    for (const pod of pods) {
      const list = podsByNode.get(pod.node) || [];
      list.push(pod);
      podsByNode.set(pod.node, list);
    }

    // One branch per Kubernetes node, carrying its own pods.
    k8sNodes.forEach((resource) => {
      const metric = nodeMetricsByName.get(resource.name);
      const cpu =
        typeof metric?.cpu_percent === "number"
          ? `CPU ${formatNumber(metric.cpu_percent, "%")}`
          : resource.allocatable?.cpu || "CPU -";

      const hostPods = (podsByNode.get(resource.name) || []).map((pod) => {
        const podMetric = podMetricsByKey.get(`${pod.namespace}/${pod.name}`);
        return {
          id: `pod:${pod.namespace}/${pod.name}`,
          kind: "pod" as GraphKind,
          label: pod.name,
          sublabel: podMetric?.cpu ? `${podMetric.cpu} CPU` : pod.phase,
          status: pod.phase,
          color: pod.phase === "Running" ? KIND_COLORS.pod : "#f97316",
          resource: pod as GraphResource,
        };
      });

      addBranch(
        {
          id: `node:${resource.name}`,
          kind: "node",
          label: resource.name,
          sublabel: cpu,
          status: resource.ready ? "ready" : "not_ready",
          color: resource.ready ? KIND_COLORS.node : "#ef4444",
          resource,
        },
        hostPods,
        "rgba(56,189,248,0.30)",
        collapsedGroups.has(`node:${resource.name}`)
      );
    });

    if (deployments.length > 0) {
      addBranch(
        {
          id: "group:deployments",
          kind: "deployment",
          label: "Deployments",
          sublabel: `${deployments.length} workload${deployments.length === 1 ? "" : "s"}`,
          status: "ready",
          color: KIND_COLORS.deployment,
        },
        deployments.map((resource) => ({
          id: `deployment:${resource.namespace}/${resource.name}`,
          kind: "deployment" as GraphKind,
          label: resource.name,
          sublabel: `${resource.ready_replicas}/${resource.desired_replicas} ready`,
          status: resource.ready_replicas >= resource.desired_replicas ? "ready" : "degraded",
          color: resource.ready_replicas >= resource.desired_replicas ? KIND_COLORS.deployment : "#f97316",
          resource: resource as GraphResource,
        })),
        "rgba(96,165,250,0.30)",
        collapsedGroups.has("group:deployments")
      );
    }

    if (services.length > 0) {
      addBranch(
        {
          id: "group:services",
          kind: "service",
          label: "Services",
          sublabel: `${services.length} exposed`,
          status: "ready",
          color: KIND_COLORS.service,
        },
        services.map((resource) => ({
          id: `service:${resource.namespace}/${resource.name}`,
          kind: "service" as GraphKind,
          label: resource.name,
          sublabel: resource.type,
          status: "ready",
          color: KIND_COLORS.service,
          resource: resource as GraphResource,
        })),
        "rgba(245,158,11,0.30)",
        collapsedGroups.has("group:services")
      );
    }

    if (containers.length > 0) {
      const running = containers.filter((item) => item.status.toLowerCase().includes("up")).length;
      addBranch(
        {
          id: "group:docker",
          kind: "container",
          label: "Docker",
          sublabel: `${running}/${containers.length} running`,
          status: running === containers.length ? "ready" : "degraded",
          color: KIND_COLORS.container,
        },
        containers.map((resource) => {
          const metric = dockerStatsByName.get(resource.name);
          const isUp = resource.status.toLowerCase().includes("up");
          return {
            id: `container:${resource.name || resource.id}`,
            kind: "container" as GraphKind,
            label: resource.name,
            sublabel: [resource.compose_service, metric?.cpu ? `CPU ${metric.cpu}` : resource.status, resource.networks].filter(Boolean).join(" | "),
            status: resource.status,
            color: isUp ? KIND_COLORS.container : "#64748b",
            resource: resource as GraphResource,
          };
        }),
        "rgba(251,113,133,0.30)",
        collapsedGroups.has("group:docker")
      );
    }

    // Root sits centered against everything it feeds.
    const totalHeight = Math.max(cursorY - GROUP_GAP, 0);
    nodes.unshift({
      id: "cluster",
      kind: "cluster",
      label: "StackPilot Cluster",
      sublabel: inventory?.kubernetes.available ? "Kubernetes reachable" : "Docker topology",
      status: inventory?.kubernetes.available ? "ready" : "observed",
      x: COL.cluster,
      y: totalHeight / 2,
      width: compact ? 150 : medium ? 180 : 200,
      height: 64,
      color: KIND_COLORS.cluster,
    });

    return { nodes, edges };
  }, [canvasSize.width, collapsedGroups, dockerStatsByName, inventory, nodeMetricsByName, podMetricsByKey]);

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) || graph.nodes[0];
  const selectedResource = selectedNode?.resource;
  const selectedMonitorHref = useMemo(() => {
    const href = monitorHref(selectedResource);
    if (targetConnectionId === "local") return href;
    return `${href}${href.includes("?") ? "&" : "?"}connection_id=${encodeURIComponent(targetConnectionId)}`;
  }, [selectedResource, targetConnectionId]);

  // Frames the whole topology instead of jumping to an arbitrary fixed offset.
  // Takes explicit dimensions so callers holding fresher measurements than the
  // canvasSize state (the ResizeObserver) can fit without waiting for a render.
  useLayoutEffect(() => { graphNodesRef.current = graph.nodes; }, [graph.nodes]);

  const fitToSize = useCallback((viewportWidth: number, viewportHeight: number) => {
    const currentNodes = graphNodesRef.current;
    if (currentNodes.length === 0 || viewportWidth === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of currentNodes) {
      minX = Math.min(minX, node.x - node.width / 2);
      maxX = Math.max(maxX, node.x + node.width / 2);
      minY = Math.min(minY, node.y - node.height / 2);
      maxY = Math.max(maxY, node.y + node.height / 2);
    }
    const padding = 56;
    const width = Math.max(maxX - minX, 1);
    const height = Math.max(maxY - minY, 1);
    const scale = clamp(
      Math.min((viewportWidth - padding * 2) / width, (viewportHeight - padding * 2) / height),
      0.25,
      1.4
    );
    setView({
      x: viewportWidth / 2 - ((minX + maxX) / 2) * scale,
      y: viewportHeight / 2 - ((minY + maxY) / 2) * scale,
      scale,
    });
  }, []);

  const fitToContent = useCallback(
    () => fitToSize(canvasSize.width, canvasSize.height),
    [canvasSize.height, canvasSize.width, fitToSize]
  );

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const update = () => {
      const rect = shell.getBoundingClientRect();
      // Read fullscreen at call time so this observer never holds a stale value.
      const fullscreen = document.fullscreenElement !== null;
      const width = Math.max(320, Math.floor(rect.width));
      const height = fullscreen
        ? Math.max(320, Math.floor(rect.height))
        : Math.max(420, Math.min(760, Math.floor(window.innerHeight - 230)));
      setCanvasSize((current) => current.width === width && current.height === height ? current : { width, height });
      // Re-frame only after a fullscreen transition — a plain window resize must
      // not yank the viewport while the user is inspecting something.
      if (pendingFullscreenFitRef.current) {
        pendingFullscreenFitRef.current = false;
        fitToSize(width, height);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [fitToSize]);

  const screenToWorld = useCallback((x: number, y: number) => ({
    x: (x - view.x) / view.scale,
    y: (y - view.y) / view.scale,
  }), [view.scale, view.x, view.y]);

  const themeVersion = useCanvasThemeVersion();

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(canvasSize.width * dpr);
    const pixelHeight = Math.round(canvasSize.height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    if (canvas.style.width !== `${canvasSize.width}px`) canvas.style.width = `${canvasSize.width}px`;
    if (canvas.style.height !== `${canvasSize.height}px`) canvas.style.height = `${canvasSize.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Resolved from the live CSS variables, so every theme is handled rather
    // than just light and dark. themeVersion is in this callback's deps purely
    // to force a repaint when the theme changes.
    void themeVersion;
    const palette = readCanvasTheme(ctx);

    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);

    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 1;
    const grid = 42 * view.scale;
    const offsetX = view.x % grid;
    const offsetY = view.y % grid;
    for (let x = offsetX; x < canvasSize.width; x += grid) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvasSize.height);
      ctx.stroke();
    }
    for (let y = offsetY; y < canvasSize.height; y += grid) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvasSize.width, y);
      ctx.stroke();
    }

    graphNodesRef.current = graph.nodes;
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);

    // Left-to-right hierarchy: leave from the parent's right edge and arrive at
    // the child's left edge with a horizontal bezier, so lines read as branches
    // instead of crossing through the boxes they connect.
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const viewportWorld = { left: -view.x / view.scale, top: -view.y / view.scale, right: (canvasSize.width - view.x) / view.scale, bottom: (canvasSize.height - view.y) / view.scale };
    const visibleNodes = graph.nodes.filter((node) => node.x + node.width / 2 >= viewportWorld.left && node.x - node.width / 2 <= viewportWorld.right && node.y + node.height / 2 >= viewportWorld.top && node.y - node.height / 2 <= viewportWorld.bottom);
    const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    for (const edge of graph.edges) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to || (!visibleNodeIds.has(edge.from) && !visibleNodeIds.has(edge.to))) continue;
      const startX = from.x + from.width / 2;
      const endX = to.x - to.width / 2;
      const control = Math.max(28, (endX - startX) / 2);
      ctx.strokeStyle = edge.color;
      ctx.lineWidth = 1.4 / view.scale;
      ctx.beginPath();
      ctx.moveTo(startX, from.y);
      ctx.bezierCurveTo(startX + control, from.y, endX - control, to.y, endX, to.y);
      ctx.stroke();
    }

    for (const node of visibleNodes) {
      const selected = node.id === selectedNodeId;
      const x = node.x - node.width / 2;
      const y = node.y - node.height / 2;
      drawRoundedRect(ctx, x, y, node.width, node.height, 10);
      ctx.fillStyle = colorWithAlpha(node.color, selected ? 0.24 : 0.13);
      ctx.fill();
      ctx.strokeStyle = selected ? palette.selection : colorWithAlpha(node.color, 0.46);
      ctx.lineWidth = selected ? 2 / view.scale : 1 / view.scale;
      ctx.stroke();
      ctx.fillStyle = node.color;
      ctx.beginPath();
      ctx.arc(x + 14, y + 19, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = palette.title;
      ctx.font = "600 13px Inter, system-ui, sans-serif";
      ctx.fillText(shortText(node.label, node.kind === "container" ? 19 : 18), x + 26, y + 21);
      ctx.fillStyle = palette.subtitle;
      ctx.font = "11px Inter, system-ui, sans-serif";
      ctx.fillText(shortText(node.sublabel, 24), x + 26, y + 38);
    }
    ctx.restore();

    ctx.fillStyle = palette.pill;
    drawRoundedRect(ctx, 14, 14, 268, 32, 16);
    ctx.fill();
    ctx.fillStyle = palette.pillText;
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(`Drag to pan - wheel to zoom - ${Math.round(view.scale * 100)}%`, 28, 34);
  }, [canvasSize.height, canvasSize.width, graph.edges, graph.nodes, selectedNodeId, themeVersion, view]);

  useEffect(() => {
    const frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [draw]);

  const resetView = fitToContent;

  // Real fullscreen, not a CSS-only "maximize". The ResizeObserver on shellRef
  // already re-measures the canvas, so entering/exiting resizes the graph for free.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => {
      pendingFullscreenFitRef.current = true;
      setIsFullscreen(document.fullscreenElement === cardRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const card = cardRef.current;
    if (!card) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await card.requestFullscreen();
      }
    } catch {
      // Safari and locked-down embeds can reject the request; keep the graph usable.
      toast.error("Fullscreen is not available in this browser");
    }
  }, []);


  // Re-frame only when the set of resources changes. Metric-only refreshes must
  // not yank the viewport while the user is inspecting something.
  const topologySignature = useMemo(() => graph.nodes.map((node) => `${node.id}:${node.x}:${node.y}`).join("|"), [graph.nodes]);
  const lastFitSignatureRef = useRef<string>("");
  useEffect(() => {
    if (canvasSize.width === 0 || graph.nodes.length === 0) return;
    if (lastFitSignatureRef.current === topologySignature) return;
    lastFitSignatureRef.current = topologySignature;
    fitToContent();
  }, [canvasSize.width, fitToContent, graph.nodes.length, topologySignature]);

  const zoomBy = (factor: number) => {
    const cx = canvasSize.width / 2;
    const cy = canvasSize.height / 2;
    const world = screenToWorld(cx, cy);
    const nextScale = clamp(view.scale * factor, 0.35, 2.4);
    setView({
      scale: nextScale,
      x: cx - world.x * nextScale,
      y: cy - world.y * nextScale,
    });
  };

  const handleWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    const nextScale = clamp(view.scale * factor, 0.35, 2.4);
    setView({
      scale: nextScale,
      x: sx - world.x * nextScale,
      y: sy - world.y * nextScale,
    });
  };

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: view.x, originY: view.y, moved: false });
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 5;
    if (moved && !drag.moved) setDrag({ ...drag, moved: true });
    if (moved) {
      pendingPanViewRef.current = { ...view, x: drag.originX + dx, y: drag.originY + dy };
      if (panFrameRef.current === null) {
        panFrameRef.current = requestAnimationFrame(() => {
          panFrameRef.current = null;
          if (pendingPanViewRef.current) setView(pendingPanViewRef.current);
        });
      }
    }
  };

  const handlePointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const currentDrag = drag;
    setDrag(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
    if (currentDrag?.moved) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const hit = [...graphNodesRef.current].reverse().find((node) => graphHit(node, world.x, world.y));
    if (!hit) {
      return;
    }
    setSelectedNodeId(hit.id);
    if (hit.id.startsWith("group:") || hit.id.startsWith("node:")) {
      setCollapsedGroups((current) => { const next = new Set(current); if (next.has(hit.id)) next.delete(hit.id); else next.add(hit.id); return next; });
    }
    setYamlDraft("");
    setYamlResourceKey("");
    setActionOutput("");
    setReplicaDraft(hit.resource?.resource_type === "deployment" ? String((hit.resource as KubernetesDeployment).desired_replicas || 1) : "1");
    if (hit.resource) inspectMutation.mutate(hit.resource);
  };

  const yamlResourceMutation = useMutation({
    mutationFn: async (resource: GraphResource) => {
      const response = await api.post<YamlResponse>("/infrastructure/kubernetes/yaml", withTarget(kubernetesYamlPayload(resource)));
      return response.data;
    },
    onSuccess: (data, resource) => {
      setYamlDraft(data.yaml || "");
      setYamlResourceKey(resource.resource_key);
      setActionOutput("");
    },
    onError: (error: unknown) => toast.error(apiErrorMessage(error, "Failed to load Kubernetes YAML")),
  });

  const inspectMutation = useMutation({
    mutationFn: async (resource: GraphResource) => {
      const response = await api.post<ActionResponse>("/infrastructure/actions/inspect", withTarget(claimPayload(resource)));
      return response.data;
    },
    onSuccess: (data) => setActionOutput(data.output || JSON.stringify(data, null, 2)),
    onError: (error: unknown) => toast.error(apiErrorMessage(error, "Inspect failed. Claim the resource first.")),
  });

  const restartMutation = useMutation({
    mutationFn: async (resource: GraphResource) => {
      const response = await api.post<ActionResponse>("/infrastructure/actions/restart", {
        ...claimPayload(resource),
        target_connection_id: targetConnectionId === "local" ? "" : targetConnectionId,
        confirm: true,
      });
      return response.data;
    },
    onSuccess: (data) => {
      toast.success("Restart requested");
      setActionOutput(data.output || data.status || "Restart requested");
      inventoryQuery.refetch();
    },
    onError: (error: unknown) => toast.error(apiErrorMessage(error, "Restart failed. Claim the resource first.")),
  });

  const scaleMutation = useMutation({
    mutationFn: async ({ resource, replicas }: { resource: KubernetesDeployment; replicas: number }) => {
      const response = await api.post<ActionResponse>("/infrastructure/actions/scale", {
        ...claimPayload(resource),
        target_connection_id: targetConnectionId === "local" ? "" : targetConnectionId,
        replicas,
        confirm: true,
      });
      return response.data;
    },
    onSuccess: (data) => {
      toast.success("Scale requested");
      setActionOutput(data.output || data.status || "Scale operation completed");
      inventoryQuery.refetch();
    },
    onError: (error: unknown) => toast.error(apiErrorMessage(error, "Scale failed. Claim the deployment first.")),
  });

  const dockerStateMutation = useMutation({
    mutationFn: async ({ resource, action }: { resource: DockerContainer; action: "start" | "stop" }) => {
      const response = await api.post<ActionResponse>("/infrastructure/actions/docker-state", {
        ...claimPayload(resource),
        target_connection_id: targetConnectionId === "local" ? "" : targetConnectionId,
        action,
        confirm: true,
      });
      return response.data;
    },
    onSuccess: (data) => {
      toast.success("Docker state action requested");
      setActionOutput(data.output || data.status || "Docker action completed");
      inventoryQuery.refetch();
    },
    onError: (error: unknown) => toast.error(apiErrorMessage(error, "Docker action failed. Claim the container first.")),
  });

  const nodeControlMutation = useMutation({
    mutationFn: async ({ resource, action, dryRun = false }: { resource: KubernetesNode; action: string; dryRun?: boolean }) => {
      const response = await api.post<ActionResponse>("/infrastructure/actions/kubernetes-control", {
        ...claimPayload(resource),
        target_connection_id: targetConnectionId === "local" ? "" : targetConnectionId,
        action,
        confirm: action === "node_describe" ? false : true,
        dry_run: dryRun,
      });
      return response.data;
    },
    onSuccess: (data) => {
      toast.success(data.dry_run ? "Dry-run generated" : "Node action completed");
      setActionOutput(data.output || data.status || "Node action completed");
      inventoryQuery.refetch();
    },
    onError: (error: unknown) => toast.error(apiErrorMessage(error, "Node action failed. Claim the node first.")),
  });

  const applyYamlMutation = useMutation({
    mutationFn: async ({ resource, dryRun }: { resource: GraphResource; dryRun: boolean }) => {
      const response = await api.post<ActionResponse>("/infrastructure/kubernetes/apply-yaml", {
        ...claimPayload(resource),
        target_connection_id: targetConnectionId === "local" ? "" : targetConnectionId,
        yaml: yamlDraft,
        dry_run: dryRun,
        confirm: !dryRun,
        restart: true,
      });
      return response.data;
    },
    onSuccess: (data) => {
      toast.success(data.dry_run ? "YAML dry-run completed" : "YAML applied");
      setActionOutput([data.output, data.restart_output].filter(Boolean).join("\n\n"));
      inventoryQuery.refetch();
    },
    onError: (error: unknown) => toast.error(apiErrorMessage(error, "YAML apply failed. Claim the resource first and check the manifest.")),
  });

  const generateYamlMutation = useMutation({
    mutationFn: async (resource: GraphResource) => {
      const response = await api.post<AiResponse>("/ai/chat", {
        command: "generate_yaml",
        model_mode: "fast",
        message:
          "Generate Kubernetes YAML for the selected resource using the supplied StackPilot cluster context. " +
          "Return only valid Kubernetes YAML. Do not wrap it in markdown fences. Preserve namespace and object identity unless the user clearly needs a replacement.",
        runtime: {
          selected_resource: resource,
          current_yaml: yamlDraft,
          cluster_summary: {
            nodes: inventory?.kubernetes.node_count || 0,
            pods: inventory?.kubernetes.pod_count || 0,
            deployments: inventory?.kubernetes.deployment_count || 0,
            services: inventory?.kubernetes.service_count || 0,
            docker_containers: inventory?.docker.container_count || 0,
          },
        },
      });
      return response.data;
    },
    onSuccess: (data) => {
      if (data.status === "error") {
        toast.error(data.error || "AI YAML generation failed");
        return;
      }
      const generated = extractYamlFromAi(data.summary || "");
      if (!generated) {
        toast.error("AI returned an empty YAML response");
        return;
      }
      setYamlDraft(generated);
      toast.success("AI YAML draft generated");
    },
    onError: () => toast.error("AI YAML generation failed"),
  });

  const summary = useMemo(() => {
    const nodes = inventory?.kubernetes.nodes || [];
    const pods = inventory?.kubernetes.pods || [];
    const deployments = inventory?.kubernetes.deployments || [];
    const totalCpu = nodes.reduce((sum, node) => sum + parseCpuUnits(node.allocatable?.cpu || node.capacity?.cpu), 0);
    const totalMemory = nodes.reduce((sum, node) => sum + parseMemoryGi(node.allocatable?.memory || node.capacity?.memory), 0);
    const avgCpuUsage = inventory?.kubernetes.node_metrics?.length
      ? inventory.kubernetes.node_metrics.reduce((sum, metric) => sum + (metric.cpu_percent || 0), 0) / inventory.kubernetes.node_metrics.length
      : null;
    const avgMemoryUsage = inventory?.kubernetes.node_metrics?.length
      ? inventory.kubernetes.node_metrics.reduce((sum, metric) => sum + (metric.memory_percent || 0), 0) / inventory.kubernetes.node_metrics.length
      : null;
    return {
      readyNodes: nodes.filter((node) => node.ready).length,
      totalNodes: nodes.length,
      runningPods: pods.filter((pod) => pod.phase === "Running").length,
      totalPods: pods.length,
      healthyDeployments: deployments.filter((deployment) => deployment.ready_replicas >= deployment.desired_replicas).length,
      totalDeployments: deployments.length,
      totalCpu,
      totalMemory,
      avgCpuUsage,
      avgMemoryUsage,
    };
  }, [inventory]);

  const relatedEvents = useMemo(() => {
    if (!selectedResource || !inventory) return [];
    const name = resourceDisplayName(selectedResource).split("/").pop() || "";
    return inventory.kubernetes.events
      .filter((event) => event.involved_name === name || event.message.includes(name))
      .slice(0, 4);
  }, [inventory, selectedResource]);

  const selectedMetricRows = useMemo(() => {
    if (!selectedResource) {
      return [
        ["Nodes", `${summary.readyNodes}/${summary.totalNodes} ready`],
        ["Pods", `${summary.runningPods}/${summary.totalPods} running`],
        ["Deployments", `${summary.healthyDeployments}/${summary.totalDeployments} healthy`],
      ];
    }
    return resourceRows(selectedResource, nodeMetricsByName, dockerStatsByName);
  }, [dockerStatsByName, nodeMetricsByName, selectedResource, summary]);

  const canUseYaml = selectedResource?.provider_type === "kubernetes";
  const canApplyYaml = Boolean(canUseYaml && selectedResource?.claimed_by_StackPilot && yamlDraft.trim());

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground">
            <AppIcon name="activity" fallback={Activity} className="h-3.5 w-3.5"  />
            Draggable topology and runtime signals
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight">Visualization Layer</h1>
          <p className="max-w-3xl text-muted-foreground">
            Pan, zoom, and inspect live Docker or Kubernetes resources. Observed resources are read-only; claimed resources can be changed from here.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 xl:shrink-0">
          <Select value={targetConnectionId} onValueChange={(value) => setTargetConnectionId(value || "local")}>
            <SelectTrigger className="h-10 w-[200px] sm:w-[240px] md:w-[260px] shrink-0 justify-between">
              <SelectValue placeholder="Select infrastructure target" />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-[240px]">
              <SelectItem value="local">Local StackPilot host</SelectItem>
              {sshConnections.map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.name} - {connection.username}@{connection.host}:{connection.port}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" className="shrink-0 whitespace-nowrap" onClick={() => inventoryQuery.refetch()} disabled={inventoryQuery.isFetching}>
            {inventoryQuery.isFetching ? <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  /> : <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4"  />}
            Refresh
          </Button>
          <Link href="/dashboard/logging-monitoring/infrastructure" className={cn(buttonVariants({ variant: "outline" }), "shrink-0 whitespace-nowrap")}>
            <AppIcon name="network" fallback={Network} className="mr-2 h-4 w-4"  />
            Open Monitor
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Server} label="Cluster nodes" value={`${summary.readyNodes}/${summary.totalNodes}`} detail="ready nodes" />
        <MetricCard icon={Boxes} label="Pods" value={`${summary.runningPods}/${summary.totalPods}`} detail="running pods" />
        <MetricCard icon={GitBranch} label="Deployments" value={`${summary.healthyDeployments}/${summary.totalDeployments}`} detail="healthy rollouts" />
        <MetricCard
          icon={Cpu}
          label="Usage"
          value={summary.avgCpuUsage == null ? "n/a" : formatNumber(summary.avgCpuUsage, "%")}
          detail={summary.avgMemoryUsage == null ? "metrics-server unavailable" : `${formatNumber(summary.avgMemoryUsage, "%")} memory`}
        />
      </div>

      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_460px]">
        <Card
          ref={cardRef}
          className={cn(
            "overflow-hidden gap-0 py-0",
            // The fullscreen element gets no page background of its own, so set one
            // and let the canvas shell take the remaining height.
            isFullscreen && "flex h-screen w-screen flex-col rounded-none bg-background py-0"
          )}
        >
          <CardHeader className="border-b border-border py-3.5 px-4 sm:px-6">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <AppIcon name="gauge" fallback={Gauge} className="h-5 w-5 text-primary"  />
                  Cluster Graph
                </CardTitle>
                <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
                      inventoryQuery.isError
                        ? "border-destructive/40 text-destructive"
                        : "border-emerald-500/40 text-emerald-500"
                    )}
                  >
                    <span className="relative flex h-1.5 w-1.5">
                      {!inventoryQuery.isError && (
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-70" />
                      )}
                      <span
                        className={cn(
                          "relative inline-flex h-1.5 w-1.5 rounded-full",
                          inventoryQuery.isError ? "bg-destructive" : "bg-emerald-500"
                        )}
                      />
                    </span>
                    {inventoryQuery.isError ? "Disconnected" : "Live"}
                  </span>
                  <span>{graph.nodes.filter((node) => node.resource).length} resources</span>
                  <span aria-hidden="true">|</span>
                  <span>Drag to pan, wheel to zoom, click a group to expand or a resource to inspect.</span>
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Legend color={KIND_COLORS.node} label="Node" />
                <Legend color={KIND_COLORS.pod} label="Pod" />
                <Legend color={KIND_COLORS.deployment} label="Deployment" />
                <Legend color={KIND_COLORS.service} label="Service" />
                <Legend color={KIND_COLORS.container} label="Container" />
                <div className="ml-0 flex items-center gap-1 rounded-lg border border-border bg-muted/20 p-1 xl:ml-2">
                  <Button size="icon-sm" variant="ghost" onClick={() => zoomBy(1.15)} title="Zoom in">
                    <AppIcon name="plus" fallback={Plus} className="h-4 w-4"  />
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => zoomBy(0.85)} title="Zoom out">
                    <AppIcon name="minus" fallback={Minus} className="h-4 w-4"  />
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={resetView} title="Fit to content">
                    <AppIcon name="focus" fallback={Focus} className="h-4 w-4"  />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={toggleFullscreen}
                    title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    aria-pressed={isFullscreen}
                  >
                    {isFullscreen ? <AppIcon name="minimize2" fallback={Minimize2} className="h-4 w-4"  /> : <AppIcon name="maximize2" fallback={Maximize2} className="h-4 w-4"  />}
                  </Button>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className={cn("min-h-0 p-0", isFullscreen && "flex-1 overflow-auto")}>
            <div
              ref={shellRef}
              className={cn(
                "relative w-full overflow-hidden",
                isFullscreen ? "min-h-0 h-full" : "min-h-[420px]"
              )}
            >
              <canvas
                ref={canvasRef}
                className={cn("block max-w-full touch-none", drag?.moved ? "cursor-grabbing" : "cursor-grab")}
                aria-label="Infrastructure topology graph. Use the resource picker below the inspector to select containers, pods, services, and other resources."
                width={canvasSize.width}
                height={canvasSize.height}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={() => setDrag(null)}
                onWheel={handleWheel}
              />
              {inventoryQuery.isLoading ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
                  <div className="flex items-center rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
                    <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />
                    Loading topology...
                  </div>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className="self-start overflow-hidden 2xl:sticky 2xl:top-20">
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center gap-2">
              <AppIcon name="settings2" fallback={Settings2} className="h-5 w-5 text-primary"  />
              Resource Inspector
            </CardTitle>
            <CardDescription>
              Actions are outside the canvas so the graph stays readable.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex max-h-[calc(100dvh-12rem)] min-h-0 flex-col overflow-hidden p-0">
            <div className="shrink-0 space-y-2 border-b border-border p-4">
              <Label htmlFor="infrastructure-resource-search">Find any resource</Label>
              <Input id="infrastructure-resource-search" value={resourceSearch} onChange={(event) => setResourceSearch(event.target.value)} placeholder="Search containers, pods, services" />
              <div className="mb-2 flex flex-wrap gap-1.5">
                {graph.nodes.filter((node) => !node.resource && node.id !== "cluster").map((group) => (
                  <Button key={group.id} size="sm" variant="outline" aria-expanded={!collapsedGroups.has(group.id)} onClick={() => { setCollapsedGroups((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; }); setSelectedNodeId(group.id); }}>
                    {collapsedGroups.has(group.id) ? "Expand" : "Collapse"} {group.label}
                  </Button>
                ))}
              </div>
              <div className="max-h-44 space-y-1 overflow-y-auto overscroll-contain" role="listbox" aria-label="Infrastructure resources">
                {graph.nodes.filter((node) => node.resource && (!resourceSearch.trim() || `${node.label} ${node.sublabel} ${node.resource.resource_key}`.toLowerCase().includes(resourceSearch.trim().toLowerCase()))).map((node) => (
                  <button key={node.id} type="button" role="option" aria-selected={node.id === selectedNodeId} onClick={() => { setSelectedNodeId(node.id); setYamlDraft(""); setYamlResourceKey(""); setActionOutput(""); if (node.resource) inspectMutation.mutate(node.resource); setCollapsedGroups((current) => { const next = new Set(current); if (node.kind === "container") next.delete("group:docker"); if (node.kind === "deployment") next.delete("group:deployments"); if (node.kind === "service") next.delete("group:services"); if (node.kind === "pod" && node.resource && "node" in node.resource) next.delete(`node:${node.resource.node}`); return next; }); }} className={cn("flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted", node.id === selectedNodeId && "bg-muted")}><span className="min-w-0 truncate">{node.label}</span><span className="shrink-0 text-xs text-muted-foreground">{node.kind}</span></button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
            <div className="rounded-xl border border-border bg-muted/20 p-4">
              <div className="min-w-0">
                <div className="truncate text-lg font-semibold text-foreground">{selectedNode?.label || "StackPilot Cluster"}</div>
                <div className="mt-1 truncate text-sm text-muted-foreground">
                  {selectedResource ? resourceSubtitle(selectedResource) : "StackPilot topology overview"}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge variant={selectedResource?.claimed_by_StackPilot ? "default" : "outline"}>
                  {selectedResource?.claimed_by_StackPilot ? "claimed" : selectedResource ? "observed" : "system"}
                </Badge>
                <span className={cn("text-sm font-medium", statusTone(selectedNode?.status || ""))}>
                  {selectedNode?.status || "ready"}
                </span>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-1">
              {selectedMetricRows.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="mt-1 truncate font-medium text-foreground">{value}</div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <Link href={selectedMonitorHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
                <AppIcon name="network" fallback={Network} className="h-4 w-4"  />
                {selectedResource && !selectedResource.claimed_by_StackPilot ? "Claim resource" : "Open monitor"}
              </Link>
              {selectedResource ? (
                <Button size="sm" variant="outline" onClick={() => inspectMutation.mutate(selectedResource)} disabled={inspectMutation.isPending}>
                  {inspectMutation.isPending ? <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  /> : <AppIcon name="eye" fallback={Eye} className="h-4 w-4"  />}
                  Inspect runtime
                </Button>
              ) : null}
              {canUseYaml && selectedResource ? (
                <Button size="sm" variant="outline" onClick={() => yamlResourceMutation.mutate(selectedResource)} disabled={yamlResourceMutation.isPending}>
                  {yamlResourceMutation.isPending ? <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  /> : <AppIcon name="code2" fallback={Code2} className="h-4 w-4"  />}
                  YAML
                </Button>
              ) : null}
              {canUseYaml && selectedResource ? (
                <Button size="sm" variant="outline" onClick={() => generateYamlMutation.mutate(selectedResource)} disabled={generateYamlMutation.isPending}>
                  {generateYamlMutation.isPending ? <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  /> : <AppIcon name="sparkles" fallback={Sparkles} className="h-4 w-4"  />}
                  Generate YAML
                </Button>
              ) : null}
              {selectedResource?.claimed_by_StackPilot && selectedResource.resource_type === "deployment" ? (
                <Button size="sm" variant="outline" onClick={() => restartMutation.mutate(selectedResource)} disabled={restartMutation.isPending}>
                  {restartMutation.isPending ? <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  /> : <AppIcon name="rotate-cw" fallback={RotateCw} className="h-4 w-4"  />}
                  Restart
                </Button>
              ) : null}
            </div>

            {selectedResource?.claimed_by_StackPilot && selectedResource.resource_type === "deployment" ? (
              <div className="rounded-lg border border-border bg-muted/15 p-3">
                <Label htmlFor="visualization-replicas" className="text-xs">Replicas</Label>
                <div className="mt-2 flex gap-2">
                  <Input id="visualization-replicas" value={replicaDraft} onChange={(event) => setReplicaDraft(event.target.value)} inputMode="numeric" />
                  <Button
                    size="sm"
                    onClick={() => scaleMutation.mutate({ resource: selectedResource as KubernetesDeployment, replicas: Math.max(0, Number(replicaDraft) || 0) })}
                    disabled={scaleMutation.isPending}
                  >
                    Apply
                  </Button>
                </div>
              </div>
            ) : null}

            {selectedResource?.claimed_by_StackPilot && selectedResource.resource_type === "node" ? (
              <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-1">
                <Button size="sm" variant="outline" onClick={() => nodeControlMutation.mutate({ resource: selectedResource as KubernetesNode, action: "node_describe" })}>Describe</Button>
                <Button size="sm" variant="outline" onClick={() => nodeControlMutation.mutate({ resource: selectedResource as KubernetesNode, action: "cordon_node", dryRun: true })}>Dry-run cordon</Button>
                <Button size="sm" variant="outline" onClick={() => nodeControlMutation.mutate({ resource: selectedResource as KubernetesNode, action: "cordon_node" })}>Cordon</Button>
                <Button size="sm" variant="outline" onClick={() => nodeControlMutation.mutate({ resource: selectedResource as KubernetesNode, action: "uncordon_node" })}>Uncordon</Button>
              </div>
            ) : null}

            {selectedResource?.claimed_by_StackPilot && selectedResource.provider_type === "docker" && selectedResource.resource_type === "container" ? (
              <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-1">
                <Button size="sm" variant="outline" onClick={() => dockerStateMutation.mutate({ resource: selectedResource as DockerContainer, action: "start" })}>Start</Button>
                <Button size="sm" variant="outline" onClick={() => dockerStateMutation.mutate({ resource: selectedResource as DockerContainer, action: "stop" })}>
                  <AppIcon name="square" fallback={Square} className="h-4 w-4"  />
                  Stop
                </Button>
              </div>
            ) : null}

            {canUseYaml && selectedResource && yamlResourceKey === selectedResource.resource_key ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="visualization-yaml" className="text-xs">Editable YAML</Label>
                  <span className="text-[11px] text-muted-foreground">Scroll horizontally to see long lines.</span>
                </div>
                <textarea
                  id="visualization-yaml"
                  value={yamlDraft}
                  onChange={(event) => setYamlDraft(event.target.value)}
                  spellCheck={false}
                  className="h-56 w-full resize-y overflow-auto rounded-lg border border-border bg-black p-3 font-mono text-xs leading-relaxed text-white outline-none ring-offset-background focus:ring-2 focus:ring-ring"
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => applyYamlMutation.mutate({ resource: selectedResource, dryRun: true })} disabled={!canApplyYaml || applyYamlMutation.isPending}>
                    Dry-run apply
                  </Button>
                  <Button size="sm" onClick={() => applyYamlMutation.mutate({ resource: selectedResource, dryRun: false })} disabled={!canApplyYaml || applyYamlMutation.isPending}>
                    {applyYamlMutation.isPending ? <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  /> : <AppIcon name="shield-check" fallback={ShieldCheck} className="h-4 w-4"  />}
                    Apply + restart
                  </Button>
                </div>
              </div>
            ) : null}

            {actionOutput ? (
              <div className="space-y-1">
                <div className="text-[11px] text-muted-foreground">Scroll horizontally to see long output.</div>
                <pre className="max-h-48 overflow-auto rounded-lg border border-border bg-black p-3 text-xs leading-relaxed text-white">
                  {actionOutput}
                </pre>
              </div>
            ) : null}

            {relatedEvents.length ? (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Recent events</div>
                {relatedEvents.map((event) => (
                  <div key={`${event.namespace}-${event.name}-${event.reason}`} className="rounded-lg border border-border bg-muted/15 p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{event.reason || event.type}</span>
                      <Badge variant={event.type === "Warning" ? "destructive" : "outline"}>{event.count || 1}</Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-muted-foreground">{event.message}</p>
                  </div>
                ))}
              </div>
            ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      {inventory?.warnings?.length ? (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
          {inventory.warnings.join(" ")}
        </div>
      ) : null}
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string; detail: string }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 p-5">
        <div>
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className="mt-2 text-3xl font-bold text-foreground">{value}</div>
          <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
        </div>
        <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-muted/30">
          <Icon className="h-5 w-5 text-primary" />
        </div>
      </CardContent>
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/20 px-2.5 py-1 text-xs text-muted-foreground">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </div>
  );
}

function resourceRows(
  resource: GraphResource,
  nodeMetricsByName: Map<string, KubernetesMetric>,
  dockerStatsByName: Map<string, DockerStats>,
) {
  const rows: Array<[string, string]> = [];
  rows.push(["Type", `${resource.provider_type}/${resource.resource_type}`]);
  rows.push(["Name", resourceDisplayName(resource)]);
  rows.push(["Owner", resource.ownership_state || "observed"]);
  if (resource.provider_type === "docker") {
    const metric = dockerStatsByName.get(resource.name);
    rows.push(["Image", resource.image]);
    rows.push(["CPU", metric?.cpu || "-"]);
    rows.push(["Memory", metric?.memory || "-"]);
    rows.push(["Compose project", resource.compose_project || "-"]);
    rows.push(["Compose service", resource.compose_service || "-"]);
    rows.push(["Networks", resource.networks || "-"]);
  } else if (resource.resource_type === "node") {
    const node = resource as KubernetesNode;
    const metric = nodeMetricsByName.get(node.name);
    rows.push(["Ready", node.ready ? "yes" : "no"]);
    rows.push(["CPU", metric?.cpu ? `${metric.cpu} (${formatNumber(metric.cpu_percent || 0, "%")})` : node.allocatable?.cpu || "-"]);
    rows.push(["Memory", metric?.memory ? `${metric.memory} (${formatNumber(metric.memory_percent || 0, "%")})` : node.allocatable?.memory || "-"]);
  } else if (resource.resource_type === "pod") {
    const pod = resource as KubernetesPod;
    rows.push(["Node", pod.node || "-"]);
    rows.push(["IP", pod.pod_ip || "-"]);
    rows.push(["Restarts", String(pod.restart_count)]);
  } else if (resource.resource_type === "deployment") {
    const deployment = resource as KubernetesDeployment;
    rows.push(["Replicas", `${deployment.ready_replicas}/${deployment.desired_replicas}`]);
    rows.push(["Available", String(deployment.available_replicas || 0)]);
    rows.push(["Generation", `${deployment.observed_generation}/${deployment.generation}`]);
  } else if (resource.resource_type === "service") {
    const service = resource as KubernetesService;
    rows.push(["Service", service.type]);
    rows.push(["Cluster IP", service.cluster_ip || "-"]);
    rows.push(["Ports", service.ports.map((port) => `${port.port}${port.node_port ? `:${port.node_port}` : ""}/${port.protocol}`).join(", ") || "-"]);
  }
  return rows;
}
