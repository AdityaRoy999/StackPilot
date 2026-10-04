"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  KeyRound,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { toast } from "sonner";

import api from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface SshConnection {
  id: string;
  name: string;
  connection_type: "ssh" | "tailscale" | "headscale";
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "key" | "tailscale" | "headscale";
  last_tested_at: string;
  host_capabilities?: Record<string, string>;
  last_probed_at?: string;
  last_probe_error?: string;
  created_at: string;
  updated_at: string;
}

interface SshConnectionsResponse {
  connections: SshConnection[];
  count: number;
}

interface KubernetesClusterNode {
  id: string;
  connection_id: string;
  connection_name: string;
  host: string;
  username: string;
  role: "server" | "agent";
  status: string;
  last_status: string;
  joined_at: string;
  created_at: string;
  updated_at: string;
}

interface KubernetesCluster {
  id: string;
  name: string;
  provider: string;
  control_plane_connection_id: string;
  control_plane_name: string;
  control_plane_host: string;
  server_url: string;
  status: string;
  last_status: string;
  created_at: string;
  updated_at: string;
  nodes: KubernetesClusterNode[];
}

interface KubernetesClustersResponse {
  clusters: KubernetesCluster[];
  count: number;
}

interface ClusterActionResponse {
  success?: boolean;
  message?: string;
  error?: string;
  hint?: string;
  details?: string;
  needs_sudo_password?: boolean;
  cluster?: {
    id: string;
    name: string;
    provider?: string;
    server_url: string;
    status: string;
  };
  worker_connection_id?: string;
}

function errorPayload(error: unknown) {
  return error instanceof AxiosError
    ? (error.response?.data as ClusterActionResponse | undefined)
    : undefined;
}

function shortDetails(details?: string) {
  if (!details) return "";
  return details.length > 18000 ? `${details.slice(0, 18000)}\n... output truncated in browser ...` : details;
}

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  const normalized = status.toLowerCase();
  if (["ready", "running", "active"].includes(normalized)) return "default";
  if (["degraded", "failed", "error"].includes(normalized)) return "destructive";
  if (["initializing", "joining", "pending"].includes(normalized)) return "secondary";
  return "outline";
}

export function ClusterBuilder() {
  const queryClient = useQueryClient();
  const [controlPlaneId, setControlPlaneId] = useState("");
  const [clusterName, setClusterName] = useState("");
  const [advertiseAddress, setAdvertiseAddress] = useState("");
  const [tlsSan, setTlsSan] = useState("");
  const [controlPlaneSudo, setControlPlaneSudo] = useState("");
  const [workerSudo, setWorkerSudo] = useState("");
  const [selectedWorkerIds, setSelectedWorkerIds] = useState<string[]>([]);
  const [actionResult, setActionResult] = useState<ClusterActionResponse | null>(null);
  const [clusterToDelete, setClusterToDelete] = useState<KubernetesCluster | null>(null);
  const [wipeServersOnDelete, setWipeServersOnDelete] = useState(false);
  const [deleteSudoPassword, setDeleteSudoPassword] = useState("");
  const [serverToWipe, setServerToWipe] = useState<SshConnection | null>(null);
  const [wipeServerPassword, setWipeServerPassword] = useState("");
  const [showWipeServerDialog, setShowWipeServerDialog] = useState(false);

  const connectionsQuery = useQuery({
    queryKey: ["ssh-connections"],
    refetchOnMount: "always",
    refetchInterval: 30000,
    queryFn: async () => {
      const response = await api.get<SshConnectionsResponse>("/ssh/connections");
      return response.data;
    },
  });

  const clustersQuery = useQuery({
    queryKey: ["kubernetes-clusters"],
    refetchOnMount: "always",
    refetchInterval: 30000,
    queryFn: async () => {
      const response = await api.get<KubernetesClustersResponse>("/ssh/clusters");
      return response.data;
    },
  });

  const connections = useMemo(
    () => connectionsQuery.data?.connections ?? [],
    [connectionsQuery.data?.connections]
  );
  const clusters = useMemo(
    () => clustersQuery.data?.clusters ?? [],
    [clustersQuery.data?.clusters]
  );
  const probeMutation = useMutation({
    mutationFn: async (id: string) => (await api.post(`/ssh/connections/${id}/probe`, {}, { timeout: 45000 })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ssh-connections"] }),
    onError: (error) => { queryClient.invalidateQueries({ queryKey: ["ssh-connections"] }); toast.error(errorPayload(error)?.error || "Host probe failed"); },
  });
  const activeMembership = (id: string) => clusters.flatMap((cluster) => cluster.nodes.filter((node) => node.status !== "removed" && node.connection_id === id).map((node) => ({ cluster, node })));
  const readiness = (connection: SshConnection) => connection.last_probe_error ? "Last probe failed" : !connection.last_probed_at ? "Readiness not checked" : `Docker ${connection.host_capabilities?.docker_daemon === "yes" ? "available" : "unavailable"} · Kubernetes ${connection.host_capabilities?.kubernetes_ready === "yes" ? "available" : "unavailable"}`;
  const effectiveControlPlaneId = controlPlaneId || connections.find((connection) =>
    !activeMembership(connection.id).some(({ cluster }) => cluster.control_plane_connection_id !== connection.id)
  )?.id || "";
  const selectedControlPlane = connections.find((connection) => connection.id === effectiveControlPlaneId);
  const effectiveClusterName = clusterName.trim() || clusters.find((cluster) => cluster.control_plane_connection_id === effectiveControlPlaneId)?.name || (selectedControlPlane ? `${selectedControlPlane.name}-cluster` : "");
  const workerOptions = useMemo(() => {
    return connections.filter((connection) => {
      if (connection.id === effectiveControlPlaneId) return false;
      if (selectedControlPlane && connection.host === selectedControlPlane.host) return false;
      return true;
    });
  }, [connections, effectiveControlPlaneId, selectedControlPlane]);

  const effectiveSelectedWorkerIds = useMemo(() => {
    const validWorkerIdSet = new Set(workerOptions.map((w) => w.id));
    return selectedWorkerIds.filter((id) => validWorkerIdSet.has(id) && !clusters.some((cluster) => cluster.nodes.some((node) => node.connection_id === id && node.status !== "removed")));
  }, [selectedWorkerIds, workerOptions, clusters]);

  const selectedCluster = useMemo(
    () => clusters.find((cluster) => cluster.control_plane_connection_id === effectiveControlPlaneId),
    [clusters, effectiveControlPlaneId]
  );

  const initializeMutation = useMutation({
    mutationKey: ["kubernetes-cluster-init"],
    mutationFn: async () => {
      const response = await api.post<ClusterActionResponse>(
        `/ssh/connections/${effectiveControlPlaneId}/cluster/init`,
        {
          cluster_name: effectiveClusterName,
          advertise_address: advertiseAddress.trim(),
          tls_san: tlsSan.trim(),
          sudo_password: controlPlaneSudo,
        },
        { timeout: 600000 }
      );
      return response.data;
    },
    onSuccess: (data) => {
      setActionResult(data);
      toast.success(data.message || "Kubernetes control plane initialized");
      queryClient.invalidateQueries({ queryKey: ["kubernetes-clusters"] });
      queryClient.invalidateQueries({ queryKey: ["ssh-connections"] });
      setControlPlaneSudo("");
    },
    onError: (error: unknown) => {
      const data = errorPayload(error);
      setActionResult(data ?? { success: false, error: "Control-plane bootstrap failed" });
      toast.error(data?.error || "Control-plane bootstrap failed", {
        description: data?.hint || (data?.details ? data.details.slice(0, 220) : undefined),
      });
    },
  });

  // Names of nodes that refused to join because they run their own standalone
  // Kubernetes. Non-empty means the confirmation dialog is open.
  const [replaceCandidates, setReplaceCandidates] = useState<string[]>([]);

  const joinWorkersMutation = useMutation({
    mutationKey: ["kubernetes-cluster-join-workers"],
    mutationFn: async (options?: { replaceExisting?: boolean }) => {
      const promises = effectiveSelectedWorkerIds.map(async (workerId) => {
        try {
          const response = await api.post<ClusterActionResponse>(
            `/ssh/connections/${effectiveControlPlaneId}/cluster/join`,
            {
              worker_connection_id: workerId,
              sudo_password: workerSudo,
              // Only ever set after the user confirms in the dialog below.
              // Converting a standalone node destroys what it was running.
              replace_existing: options?.replaceExisting === true,
            },
            { timeout: 600000 }
          );
          return response.data;
        } catch (error) {
          const data = errorPayload(error);
          return data ?? {
            success: false,
            error: "Worker join failed",
            worker_connection_id: workerId,
          };
        }
      });
      return await Promise.all(promises);
    },
    onSuccess: (results) => {
      const failed = results.filter((result) => !result.success);
      const combinedDetails = results
        .map((result) => {
          const worker = connections.find((connection) => connection.id === result.worker_connection_id);
          return `# ${worker?.name || result.worker_connection_id || "worker"}\n${result.details || result.error || result.message || ""}`;
        })
        .join("\n\n");
      setActionResult({
        success: failed.length === 0,
        message: failed.length === 0 ? "Selected workers joined the cluster" : `${failed.length} worker join operation failed`,
        details: combinedDetails,
      });
      // A node already running its own standalone Kubernetes is the one
      // failure the user can resolve without understanding k3s internals, so
      // offer to do it for them instead of explaining server-versus-agent.
      const alreadyServers = failed.filter((result) =>
        (result.error || "").includes("already running k3s as its own control plane") ||
        (result.error || "").includes("already registered as the control plane")
      );
      if (alreadyServers.length > 0) {
        setReplaceCandidates(
          alreadyServers
            .map((result) => connections.find((c) => c.id === result.worker_connection_id)?.name)
            .filter((name): name is string => Boolean(name))
        );
        return;
      }

      if (failed.length === 0) {
        toast.success("Selected workers joined the cluster");
        setWorkerSudo("");
      } else {
        toast.warning(`${failed.length} worker join operation failed`);
      }
      queryClient.invalidateQueries({ queryKey: ["kubernetes-clusters"] });
    },
  });

  const inspectMutation = useMutation({
    mutationKey: ["kubernetes-cluster-status"],
    mutationFn: async (connectionId: string) => {
      const response = await api.get<ClusterActionResponse>(`/ssh/connections/${connectionId}/cluster/status`);
      return response.data;
    },
    onSuccess: (data) => {
      setActionResult(data);
      toast.success(data.message || "Cluster status loaded");
      queryClient.invalidateQueries({ queryKey: ["kubernetes-clusters"] });
    },
    onError: (error: unknown) => {
      const data = errorPayload(error);
      setActionResult(data ?? { success: false, error: "Failed to inspect cluster" });
      const sanitizedDetails = data?.details
        ? data.details.replace(/__[A-Z0-9_]+__/g, "").replace(/E\d+\s+[\d:.]+\s+\d+\s+\S+\]/g, "").trim().slice(0, 180)
        : undefined;
      toast.error(data?.error || "Failed to inspect cluster", {
        description: data?.hint || sanitizedDetails,
      });
    },
  });

  const deleteClusterMutation = useMutation({
    mutationKey: ["delete-kubernetes-cluster"],
    mutationFn: async ({
      clusterId,
      wipeServers,
      sudoPassword,
    }: {
      clusterId: string;
      wipeServers: boolean;
      sudoPassword?: string;
    }) => {
      const response = await api.delete<ClusterActionResponse>(`/ssh/clusters/${clusterId}`, {
        data: { wipe_servers: wipeServers, sudo_password: sudoPassword },
        timeout: wipeServers ? 300000 : 30000,
      });
      return response.data;
    },
    onSuccess: (data) => {
      toast.success(data.message || "Cluster deleted");
      setClusterToDelete(null);
      setWipeServersOnDelete(false);
      setDeleteSudoPassword("");
      queryClient.invalidateQueries({ queryKey: ["kubernetes-clusters"] });
      queryClient.invalidateQueries({ queryKey: ["ssh-connections"] });
    },
    onError: (error: unknown) => {
      const data = errorPayload(error);
      toast.error(data?.error || "Failed to delete cluster");
    },
  });

  const wipeServerMutation = useMutation({
    mutationKey: ["wipe-server-k3s"],
    mutationFn: async ({
      connectionId,
      sudoPassword,
    }: {
      connectionId: string;
      sudoPassword?: string;
    }) => {
      const response = await api.post<ClusterActionResponse>(
        `/ssh/connections/${connectionId}/wipe`,
        { sudo_password: sudoPassword },
        { timeout: 300000 }
      );
      return response.data;
    },
    onSuccess: (data) => {
      toast.success(data.message || "Server wiped successfully");
      setServerToWipe(null);
      setWipeServerPassword("");
      setShowWipeServerDialog(false);
      queryClient.invalidateQueries({ queryKey: ["kubernetes-clusters"] });
      queryClient.invalidateQueries({ queryKey: ["ssh-connections"] });
    },
    onError: (error: unknown) => {
      const data = errorPayload(error);
      toast.error(data?.error || "Failed to wipe server");
    },
  });

  const toggleWorker = (id: string, checked: boolean) => {
    if (id === effectiveControlPlaneId) {
      return;
    }
    setSelectedWorkerIds((current) =>
      checked ? Array.from(new Set([...current, id])) : current.filter((workerId) => workerId !== id)
    );
  };

  return (
    <div className="space-y-6">
      {(connectionsQuery.isError || clustersQuery.isError) && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">Could not load saved servers or clusters. Use Refresh to retry.</p>}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground">
            <AppIcon name="network" fallback={Network} className="h-3.5 w-3.5"  />
            k3s multi-node bootstrap
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight">Cluster Builder</h1>
          <p className="max-w-3xl text-muted-foreground">
            Bootstrap a control plane from a saved server, join worker servers, and verify the cluster without leaving StackPilot.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 lg:shrink-0">
          <Button
            variant="outline"
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ["ssh-connections"] });
              queryClient.invalidateQueries({ queryKey: ["kubernetes-clusters"] });
            }}
            disabled={connectionsQuery.isFetching || clustersQuery.isFetching}
          >
            {connectionsQuery.isFetching || clustersQuery.isFetching ? (
              <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />
            ) : (
              <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4"  />
            )}
            Refresh
          </Button>
          <Link href="/dashboard/settings" className={buttonVariants({ variant: "outline" })}>
              <AppIcon name="key-round" fallback={KeyRound} className="mr-2 h-4 w-4"  />
              Manage Servers
          </Link>
          <Button
            variant="outline"
            className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive whitespace-nowrap"
            onClick={() => {
              setServerToWipe(connections[0] || null);
              setShowWipeServerDialog(true);
            }}
          >
            <AppIcon name="trash-2" fallback={Trash2} className="mr-2 h-4 w-4" />
            Wipe Server K3s
          </Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.72fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AppIcon name="server" fallback={Server} className="h-5 w-5 text-primary"  />
              Create or Expand Cluster
            </CardTitle>
            <CardDescription>
              Run these operations on trusted servers only. StackPilot installs k3s and stores the join token encrypted for future worker joins.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {connections.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 p-5 text-sm text-muted-foreground">
                No saved servers are available yet. Add SSH, Tailscale SSH, or Headscale SSH connections in Settings first.
              </div>
            ) : (
              <>
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-xs text-muted-foreground space-y-1.5">
                  <div className="font-semibold text-foreground flex items-center gap-1.5 text-xs">
                    <AppIcon name="shield-check" fallback={ShieldCheck} className="h-4 w-4 text-primary" />
                    AWS EC2 & Cloud Multi-Node Setup
                  </div>
                  <p>
                    StackPilot automatically provisions packages (curl, wget, tar, container-selinux), multi-SAN certificates, and OS firewall rules (UFW/firewalld) on all fresh instances.
                  </p>
                  <p>
                    <strong>AWS Security Group:</strong> Ensure your EC2 instances allow inbound <strong>TCP 6443</strong> (K8s API) and <strong>UDP 8472</strong> (Flannel VXLAN overlay) from each other.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    1
                  </span>
                  <h3 className="text-sm font-semibold">Choose the control plane</h3>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Control-plane server</Label>
                    <Select
                      value={effectiveControlPlaneId}
                      onValueChange={(value) => {
                        if (value) setControlPlaneId(value);
                      }}
                    >
                      <SelectTrigger className="h-10 w-full bg-muted/30">
                        <span className="truncate">
                          {selectedControlPlane
                            ? `${selectedControlPlane.name} (${selectedControlPlane.host})`
                            : "Select control plane"}
                        </span>
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        {connections.map((connection) => (
                          <SelectItem key={connection.id} value={connection.id} disabled={activeMembership(connection.id).some(({ cluster }) => cluster.control_plane_connection_id !== connection.id)}>
                            <span>{connection.name}</span>
                            <span className="font-mono text-xs text-muted-foreground">{connection.host}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedControlPlane && <div className="space-y-2 rounded-lg border p-3">
                      <p className="text-xs text-muted-foreground">{readiness(selectedControlPlane)}</p>
                      {selectedControlPlane.last_probed_at && <p className="text-[11px] text-muted-foreground">Last checked {new Date(selectedControlPlane.last_probed_at).toLocaleString()}</p>}
                      <Button size="sm" type="button" variant="outline" disabled={probeMutation.isPending} onClick={() => probeMutation.mutate(selectedControlPlane.id)}><RefreshCw size={14} className={probeMutation.isPending ? "animate-spin" : ""} />Check readiness</Button>
                    </div>}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="clusterName">Cluster name</Label>
                    <Input
                      id="clusterName"
                      value={effectiveClusterName}
                      onChange={(event) => setClusterName(event.target.value)}
                      placeholder="production-edge"
                    />
                  </div>
                </div>

                {/* Three optional fields were competing for attention with the
                    two that are actually required. Folded away by default. */}
                <details className="group rounded-xl border border-border bg-muted/10">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm">
                    <span className="font-medium">Advanced network options</span>
                    <span className="text-xs text-muted-foreground">
                      Advertise address, TLS SAN, sudo password
                    </span>
                  </summary>
                  <div className="grid gap-4 border-t border-border p-4 lg:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="advertiseAddress">Advertise address</Label>
                      <Input
                        id="advertiseAddress"
                        value={advertiseAddress}
                        onChange={(event) => setAdvertiseAddress(event.target.value)}
                        placeholder="Private IP workers will connect to"
                      />
                      <p className="text-xs text-muted-foreground">
                        The address other nodes use to reach the API server. On AWS this is the
                        private IP, not the public one.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tlsSan">TLS SAN</Label>
                      <Input
                        id="tlsSan"
                        value={tlsSan}
                        onChange={(event) => setTlsSan(event.target.value)}
                        placeholder="Optional domain or fixed IP"
                      />
                      <p className="text-xs text-muted-foreground">
                        Extra hostname to include in the API server certificate.
                      </p>
                    </div>
                    <div className="space-y-2 lg:col-span-2">
                      <Label htmlFor="controlPlaneSudo">Control-plane sudo password</Label>
                      <Input
                        id="controlPlaneSudo"
                        type="password"
                        value={controlPlaneSudo}
                        onChange={(event) => setControlPlaneSudo(event.target.value)}
                        placeholder="Leave blank when passwordless sudo works"
                      />
                    </div>
                  </div>
                </details>

                <div className="flex items-center gap-2 pt-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    2
                  </span>
                  <h3 className="text-sm font-semibold">
                    {selectedCluster && selectedCluster.status === "ready"
                      ? "Control plane active"
                      : "Install Kubernetes on it"}
                  </h3>
                </div>

                {selectedCluster && selectedCluster.status === "ready" ? (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-2.5">
                        <AppIcon name="check-circle-2" fallback={CheckCircle2} className="h-5 w-5 text-emerald-500 shrink-0" />
                        <div>
                          <div className="font-semibold text-foreground flex items-center gap-2">
                            <span>{selectedCluster.name}</span>
                            <Badge variant="outline" className="border-emerald-500/40 text-emerald-500 text-[10px]">
                              Ready
                            </Badge>
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">{selectedCluster.server_url}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => inspectMutation.mutate(effectiveControlPlaneId)}
                          disabled={inspectMutation.isPending}
                        >
                          {inspectMutation.isPending && inspectMutation.variables === effectiveControlPlaneId ? (
                            <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4" />
                          )}
                          Inspect Cluster
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => initializeMutation.mutate()}
                          disabled={initializeMutation.isPending}
                        >
                          Re-initialize
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Kubernetes control plane is active. To add worker servers to this cluster, select them in <strong>Step 3</strong> below and click <strong>Join Workers</strong>.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/20 p-4">
                    <Button
                      onClick={() => initializeMutation.mutate()}
                      disabled={!effectiveControlPlaneId || !effectiveClusterName || initializeMutation.isPending || activeMembership(effectiveControlPlaneId).some(({ cluster }) => cluster.control_plane_connection_id !== effectiveControlPlaneId)}
                    >
                      {initializeMutation.isPending ? (
                        <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />
                      ) : (
                        <AppIcon name="shield-check" fallback={ShieldCheck} className="mr-2 h-4 w-4"  />
                      )}
                      Initialize Control Plane
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => inspectMutation.mutate(effectiveControlPlaneId)}
                      disabled={!selectedCluster || inspectMutation.isPending}
                    >
                      {inspectMutation.isPending && inspectMutation.variables === effectiveControlPlaneId ? (
                        <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />
                      ) : (
                        <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4"  />
                      )}
                      Inspect Cluster
                    </Button>
                    {selectedCluster ? (
                      <Badge variant={statusBadgeVariant(selectedCluster.status)}>
                        {selectedCluster.status}
                      </Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        Initialize this server before joining workers.
                      </span>
                    )}
                  </div>
                )}

                <div id="cluster-step-3-workers" className="space-y-3 rounded-xl border border-border bg-card p-4 scroll-mt-6">
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h3 className="flex items-center gap-2 font-semibold text-foreground">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                          3
                        </span>
                        {selectedCluster ? `Join worker servers to ${selectedCluster.name}` : "Join worker servers"}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        Select one or more saved servers. They will join the selected control plane as k3s agents.
                      </p>
                    </div>
                    <Badge variant="outline">{effectiveSelectedWorkerIds.length} selected</Badge>
                  </div>

                  {workerOptions.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
                      Add at least one more saved server to join worker nodes.
                    </div>
                  ) : (
                    <div className="grid gap-2 md:grid-cols-2">
                      {workerOptions.map((connection) => {
                        const isAlreadyMember = selectedCluster?.nodes.some((n) => n.connection_id === connection.id && n.status !== "removed");
                        const managedWorker = activeMembership(connection.id).some(({ node }) => node.role === "agent");
                        return (
                          <Label
                            key={connection.id}
                            htmlFor={`worker-${connection.id}`}
                            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/20 p-3 font-normal"
                          >
                            <Checkbox
                              id={`worker-${connection.id}`}
                              disabled={Boolean(isAlreadyMember || managedWorker)}
                              checked={Boolean(isAlreadyMember) || effectiveSelectedWorkerIds.includes(connection.id)}
                              onCheckedChange={(checked) => toggleWorker(connection.id, checked === true)}
                            />
                            <span className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate font-medium text-foreground">{connection.name}</span>
                                {isAlreadyMember ? (
                                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-emerald-500/40 text-emerald-500">
                                    In this cluster
                                  </Badge>
                                ) : clusters.some((c) => c.control_plane_connection_id === connection.id) ? (
                                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                    Standalone CP
                                  </Badge>
                                ) : null}
                              </div>
                              <span className="block text-xs text-muted-foreground">{readiness(connection)}</span>
                              {managedWorker && !isAlreadyMember && <span className="block text-xs text-amber-600">Worker managed by another cluster</span>}
                              <span className="block truncate font-mono text-xs text-muted-foreground">
                                {connection.username}@{connection.host}
                              </span>
                            </span>
                          </Label>
                        );
                      })}
                    </div>
                  )}

                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                    <div className="space-y-2">
                      <Label htmlFor="workerSudo">Worker sudo password</Label>
                      <Input
                        id="workerSudo"
                        type="password"
                        value={workerSudo}
                        onChange={(event) => setWorkerSudo(event.target.value)}
                        placeholder="Optional. Used once if workers need sudo password."
                      />
                    </div>
                    <Button
                      onClick={() => joinWorkersMutation.mutate({})}
                      disabled={!selectedCluster || effectiveSelectedWorkerIds.length === 0 || joinWorkersMutation.isPending}
                    >
                      {joinWorkersMutation.isPending ? (
                        <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />
                      ) : (
                        <AppIcon name="boxes" fallback={Boxes} className="mr-2 h-4 w-4"  />
                      )}
                      Join Workers
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AppIcon name="check-circle2" fallback={CheckCircle2} className="h-5 w-5 text-primary"  />
              Operation Output
            </CardTitle>
            <CardDescription>
              Bootstrap, join, and status output appears here. Tokens are redacted by the backend.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {actionResult ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={actionResult.success ? "default" : "destructive"}>
                    {actionResult.success ? "ok" : "failed"}
                  </Badge>
                  <span className="text-sm font-medium text-foreground">
                    {actionResult.message || actionResult.error || "Cluster operation finished"}
                  </span>
                </div>
                {actionResult.hint ? (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                    {actionResult.hint}
                  </div>
                ) : null}
                {actionResult.cluster?.server_url ? (
                  <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">API server</div>
                    <div className="mt-1 font-mono text-foreground">{actionResult.cluster.server_url}</div>
                  </div>
                ) : null}
                <pre className="max-h-[36rem] overflow-auto rounded-xl border border-border bg-background p-4 text-xs leading-relaxed text-muted-foreground scrollbar-thin">
                  {shortDetails(actionResult.details) || actionResult.error || "No detailed output was returned."}
                </pre>
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 p-5 text-sm text-muted-foreground">
                Run an operation to see installer logs, join results, and cluster status here.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AppIcon name="git-branch" fallback={GitBranch} className="h-5 w-5 text-primary"  />
            Registered Clusters
          </CardTitle>
          <CardDescription>
            Existing control planes and joined nodes known to StackPilot. Runtime workloads still appear in Infrastructure Monitor.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {clustersQuery.isLoading ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />
              Loading clusters...
            </div>
          ) : clusters.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-muted/20 p-5 text-sm text-muted-foreground">
              No Kubernetes clusters have been initialized from StackPilot yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cluster</TableHead>
                  <TableHead>Control Plane</TableHead>
                  <TableHead>API Server</TableHead>
                  <TableHead>Nodes</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clusters.map((cluster) => (
                  <TableRow key={cluster.id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{cluster.name}</div>
                      <div className="text-xs text-muted-foreground">{cluster.provider}</div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-foreground">{cluster.control_plane_name || "Unknown"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{cluster.control_plane_host}</div>
                    </TableCell>
                    <TableCell className="max-w-[18rem] truncate font-mono text-xs">
                      {cluster.server_url}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {cluster.nodes.map((node) => (
                          <Badge key={node.id} variant={node.role === "server" ? "default" : "outline"}>
                            {node.connection_name || node.host || node.role} / {node.role}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(cluster.status)}>{cluster.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setControlPlaneId(cluster.control_plane_connection_id);
                            setClusterName(cluster.name);
                            const step3 = document.getElementById("cluster-step-3-workers");
                            if (step3) {
                              step3.scrollIntoView({ behavior: "smooth" });
                            } else {
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }
                            toast.info(`Selected cluster "${cluster.name}". Choose worker servers in Step 3 to expand it.`);
                          }}
                        >
                          <AppIcon name="plus" fallback={Plus} className="mr-1.5 h-3.5 w-3.5" />
                          Add Worker
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setControlPlaneId(cluster.control_plane_connection_id);
                            inspectMutation.mutate(cluster.control_plane_connection_id);
                          }}
                          disabled={inspectMutation.isPending}
                        >
                          {inspectMutation.isPending && inspectMutation.variables === cluster.control_plane_connection_id ? (
                            <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4" />
                          )}
                          Inspect
                        </Button>
                        <Link
                          // Without the connection id the monitor opens on the
                          // local host and reports "no cluster detected" for a
                          // cluster that is running perfectly well.
                          href={`/dashboard/logging-monitoring/infrastructure?connection_id=${encodeURIComponent(
                            cluster.control_plane_connection_id
                          )}`}
                          className={buttonVariants({ variant: "outline", size: "sm" })}
                        >
                            <AppIcon name="external-link" fallback={ExternalLink} className="mr-2 h-4 w-4"  />
                            Monitor
                        </Link>
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => {
                            setClusterToDelete(cluster);
                            setWipeServersOnDelete(false);
                            setDeleteSudoPassword("");
                          }}
                          title="Delete or deregister cluster"
                        >
                          <AppIcon name="trash-2" fallback={Trash2} className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Dialog open={replaceCandidates.length > 0} onOpenChange={(open) => !open && setReplaceCandidates([])}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Replace the standalone Kubernetes on these servers?</DialogTitle>
            <DialogDescription>
              {replaceCandidates.join(", ")}{" "}
              {replaceCandidates.length === 1 ? "is" : "are"} already running Kubernetes as a
              single-server cluster, which is why the join was refused.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              To join the cluster, that standalone install has to be removed first. StackPilot can
              do it now and then join the server as a worker.
            </p>
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-destructive">
              Anything currently running on those servers&apos; own clusters will be destroyed. Only
              their standalone Kubernetes is affected — the cluster you are joining them to is not
              touched.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplaceCandidates([])}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setReplaceCandidates([]);
                joinWorkersMutation.mutate({ replaceExisting: true });
              }}
            >
              Replace and join
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Cluster Confirmation Dialog */}
      <Dialog open={Boolean(clusterToDelete)} onOpenChange={(open) => !open && setClusterToDelete(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AppIcon name="trash-2" fallback={Trash2} className="h-5 w-5" />
              Delete Cluster &ldquo;{clusterToDelete?.name}&rdquo;?
            </DialogTitle>
            <DialogDescription>
              This removes the cluster registration from StackPilot.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm py-2">
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="wipeServersCheckbox"
                  checked={wipeServersOnDelete}
                  onCheckedChange={(checked) => setWipeServersOnDelete(checked === true)}
                />
                <div className="space-y-1">
                  <Label htmlFor="wipeServersCheckbox" className="font-semibold cursor-pointer text-foreground">
                    Wipe &amp; uninstall K3s on all nodes via SSH
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Connects to control plane ({clusterToDelete?.control_plane_host}) and all worker nodes, stops k3s, executes <code>k3s-uninstall.sh</code> and <code>k3s-agent-uninstall.sh</code>, and cleans <code>/etc/rancher</code>. Check this if you want to reuse these servers fresh.
                  </p>
                </div>
              </div>
            </div>
            {wipeServersOnDelete && (
              <div className="space-y-2">
                <Label htmlFor="deleteSudoPassword">Sudo password (if required)</Label>
                <Input
                  id="deleteSudoPassword"
                  type="password"
                  value={deleteSudoPassword}
                  onChange={(e) => setDeleteSudoPassword(e.target.value)}
                  placeholder="Leave empty if passwordless sudo works"
                />
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setClusterToDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (clusterToDelete) {
                  deleteClusterMutation.mutate({
                    clusterId: clusterToDelete.id,
                    wipeServers: wipeServersOnDelete,
                    sudoPassword: deleteSudoPassword,
                  });
                }
              }}
              disabled={deleteClusterMutation.isPending}
            >
              {deleteClusterMutation.isPending ? (
                <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <AppIcon name="trash-2" fallback={Trash2} className="mr-2 h-4 w-4" />
              )}
              {wipeServersOnDelete ? "Wipe Servers & Delete Cluster" : "Deregister Cluster"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Wipe Single Server Dialog */}
      <Dialog open={showWipeServerDialog} onOpenChange={(open) => !open && setShowWipeServerDialog(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AppIcon name="trash-2" fallback={Trash2} className="h-5 w-5" />
              Wipe Server &amp; Uninstall K3s
            </DialogTitle>
            <DialogDescription>
              Completely uninstalls K3s, kills background processes, removes /etc/rancher and resets iptables so this machine is ready for a fresh start.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 text-sm">
            <div className="space-y-2">
              <Label>Target Server</Label>
              <Select
                value={serverToWipe?.id || ""}
                onValueChange={(val) => {
                  const s = connections.find((c) => c.id === val);
                  if (s) setServerToWipe(s);
                }}
              >
                <SelectTrigger className="w-full">
                  <span>{serverToWipe ? `${serverToWipe.name} (${serverToWipe.host})` : "Select a server"}</span>
                </SelectTrigger>
                <SelectContent>
                  {connections.map((conn) => (
                    <SelectItem key={conn.id} value={conn.id}>
                      {conn.name} ({conn.host})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="wipeServerPassword">Sudo password</Label>
              <Input
                id="wipeServerPassword"
                type="password"
                value={wipeServerPassword}
                onChange={(e) => setWipeServerPassword(e.target.value)}
                placeholder="Leave blank for passwordless sudo"
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowWipeServerDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (serverToWipe) {
                  wipeServerMutation.mutate({
                    connectionId: serverToWipe.id,
                    sudoPassword: wipeServerPassword,
                  });
                }
              }}
              disabled={!serverToWipe || wipeServerMutation.isPending}
            >
              {wipeServerMutation.isPending ? (
                <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <AppIcon name="trash-2" fallback={Trash2} className="mr-2 h-4 w-4" />
              )}
              Wipe Server Clean
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
