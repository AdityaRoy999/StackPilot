"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CreateProjectDialog } from "@/components/CreateProjectDialog";
import { EditProjectDialog } from "@/components/EditProjectDialog";
import { DeleteProjectDialog } from "@/components/DeleteProjectDialog";
import { ExternalLink, Code2, Loader2, Play, CheckCircle, Clock, Server, Search } from "lucide-react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Input } from "@/components/ui/input";

interface Project {
  id: string;
  name: string;
  description: string;
  repo_url: string;
  source_type: "github" | "ssh" | "local";
  source_path?: string;
  env_var_count?: number;
  status: string;
  created_at: string;
}

interface DeploymentListItem {
  id: string;
  project_id?: string;
  project_name?: string;
  status?: string;
  version?: string;
  image_name?: string;
  runtime_provider?: string;
  runtime_url?: string;
  runtime_exposure?: string;
  remote_container_name?: string;
  k8s_namespace?: string;
  k8s_deployment_name?: string;
  k8s_service_name?: string;
  k8s_ingress_name?: string;
  desired_replicas?: number;
  created_at?: string;
}

interface DeploymentsCache {
  deployments?: DeploymentListItem[];
  count?: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [deployingId, setDeployingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const res = await api.get("/projects");
      return res.data;
    },
    refetchInterval: 5000, // Poll every 5 seconds
  });

  const deployMutation = useMutation({
    mutationFn: async (project: Project) => {
      setDeployingId(project.id);
      const depRes = await api.post(`/projects/${project.id}/deployments`, {
        version: "v1.0." + Math.floor(Math.random() * 100),
        commit_hash: "manual-trigger"
      });
      const deployment = depRes.data.deployment as DeploymentListItem;
      const deploymentId = deployment.id;

      queryClient.setQueryData<DeploymentsCache>(["deployments"], (current) => {
        const existing = Array.isArray(current?.deployments) ? current.deployments : [];
        if (existing.some((item) => item.id === deploymentId)) {
          return current;
        }

        return {
          ...(current || {}),
          deployments: [
            {
              ...deployment,
              project_id: project.id,
              project_name: project.name,
              status: deployment.status || "pending",
              version: deployment.version || "manual",
              image_name: deployment.image_name || "",
              runtime_provider: deployment.runtime_provider || "",
              runtime_url: deployment.runtime_url || "",
              runtime_exposure: deployment.runtime_exposure || "",
              remote_container_name: deployment.remote_container_name || "",
              k8s_namespace: deployment.k8s_namespace || "",
              k8s_deployment_name: deployment.k8s_deployment_name || "",
              k8s_service_name: deployment.k8s_service_name || "",
              k8s_ingress_name: deployment.k8s_ingress_name || "",
              desired_replicas: deployment.desired_replicas || 1,
              created_at: deployment.created_at || new Date().toISOString()
            },
            ...existing
          ],
          count: (current?.count ?? existing.length) + 1
        };
      });

      await api.post(`/deployments/${deploymentId}/trigger`);
      queryClient.setQueryData<DeploymentsCache>(["deployments"], (current) => {
        if (!Array.isArray(current?.deployments)) {
          return current;
        }

        return {
          ...current,
          deployments: current.deployments.map((item) =>
            item.id === deploymentId ? { ...item, status: "queued" } : item
          )
        };
      });
      return deploymentId;
    },
    onSuccess: () => {
      router.push("/dashboard/deployments");
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
    },
    onSettled: () => {
      setDeployingId(null);
    }
  });

  const projects: Project[] = data?.projects || [];
  const filteredProjects = projects.filter(p => 
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.description?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Projects</h1>
          <p className="text-muted-foreground mt-1">
            Build and manage your autonomous application deployments.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="Search projects..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 bg-card"
            />
          </div>
          <CreateProjectDialog />
        </div>
      </div>

      {projects.length === 0 ? (
        <Card className="border-dashed border-border/80 ring-0 flex flex-col items-center justify-center py-20 bg-card">
          <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4">
            <Server className="w-6 h-6 text-muted-foreground" />
          </div>
          <CardTitle className="text-foreground">No projects yet</CardTitle>
          <CardDescription className="mb-6">Create your first project to start deploying.</CardDescription>
          <CreateProjectDialog />
        </Card>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {filteredProjects.map((project) => (
            <Card key={project.id} className="group flex flex-col border-border/70 hover:ring-1 hover:ring-primary/30 transition-all bg-card overflow-hidden">
              <CardHeader className="pb-4">
                <div className="flex items-start justify-between">
                  <div className="space-y-1.5">
                    <CardTitle className="text-lg font-bold text-foreground group-hover:text-primary transition-colors">
                      {project.name}
                    </CardTitle>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <Clock className="w-3.5 h-3.5 mr-1" />
                      {new Date(project.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1">
                    <EditProjectDialog project={project} />
                    <DeleteProjectDialog projectId={project.id} projectName={project.name} />
                  </div>
                    <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">
                      <CheckCircle className="w-3 h-3 mr-1" />
                      Active
                    </Badge>
                  </div>
                </div>
                <CardDescription className="line-clamp-2 text-muted-foreground text-sm mt-2">
                  {project.description || "No description provided."}
                </CardDescription>
              </CardHeader>
              
              <CardContent className="flex-1">
                {(project.repo_url || project.source_path) && (
                  <div className="flex items-center text-[11px] font-mono text-muted-foreground bg-muted/50 p-2 rounded border border-border/50 overflow-hidden">
                    <Code2 className="h-3 w-3 mr-2 text-muted-foreground/70 flex-shrink-0" />
                    <span className="truncate">{project.source_type === "ssh" ? project.source_path : project.repo_url}</span>
                  </div>
                )}
                {(project.env_var_count ?? 0) > 0 && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    {(project.env_var_count ?? 0)} environment variable{(project.env_var_count ?? 0) === 1 ? "" : "s"} configured
                  </div>
                )}
              </CardContent>
              <CardFooter className="bg-muted/40 p-4 border-t border-border/60 flex items-center justify-between">
                <Link 
                  href={`/dashboard/projects/${project.id}`}
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "sm" }),
                    "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Details
                </Link>
                
                <Button 
                  size="sm" 
                  onClick={() => deployMutation.mutate(project)}
                  disabled={deployingId === project.id || (project.source_type === "github" ? !project.repo_url : !project.source_path)}
                >
                  {deployingId === project.id ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 mr-2 fill-current" />
                  )}
                  {(project.source_type === "github" ? project.repo_url : project.source_path) ? "Deploy" : "Connect Source"}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
