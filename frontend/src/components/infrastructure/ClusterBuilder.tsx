"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import {
  Boxes,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  KeyRound,
  Loader2,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import api from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

  const connectionsQuery = useQuery({
    queryKey: ["ssh-connections"],
    queryFn: async () => {
      const response = await api.get<SshConnectionsResponse>("/ssh/connections");
      return response.data;
    },
  });

  const clustersQuery = useQuery({
    queryKey: ["kubernetes-clusters"],
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
  const effectiveControlPlaneId = controlPlaneId || connections[0]?.id || "";
  const selectedControlPlane = connections.find((connection) => connection.id === effectiveControlPlaneId);
  const effectiveClusterName = clusterName.trim() || (selectedControlPlane ? `${selectedControlPlane.name}-cluster` : "");
  const workerOptions = connections.filter((connection) => connection.id !== effectiveControlPlaneId);
  const effectiveSelectedWorkerIds = selectedWorkerIds.filter((id) => id !== effectiveControlPlaneId);
  const selectedCluster = useMemo(
    () => clusters.find((cluster) => cluster.control_plane_connection_id === effectiveControlPlaneId),
    [clusters, effectiveControlPlaneId]
  );

  const initializeMutation = useMutation({
    mutationKey: ["kubernetes-cluster-init"],
    mutationFn: async () => {
      const response = await api.post<ClusterActionResponse>(`/ssh/connections/${effectiveControlPlaneId}/cluster/init`, {
        cluster_name: effectiveClusterName,
        advertise_address: advertiseAddress.trim(),
        tls_san: tlsSan.trim(),
        sudo_password: controlPlaneSudo,
      });
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

  const joinWorkersMutation = useMutation({
    mutationKey: ["kubernetes-cluster-join-workers"],
    mutationFn: async () => {
      const results: ClusterActionResponse[] = [];
      for (const workerId of effectiveSelectedWorkerIds) {
        try {
          const response = await api.post<ClusterActionResponse>(`/ssh/connections/${effectiveControlPlaneId}/cluster/join`, {
            worker_connection_id: workerId,
            sudo_password: workerSudo,
          });
          results.push(response.data);
        } catch (error) {
          const data = errorPayload(error);
          results.push(data ?? {
            success: false,
            error: "Worker join failed",
            worker_connection_id: workerId,
          });
        }
      }
      return results;
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
      toast.error(data?.error || "Failed to inspect cluster", {
        description: data?.hint || (data?.details ? data.details.slice(0, 220) : undefined),
      });
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
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground">
            <Network className="h-3.5 w-3.5" />
            k3s multi-node bootstrap
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight">Cluster Builder</h1>
          <p className="max-w-3xl text-muted-foreground">
            Bootstrap a control plane from a saved server, join worker servers, and verify the cluster without leaving DOKSCP.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ["ssh-connections"] });
              queryClient.invalidateQueries({ queryKey: ["kubernetes-clusters"] });
            }}
            disabled={connectionsQuery.isFetching || clustersQuery.isFetching}
          >
            {connectionsQuery.isFetching || clustersQuery.isFetching ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh
          </Button>
          <Link href="/dashboard/settings" className={buttonVariants({ variant: "outline" })}>
              <KeyRound className="mr-2 h-4 w-4" />
              Manage Servers
          </Link>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.72fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5 text-primary" />
              Create or Expand Cluster
            </CardTitle>
            <CardDescription>
              Run these operations on trusted servers only. DOKSCP installs k3s and stores the join token encrypted for future worker joins.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {connections.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 p-5 text-sm text-muted-foreground">
                No saved servers are available yet. Add SSH, Tailscale SSH, or Headscale SSH connections in Settings first.
              </div>
            ) : (
              <>
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
                          <SelectItem key={connection.id} value={connection.id}>
                            <span>{connection.name}</span>
                            <span className="font-mono text-xs text-muted-foreground">{connection.host}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                  <div className="space-y-2">
                    <Label htmlFor="advertiseAddress">Advertise address</Label>
                    <Input
                      id="advertiseAddress"
                      value={advertiseAddress}
                      onChange={(event) => setAdvertiseAddress(event.target.value)}
                      placeholder="Optional node IP or private mesh IP"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tlsSan">TLS SAN</Label>
                    <Input
                      id="tlsSan"
                      value={tlsSan}
                      onChange={(event) => setTlsSan(event.target.value)}
                      placeholder="Optional domain or fixed IP"
                    />
                  </div>
                  <div className="space-y-2 lg:col-span-2">
                    <Label htmlFor="controlPlaneSudo">Control-plane sudo password</Label>
                    <Input
                      id="controlPlaneSudo"
                      type="password"
                      value={controlPlaneSudo}
                      onChange={(event) => setControlPlaneSudo(event.target.value)}
                      placeholder="Optional. Used once if passwordless sudo is unavailable."
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/20 p-4">
                  <Button
                    onClick={() => initializeMutation.mutate()}
                    disabled={!effectiveControlPlaneId || !effectiveClusterName || initializeMutation.isPending}
                  >
                    {initializeMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-2 h-4 w-4" />
                    )}
                    Initialize Control Plane
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => inspectMutation.mutate(effectiveControlPlaneId)}
                    disabled={!selectedCluster || inspectMutation.isPending}
                  >
                    {inspectMutation.isPending && inspectMutation.variables === effectiveControlPlaneId ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
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

                <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h3 className="font-semibold text-foreground">Join worker servers</h3>
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
                      {workerOptions.map((connection) => (
                        <Label
                          key={connection.id}
                          htmlFor={`worker-${connection.id}`}
                          className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/20 p-3 font-normal"
                        >
                          <Checkbox
                            id={`worker-${connection.id}`}
                            checked={effectiveSelectedWorkerIds.includes(connection.id)}
                            onCheckedChange={(checked) => toggleWorker(connection.id, checked === true)}
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-foreground">{connection.name}</span>
                            <span className="block truncate font-mono text-xs text-muted-foreground">
                              {connection.username}@{connection.host}
                            </span>
                          </span>
                        </Label>
                      ))}
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
                      onClick={() => joinWorkersMutation.mutate()}
                      disabled={!selectedCluster || effectiveSelectedWorkerIds.length === 0 || joinWorkersMutation.isPending}
                    >
                      {joinWorkersMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Boxes className="mr-2 h-4 w-4" />
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
              <CheckCircle2 className="h-5 w-5 text-primary" />
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
            <GitBranch className="h-5 w-5 text-primary" />
            Registered Clusters
          </CardTitle>
          <CardDescription>
            Existing control planes and joined nodes known to DOKSCP. Runtime workloads still appear in Infrastructure Monitor.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {clustersQuery.isLoading ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading clusters...
            </div>
          ) : clusters.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-muted/20 p-5 text-sm text-muted-foreground">
              No Kubernetes clusters have been initialized from DOKSCP yet.
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
                            inspectMutation.mutate(cluster.control_plane_connection_id);
                          }}
                          disabled={inspectMutation.isPending}
                        >
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Inspect
                        </Button>
                        <Link
                          href="/dashboard/logging-monitoring/infrastructure"
                          className={buttonVariants({ variant: "outline", size: "sm" })}
                        >
                            <ExternalLink className="mr-2 h-4 w-4" />
                            Monitor
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
