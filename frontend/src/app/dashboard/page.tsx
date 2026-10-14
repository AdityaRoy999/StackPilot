"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { NewProjectButton as CreateProjectDialog } from "@/components/projects/NewProjectButton";
import { ProjectInfoDialog } from "@/components/projects/ProjectInfoDialog";
import { ProjectStackIcons } from "@/components/projects/ProjectStack";
import { ProjectEditButton as EditProjectDialog } from "@/components/projects/ProjectEditButton";
import { DeleteProjectDialog } from "@/components/DeleteProjectDialog";
import { useWorkspace } from "@/context/WorkspaceContext";
import { Building2, ExternalLink, Code2, Loader2, Play, Clock, Server, Search, Boxes } from "@/lib/platform-icons";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { AppIcon } from "@/lib/custom-icons";
import { toast } from "sonner";
import { projectReleaseLabel, type ProjectRelease } from "@/lib/project-release";

interface Project {
  id: string;
  name: string;
  description: string;
  repo_url: string;
  source_type: "github" | "ssh" | "local" | "application";
  source_path?: string;
  organization_id?: string;
  organization_name?: string;
  application_template_id?: string;
  application_config?: {
    template_name?: string;
    image?: string;
  };
  env_var_count?: number;
  status: string;
  created_at: string;
  updated_at?: string;
  latest_deployment?: DeploymentListItem | null;
}

interface DeploymentListItem extends ProjectRelease {
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

function displayProjectName(project: Project) {
  if (project.source_type !== "application") return project.name;

  const legacyAiName = project.name.match(/^AI\s+(.+?)\s+\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
  if (!legacyAiName) return project.name;

  return legacyAiName[1]
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export default function DashboardPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { activeWorkspaceId, activeWorkspace, setActiveWorkspaceId, isLoading: workspaceLoading } = useWorkspace();
  const [deployingId, setDeployingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["projects", "dashboard-list"],
    queryFn: async () => {
      const res = await api.get<{ projects: Project[] }>("/projects");
      if (!Array.isArray(res.data.projects)) throw new Error("Invalid projects response");
      return res.data;
    },
    refetchInterval: 15000,
  });

  const legacyReleaseListing = !!data?.projects.some(project => project.latest_deployment === undefined);
  const releasesQuery = useQuery({
    queryKey: ["deployments"],
    queryFn: async () => (await api.get<DeploymentsCache>("/deployments")).data,
    refetchInterval: 10000,
    enabled: legacyReleaseListing,
  });

  const deployMutation = useMutation({
    mutationFn: async (project: Project) => {
      setDeployingId(project.id);
      const depRes = await api.post(`/projects/${project.id}/deployments`, { trigger_source: "manual" });
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

      const trigger = await api.post(`/deployments/${deploymentId}/trigger`);
      queryClient.setQueryData<DeploymentsCache>(["deployments"], (current) => {
        if (!Array.isArray(current?.deployments)) {
          return current;
        }

        return {
          ...current,
          deployments: current.deployments.map((item) =>
            item.id === deploymentId ? { ...item, status: trigger.data.status || "queued" } : item
          )
        };
      });
      return deploymentId;
    },
    onSuccess: () => {
      router.push("/dashboard/deployments");
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || "Deployment failed");
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onSettled: () => {
      setDeployingId(null);
    }
  });

  const allProjects = data?.projects || [];
  const projects = activeWorkspaceId
    ? allProjects.filter(project => project.organization_id === activeWorkspaceId)
    : allProjects;
  const filteredProjects = projects.filter(p => 
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.description?.toLowerCase().includes(searchTerm.toLowerCase())
  );
  const latestReleases = new Map<string, DeploymentListItem>();
  for (const project of projects) if (project.latest_deployment) latestReleases.set(project.id, project.latest_deployment);
  for (const release of releasesQuery.data?.deployments || []) {
    if (!release.project_id) continue;
    const current = latestReleases.get(release.project_id);
    if (!current || (release.created_at || "") > (current.created_at || "")) latestReleases.set(release.project_id, release);
  }
  const verifiedCount = projects.filter(project => projectReleaseLabel(latestReleases.get(project.id)).tone === "positive").length;
  const failedCount = projects.filter(project => projectReleaseLabel(latestReleases.get(project.id)).tone === "negative").length;
  const releaseStatusLoading = legacyReleaseListing && releasesQuery.isPending;
  const releaseStatusError = isError || (legacyReleaseListing && releasesQuery.isError);

  if (isLoading || workspaceLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <AppIcon name="loader2" fallback={Loader2} className="h-8 w-8 animate-spin text-primary"  />
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-6xl mx-auto space-y-6 sm:space-y-8">
      <div className="workspace-page-heading flex flex-col lg:flex-row lg:items-end justify-between gap-5">
        <div>
          <p className="workspace-section-label mb-3">Application workspace</p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Projects</h1>
          <p className="text-muted-foreground mt-1">
            Your source, releases, and runtime. All in one place.
          </p>
          {activeWorkspace && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>Workspace: {activeWorkspace.name}</span>
              <Button variant="ghost" size="sm" onClick={() => setActiveWorkspaceId(null)}>View all projects</Button>
            </div>
          )}
        </div>
        <div className="flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-center lg:w-auto">
          <div className="relative min-w-0 flex-1 lg:w-64">
            <AppIcon name="search" fallback={Search} size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="Search projects..." 
              aria-label="Search projects"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-11 pl-10 bg-card sm:h-9"
            />
          </div>
          <CreateProjectDialog />
        </div>
      </div>

      <div className="workspace-stats" aria-label="Project summary">
        <div className="workspace-stat"><span className="workspace-section-label">Projects</span><span className="workspace-stat-number">{projects.length.toString().padStart(2, "0")}</span></div>
        <div className="workspace-stat"><span className="workspace-section-label">Verified releases</span><span className="workspace-stat-number">{releaseStatusLoading || releaseStatusError ? "—" : verifiedCount.toString().padStart(2, "0")}</span></div>
        <div className="workspace-stat"><span className="workspace-section-label">Needs attention</span><span className="workspace-stat-number">{releaseStatusLoading || releaseStatusError ? "—" : failedCount.toString().padStart(2, "0")}</span></div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{searchTerm ? "Search results" : "Your projects"} <span className="ml-1 font-mono text-xs text-muted-foreground">({filteredProjects.length})</span></h2>
        <Link href="/dashboard/deployments" className="text-xs text-muted-foreground hover:text-foreground">Release history <span aria-hidden="true">↗</span></Link>
      </div>

      {isError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-destructive/40 bg-card p-5">
          <div>
            <p className="font-medium">Could not refresh your projects</p>
            <p className="text-sm text-muted-foreground">The project request failed. Try loading it again.</p>
          </div>
          <Button variant="outline" onClick={() => void refetch()}>Retry</Button>
        </div>
      )}
      {!data && isError ? null : projects.length === 0 ? (
        <Card className="border-dashed border-border/80 ring-0 flex flex-col items-center justify-center px-4 py-12 text-center sm:py-20 bg-card">
          <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4">
            <AppIcon name="server" fallback={Server} size={24} className="w-6 h-6 text-muted-foreground" />
          </div>
          <CardTitle className="text-foreground">{activeWorkspace ? `No projects in ${activeWorkspace.name}` : "No projects yet"}</CardTitle>
          <CardDescription className="mb-6">
            {allProjects.length > 0
              ? `${allProjects.length} project${allProjects.length === 1 ? " is" : "s are"} available in your other workspaces.`
              : "Create your first project to start deploying."}
          </CardDescription>
          {allProjects.length > 0
            ? <Button onClick={() => setActiveWorkspaceId(null)}>View all projects</Button>
            : <CreateProjectDialog />}
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredProjects.map((project) => {
            const release = latestReleases.get(project.id);
            const summary = projectReleaseLabel(release, releaseStatusError);
            return (
            <Card key={project.id} className="group min-w-0 flex flex-col border-border transition-colors hover:border-foreground/30 bg-card overflow-hidden">
              <CardHeader className="pb-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <span className="project-source-glyph"><Code2 className="h-4 w-4" /></span>
                  <div className="flex items-center gap-1"><ProjectInfoDialog project={project} /><EditProjectDialog project={project} /><DeleteProjectDialog projectId={project.id} projectName={project.name} /></div>
                </div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 basis-32 space-y-1.5">
                    <CardTitle className="break-words [overflow-wrap:anywhere] text-lg font-semibold text-foreground">
                    <Link prefetch={false} href={`/dashboard/projects/${project.id}`} className="hover:underline underline-offset-4">{displayProjectName(project)}</Link>
                    </CardTitle>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="flex items-center">
                        <AppIcon name="clock" fallback={Clock} size={14} className="w-3.5 h-3.5 mr-1" />
                        {new Date(project.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Badge variant="outline" className={cn("text-[10px] font-normal", summary.tone === "positive" && "text-emerald-700 dark:text-emerald-400", summary.tone === "negative" && "text-destructive", summary.tone === "pending" && "text-amber-700 dark:text-amber-400")}>
                      <span className={cn("mr-1.5 h-1.5 w-1.5 rounded-full", summary.tone === "positive" ? "bg-emerald-500" : summary.tone === "negative" ? "bg-destructive" : "bg-muted-foreground")} />
                      {releaseStatusLoading ? "Loading status" : summary.label}
                    </Badge>
                  </div>
                </div>
                <CardDescription className="line-clamp-2 text-muted-foreground text-sm mt-2">
                  {project.description || (project.source_type === "application" ? "Managed application" : "Source project")}
                </CardDescription>
              </CardHeader>
              
              <CardContent className="flex-1">
                <div className="mb-3"><ProjectStackIcons projectId={project.id} updatedAt={project.updated_at} /></div>
                {projectSourceLabel(project) && (
                  <div className="flex items-center text-[11px] font-mono text-muted-foreground bg-muted/50 p-2 rounded border border-border/50 overflow-hidden">
                    {project.source_type === "application" ? (
                      <AppIcon name="boxes" fallback={Boxes} size={14} className="h-3.5 w-3.5 mr-2 text-muted-foreground/70 flex-shrink-0" />
                    ) : (
                      <AppIcon name="code-2" fallback={Code2} size={14} className="h-3.5 w-3.5 mr-2 text-muted-foreground/70 flex-shrink-0" />
                    )}
                    <span className="truncate">{projectSourceLabel(project)}</span>
                  </div>
                )}
              </CardContent>
              <CardFooter className="bg-muted/40 p-4 border-t border-border/60 flex flex-wrap items-center justify-between gap-2">
                <Link 
                  href={`/dashboard/projects/${project.id}`}
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "sm" }),
                    "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <AppIcon name="external-link" fallback={ExternalLink} size={16} className="h-4 w-4 mr-2" />
                  Details
                </Link>
                
                <Button 
                  size="sm" 
                  onClick={() => deployMutation.mutate(project)}
                  disabled={deployMutation.isPending || !projectCanDeploy(project)}
                >
                  {deployingId === project.id ? (
                    <AppIcon name="loader2" fallback={Loader2} className="w-4 h-4 mr-2 animate-spin"  />
                  ) : (
                    <AppIcon name="play" fallback={Play} size={14} className="w-3.5 h-3.5 mr-2 fill-current" />
                  )}
                  {projectCanDeploy(project) ? "Deploy" : "Connect Source"}
                </Button>
              </CardFooter>
            </Card>
          );})}
        </div>
      )}
    </div>
  );
}
  const projectSourceLabel = (project: Project) => {
    if (project.source_type === "application") {
      return project.application_config?.template_name || project.application_template_id || "Application";
    }
    return project.source_type === "ssh" ? project.source_path : project.source_type === "local" ? project.source_path : project.repo_url;
  };

  const projectCanDeploy = (project: Project) => {
    if (project.source_type === "application") return Boolean(project.application_template_id);
    return project.source_type === "github" ? Boolean(project.repo_url) : Boolean(project.source_path);
  };
