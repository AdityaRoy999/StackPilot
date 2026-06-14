"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Boxes, Database, Eye, FileCode2, History, Loader2, Play, RefreshCw, RotateCw, ScrollText, Server, ShieldCheck, SlidersHorizontal, Square, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";

import api from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface InfrastructureInventory {
  status: string;
  mode: string;
  timestamp: string;
  docker: {
    available: boolean;
    container_count: number;
    image_count: number;
    containers: Array<{
      id: string;
      name: string;
      image: string;
      status: string;
      ports: string;
      managed_by_stackpilot: boolean;
      claimed_by_StackPilot: boolean;
      claim_id: string;
      ownership_state: string;
      provider_type: "docker";
      resource_type: "container";
      resource_key: string;
    }>;
    images: Array<{
      repository: string;
      tag: string;
      id: string;
      size: string;
      managed_by_stackpilot: boolean;
      claimed_by_StackPilot: boolean;
      claim_id: string;
      ownership_state: string;
      provider_type: "docker";
      resource_type: "image";
      resource_key: string;
    }>;
  };
  kubernetes: {
    available: boolean;
    namespace_count: number;
    node_count: number;
    pod_count: number;
    deployment_count: number;
    service_count: number;
    event_count: number;
    namespaces: Array<{
      name: string;
      status: string;
      created_at: string;
      managed_by_stackpilot: boolean;
      claimed_by_StackPilot: boolean;
      claim_id: string;
      ownership_state: string;
      provider_type: "kubernetes";
      resource_type: "namespace";
      resource_key: string;
    }>;
    nodes: Array<{
      name: string;
      ready: boolean;
      version: string;
      os_image: string;
      container_runtime: string;
      architecture: string;
      kernel_version: string;
      capacity: Record<string, string>;
      allocatable: Record<string, string>;
      conditions: Array<{
        type: string;
        status: string;
        reason: string;
        message: string;
      }>;
      managed_by_stackpilot: boolean;
      claimed_by_StackPilot: boolean;
      claim_id: string;
      ownership_state: string;
      provider_type: "kubernetes";
      resource_type: "node";
      resource_key: string;
    }>;
    pods: Array<{
      namespace: string;
      name: string;
      node: string;
      phase: string;
      pod_ip: string;
      created_at: string;
      restart_count: number;
      containers_ready: number;
      container_count: number;
      managed_by_stackpilot: boolean;
      claimed_by_StackPilot: boolean;
      claim_id: string;
      ownership_state: string;
      provider_type: "kubernetes";
      resource_type: "pod";
      resource_key: string;
    }>;
    deployments: Array<{
      namespace: string;
      name: string;
      replicas: number;
      desired_replicas: number;
      ready_replicas: number;
      available_replicas: number;
      updated_replicas: number;
      generation: number;
      observed_generation: number;
      created_at: string;
      conditions: Array<{
        type: string;
        status: string;
        reason: string;
        message: string;
      }>;
      managed_by_stackpilot: boolean;
      claimed_by_StackPilot: boolean;
      claim_id: string;
      ownership_state: string;
      provider_type: "kubernetes";
      resource_type: "deployment";
      resource_key: string;
    }>;
    services: Array<{
      namespace: string;
      name: string;
      type: string;
      cluster_ip: string;
      created_at: string;
      ports: Array<{
        name: string;
        protocol: string;
        port: number;
        target_port: string | number;
        node_port: number;
      }>;
      managed_by_stackpilot: boolean;
      claimed_by_StackPilot: boolean;
      claim_id: string;
      ownership_state: string;
      provider_type: "kubernetes";
      resource_type: "service";
      resource_key: string;
    }>;
    events: Array<{
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
    }>;
  };
  warnings: string[];
}

const EMPTY_INVENTORY: InfrastructureInventory = {
  status: "unknown",
  mode: "local",
  timestamp: "",
  docker: {
    available: false,
    container_count: 0,
    image_count: 0,
    containers: [],
    images: [],
  },
  kubernetes: {
    available: false,
    namespace_count: 0,
    node_count: 0,
    pod_count: 0,
    deployment_count: 0,
    service_count: 0,
    event_count: 0,
    namespaces: [],
    nodes: [],
    pods: [],
    deployments: [],
    services: [],
    events: [],
  },
  warnings: [],
};

function normalizeInventory(data?: Partial<InfrastructureInventory> | null): InfrastructureInventory {
  const docker = data?.docker || EMPTY_INVENTORY.docker;
  const kubernetes = data?.kubernetes || EMPTY_INVENTORY.kubernetes;
  return {
    ...EMPTY_INVENTORY,
    ...data,
    docker: {
      ...EMPTY_INVENTORY.docker,
      ...docker,
      containers: Array.isArray(docker.containers) ? docker.containers : [],
      images: Array.isArray(docker.images) ? docker.images : [],
    },
    kubernetes: {
      ...EMPTY_INVENTORY.kubernetes,
      ...kubernetes,
      namespaces: Array.isArray(kubernetes.namespaces) ? kubernetes.namespaces : [],
      nodes: Array.isArray(kubernetes.nodes) ? kubernetes.nodes : [],
      pods: Array.isArray(kubernetes.pods) ? kubernetes.pods : [],
      deployments: Array.isArray(kubernetes.deployments) ? kubernetes.deployments : [],
      services: Array.isArray(kubernetes.services) ? kubernetes.services : [],
      events: Array.isArray(kubernetes.events) ? kubernetes.events : [],
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

type ClaimableInfrastructureResource =
  | InfrastructureInventory["docker"]["containers"][number]
  | InfrastructureInventory["docker"]["images"][number]
  | InfrastructureInventory["kubernetes"]["namespaces"][number]
  | InfrastructureInventory["kubernetes"]["nodes"][number]
  | InfrastructureInventory["kubernetes"]["pods"][number]
  | InfrastructureInventory["kubernetes"]["deployments"][number]
  | InfrastructureInventory["kubernetes"]["services"][number];

interface InspectResponse {
  resource: ClaimableInfrastructureResource;
  mode: string;
  inspect?: unknown;
  raw?: string;
  warning?: string;
}

interface LogsResponse {
  resource: ClaimableInfrastructureResource;
  mode: string;
  tail_lines: number;
  logs: string;
}

interface ActionResponse {
  resource: ClaimableInfrastructureResource;
  action: string;
  output: string;
  status: string;
  replicas?: number;
  dry_run?: boolean;
}

interface YamlResponse {
  mode: string;
  resource_type: string;
  namespace: string;
  name: string;
  yaml: string;
}

function resourceName(resource: ClaimableInfrastructureResource) {
  if ("namespace" in resource && resource.namespace) return `${resource.namespace}/${resource.name}`;
  if ("repository" in resource) return `${resource.repository}:${resource.tag}`;
  return resource.name;
}

function claimStoredName(resource: ClaimableInfrastructureResource) {
  if ("namespace" in resource && resource.namespace) return resource.name;
  if ("repository" in resource) return `${resource.repository}:${resource.tag}`;
  return resource.name;
}

function servicePorts(ports: InfrastructureInventory["kubernetes"]["services"][number]["ports"]) {
  if (!ports?.length) return "-";
  return ports
    .map((port) => `${port.port}${port.node_port ? `:${port.node_port}` : ""}/${port.protocol || "TCP"}`)
    .join(", ");
}

function infrastructureClaimPayload(resource: ClaimableInfrastructureResource) {
  return {
    provider_type: resource.provider_type,
    resource_type: resource.resource_type,
    resource_key: resource.resource_key,
    namespace: "namespace" in resource ? resource.namespace : "",
    name: claimStoredName(resource),
    external_id: "id" in resource ? resource.id : "",
    image: "image" in resource ? resource.image : "repository" in resource ? `${resource.repository}:${resource.tag}` : "",
    status: "status" in resource ? resource.status : "phase" in resource ? resource.phase : "ready" in resource ? (resource.ready ? "Ready" : "Not ready") : "",
    metadata: resource,
  };
}

function inspectPayload(resource: ClaimableInfrastructureResource) {
  return {
    claim_id: resource.claim_id,
    provider_type: resource.provider_type,
    resource_type: resource.resource_type,
    resource_key: resource.resource_key,
  };
}

function isKubernetesResource(resource: ClaimableInfrastructureResource) {
  return resource.provider_type === "kubernetes";
}

function kubernetesYamlPayload(resource: ClaimableInfrastructureResource) {
  return {
    resource_type: resource.resource_type,
    namespace: "namespace" in resource ? resource.namespace : "",
    name: "namespace" in resource && resource.namespace ? resource.name : resourceName(resource),
  };
}

function kubernetesActionLabel(action: string) {
  if (action === "rollout_status") return "Rollout Status";
  if (action === "rollout_history") return "Rollout History";
  if (action === "undo_rollout") return "Undo Rollout";
  if (action === "pause_rollout") return "Pause Rollout";
  if (action === "resume_rollout") return "Resume Rollout";
  if (action === "set_image") return "Set Image";
  if (action === "delete_pod") return "Delete Pod";
  if (action === "node_describe") return "Describe Node";
  if (action === "cordon_node") return "Cordon Node";
  if (action === "uncordon_node") return "Uncordon Node";
  if (action === "drain_node") return "Drain Node";
  return "Kubernetes Output";
}

type KubernetesConfirmAction =
  | "undo_rollout"
  | "delete_pod"
  | "pause_rollout"
  | "resume_rollout"
  | "cordon_node"
  | "uncordon_node"
  | "drain_node";

export function InfrastructureMonitor() {
  const [inspectResult, setInspectResult] = useState<InspectResponse | null>(null);
  const [logsResult, setLogsResult] = useState<LogsResponse | ActionResponse | null>(null);
  const [detailsResource, setDetailsResource] = useState<ClaimableInfrastructureResource | null>(null);
  const [yamlResult, setYamlResult] = useState<YamlResponse | null>(null);
  const [yamlError, setYamlError] = useState("");
  const [restartCandidate, setRestartCandidate] = useState<ClaimableInfrastructureResource | null>(null);
  const [dockerStateCandidate, setDockerStateCandidate] = useState<{ resource: ClaimableInfrastructureResource; action: "start" | "stop" } | null>(null);
  const [kubernetesActionCandidate, setKubernetesActionCandidate] = useState<{ resource: ClaimableInfrastructureResource; action: KubernetesConfirmAction } | null>(null);
  const [setImageCandidate, setSetImageCandidate] = useState<ClaimableInfrastructureResource | null>(null);
  const [deploymentImage, setDeploymentImage] = useState("");
  const [scaleCandidate, setScaleCandidate] = useState<ClaimableInfrastructureResource | null>(null);
  const [scaleReplicas, setScaleReplicas] = useState("1");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [targetConnectionId, setTargetConnectionId] = useState(() => {
    if (typeof window === "undefined") return "local";
    return new URLSearchParams(window.location.search).get("connection_id") || "local";
  });
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
    queryKey: ["infrastructure-inventory", targetConnectionId],
    queryFn: async () => {
      const response = await api.get<InfrastructureInventory>(`/infrastructure/inventory${targetQueryValue}`);
      return normalizeInventory(response.data);
    },
    refetchInterval: 10000,
  });

  const claimedCount = useMemo(() => {
    const data = inventoryQuery.data;
    if (!data) return 0;
    const resources: ClaimableInfrastructureResource[] = [
      ...data.docker.containers,
      ...data.docker.images,
      ...data.kubernetes.namespaces,
      ...data.kubernetes.nodes,
      ...data.kubernetes.pods,
      ...data.kubernetes.deployments,
      ...data.kubernetes.services,
    ];
    return resources.filter((resource) => resource.claimed_by_StackPilot).length;
  }, [inventoryQuery.data]);

  const namespaces = inventoryQuery.data?.kubernetes.namespaces || [];
  const filteredPods = (inventoryQuery.data?.kubernetes.pods || []).filter(
    (pod) => namespaceFilter === "all" || pod.namespace === namespaceFilter
  );
  const filteredDeployments = (inventoryQuery.data?.kubernetes.deployments || []).filter(
    (deployment) => namespaceFilter === "all" || deployment.namespace === namespaceFilter
  );
  const filteredServices = (inventoryQuery.data?.kubernetes.services || []).filter(
    (service) => namespaceFilter === "all" || service.namespace === namespaceFilter
  );
  const filteredEvents = (inventoryQuery.data?.kubernetes.events || []).filter(
    (event) => namespaceFilter === "all" || event.namespace === namespaceFilter
  );

  const openResourceDetails = (resource: ClaimableInfrastructureResource) => {
    setDetailsResource(resource);
    setYamlResult(null);
    setYamlError("");
    if (isKubernetesResource(resource)) {
      yamlResourceMutation.mutate(resource);
    }
  };

  const claimResourceMutation = useMutation({
    mutationFn: async (resource: ClaimableInfrastructureResource) => {
      const response = await api.post("/infrastructure/claims", withTarget(infrastructureClaimPayload(resource)));
      return response.data;
    },
    onSuccess: () => {
      toast.success("Infrastructure resource claimed");
      inventoryQuery.refetch();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to claim resource");
    },
  });

  const yamlResourceMutation = useMutation({
    mutationFn: async (resource: ClaimableInfrastructureResource) => {
      const response = await api.post<YamlResponse>("/infrastructure/kubernetes/yaml", withTarget(kubernetesYamlPayload(resource)));
      return response.data;
    },
    onSuccess: (data) => {
      setYamlResult(data);
    },
    onError: (error) => {
      setYamlError(error instanceof Error ? error.message : "Failed to read Kubernetes YAML");
    },
  });

  const releaseResourceMutation = useMutation({
    mutationFn: async (claimId: string) => {
      const response = await api.delete(`/infrastructure/claims/${claimId}`);
      return response.data;
    },
    onSuccess: () => {
      toast.success("Infrastructure claim released");
      inventoryQuery.refetch();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to release resource");
    },
  });

  const inspectResourceMutation = useMutation({
    mutationFn: async (resource: ClaimableInfrastructureResource) => {
      const response = await api.post<InspectResponse>("/infrastructure/actions/inspect", withTarget(inspectPayload(resource)));
      return response.data;
    },
    onSuccess: (data) => {
      setInspectResult(data);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to inspect resource");
    },
  });

  const logsResourceMutation = useMutation({
    mutationFn: async (resource: ClaimableInfrastructureResource) => {
      const response = await api.post<LogsResponse>("/infrastructure/actions/logs", {
        ...inspectPayload(resource),
        target_connection_id: targetConnectionId === "local" ? "" : targetConnectionId,
        tail_lines: 250,
      });
      return response.data;
    },
    onSuccess: (data) => {
      setLogsResult(data);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to read resource logs");
    },
  });

  const restartResourceMutation = useMutation({
    mutationFn: async (resource: ClaimableInfrastructureResource) => {
      const response = await api.post<ActionResponse>("/infrastructure/actions/restart", {
        ...inspectPayload(resource),
        target_connection_id: targetConnectionId === "local" ? "" : targetConnectionId,
        confirm: true,
      });
      return response.data;
    },
    onSuccess: (data) => {
      toast.success("Restart requested");
      setLogsResult(data);
      inventoryQuery.refetch();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to restart resource");
    },
    onSettled: () => {
      setRestartCandidate(null);
    },
  });

  const dockerStateMutation = useMutation({
    mutationFn: async ({ resource, action }: { resource: ClaimableInfrastructureResource; action: "start" | "stop" }) => {
      const response = await api.post<ActionResponse>("/infrastructure/actions/docker-state", {
        ...inspectPayload(resource),
        target_connection_id: targetConnectionId === "local" ? "" : targetConnectionId,
        action,
        confirm: true,
      });
      return response.data;
    },
    onSuccess: (data) => {
      toast.success(`Docker ${data.action.replace("docker_", "")} requested`);
      setLogsResult(data);
      inventoryQuery.refetch();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to change Docker state");
    },
    onSettled: () => {
      setDockerStateCandidate(null);
    },
  });

  const scaleResourceMutation = useMutation({
    mutationFn: async ({ resource, replicas }: { resource: ClaimableInfrastructureResource; replicas: number }) => {
      const response = await api.post<ActionResponse>("/infrastructure/actions/scale", {
        ...inspectPayload(resource),
        target_connection_id: targetConnectionId === "local" ? "" : targetConnectionId,
        replicas,
        confirm: true,
      });
      return response.data;
    },
    onSuccess: (data) => {
      toast.success(`Scale requested to ${data.replicas ?? "selected"} replicas`);
      setLogsResult(data);
      inventoryQuery.refetch();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to scale deployment");
    },
    onSettled: () => {
      setScaleCandidate(null);
    },
  });

  const kubernetesControlMutation = useMutation({
    mutationFn: async ({ resource, action, confirm = false, dryRun = false, newImage = "" }: { resource: ClaimableInfrastructureResource; action: string; confirm?: boolean; dryRun?: boolean; newImage?: string }) => {
      const response = await api.post<ActionResponse>("/infrastructure/actions/kubernetes-control", {
        ...inspectPayload(resource),
        target_connection_id: targetConnectionId === "local" ? "" : targetConnectionId,
        action,
        confirm,
        dry_run: dryRun,
        new_image: newImage,
      });
      return response.data;
    },
    onSuccess: (data) => {
      toast.success(`${kubernetesActionLabel(data.action)} ${data.status === "dry_run" ? "preview loaded" : data.status === "requested" ? "requested" : "loaded"}`);
      setLogsResult(data);
      inventoryQuery.refetch();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to run Kubernetes action");
    },
    onSettled: () => {
      setKubernetesActionCandidate(null);
      setSetImageCandidate(null);
    },
  });

  const renderControls = (resource: ClaimableInfrastructureResource) => {
    const supportsLogs =
      resource.claimed_by_StackPilot &&
      ((resource.provider_type === "docker" && resource.resource_type === "container") ||
        (resource.provider_type === "kubernetes" && ["pod", "deployment"].includes(resource.resource_type)));
    const supportsRestart =
      resource.claimed_by_StackPilot &&
      ((resource.provider_type === "docker" && resource.resource_type === "container") ||
        (resource.provider_type === "kubernetes" && resource.resource_type === "deployment"));
    const supportsDockerState =
      resource.claimed_by_StackPilot && resource.provider_type === "docker" && resource.resource_type === "container";
    const supportsScale =
      resource.claimed_by_StackPilot && resource.provider_type === "kubernetes" && resource.resource_type === "deployment";
    const dockerIsRunning =
      "status" in resource &&
      typeof resource.status === "string" &&
      (resource.status.toLowerCase().includes("up") || resource.status.toLowerCase().includes("running"));
    const isBusy =
      claimResourceMutation.isPending ||
      releaseResourceMutation.isPending ||
      inspectResourceMutation.isPending ||
      logsResourceMutation.isPending ||
      yamlResourceMutation.isPending ||
      restartResourceMutation.isPending ||
      dockerStateMutation.isPending ||
      kubernetesControlMutation.isPending ||
      scaleResourceMutation.isPending;
    const detailsButton = isKubernetesResource(resource) ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isBusy}
        onClick={() => openResourceDetails(resource)}
      >
        {yamlResourceMutation.isPending && detailsResource?.resource_key === resource.resource_key ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <FileCode2 className="h-4 w-4" />
        )}
        Details
      </Button>
    ) : null;

    if (resource.claimed_by_StackPilot) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          {detailsButton}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBusy}
            onClick={() => inspectResourceMutation.mutate(resource)}
          >
            {inspectResourceMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            Inspect
          </Button>
          {supportsLogs ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => logsResourceMutation.mutate(resource)}
            >
              {logsResourceMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScrollText className="h-4 w-4" />}
              Logs
            </Button>
          ) : null}
          {supportsRestart ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => setRestartCandidate(resource)}
            >
              {restartResourceMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
              Restart
            </Button>
          ) : null}
          {resource.provider_type === "kubernetes" && resource.resource_type === "deployment" ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => kubernetesControlMutation.mutate({ resource, action: "rollout_status" })}
              >
                {kubernetesControlMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Status
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => kubernetesControlMutation.mutate({ resource, action: "rollout_history" })}
              >
                {kubernetesControlMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}
                History
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => setKubernetesActionCandidate({ resource, action: "undo_rollout" })}
              >
                <Undo2 className="h-4 w-4" />
                Undo
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => setKubernetesActionCandidate({ resource, action: "pause_rollout" })}
              >
                <Square className="h-4 w-4" />
                Pause
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => setKubernetesActionCandidate({ resource, action: "resume_rollout" })}
              >
                <Play className="h-4 w-4" />
                Resume
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => {
                  setDeploymentImage("");
                  setSetImageCandidate(resource);
                }}
              >
                <RefreshCw className="h-4 w-4" />
                Set Image
              </Button>
            </>
          ) : null}
          {resource.provider_type === "kubernetes" && resource.resource_type === "pod" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => setKubernetesActionCandidate({ resource, action: "delete_pod" })}
            >
              <Trash2 className="h-4 w-4" />
              Delete Pod
            </Button>
          ) : null}
          {resource.provider_type === "kubernetes" && resource.resource_type === "node" ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => kubernetesControlMutation.mutate({ resource, action: "node_describe" })}
              >
                {kubernetesControlMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Server className="h-4 w-4" />}
                Describe
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => setKubernetesActionCandidate({ resource, action: "cordon_node" })}
              >
                <Square className="h-4 w-4" />
                Cordon
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => setKubernetesActionCandidate({ resource, action: "uncordon_node" })}
              >
                <Play className="h-4 w-4" />
                Uncordon
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => setKubernetesActionCandidate({ resource, action: "drain_node" })}
              >
                <Trash2 className="h-4 w-4" />
                Drain
              </Button>
            </>
          ) : null}
          {supportsDockerState ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => setDockerStateCandidate({ resource, action: dockerIsRunning ? "stop" : "start" })}
            >
              {dockerStateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : dockerIsRunning ? (
                <Square className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {dockerIsRunning ? "Stop" : "Start"}
            </Button>
          ) : null}
          {supportsScale ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => {
                setScaleReplicas("replicas" in resource ? String(resource.replicas || 1) : "1");
                setScaleCandidate(resource);
              }}
            >
              {scaleResourceMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SlidersHorizontal className="h-4 w-4" />}
              Scale
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isBusy || !resource.claim_id}
            onClick={() => releaseResourceMutation.mutate(resource.claim_id)}
          >
            Release
          </Button>
        </div>
      );
    }
    if (resource.managed_by_stackpilot) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          {detailsButton}
          <Badge variant="default">Managed</Badge>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-2">
        {detailsButton}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isBusy}
          onClick={() => claimResourceMutation.mutate(resource)}
        >
          Claim
        </Button>
      </div>
    );
  };

  const renderOwner = (resource: ClaimableInfrastructureResource) => {
    if (resource.claimed_by_StackPilot) {
      return (
        <Badge variant="default">
          <ShieldCheck className="h-3 w-3" />
          Claimed
        </Badge>
      );
    }
    if (resource.managed_by_stackpilot) return <Badge variant="default">StackPilot</Badge>;
    return <Badge variant="outline">External</Badge>;
  };

  const inspectBody = inspectResult
    ? JSON.stringify(inspectResult.inspect && Object.keys(inspectResult.inspect as object).length ? inspectResult.inspect : inspectResult.raw || inspectResult.warning || "", null, 2)
    : "";
  const logsBody = logsResult ? ("logs" in logsResult ? logsResult.logs : logsResult.output) : "";
  const outputDialogTitle = logsResult
    ? "logs" in logsResult
      ? "Resource Logs"
        : logsResult.action === "kubernetes_scale"
        ? "Scale Output"
        : logsResult.action?.startsWith("rollout_") ||
            logsResult.action === "undo_rollout" ||
            logsResult.action === "delete_pod" ||
            logsResult.action === "pause_rollout" ||
            logsResult.action === "resume_rollout" ||
            logsResult.action === "set_image" ||
            logsResult.action === "node_describe" ||
            logsResult.action === "cordon_node" ||
            logsResult.action === "uncordon_node" ||
            logsResult.action === "drain_node"
          ? kubernetesActionLabel(logsResult.action)
        : logsResult.action?.startsWith("docker_")
          ? "Docker Action Output"
          : "Restart Output"
    : "Resource Output";
  const parsedScaleReplicas = Number.parseInt(scaleReplicas, 10);
  const detailsEvents = useMemo(() => {
    if (!detailsResource || !inventoryQuery.data || !isKubernetesResource(detailsResource)) return [];
    return inventoryQuery.data.kubernetes.events.filter((event) => {
      if (detailsResource.resource_type === "node") {
        return event.involved_kind === "Node" && event.involved_name === detailsResource.name;
      }
      if (detailsResource.resource_type === "namespace") {
        return event.involved_kind === "Namespace" && event.involved_name === detailsResource.name;
      }
      if ("namespace" in detailsResource) {
        return event.namespace === detailsResource.namespace && event.involved_name === detailsResource.name;
      }
      return false;
    }).slice(0, 20);
  }, [detailsResource, inventoryQuery.data]);
  const detailsRows = useMemo(() => {
    if (!detailsResource) return [];
    const rows: Array<[string, string | number]> = [
      ["Type", detailsResource.resource_type],
      ["Name", resourceName(detailsResource)],
      ["Owner", detailsResource.ownership_state],
      ["Managed by StackPilot", detailsResource.managed_by_stackpilot ? "yes" : "no"],
      ["Claimed", detailsResource.claimed_by_StackPilot ? "yes" : "no"],
    ];
    if ("status" in detailsResource) rows.push(["Status", detailsResource.status || "-"]);
    if ("phase" in detailsResource) rows.push(["Phase", detailsResource.phase || "-"]);
    if ("ready" in detailsResource) rows.push(["Ready", detailsResource.ready ? "yes" : "no"]);
    if ("node" in detailsResource) rows.push(["Node", detailsResource.node || "-"]);
    if ("pod_ip" in detailsResource) rows.push(["Pod IP", detailsResource.pod_ip || "-"]);
    if ("restart_count" in detailsResource) rows.push(["Restarts", detailsResource.restart_count || 0]);
    if ("containers_ready" in detailsResource) rows.push(["Containers ready", `${detailsResource.containers_ready || 0}/${detailsResource.container_count || 0}`]);
    if ("replicas" in detailsResource) rows.push(["Replicas", `${detailsResource.ready_replicas || 0}/${detailsResource.desired_replicas || detailsResource.replicas || 0}`]);
    if ("updated_replicas" in detailsResource) rows.push(["Updated replicas", detailsResource.updated_replicas || 0]);
    if ("generation" in detailsResource) rows.push(["Generation", `${detailsResource.observed_generation || 0}/${detailsResource.generation || 0}`]);
    if ("type" in detailsResource) rows.push(["Service type", detailsResource.type || "-"]);
    if ("cluster_ip" in detailsResource) rows.push(["Cluster IP", detailsResource.cluster_ip || "-"]);
    if ("ports" in detailsResource && Array.isArray(detailsResource.ports)) rows.push(["Ports", servicePorts(detailsResource.ports)]);
    if ("version" in detailsResource) rows.push(["Kubelet", detailsResource.version || "-"]);
    if ("container_runtime" in detailsResource) rows.push(["Runtime", detailsResource.container_runtime || "-"]);
    if ("capacity" in detailsResource) {
      rows.push(["CPU", detailsResource.allocatable?.cpu || detailsResource.capacity?.cpu || "-"]);
      rows.push(["Memory", detailsResource.allocatable?.memory || detailsResource.capacity?.memory || "-"]);
    }
    if ("created_at" in detailsResource) rows.push(["Created", detailsResource.created_at || "-"]);
    return rows;
  }, [detailsResource]);

  return (
    <div className="space-y-3">
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight">Infrastructure Monitor</h1>
          <p className="mt-2 max-w-3xl text-lg text-muted-foreground">
            Observe, claim, and control Docker and Kubernetes resources on the StackPilot host or a saved SSH server.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <Select value={targetConnectionId} onValueChange={(value) => setTargetConnectionId(value || "local")}>
            <SelectTrigger className="h-10 min-w-[280px] justify-between">
              <SelectValue placeholder="Select infrastructure target" />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-[280px]">
              <SelectItem value="local">
                Local StackPilot host
              </SelectItem>
              {(connectionsQuery.data || []).map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.name} - {connection.username}@{connection.host}:{connection.port}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => inventoryQuery.refetch()} disabled={inventoryQuery.isFetching}>
            <RefreshCw className={inventoryQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Refresh
          </Button>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Server className="h-4 w-4" />Docker containers</CardTitle>
            <CardDescription>{inventoryQuery.data?.docker.available ? "Docker reachable" : "Docker unavailable"}</CardDescription>
          </CardHeader>
          <CardContent><div className="text-3xl font-bold">{inventoryQuery.data?.docker.container_count ?? "-"}</div></CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Database className="h-4 w-4" />Docker images</CardTitle>
            <CardDescription>Host image inventory</CardDescription>
          </CardHeader>
          <CardContent><div className="text-3xl font-bold">{inventoryQuery.data?.docker.image_count ?? "-"}</div></CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Boxes className="h-4 w-4" />Kubernetes nodes</CardTitle>
            <CardDescription>{inventoryQuery.data?.kubernetes.available ? "Cluster reachable" : "No cluster detected"}</CardDescription>
          </CardHeader>
          <CardContent><div className="text-3xl font-bold">{inventoryQuery.data?.kubernetes.node_count ?? "-"}</div></CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>Kubernetes pods</CardTitle>
            <CardDescription>Across all namespaces</CardDescription>
          </CardHeader>
          <CardContent><div className="text-3xl font-bold">{inventoryQuery.data?.kubernetes.pod_count ?? "-"}</div></CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>Claimed</CardTitle>
            <CardDescription>Eligible for safe controls</CardDescription>
          </CardHeader>
          <CardContent><div className="text-3xl font-bold">{claimedCount}</div></CardContent>
        </Card>
      </section>

      {inventoryQuery.data?.warnings?.length ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          {inventoryQuery.data.warnings.join(" ")}
        </div>
      ) : null}

      <section className="grid gap-3 xl:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Docker Containers</CardTitle>
            <CardDescription>External containers can be claimed before inspection or future lifecycle actions.</CardDescription>
          </CardHeader>
          <CardContent className="max-h-[520px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Control</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(inventoryQuery.data?.docker.containers || []).map((container) => (
                  <TableRow key={container.id}>
                    <TableCell className="font-medium">{container.name}</TableCell>
                    <TableCell className="max-w-52 truncate text-muted-foreground">{container.image}</TableCell>
                    <TableCell>{container.status}</TableCell>
                    <TableCell>{renderOwner(container)}</TableCell>
                    <TableCell>{renderControls(container)}</TableCell>
                  </TableRow>
                ))}
                {(inventoryQuery.data?.docker.containers || []).length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="h-20 text-center text-muted-foreground">No Docker containers detected.</TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Kubernetes Nodes & Deployments</CardTitle>
            <CardDescription>Cluster resources are read-only until explicitly claimed.</CardDescription>
          </CardHeader>
          <CardContent className="max-h-[520px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Control</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(inventoryQuery.data?.kubernetes.nodes || []).map((node) => (
                  <TableRow key={`node-${node.name}`}>
                    <TableCell>Node</TableCell>
                    <TableCell className="font-medium">{node.name}</TableCell>
                    <TableCell>{node.ready ? "Ready" : "Not ready"}</TableCell>
                    <TableCell>{renderOwner(node)}</TableCell>
                    <TableCell>{renderControls(node)}</TableCell>
                  </TableRow>
                ))}
                {(inventoryQuery.data?.kubernetes.deployments || []).map((deployment) => (
                  <TableRow key={`deployment-${deployment.namespace}-${deployment.name}`}>
                    <TableCell>Deployment</TableCell>
                    <TableCell className="font-medium">{deployment.namespace}/{deployment.name}</TableCell>
                    <TableCell>{deployment.ready_replicas || 0}/{deployment.replicas || 0} ready</TableCell>
                    <TableCell>{renderOwner(deployment)}</TableCell>
                    <TableCell>{renderControls(deployment)}</TableCell>
                  </TableRow>
                ))}
                {(inventoryQuery.data?.kubernetes.nodes || []).length === 0 &&
                (inventoryQuery.data?.kubernetes.deployments || []).length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="h-20 text-center text-muted-foreground">No Kubernetes cluster detected.</TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>

      <Card size="sm">
        <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle>Cluster Explorer</CardTitle>
            <CardDescription>
              Namespace-aware Kubernetes inventory for workloads, network resources, nodes, and recent events.
            </CardDescription>
          </div>
          <Select value={namespaceFilter} onValueChange={(value) => setNamespaceFilter(value || "all")}>
            <SelectTrigger className="h-9 w-full bg-muted/30 md:w-56">
              <span className="truncate">{namespaceFilter === "all" ? "All namespaces" : namespaceFilter}</span>
            </SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value="all">All namespaces</SelectItem>
              {namespaces.map((namespace) => (
                <SelectItem key={namespace.name} value={namespace.name}>
                  {namespace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="workloads" className="gap-3">
            <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-muted/40">
              <TabsTrigger value="workloads">Workloads</TabsTrigger>
              <TabsTrigger value="pods">Pods</TabsTrigger>
              <TabsTrigger value="services">Services</TabsTrigger>
              <TabsTrigger value="nodes">Nodes</TabsTrigger>
              <TabsTrigger value="namespaces">Namespaces</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
            </TabsList>

            <TabsContent value="workloads">
              <div className="max-h-[560px] overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Deployment</TableHead>
                      <TableHead>Namespace</TableHead>
                      <TableHead>Ready</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead>Generation</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Control</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDeployments.map((deployment) => (
                      <TableRow key={`explorer-deployment-${deployment.namespace}-${deployment.name}`}>
                        <TableCell className="font-medium">{deployment.name}</TableCell>
                        <TableCell>{deployment.namespace}</TableCell>
                        <TableCell>{deployment.ready_replicas || 0}/{deployment.desired_replicas || deployment.replicas || 0}</TableCell>
                        <TableCell>{deployment.updated_replicas || 0}</TableCell>
                        <TableCell>{deployment.observed_generation || 0}/{deployment.generation || 0}</TableCell>
                        <TableCell>{renderOwner(deployment)}</TableCell>
                        <TableCell>{renderControls(deployment)}</TableCell>
                      </TableRow>
                    ))}
                    {filteredDeployments.length === 0 ? (
                      <TableRow><TableCell colSpan={7} className="h-20 text-center text-muted-foreground">No deployments found.</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="pods">
              <div className="max-h-[560px] overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pod</TableHead>
                      <TableHead>Namespace</TableHead>
                      <TableHead>Phase</TableHead>
                      <TableHead>Ready</TableHead>
                      <TableHead>Restarts</TableHead>
                      <TableHead>Node</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Control</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPods.map((pod) => (
                      <TableRow key={`explorer-pod-${pod.namespace}-${pod.name}`}>
                        <TableCell className="font-medium">{pod.name}</TableCell>
                        <TableCell>{pod.namespace}</TableCell>
                        <TableCell>{pod.phase}</TableCell>
                        <TableCell>{pod.containers_ready || 0}/{pod.container_count || 0}</TableCell>
                        <TableCell>{pod.restart_count || 0}</TableCell>
                        <TableCell className="max-w-48 truncate text-muted-foreground">{pod.node || "-"}</TableCell>
                        <TableCell>{renderOwner(pod)}</TableCell>
                        <TableCell>{renderControls(pod)}</TableCell>
                      </TableRow>
                    ))}
                    {filteredPods.length === 0 ? (
                      <TableRow><TableCell colSpan={8} className="h-20 text-center text-muted-foreground">No pods found.</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="services">
              <div className="max-h-[560px] overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Service</TableHead>
                      <TableHead>Namespace</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Cluster IP</TableHead>
                      <TableHead>Ports</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Control</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredServices.map((service) => (
                      <TableRow key={`explorer-service-${service.namespace}-${service.name}`}>
                        <TableCell className="font-medium">{service.name}</TableCell>
                        <TableCell>{service.namespace}</TableCell>
                        <TableCell>{service.type}</TableCell>
                        <TableCell>{service.cluster_ip || "-"}</TableCell>
                        <TableCell className="max-w-64 truncate">{servicePorts(service.ports)}</TableCell>
                        <TableCell>{renderOwner(service)}</TableCell>
                        <TableCell>{renderControls(service)}</TableCell>
                      </TableRow>
                    ))}
                    {filteredServices.length === 0 ? (
                      <TableRow><TableCell colSpan={7} className="h-20 text-center text-muted-foreground">No services found.</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="nodes">
              <div className="max-h-[560px] overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Node</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>CPU</TableHead>
                      <TableHead>Memory</TableHead>
                      <TableHead>Kubelet</TableHead>
                      <TableHead>Runtime</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Control</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(inventoryQuery.data?.kubernetes.nodes || []).map((node) => (
                      <TableRow key={`explorer-node-${node.name}`}>
                        <TableCell className="font-medium">{node.name}</TableCell>
                        <TableCell>{node.ready ? "Ready" : "Not ready"}</TableCell>
                        <TableCell>{node.allocatable?.cpu || node.capacity?.cpu || "-"}</TableCell>
                        <TableCell>{node.allocatable?.memory || node.capacity?.memory || "-"}</TableCell>
                        <TableCell>{node.version}</TableCell>
                        <TableCell className="max-w-56 truncate text-muted-foreground">{node.container_runtime}</TableCell>
                        <TableCell>{renderOwner(node)}</TableCell>
                        <TableCell>{renderControls(node)}</TableCell>
                      </TableRow>
                    ))}
                    {(inventoryQuery.data?.kubernetes.nodes || []).length === 0 ? (
                      <TableRow><TableCell colSpan={8} className="h-20 text-center text-muted-foreground">No nodes found.</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="namespaces">
              <div className="max-h-[560px] overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Namespace</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Control</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {namespaces.map((namespace) => (
                      <TableRow key={`explorer-namespace-${namespace.name}`}>
                        <TableCell className="font-medium">{namespace.name}</TableCell>
                        <TableCell>{namespace.status}</TableCell>
                        <TableCell className="text-muted-foreground">{namespace.created_at || "-"}</TableCell>
                        <TableCell>{renderOwner(namespace)}</TableCell>
                        <TableCell>{renderControls(namespace)}</TableCell>
                      </TableRow>
                    ))}
                    {namespaces.length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="h-20 text-center text-muted-foreground">No namespaces found.</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="events">
              <div className="max-h-[560px] overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Object</TableHead>
                      <TableHead>Count</TableHead>
                      <TableHead>Last Seen</TableHead>
                      <TableHead>Message</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredEvents.map((event) => (
                      <TableRow key={`explorer-event-${event.namespace}-${event.name}`}>
                        <TableCell>
                          <Badge variant={event.type === "Warning" ? "destructive" : "outline"}>{event.type || "Normal"}</Badge>
                        </TableCell>
                        <TableCell>{event.reason || "-"}</TableCell>
                        <TableCell className="max-w-56 truncate">
                          {event.namespace ? `${event.namespace}/` : ""}{event.involved_kind}/{event.involved_name}
                        </TableCell>
                        <TableCell>{event.count || 1}</TableCell>
                        <TableCell className="text-muted-foreground">{event.last_timestamp || "-"}</TableCell>
                        <TableCell className="max-w-xl truncate text-muted-foreground">{event.message || "-"}</TableCell>
                      </TableRow>
                    ))}
                    {filteredEvents.length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="h-20 text-center text-muted-foreground">No events found.</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(detailsResource)}
        onOpenChange={(open) => {
          if (!open) {
            setDetailsResource(null);
            setYamlResult(null);
            setYamlError("");
          }
        }}
      >
        <DialogContent className="max-h-[86vh] overflow-hidden sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Kubernetes Resource Details</DialogTitle>
            <DialogDescription>
              {detailsResource ? `${detailsResource.resource_type} ${resourceName(detailsResource)}` : ""}
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="summary" className="gap-3">
            <TabsList className="grid w-full grid-cols-3 bg-muted/40">
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
              <TabsTrigger value="yaml">YAML</TabsTrigger>
            </TabsList>
            <TabsContent value="summary" className="max-h-[58vh] overflow-auto rounded-lg border border-border">
              <div className="grid gap-0 sm:grid-cols-2">
                {detailsRows.map(([label, value]) => (
                  <div key={label} className="border-b border-border p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
                    <div className="mt-1 break-words text-sm font-medium">{String(value || "-")}</div>
                  </div>
                ))}
              </div>
            </TabsContent>
            <TabsContent value="events" className="max-h-[58vh] overflow-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Count</TableHead>
                    <TableHead>Last Seen</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detailsEvents.map((event) => (
                    <TableRow key={`details-event-${event.namespace}-${event.name}-${event.reason}`}>
                      <TableCell>
                        <Badge variant={event.type === "Warning" ? "destructive" : "outline"}>{event.type || "Normal"}</Badge>
                      </TableCell>
                      <TableCell>{event.reason || "-"}</TableCell>
                      <TableCell>{event.count || 1}</TableCell>
                      <TableCell className="text-muted-foreground">{event.last_timestamp || "-"}</TableCell>
                      <TableCell className="max-w-xl text-muted-foreground">{event.message || "-"}</TableCell>
                    </TableRow>
                  ))}
                  {detailsEvents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                        No direct events found for this resource.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="yaml">
              <pre className="max-h-[58vh] overflow-auto rounded-lg border border-border bg-black p-4 text-xs leading-relaxed text-white">
                {yamlResourceMutation.isPending
                  ? "Loading Kubernetes YAML..."
                  : yamlResult?.yaml || yamlError || "No YAML returned by kubectl."}
              </pre>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(inspectResult)} onOpenChange={(open) => !open && setInspectResult(null)}>
        <DialogContent className="max-h-[82vh] overflow-hidden sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Resource Inspect</DialogTitle>
            <DialogDescription>
              {inspectResult ? `${inspectResult.resource.provider_type} ${inspectResult.resource.resource_type} ${resourceName(inspectResult.resource)}` : ""}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[58vh] overflow-auto rounded-lg border border-border bg-black p-4 text-xs text-white">
            {inspectBody.slice(0, 12000)}
          </pre>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(logsResult)} onOpenChange={(open) => !open && setLogsResult(null)}>
        <DialogContent className="max-h-[82vh] overflow-hidden sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{outputDialogTitle}</DialogTitle>
            <DialogDescription>
              {logsResult ? `${logsResult.resource.provider_type} ${logsResult.resource.resource_type} ${resourceName(logsResult.resource)}` : ""}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[58vh] overflow-auto rounded-lg border border-border bg-black p-4 text-xs leading-relaxed text-white">
            {logsBody || "No output returned by the runtime."}
          </pre>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(restartCandidate)} onOpenChange={(open) => !open && setRestartCandidate(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Restart Resource</DialogTitle>
            <DialogDescription>
              {restartCandidate
                ? `Restart ${restartCandidate.provider_type} ${restartCandidate.resource_type} ${resourceName(restartCandidate)}? This action is allowed because the resource is claimed.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRestartCandidate(null)} disabled={restartResourceMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => restartCandidate && restartResourceMutation.mutate(restartCandidate)}
              disabled={!restartCandidate || restartResourceMutation.isPending}
            >
              {restartResourceMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
              Restart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(dockerStateCandidate)} onOpenChange={(open) => !open && setDockerStateCandidate(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{dockerStateCandidate?.action === "stop" ? "Stop Container" : "Start Container"}</DialogTitle>
            <DialogDescription>
              {dockerStateCandidate
                ? `${dockerStateCandidate.action === "stop" ? "Stop" : "Start"} Docker container ${resourceName(dockerStateCandidate.resource)}? This action is allowed because the resource is claimed.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDockerStateCandidate(null)} disabled={dockerStateMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => dockerStateCandidate && dockerStateMutation.mutate(dockerStateCandidate)}
              disabled={!dockerStateCandidate || dockerStateMutation.isPending}
            >
              {dockerStateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : dockerStateCandidate?.action === "stop" ? (
                <Square className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {dockerStateCandidate?.action === "stop" ? "Stop" : "Start"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(kubernetesActionCandidate)} onOpenChange={(open) => !open && setKubernetesActionCandidate(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{kubernetesActionCandidate ? kubernetesActionLabel(kubernetesActionCandidate.action) : "Kubernetes Action"}</DialogTitle>
            <DialogDescription>
              {kubernetesActionCandidate
                ? `${kubernetesActionLabel(kubernetesActionCandidate.action)} for ${resourceName(kubernetesActionCandidate.resource)}? This action is allowed because the resource is claimed.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setKubernetesActionCandidate(null)} disabled={kubernetesControlMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => kubernetesActionCandidate && kubernetesControlMutation.mutate({
                resource: kubernetesActionCandidate.resource,
                action: kubernetesActionCandidate.action,
                dryRun: true,
              })}
              disabled={!kubernetesActionCandidate || kubernetesControlMutation.isPending}
            >
              {kubernetesControlMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
              Preview
            </Button>
            <Button
              type="button"
              onClick={() => kubernetesActionCandidate && kubernetesControlMutation.mutate({
                resource: kubernetesActionCandidate.resource,
                action: kubernetesActionCandidate.action,
                confirm: true,
              })}
              disabled={!kubernetesActionCandidate || kubernetesControlMutation.isPending}
            >
              {kubernetesControlMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : kubernetesActionCandidate?.action === "delete_pod" || kubernetesActionCandidate?.action === "drain_node" ? (
                <Trash2 className="h-4 w-4" />
              ) : kubernetesActionCandidate?.action === "cordon_node" || kubernetesActionCandidate?.action === "pause_rollout" ? (
                <Square className="h-4 w-4" />
              ) : kubernetesActionCandidate?.action === "uncordon_node" || kubernetesActionCandidate?.action === "resume_rollout" ? (
                <Play className="h-4 w-4" />
              ) : (
                <Undo2 className="h-4 w-4" />
              )}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(setImageCandidate)}
        onOpenChange={(open) => {
          if (!open) {
            setSetImageCandidate(null);
            setDeploymentImage("");
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Set Deployment Image</DialogTitle>
            <DialogDescription>
              {setImageCandidate
                ? `Update the container image for ${resourceName(setImageCandidate)}. This runs kubectl set image on the claimed deployment.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="deployment-image">
              New image
            </label>
            <Input
              id="deployment-image"
              placeholder="nginx:1.27-alpine"
              value={deploymentImage}
              onChange={(event) => setDeploymentImage(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSetImageCandidate(null)} disabled={kubernetesControlMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setImageCandidate && kubernetesControlMutation.mutate({
                resource: setImageCandidate,
                action: "set_image",
                dryRun: true,
                newImage: deploymentImage.trim(),
              })}
              disabled={!setImageCandidate || !deploymentImage.trim() || kubernetesControlMutation.isPending}
            >
              {kubernetesControlMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
              Preview
            </Button>
            <Button
              type="button"
              onClick={() => setImageCandidate && kubernetesControlMutation.mutate({
                resource: setImageCandidate,
                action: "set_image",
                confirm: true,
                newImage: deploymentImage.trim(),
              })}
              disabled={!setImageCandidate || !deploymentImage.trim() || kubernetesControlMutation.isPending}
            >
              {kubernetesControlMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Update Image
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(scaleCandidate)} onOpenChange={(open) => !open && setScaleCandidate(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Scale Deployment</DialogTitle>
            <DialogDescription>
              {scaleCandidate
                ? `Set the replica count for ${resourceName(scaleCandidate)}. This action is allowed because the deployment is claimed.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="scale-replicas">
              Replicas
            </label>
            <Input
              id="scale-replicas"
              type="number"
              min={0}
              max={50}
              value={scaleReplicas}
              onChange={(event) => setScaleReplicas(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setScaleCandidate(null)} disabled={scaleResourceMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => scaleCandidate && scaleResourceMutation.mutate({ resource: scaleCandidate, replicas: parsedScaleReplicas })}
              disabled={!scaleCandidate || !Number.isInteger(parsedScaleReplicas) || parsedScaleReplicas < 0 || parsedScaleReplicas > 50 || scaleResourceMutation.isPending}
            >
              {scaleResourceMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SlidersHorizontal className="h-4 w-4" />}
              Scale
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
