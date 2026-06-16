"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import Link from "next/link";
import api from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, GitBranch, Loader2, ShieldCheck, Trash2 } from "lucide-react";

type RuntimeTarget = "docker" | "kubernetes";

interface BuildEnvironmentInput {
  environmentId?: string;
}

interface Project {
  id: string;
  name: string;
  description: string;
  repo_url: string;
  execution_mode?: "local" | "remote_host";
  remote_runtime_type?: "docker" | "kubernetes";
  status: string;
  created_at: string;
  updated_at: string;
}

interface Deployment {
  id: string;
  status: string;
  version: string;
  commit_hash: string;
  environment_id?: string;
  environment_name?: string;
  branch?: string;
  commit_sha?: string;
  trigger_source?: string;
  ci_required?: boolean;
  ci_status?: string;
  runtime_url?: string;
  image_name?: string;
  created_at: string;
}

interface ProjectEnvironment {
  id: string;
  name: string;
  branch: string;
  auto_deploy: boolean;
  require_ci: boolean;
  cleanup_previous_on_success: boolean;
  current_deployment_id?: string;
  current_deployment_status?: string;
  current_deployment_version?: string;
  current_commit_sha?: string;
  current_runtime_url?: string;
}

interface DeploymentDetails {
  id: string;
  status: string;
  logs: string;
  image_name: string;
  updated_at: string;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "built") return "default";
  if (status === "failed" || status === "failed_ci") return "destructive";
  if (status === "running") return "default";
  if (status === "pending" || status === "queued" || status === "building" || status === "deploying") return "secondary";
  return "outline";
}

export default function ProjectDeploymentsPage() {
  const params = useParams();
  const rawId = params.id;
  const projectId = useMemo(() => (Array.isArray(rawId) ? rawId[0] : rawId), [rawId]);

  const queryClient = useQueryClient();
  const selectedEnvironmentStorageKey = projectId ? `StackPilot:selected-environment:${projectId}` : "";
  const [version, setVersion] = useState("v1.0.0");
  const [commitHash, setCommitHash] = useState("");
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string>("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>(() => {
    if (!selectedEnvironmentStorageKey || typeof window === "undefined") {
      return "";
    }
    return window.localStorage.getItem(selectedEnvironmentStorageKey) || "";
  });
  const [runtimeTargetByDeploymentId, setRuntimeTargetByDeploymentId] = useState<Record<string, RuntimeTarget>>({});

  const selectEnvironment = (environmentId: string) => {
    setSelectedEnvironmentId(environmentId);
    if (selectedEnvironmentStorageKey && typeof window !== "undefined") {
      window.localStorage.setItem(selectedEnvironmentStorageKey, environmentId);
    }
  };

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const res = await api.get(`/projects/${projectId}`);
      return res.data;
    },
    enabled: !!projectId,
  });

  const deploymentsQuery = useQuery({
    queryKey: ["project-deployments", projectId],
    queryFn: async () => {
      const res = await api.get(`/projects/${projectId}/deployments`);
      return res.data;
    },
    enabled: !!projectId,
  });

  const environmentsQuery = useQuery({
    queryKey: ["project-environments", projectId],
    queryFn: async () => {
      const res = await api.get(`/projects/${projectId}/environments`);
      return res.data;
    },
    enabled: !!projectId,
  });

  const createDeploymentMutation = useMutation({
    mutationFn: async ({ environmentId }: BuildEnvironmentInput = {}) => {
      const availableEnvironments: ProjectEnvironment[] = environmentsQuery.data?.environments || [];
      const candidateId = environmentId || selectedEnvironmentId;
      const selectedId = availableEnvironments.some((environment) => environment.id === candidateId)
        ? candidateId
        : availableEnvironments[0]?.id ?? "";
      const res = await api.post(`/projects/${projectId}/deployments`, {
        version,
        commit_hash: commitHash,
        environment_id: selectedId,
        trigger_source: "manual",
      });
      const deploymentId = res.data.deployment.id;
      await api.post(`/deployments/${deploymentId}/trigger`);
      return { ...res.data, deploymentId };
    },
    onSuccess: (data) => {
      toast.success("Deployment started. StackPilot will build and start the runtime automatically.");
      queryClient.invalidateQueries({ queryKey: ["project-deployments", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project-environments", projectId] });
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      queryClient.invalidateQueries({ queryKey: ["deployment-logs", data.deploymentId] });
      setSelectedDeploymentId(data.deploymentId);
      setCommitHash("");
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to create deployment"
          : "Failed to create deployment";
      toast.error(message);
    },
  });

  const triggerBuildMutation = useMutation({
    mutationFn: async (deploymentId: string) => {
      const res = await api.post(`/deployments/${deploymentId}/trigger`);
      return res.data;
    },
    onSuccess: (_data, deploymentId) => {
      toast.success("Rebuild started. If this environment uses local Docker, the runtime URL will refresh after the build.");
      queryClient.invalidateQueries({ queryKey: ["project-deployments", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project-environments", projectId] });
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      queryClient.invalidateQueries({ queryKey: ["deployment-logs", deploymentId] });
      setSelectedDeploymentId(deploymentId);
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Build failed"
          : "Build failed";
      toast.error(message);
      queryClient.invalidateQueries({ queryKey: ["project-deployments", projectId] });
    },
  });

  const deploymentLogsQuery = useQuery({
    queryKey: ["deployment-logs", selectedDeploymentId],
    queryFn: async () => {
      const res = await api.get(`/deployments/${selectedDeploymentId}/logs`);
      return res.data;
    },
    enabled: !!selectedDeploymentId,
    refetchInterval: 3000,
  });

  const deployRuntimeMutation = useMutation({
    mutationFn: async ({ deployment, runtimeType }: { deployment: Deployment; runtimeType: RuntimeTarget }) => {
      if (projectQuery.data?.project?.execution_mode === "remote_host") {
        return { message: "Remote-host deployments are deployed by the build worker when the remote runtime is selected." };
      }
      const endpoint =
        runtimeType === "kubernetes"
          ? `/deployments/${deployment.id}/kubernetes/deploy`
          : `/deployments/${deployment.id}/docker/deploy`;
      const payload =
        runtimeType === "kubernetes"
          ? { exposure_mode: "nodeport", runtime_scheme: "http" }
          : {};
      const res = await api.post(endpoint, payload);
      return res.data as { message?: string; runtime?: { runtime_url?: string } };
    },
    onSuccess: (data, { deployment }) => {
      toast.success(data.message || "Deployment runtime started");
      if (data.runtime?.runtime_url) {
        toast.success(`Runtime URL: ${data.runtime.runtime_url}`);
      }
      queryClient.invalidateQueries({ queryKey: ["project-deployments", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project-environments", projectId] });
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      queryClient.invalidateQueries({ queryKey: ["deployment-logs", deployment.id] });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Deploy failed"
          : "Deploy failed";
      toast.error(message);
    },
  });

  if (!projectId) {
    return <div className="text-destructive">Invalid project id.</div>;
  }

  if (projectQuery.isLoading || deploymentsQuery.isLoading || environmentsQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (projectQuery.error) {
    return <div className="text-destructive">Failed to load project details.</div>;
  }

  if (deploymentsQuery.error) {
    return <div className="text-destructive">Failed to load deployments.</div>;
  }

  if (environmentsQuery.error) {
    return <div className="text-destructive">Failed to load environments.</div>;
  }

  const project: Project = projectQuery.data?.project;
  const deployments: Deployment[] = deploymentsQuery.data?.deployments || [];
  const environments: ProjectEnvironment[] = environmentsQuery.data?.environments || [];
  const selectedEnvironmentExists = environments.some((environment) => environment.id === selectedEnvironmentId);
  const effectiveSelectedEnvironmentId = selectedEnvironmentExists ? selectedEnvironmentId : environments[0]?.id || "";
  const selectedEnvironment = environments.find((environment) => environment.id === effectiveSelectedEnvironmentId);
  const defaultRuntimeTarget: RuntimeTarget = project.remote_runtime_type === "kubernetes" ? "kubernetes" : "docker";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <Link href="/dashboard" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to projects
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
          <p className="text-muted-foreground">{project.description || "No description provided."}</p>
          {project.repo_url && (
            <a className="text-sm text-primary hover:underline" href={project.repo_url} target="_blank" rel="noopener noreferrer">
              {project.repo_url}
            </a>
          )}
        </div>
        <Badge variant={project.status === "active" ? "default" : "secondary"}>{project.status}</Badge>
      </div>

      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle>Deploy one environment</CardTitle>
          <CardDescription>
            Pick the environment you want to release. StackPilot builds that mapped branch and starts its runtime URL automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 md:grid-cols-[1fr,160px,1fr,auto]"
            onSubmit={(event) => {
              event.preventDefault();
              createDeploymentMutation.mutate({});
            }}
          >
            <div className="space-y-2">
              <Label>Environment</Label>
              <Select
                value={effectiveSelectedEnvironmentId}
                onValueChange={(value) => {
                  if (value) selectEnvironment(value);
                }}
              >
                <SelectTrigger className="h-10 w-full bg-muted/30">
                  <span className="truncate">
                    {selectedEnvironment ? `${selectedEnvironment.name} (${selectedEnvironment.branch})` : "Select environment"}
                  </span>
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {environments.map((environment) => (
                    <SelectItem key={environment.id} value={environment.id}>
                      <span>{environment.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{environment.branch}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="version">Version</Label>
              <Input
                id="version"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                placeholder="v1.0.0"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="commitHash">Commit SHA (optional)</Label>
              <Input
                id="commitHash"
                value={commitHash}
                onChange={(event) => setCommitHash(event.target.value)}
                placeholder="Leave empty to build branch head"
              />
            </div>
            <div className="flex items-end">
              <Button type="submit" disabled={createDeploymentMutation.isPending || environments.length === 0}>
                {createDeploymentMutation.isPending ? "Deploying..." : "Deploy Selected"}
              </Button>
            </div>
          </form>
          <p className="mt-3 text-sm text-muted-foreground">
            This deploys only the selected environment. Your selected environment is remembered in this browser.
          </p>
          <div className="mt-6 border-t pt-5">
            <div>
              <h2 className="text-base font-semibold">Branch environments</h2>
              <p className="text-sm text-muted-foreground">
                These cards show which Git branch belongs to each environment. Click one to choose the default target for manual deploys.
              </p>
            </div>
          {environments.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No environments are configured for this project.
            </div>
          ) : (
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {environments.map((environment) => {
                const isSelected = effectiveSelectedEnvironmentId === environment.id;
                return (
                  <button
                    key={environment.id}
                    type="button"
                    onClick={() => selectEnvironment(environment.id)}
                    className={`rounded-xl border p-4 text-left transition-colors ${
                      isSelected ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/40"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 font-semibold">
                          <GitBranch className="h-4 w-4" />
                          {environment.name}
                        </div>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">{environment.branch}</p>
                      </div>
                      {environment.current_deployment_status ? (
                        <Badge variant={statusVariant(environment.current_deployment_status)}>
                          {environment.current_deployment_status}
                        </Badge>
                      ) : (
                        <Badge variant="outline">no live build</Badge>
                      )}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2 text-xs">
                      <Badge variant={environment.auto_deploy ? "default" : "outline"}>
                        {environment.auto_deploy ? "auto deploy" : "manual"}
                      </Badge>
                      <Badge variant={environment.require_ci ? "secondary" : "outline"}>
                        <ShieldCheck className="h-3 w-3" />
                        {environment.require_ci ? "CI required" : "no CI gate"}
                      </Badge>
                      <Badge variant={environment.cleanup_previous_on_success ? "secondary" : "outline"}>
                        <Trash2 className="h-3 w-3" />
                        {environment.cleanup_previous_on_success ? "cleanup on success" : "keep previous"}
                      </Badge>
                    </div>
                    <div className="mt-4 space-y-1 text-xs text-muted-foreground">
                      <div>Current commit: {environment.current_commit_sha ? environment.current_commit_sha.slice(0, 12) : "-"}</div>
                      <div>Version: {environment.current_deployment_version || "-"}</div>
                      {environment.current_runtime_url && (
                        <a
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                          href={environment.current_runtime_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(event) => event.stopPropagation()}
                        >
                          Preview <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deployment History</CardTitle>
          <CardDescription>{deployments.length} total deployment records.</CardDescription>
        </CardHeader>
        <CardContent>
          {deployments.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No deployment records yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Commit</TableHead>
                  <TableHead>CI</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>Runtime</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-px whitespace-nowrap">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deployments.map((deployment) => {
                  const runtimeTarget = runtimeTargetByDeploymentId[deployment.id] || defaultRuntimeTarget;
                  const canDeployRuntime = project.execution_mode !== "remote_host" && deployment.status === "built";
                  return (
                  <TableRow key={deployment.id}>
                    <TableCell>
                      <Badge variant={statusVariant(deployment.status)}>{deployment.status}</Badge>
                    </TableCell>
                    <TableCell>{deployment.environment_name || "-"}</TableCell>
                    <TableCell className="font-mono text-xs">{deployment.branch || "-"}</TableCell>
                    <TableCell>{deployment.version || "-"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {(deployment.commit_sha || deployment.commit_hash || "").slice(0, 12) || "-"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={deployment.ci_status === "failed" ? "destructive" : deployment.ci_required ? "secondary" : "outline"}>
                        {deployment.ci_status || "not_required"}
                      </Badge>
                    </TableCell>
                    <TableCell>{deployment.trigger_source || "manual"}</TableCell>
                    <TableCell className="font-mono text-xs">{deployment.image_name || "-"}</TableCell>
                    <TableCell>
                      {deployment.runtime_url ? (
                        <a
                          href={deployment.runtime_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          Open <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>{new Date(deployment.created_at).toLocaleString()}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div className="w-max max-w-full overflow-x-auto">
                        <div className="flex w-max items-center gap-2 whitespace-nowrap pb-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          disabled={triggerBuildMutation.isPending || deployment.status === "building" || deployment.status === "queued"}
                          onClick={() => triggerBuildMutation.mutate(deployment.id)}
                        >
                          {deployment.status === "queued" ? "Queued..." : deployment.status === "building" ? "Building..." : "Rebuild"}
                        </Button>
                        <Select
                          value={runtimeTarget}
                          onValueChange={(value) => {
                            if (!value) return;
                            setRuntimeTargetByDeploymentId((current) => ({
                              ...current,
                              [deployment.id]: value as RuntimeTarget,
                            }));
                          }}
                          disabled={!canDeployRuntime || deployRuntimeMutation.isPending}
                        >
                          <SelectTrigger size="sm" className="w-32 shrink-0">
                            <SelectValue placeholder="Runtime" />
                          </SelectTrigger>
                          <SelectContent align="start" className="w-40">
                            <SelectItem value="docker">Docker</SelectItem>
                            <SelectItem value="kubernetes">Kubernetes</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          disabled={
                            deployRuntimeMutation.isPending ||
                            !canDeployRuntime
                          }
                          onClick={() => deployRuntimeMutation.mutate({ deployment, runtimeType: runtimeTarget })}
                        >
                          Start runtime
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="shrink-0"
                          onClick={() => setSelectedDeploymentId(deployment.id)}
                        >
                          Logs
                        </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {selectedDeploymentId && (
        <Card>
          <CardHeader>
            <CardTitle>Build Logs</CardTitle>
            <CardDescription>
              Deployment {selectedDeploymentId.slice(0, 12)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {deploymentLogsQuery.isLoading ? (
              <div className="flex items-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading logs...
              </div>
            ) : deploymentLogsQuery.error ? (
              <div className="text-sm text-destructive">Failed to load logs.</div>
            ) : (
              (() => {
                const details: DeploymentDetails | undefined = deploymentLogsQuery.data?.deployment;
                return (
                  <>
                    <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                      <span>Status: {details?.status || "-"}</span>
                      <span>Image: {details?.image_name || "-"}</span>
                    </div>
                    <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
                      {details?.logs || "No logs available yet."}
                    </pre>
                  </>
                );
              })()
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
