"use client";

import Link from "next/link";
import { type PointerEvent, type WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  Boxes,
  Code2,
  Cpu,
  Eye,
  Gauge,
  GitBranch,
  Loader2,
  Maximize2,
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
} from "lucide-react";
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
  deployment: "#a78bfa",
  service: "#f59e0b",
  container: "#fb7185",
};

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
  if (["ready", "running", "active", "ok", "true"].some((item) => normalized.includes(item))) return "text-emerald-400";
  if (["fail", "error", "crash", "pending", "unknown", "degraded"].some((item) => normalized.includes(item))) return "text-red-400";
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
  return {
    claim_id: resource.claim_id,
    provider_type: resource.provider_type,
    resource_type: resource.resource_type,
    resource_key: resource.resource_key,
  };
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
  const graphNodesRef = useRef<GraphNode[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: 1180, height: 640 });
  const [view, setView] = useState({ x: 80, y: 40, scale: 0.78 });
  const [drag, setDrag] = useState<{ pointerId: number; x: number; y: number; originX: number; originY: number; moved: boolean } | null>(null);
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
      const response = await api.get<{ connections: SshConnection[] }>("/ssh/connections");
      return response.data.connections || [];
    },
  });

  const inventoryQuery = useQuery({
    queryKey: ["infrastructure-inventory-visualization", targetConnectionId],
    queryFn: async () => {
      const response = await api.get<InfrastructureInventory>(`/infrastructure/inventory${targetQueryValue}`);
      return normalizeVisualInventory(response.data);
    },
    refetchInterval: 15000,
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
    const nodes: GraphNode[] = [{
      id: "cluster",
      kind: "cluster",
      label: "StackPilot Cluster",
      sublabel: inventory?.kubernetes.available ? "Kubernetes reachable" : "Topology view",
      status: inventory?.kubernetes.available ? "ready" : "observed",
      x: 820,
      y: 410,
      width: 180,
      height: 64,
      color: KIND_COLORS.cluster,
    }];
    const edges: GraphEdge[] = [];
    const k8sNodes = inventory?.kubernetes.nodes || [];
    const pods = inventory?.kubernetes.pods || [];
    const deployments = inventory?.kubernetes.deployments || [];
    const services = inventory?.kubernetes.services || [];
    const containers = inventory?.docker.containers || [];

    k8sNodes.forEach((resource, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(k8sNodes.length, 1)) * Math.PI * 2;
      const metric = nodeMetricsByName.get(resource.name);
      const cpu = typeof metric?.cpu_percent === "number" ? `CPU ${formatNumber(metric.cpu_percent, "%")}` : resource.allocatable?.cpu || "CPU -";
      const node: GraphNode = {
        id: `node:${resource.name}`,
        kind: "node",
        label: resource.name,
        sublabel: cpu,
        status: resource.ready ? "ready" : "not_ready",
        x: 820 + Math.cos(angle) * 250,
        y: 410 + Math.sin(angle) * 220,
        width: 170,
        height: 56,
        color: resource.ready ? KIND_COLORS.node : "#ef4444",
        resource,
      };
      nodes.push(node);
      edges.push({ from: "cluster", to: node.id, color: "rgba(148, 163, 184, 0.35)" });
    });

    deployments.slice(0, 32).forEach((resource, index) => {
      const node: GraphNode = {
        id: `deployment:${resource.namespace}/${resource.name}`,
        kind: "deployment",
        label: resource.name,
        sublabel: `${resource.ready_replicas}/${resource.desired_replicas} ready`,
        status: resource.ready_replicas >= resource.desired_replicas ? "ready" : "degraded",
        x: 140 + (index % 3) * 188,
        y: 90 + Math.floor(index / 3) * 72,
        width: 170,
        height: 48,
        color: KIND_COLORS.deployment,
        resource,
      };
      nodes.push(node);
      edges.push({ from: "cluster", to: node.id, color: "rgba(167, 139, 250, 0.24)" });
    });

    services.slice(0, 28).forEach((resource, index) => {
      const node: GraphNode = {
        id: `service:${resource.namespace}/${resource.name}`,
        kind: "service",
        label: resource.name,
        sublabel: resource.type,
        status: "ready",
        x: 140 + (index % 5) * 178,
        y: 780 + Math.floor(index / 5) * 62,
        width: 160,
        height: 44,
        color: KIND_COLORS.service,
        resource,
      };
      nodes.push(node);
      edges.push({ from: "cluster", to: node.id, color: "rgba(245, 158, 11, 0.24)" });
    });

    const podsByNode = new Map<string, KubernetesPod[]>();
    for (const pod of pods) {
      const list = podsByNode.get(pod.node) || [];
      list.push(pod);
      podsByNode.set(pod.node, list);
    }
    k8sNodes.forEach((host, hostIndex) => {
      const hostGraph = nodes.find((node) => node.id === `node:${host.name}`);
      if (!hostGraph) return;
      const hostPods = (podsByNode.get(host.name) || []).slice(0, 18);
      hostPods.forEach((resource, podIndex) => {
        const col = podIndex % 3;
        const row = Math.floor(podIndex / 3);
        const metric = podMetricsByKey.get(`${resource.namespace}/${resource.name}`);
        const node: GraphNode = {
          id: `pod:${resource.namespace}/${resource.name}`,
          kind: "pod",
          label: resource.name,
          sublabel: metric?.cpu ? `${metric.cpu} CPU` : resource.phase,
          status: resource.phase,
          x: hostGraph.x - 190 + col * 150 + hostIndex * 18,
          y: hostGraph.y + 84 + row * 50,
          width: 136,
          height: 38,
          color: resource.phase === "Running" ? KIND_COLORS.pod : "#f97316",
          resource,
        };
        nodes.push(node);
        edges.push({ from: hostGraph.id, to: node.id, color: "rgba(56, 189, 248, 0.26)" });
      });
    });

    containers.slice(0, 24).forEach((resource, index) => {
      const metric = dockerStatsByName.get(resource.name);
      const node: GraphNode = {
        id: `container:${resource.name || resource.id}`,
        kind: "container",
        label: resource.name,
        sublabel: metric?.cpu ? `CPU ${metric.cpu}` : resource.status,
        status: resource.status,
        x: 1450,
        y: 90 + index * 56,
        width: 205,
        height: 42,
        color: resource.status.toLowerCase().includes("up") ? KIND_COLORS.container : "#64748b",
        resource,
      };
      nodes.push(node);
      edges.push({ from: "cluster", to: node.id, color: "rgba(251, 113, 133, 0.22)" });
    });

    return { nodes, edges };
  }, [dockerStatsByName, inventory, nodeMetricsByName, podMetricsByKey]);

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) || graph.nodes[0];
  const selectedResource = selectedNode?.resource;
  const selectedMonitorHref = useMemo(() => {
    const href = monitorHref(selectedResource);
    if (targetConnectionId === "local") return href;
    return `${href}${href.includes("?") ? "&" : "?"}connection_id=${encodeURIComponent(targetConnectionId)}`;
  }, [selectedResource, targetConnectionId]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const update = () => {
      const rect = shell.getBoundingClientRect();
      setCanvasSize({
        width: Math.max(720, Math.floor(rect.width)),
        height: Math.max(540, Math.min(760, Math.floor(window.innerHeight - 230))),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const screenToWorld = useCallback((x: number, y: number) => ({
    x: (x - view.x) / view.scale,
    y: (y - view.y) / view.scale,
  }), [view.scale, view.x, view.y]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.width * dpr;
    canvas.height = canvasSize.height * dpr;
    canvas.style.width = `${canvasSize.width}px`;
    canvas.style.height = `${canvasSize.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#090909";
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);

    ctx.strokeStyle = "rgba(255,255,255,0.045)";
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

    for (const edge of graph.edges) {
      const from = graph.nodes.find((node) => node.id === edge.from);
      const to = graph.nodes.find((node) => node.id === edge.to);
      if (!from || !to) continue;
      ctx.strokeStyle = edge.color;
      ctx.lineWidth = 1.3 / view.scale;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      ctx.quadraticCurveTo(midX, midY - 28, to.x, to.y);
      ctx.stroke();
    }

    for (const node of graph.nodes) {
      const selected = node.id === selectedNodeId;
      const x = node.x - node.width / 2;
      const y = node.y - node.height / 2;
      drawRoundedRect(ctx, x, y, node.width, node.height, 10);
      ctx.fillStyle = colorWithAlpha(node.color, selected ? 0.24 : 0.13);
      ctx.fill();
      ctx.strokeStyle = selected ? "#ffffff" : colorWithAlpha(node.color, 0.46);
      ctx.lineWidth = selected ? 2 / view.scale : 1 / view.scale;
      ctx.stroke();
      ctx.fillStyle = node.color;
      ctx.beginPath();
      ctx.arc(x + 14, y + 19, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f8fafc";
      ctx.font = "600 13px Inter, system-ui, sans-serif";
      ctx.fillText(shortText(node.label, node.kind === "container" ? 19 : 18), x + 26, y + 21);
      ctx.fillStyle = "rgba(226,232,240,0.62)";
      ctx.font = "11px Inter, system-ui, sans-serif";
      ctx.fillText(shortText(node.sublabel, 24), x + 26, y + 38);
    }
    ctx.restore();

    ctx.fillStyle = "rgba(10,10,10,0.78)";
    drawRoundedRect(ctx, 14, 14, 280, 34, 17);
    ctx.fill();
    ctx.fillStyle = "rgba(226,232,240,0.8)";
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(`Drag to move - wheel to zoom - ${Math.round(view.scale * 100)}%`, 30, 36);
  }, [canvasSize.height, canvasSize.width, graph.edges, graph.nodes, selectedNodeId, view]);

  useEffect(() => {
    draw();
  }, [draw]);

  const resetView = () => {
    setView({ x: 80, y: 40, scale: 0.78 });
  };

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
    setDrag({ ...drag, moved });
    if (moved) {
      setView((current) => ({ ...current, x: drag.originX + dx, y: drag.originY + dy }));
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
    setYamlDraft("");
    setYamlResourceKey("");
    setActionOutput("");
    setReplicaDraft(hit.resource?.resource_type === "deployment" ? String((hit.resource as KubernetesDeployment).desired_replicas || 1) : "1");
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
    onError: () => toast.error("Failed to load Kubernetes YAML"),
  });

  const inspectMutation = useMutation({
    mutationFn: async (resource: GraphResource) => {
      const response = await api.post<ActionResponse>("/infrastructure/actions/inspect", withTarget(claimPayload(resource)));
      return response.data;
    },
    onSuccess: (data) => setActionOutput(data.output || JSON.stringify(data, null, 2)),
    onError: () => toast.error("Inspect failed. Claim the resource first."),
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
    onError: () => toast.error("Restart failed. Claim the resource first."),
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
    onError: () => toast.error("Scale failed. Claim the deployment first."),
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
    onError: () => toast.error("Docker action failed. Claim the container first."),
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
    onError: () => toast.error("Node action failed. Claim the node first."),
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
    onError: () => toast.error("YAML apply failed. Claim the resource first and check the manifest."),
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
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            Draggable topology and runtime signals
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight">Visualization Layer</h1>
          <p className="max-w-3xl text-muted-foreground">
            Pan, zoom, and click live Docker or Kubernetes resources. Claimed resources can be inspected, edited, restarted, or updated from YAML.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={targetConnectionId} onValueChange={(value) => setTargetConnectionId(value || "local")}>
            <SelectTrigger className="h-10 min-w-[280px] justify-between">
              <SelectValue placeholder="Select infrastructure target" />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-[280px]">
              <SelectItem value="local">Local StackPilot host</SelectItem>
              {(connectionsQuery.data || []).map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.name} - {connection.username}@{connection.host}:{connection.port}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => inventoryQuery.refetch()} disabled={inventoryQuery.isFetching}>
            {inventoryQuery.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
          <Link href="/dashboard/logging-monitoring/infrastructure" className={buttonVariants({ variant: "outline" })}>
            <Network className="mr-2 h-4 w-4" />
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
        <Card className="overflow-hidden">
          <CardHeader className="border-b border-border">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Gauge className="h-5 w-5 text-primary" />
                  Cluster Graph
                </CardTitle>
                <CardDescription>
                  Drag to pan, use the wheel to zoom, and click a resource to inspect it on the side.
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
                    <Plus className="h-4 w-4" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => zoomBy(0.85)} title="Zoom out">
                    <Minus className="h-4 w-4" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={resetView} title="Reset view">
                    <Maximize2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div ref={shellRef} className="relative min-h-[540px] w-full overflow-hidden">
              <canvas
                ref={canvasRef}
                className={cn("block touch-none", drag?.moved ? "cursor-grabbing" : "cursor-grab")}
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
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
              <Settings2 className="h-5 w-5 text-primary" />
              Resource Inspector
            </CardTitle>
            <CardDescription>
              Actions are outside the canvas so the graph stays readable.
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-[calc(100vh-12rem)] space-y-4 overflow-auto p-4">
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
              {selectedMetricRows.slice(0, 8).map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="mt-1 truncate font-medium text-foreground">{value}</div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <Link href={selectedMonitorHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
                <Network className="h-4 w-4" />
                {selectedResource && !selectedResource.claimed_by_StackPilot ? "Claim resource" : "Open monitor"}
              </Link>
              {selectedResource?.claimed_by_StackPilot ? (
                <Button size="sm" variant="outline" onClick={() => inspectMutation.mutate(selectedResource)} disabled={inspectMutation.isPending}>
                  {inspectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                  Inspect
                </Button>
              ) : null}
              {canUseYaml && selectedResource ? (
                <Button size="sm" variant="outline" onClick={() => yamlResourceMutation.mutate(selectedResource)} disabled={yamlResourceMutation.isPending}>
                  {yamlResourceMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Code2 className="h-4 w-4" />}
                  YAML
                </Button>
              ) : null}
              {canUseYaml && selectedResource ? (
                <Button size="sm" variant="outline" onClick={() => generateYamlMutation.mutate(selectedResource)} disabled={generateYamlMutation.isPending}>
                  {generateYamlMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Generate YAML
                </Button>
              ) : null}
              {selectedResource?.claimed_by_StackPilot && selectedResource.resource_type === "deployment" ? (
                <Button size="sm" variant="outline" onClick={() => restartMutation.mutate(selectedResource)} disabled={restartMutation.isPending}>
                  {restartMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
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
                  <Square className="h-4 w-4" />
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
                    {applyYamlMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
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
