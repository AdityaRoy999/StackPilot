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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";

interface Project {
  id: string;
  name: string;
  description: string;
  repo_url: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface Deployment {
  id: string;
  status: string;
  version: string;
  commit_hash: string;
  image_name?: string;
  created_at: string;
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
  if (status === "failed") return "destructive";
  if (status === "running") return "default";
  if (status === "pending" || status === "queued" || status === "building" || status === "deploying") return "secondary";
  return "outline";
}

export default function ProjectDeploymentsPage() {
  const params = useParams();
  const rawId = params.id;
  const projectId = useMemo(() => (Array.isArray(rawId) ? rawId[0] : rawId), [rawId]);

  const queryClient = useQueryClient();
  const [version, setVersion] = useState("v1.0.0");
  const [commitHash, setCommitHash] = useState("");
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string>("");

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

  const createDeploymentMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post(`/projects/${projectId}/deployments`, {
        version,
        commit_hash: commitHash,
      });
      const deploymentId = res.data.deployment.id;
      await api.post(`/deployments/${deploymentId}/trigger`);
      return { ...res.data, deploymentId };
    },
    onSuccess: (data) => {
      toast.success("Build started");
      queryClient.invalidateQueries({ queryKey: ["project-deployments", projectId] });
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
      toast.success("Build started");
      queryClient.invalidateQueries({ queryKey: ["project-deployments", projectId] });
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

  if (!projectId) {
    return <div className="text-destructive">Invalid project id.</div>;
  }

  if (projectQuery.isLoading || deploymentsQuery.isLoading) {
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

  const project: Project = projectQuery.data?.project;
  const deployments: Deployment[] = deploymentsQuery.data?.deployments || [];

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

      <Card>
        <CardHeader>
          <CardTitle>Create Deployment Record</CardTitle>
          <CardDescription>
            This creates a deployment entry and starts the Docker image build.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 md:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              createDeploymentMutation.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="version">Version</Label>
              <Input
                id="version"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                placeholder="v1.0.0"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="commitHash">Commit Hash (Optional)</Label>
              <Input
                id="commitHash"
                value={commitHash}
                onChange={(event) => setCommitHash(event.target.value)}
                placeholder="a1b2c3d4e5f6"
              />
            </div>
            <div className="md:col-span-3">
              <Button type="submit" disabled={createDeploymentMutation.isPending}>
                {createDeploymentMutation.isPending ? "Starting build..." : "Create and Start Build"}
              </Button>
            </div>
          </form>
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
                  <TableHead>Version</TableHead>
                  <TableHead>Commit</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deployments.map((deployment) => (
                  <TableRow key={deployment.id}>
                    <TableCell>
                      <Badge variant={statusVariant(deployment.status)}>{deployment.status}</Badge>
                    </TableCell>
                    <TableCell>{deployment.version || "-"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {deployment.commit_hash ? deployment.commit_hash.slice(0, 12) : "-"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{deployment.image_name || "-"}</TableCell>
                    <TableCell>{new Date(deployment.created_at).toLocaleString()}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={triggerBuildMutation.isPending || deployment.status === "building" || deployment.status === "queued"}
                          onClick={() => triggerBuildMutation.mutate(deployment.id)}
                        >
                          {deployment.status === "queued" ? "Queued..." : deployment.status === "building" ? "Building..." : "Build"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelectedDeploymentId(deployment.id)}
                        >
                          Logs
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
