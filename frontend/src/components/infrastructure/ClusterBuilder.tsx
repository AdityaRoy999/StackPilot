"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import {
  Plus,
  CheckCircle2,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { toast } from "sonner";

import api from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { DisclosureSection } from "@/components/ui/disclosure-section";
import { SetupSteps } from "@/components/projects/ProjectSetupSteps";
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
  const [creationOpen, setCreationOpen] = useState(false);
  const [creationBusy, setCreationBusy] = useState(false);
  const [creationDone, setCreationDone] = useState(false);
  const [installedControlPlane, setInstalledControlPlane] = useState("");
  const creationLock = useRef(false);
  const [joinedWorkerIds, setJoinedWorkerIds] = useState<Set<string>>(() => new Set());
  const [setupStep, setSetupStep] = useState<"server" | "install" | "workers" | "confirmation">("server");
  const [controlPlaneId, setControlPlaneId] = useState("");
  const [clusterName, setClusterName] = useState("");
  const [advertiseAddress, setAdvertiseAddress] = useState("");
  const [tlsSan, setTlsSan] = useState("");
  const [controlPlaneSudo, setControlPlaneSudo] = useState("");
  const [workerSudo, setWorkerSudo] = useState("");
  const [selectedWorkerIds, setSelectedWorkerIds] = useState<string[]>([]);
  const [actionResult, setActionResult] = useState<ClusterActionResponse | null>(null);
  const [operationOutputs, setOperationOutputs] = useState<Record<string, ClusterActionResponse>>({});
  const [outputCluster, setOutputCluster] = useState<KubernetesCluster | null>(null);
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
  const effectiveControlPlaneId = controlPlaneId || connections.find(connection => activeMembership(connection.id).length === 0)?.id || connections.find((connection) =>
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
    return selectedWorkerIds.filter((id) => validWorkerIdSet.has(id) && !joinedWorkerIds.has(id) && !clusters.some((cluster) => cluster.nodes.some((node) => node.connection_id === id && node.role === "agent" && node.status !== "removed")));
  }, [selectedWorkerIds, workerOptions, clusters, joinedWorkerIds]);

  const selectedCluster = useMemo(
    () => clusters.find((cluster) => cluster.control_plane_connection_id === effectiveControlPlaneId),
    [clusters, effectiveControlPlaneId]
  );

  function recordActionResult(result: ClusterActionResponse, connectionId = effectiveControlPlaneId) {
    setActionResult(result);
    setOperationOutputs(current => ({ ...current, [connectionId]: result }));
  }
  const outputResult = operationOutputs[outputCluster?.control_plane_connection_id || ""];

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
      recordActionResult(data);
      if (data.success) toast.success(data.message || "Kubernetes control plane initialized");
      else toast.error(data.error || "Control-plane bootstrap failed");
      queryClient.invalidateQueries({ queryKey: ["kubernetes-clusters"] });
      queryClient.invalidateQueries({ queryKey: ["ssh-connections"] });
      setControlPlaneSudo("");
    },
    onError: (error: unknown) => {
      const data = errorPayload(error);
      recordActionResult(data ?? { success: false, error: "Control-plane bootstrap failed" });
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
          if (response.data.success) setJoinedWorkerIds(current => new Set([...current, workerId]));
          return { ...response.data, worker_connection_id: workerId };
        } catch (error) {
          const data = errorPayload(error);
          return { ...data,
            success: false,
            error: data?.error || "Worker join failed",
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
      recordActionResult({
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
      queryClient.invalidateQueries({ queryKey: ["kubernetes-clusters"] });
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
        if (!creationLock.current) setCreationDone(true);
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
    onSuccess: (data, connectionId) => {
      recordActionResult(data, connectionId);
      if (data.success) toast.success(data.message || "Cluster status loaded");
      else toast.error(data.error || "Cluster status check failed");
      queryClient.invalidateQueries({ queryKey: ["kubernetes-clusters"] });
    },
    onError: (error: unknown, connectionId) => {
      const data = errorPayload(error);
      recordActionResult(data ?? { success: false, error: "Failed to inspect cluster" }, connectionId);
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

  const operationBusy = creationBusy || initializeMutation.isPending || joinWorkersMutation.isPending || inspectMutation.isPending;
  const steps = ["server", "install", "workers", "confirmation"] as const;
  const reuseControlPlane = selectedCluster?.status === "ready" || installedControlPlane === effectiveControlPlaneId;
  const openCreation = () => {
    setSetupStep("server"); setCreationDone(false); setActionResult(null);
    setControlPlaneId(connections.find(connection => activeMembership(connection.id).length === 0)?.id || connections.find(connection => !activeMembership(connection.id).some(({ cluster }) => cluster.control_plane_connection_id !== connection.id))?.id || ""); setClusterName(""); setAdvertiseAddress(""); setTlsSan(""); setJoinedWorkerIds(new Set());
    setControlPlaneSudo(""); setWorkerSudo(""); setSelectedWorkerIds([]); setCreationOpen(true);
  };
  async function confirmCreation() {
    if (creationLock.current || operationBusy || !effectiveControlPlaneId || !effectiveClusterName) return;
    creationLock.current = true; setCreationBusy(true); setCreationDone(false); setActionResult(null);
    try {
      if (!reuseControlPlane) {
        const result = await initializeMutation.mutateAsync();
        if (!result.success) return;
        setInstalledControlPlane(effectiveControlPlaneId);
      }
      if (effectiveSelectedWorkerIds.length) {
        const results = await joinWorkersMutation.mutateAsync({});
        if (results.some(result => !result.success)) return;
      } else setActionResult({ success: true, message: "Cluster is ready", cluster: { id: selectedCluster?.id || "", name: effectiveClusterName, server_url: selectedCluster?.server_url || "", status: "ready" } });
      setCreationDone(true); setControlPlaneSudo(""); setWorkerSudo("");
    } catch { /* Mutations retain the backend error and any recoverable partial progress. */ }
    finally { creationLock.current = false; setCreationBusy(false); }
  }
  function closeCreation(open: boolean) {
    if (operationBusy) return;
    setCreationOpen(open);
    if (!open) { setControlPlaneSudo(""); setWorkerSudo(""); }
  }

  return (
    <div className="space-y-6">
      {(connectionsQuery.isError || clustersQuery.isError) && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">Could not load saved servers or clusters. Use Refresh to retry.</p>}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Cluster Builder</h1>
          <p className="max-w-3xl text-muted-foreground">
            Create a Kubernetes cluster from your saved servers, or manage an existing one.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 lg:shrink-0">
          <Button disabled={operationBusy} onClick={openCreation}><Plus className="size-4" />Create clusters</Button>
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

        </div>
      </div>

      <Dialog open={creationOpen} onOpenChange={closeCreation}>
        <DialogContent resizeKey={setupStep} showCloseButton={!operationBusy} className="flex max-h-[90dvh] flex-col overflow-hidden p-0 sm:max-w-4xl">
          <DialogHeader className="shrink-0 px-5 py-5 pr-12 sm:px-6"><DialogTitle>Create cluster</DialogTitle><DialogDescription>Choose your servers, review the installation, and confirm your cluster.</DialogDescription></DialogHeader>
          <SetupSteps label="Cluster setup progress" labels={["Server", "Install", "Workers", "Confirmation"]} step={steps.indexOf(setupStep)} onChange={index => setSetupStep(steps[index])} disabled={operationBusy || creationDone} />
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-5 sm:p-6">
              {connectionsQuery.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading saved servers…</p> : connections.length === 0 ? <div className="space-y-3 rounded-lg border border-dashed p-5"><p className="text-sm text-muted-foreground">Add a server connection in Settings to create a cluster.</p><Link href="/dashboard/settings" onClick={() => closeCreation(false)} className={buttonVariants({variant:"outline"})}>Add a server</Link></div> : <>
                {setupStep === "server" && <div className="space-y-5">
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="control-plane-server">Control-plane server</Label>
                    <Select
                      value={effectiveControlPlaneId}
                      disabled={operationBusy}
                      onValueChange={(value) => {
                        if (value) { setControlPlaneId(value); setInstalledControlPlane(""); setJoinedWorkerIds(new Set()); setClusterName(""); setSelectedWorkerIds([]); setActionResult(null); }
                      }}
                    >
                      <SelectTrigger id="control-plane-server" className="h-10 w-full bg-muted/30">
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
                      readOnly={Boolean(selectedCluster)}
                      value={effectiveClusterName}
                      onChange={(event) => setClusterName(event.target.value)}
                      placeholder="production-edge"
                    />
                  </div>
                </div>

                </div>}
                {setupStep === "install" && <div className="space-y-5">
                  <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm"><p className="font-medium">{effectiveClusterName}</p><p className="mt-1 break-words text-muted-foreground">{selectedControlPlane?.name} · {selectedControlPlane?.host}</p></div>
<DisclosureSection title="Advanced settings" description="Network address, certificate names, and sudo password">
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
</DisclosureSection>
                  <DisclosureSection title="Cloud networking requirements" description="Review these when connecting servers across a cloud network">
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
                  </DisclosureSection>
                  <p className="text-sm text-muted-foreground">{reuseControlPlane ? "This control plane is already installed. Its installation will be kept." : "k3s will be installed on the selected server after confirmation."}</p>

                </div>}
                {setupStep === "workers" && <div className="space-y-5">
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
                              disabled={operationBusy || Boolean(isAlreadyMember || managedWorker)}
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
                    <DisclosureSection title="Worker sudo password" description="Only needed when passwordless sudo is unavailable">
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
                    </DisclosureSection>
                  </div>
                </div>

                </div>}
                {setupStep === "confirmation" && <section className="space-y-5" aria-label="Cluster creation confirmation">
                  <div><h3 className="text-lg font-semibold">{effectiveClusterName}</h3><p className="mt-1 text-sm text-muted-foreground">{reuseControlPlane ? "Keep the control plane and join the selected workers." : "Install k3s on the control plane, then join the selected workers."}</p></div>
                  <dl className="divide-y divide-border rounded-xl border text-sm">
                    {[{ label: "Server", value: `${selectedControlPlane?.name} · ${selectedControlPlane?.host}` }, { label: "Install", value: reuseControlPlane ? "Reuse existing k3s control plane" : "Install k3s" }, { label: "Advertise address", value: advertiseAddress.trim() || "Automatic" }, { label: "Certificate name", value: tlsSan.trim() || "Automatic" }, { label: "Workers", value: selectedWorkerIds.length ? connections.filter(c => selectedWorkerIds.includes(c.id)).map(c => `${c.name} (${c.host})`).join(", ") : "Single-server cluster" }].map(row => <div key={row.label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 p-4"><dt className="text-muted-foreground">{row.label}</dt><dd className="break-words [overflow-wrap:anywhere] font-medium">{row.value}</dd></div>)}
                  </dl>
                  <p className="text-sm text-muted-foreground">Server software and firewall rules may change. Any saved passwords are used for this operation and hidden from this review.</p>
                  {operationBusy && <p role="status" className="flex gap-2 text-sm"><Loader2 className="size-4 animate-spin" />{initializeMutation.isPending ? "Installing control plane…" : "Joining workers…"}</p>}
                  {actionResult && <div role={actionResult.success ? "status" : "alert"} className="rounded-lg border p-4 text-sm"><p className={actionResult.success ? "font-medium" : "text-destructive"}>{actionResult.message || actionResult.error}</p>{actionResult.hint && <p className="mt-2 text-muted-foreground">{actionResult.hint}</p>}<DisclosureSection className="mt-3" title="Operation logs"><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{shortDetails(actionResult.details) || actionResult.error || "No additional output."}</pre></DisclosureSection></div>}
                </section>}
              </>}
          </div>
          <div data-cluster-footer className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t px-4 py-2 sm:px-6">
            {!creationDone && <Button variant="ghost" disabled={operationBusy} onClick={() => closeCreation(false)}>Cancel</Button>}
            {!creationDone && setupStep !== "server" && <Button variant="outline" disabled={operationBusy} onClick={() => setSetupStep(steps[steps.indexOf(setupStep) - 1])}>Back</Button>}
            {creationDone ? <Button onClick={() => closeCreation(false)}>Done</Button> : setupStep === "confirmation" ? <Button disabled={!effectiveControlPlaneId || !effectiveClusterName || operationBusy} onClick={() => void confirmCreation()}>{operationBusy && <Loader2 className="size-4 animate-spin" />}{reuseControlPlane ? "Confirm cluster" : "Create cluster"}</Button> : <Button disabled={!effectiveControlPlaneId || !effectiveClusterName || operationBusy} onClick={() => { setControlPlaneId(effectiveControlPlaneId); setSetupStep(steps[steps.indexOf(setupStep) + 1]); }}>{setupStep === "server" ? "Continue" : setupStep === "install" ? "Continue to workers" : "Review cluster"}</Button>}
          </div>
        </DialogContent>
      </Dialog>
      <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Clusters</CardTitle><CardDescription>Check status, add workers, or open the infrastructure monitor.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              {clustersQuery.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading clusters…</p> : clusters.length === 0 ? <div className="space-y-3 rounded-lg border border-dashed p-5"><p className="text-sm text-muted-foreground">You haven’t created a cluster yet.</p></div> : clusters.map(cluster => <section key={cluster.id} className="space-y-3 rounded-xl border border-border p-4" aria-label={cluster.name}>
                <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="min-w-0 break-words font-semibold">{cluster.name}</h2><div className="flex items-center gap-3"><Badge variant={statusBadgeVariant(cluster.status)}>{cluster.status}</Badge><Button size="icon" variant="ghost" className="size-11 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete cluster ${cluster.name}`} title="Delete cluster" disabled={operationBusy || deleteClusterMutation.isPending} onClick={() => { setClusterToDelete(cluster); setWipeServersOnDelete(false); setDeleteSudoPassword(""); }}><Trash2 className="size-4" /></Button></div></div>
                <p className="break-words text-sm text-muted-foreground">{cluster.control_plane_name || "Control plane"} · {cluster.control_plane_host} · {cluster.nodes.filter(node => node.status !== "removed").length} nodes</p>
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={operationBusy} onClick={() => { setControlPlaneId(cluster.control_plane_connection_id); setClusterName(cluster.name); setSelectedWorkerIds([]); setJoinedWorkerIds(new Set()); setControlPlaneSudo(""); setWorkerSudo(""); setAdvertiseAddress(""); setTlsSan(""); setActionResult(null); setSetupStep("workers"); setCreationDone(false); setCreationOpen(true); }}>Add workers</Button>
                  <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => { setControlPlaneId(cluster.control_plane_connection_id); inspectMutation.mutate(cluster.control_plane_connection_id); }} disabled={inspectMutation.isPending}>Check status</Button>
                  <Link href={`/dashboard/logging-monitoring/infrastructure?connection_id=${encodeURIComponent(cluster.control_plane_connection_id)}`} className={buttonVariants({variant:"outline",size:"sm",className:"min-h-11 sm:min-h-8"})}>Open monitor</Link>
                  <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => setOutputCluster(cluster)}><CheckCircle2 className="size-4" />Operation output</Button>
                </div>
                <DisclosureSection title="Cluster details" description="API address and member servers"><p className="break-all font-mono text-xs text-muted-foreground">{cluster.server_url}</p><div className="mt-3 flex flex-wrap gap-2">{cluster.nodes.map(node => <Badge key={node.id} variant={node.role === "server" ? "default" : "outline"}>{node.connection_name || node.host || node.role} / {node.role}</Badge>)}</div></DisclosureSection>
              </section>)}
            </CardContent>
          </Card>
          <DisclosureSection title="Server maintenance" description="Remove a Kubernetes installation from a saved server">
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
          </DisclosureSection>
      </div>
      <Dialog open={outputCluster !== null} onOpenChange={open => { if (!open) setOutputCluster(null); }}>
        <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader className="pr-8"><DialogTitle>Operation output</DialogTitle><DialogDescription>{outputCluster?.name} · Latest installer, worker, or status results.</DialogDescription></DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto">
            {inspectMutation.isPending && inspectMutation.variables === outputCluster?.control_plane_connection_id ? (<p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{initializeMutation.isPending ? "Installing the control plane…" : joinWorkersMutation.isPending ? "Joining worker servers…" : "Checking cluster status…"}</p>) : outputResult ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={outputResult.success ? "default" : "destructive"}>
                    {outputResult.success ? "ok" : "failed"}
                  </Badge>
                  <span className="text-sm font-medium text-foreground">
                    {outputResult.message || outputResult.error || "Cluster operation finished"}
                  </span>
                </div>
                {outputResult.hint ? (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                    {outputResult.hint}
                  </div>
                ) : null}
                {outputResult.cluster?.server_url ? (
                  <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">API server</div>
                    <div className="mt-1 break-all font-mono text-foreground">{outputResult.cluster.server_url}</div>
                  </div>
                ) : null}
                <DisclosureSection title="Operation logs" description="Detailed installer and status output">
                <pre className="max-h-[24rem] overflow-auto rounded-xl border border-border bg-background p-4 text-xs leading-relaxed text-muted-foreground scrollbar-thin">
                  {shortDetails(outputResult.details) || outputResult.error || "No detailed output was returned."}
                </pre>
                </DisclosureSection>
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 p-5 text-sm text-muted-foreground">
                No operation output recorded for this cluster. Use Check status to collect the latest results.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
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
