"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { CheckCircle2, ChevronRight, FolderTree, GitBranch, HardDrive, Link2, RefreshCw, Server, Settings2 } from "lucide-react";
import { GitHubAuthButton } from "@/components/auth/GitHubAuthButton";
import { ProjectEnvEditor, ProjectEnvVar } from "@/components/ProjectEnvEditor";
import { cn } from "@/lib/utils";

interface GitHubRepo {
  id: number;
  full_name: string;
  clone_url: string;
  private: boolean;
  description: string;
}

interface GitHubReposResponse {
  repositories?: GitHubRepo[];
  warnings?: string[];
}

interface MeResponse {
  user: {
    github_connected: boolean;
    github_username: string;
    github_oauth_available: boolean;
  };
}

interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  repo_url: string;
  source_type?: "github" | "ssh" | "local";
  source_path?: string;
  execution_mode?: "local" | "remote_host";
  remote_runtime_type?: "docker" | "kubernetes";
  remote_k8s_exposure?: "nodeport" | "ingress" | "loadbalancer" | "clusterip";
  runtime_scheme?: "http" | "https";
  local_https_enabled?: boolean;
  remote_connection_id?: string;
  github_pat_configured?: boolean;
}

interface ProjectDetails extends ProjectSummary {
  ssh_connection_id?: string;
  env_vars?: ProjectEnvVar[];
}

interface SshConnection {
  id: string;
  name: string;
  connection_type: "ssh" | "tailscale" | "headscale";
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "key" | "tailscale" | "headscale";
}

interface SshConnectionsResponse {
  connections: SshConnection[];
}

interface SshBrowseEntry {
  name: string;
  directory: boolean;
  path: string;
}

interface SshBrowseResponse {
  path: string;
  entries: SshBrowseEntry[];
}

interface LocalBrowseEntry {
  name: string;
  directory: boolean;
  path: string;
}

interface LocalBrowseResponse {
  path: string;
  roots: { name: string; path: string }[];
  entries: LocalBrowseEntry[];
}

interface EditProjectDialogProps {
  project: ProjectSummary;
}

export function EditProjectDialog({ project }: EditProjectDialogProps) {
  const [open, setOpen] = useState(false);

  const queryClient = useQueryClient();
  const projectQuery = useQuery({
    queryKey: ["project", project.id, "edit"],
    queryFn: async () => {
      const res = await api.get(`/projects/${project.id}`);
      return res.data.project as ProjectDetails;
    },
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
            <Settings2 className="h-4 w-4" />
            <span className="sr-only">Edit project</span>
          </Button>
        }
      />
      <DialogContent className="!flex h-[min(84vh,840px)] !w-[min(94vw,920px)] !max-w-[920px] flex-col overflow-hidden rounded-2xl p-0">
        <DialogHeader className="shrink-0 border-b border-border p-6">
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-primary" />
            Project Settings
          </DialogTitle>
          <DialogDescription>
            Update project details and environment variables. Env changes automatically trigger a rebuild when a previous deployment exists.
          </DialogDescription>
        </DialogHeader>

        {projectQuery.isLoading ? (
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin p-6">
            <div className="flex items-center text-sm text-muted-foreground">
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              Loading project settings...
            </div>
          </div>
        ) : projectQuery.data ? (
          <EditProjectForm
            project={projectQuery.data}
            onCancel={() => setOpen(false)}
            onSaved={() => {
              queryClient.invalidateQueries({ queryKey: ["projects"] });
              queryClient.invalidateQueries({ queryKey: ["project", project.id] });
              queryClient.invalidateQueries({ queryKey: ["project-deployments", project.id] });
              queryClient.invalidateQueries({ queryKey: ["deployments"] });
              setOpen(false);
            }}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6 text-sm text-destructive">
            Failed to load project settings.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditProjectForm({
  project,
  onCancel,
  onSaved,
}: {
  project: ProjectDetails;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description || "");
  const [repoUrl, setRepoUrl] = useState(project.repo_url || "");
  const [sourcePath, setSourcePath] = useState(project.source_path || "");
  const [githubPat, setGithubPat] = useState("");
  const [envVars, setEnvVars] = useState<ProjectEnvVar[]>(project.env_vars || []);
  const [remoteRuntimeType, setRemoteRuntimeType] = useState<"docker" | "kubernetes">(
    project.remote_runtime_type || "docker"
  );
  const [remoteK8sExposure, setRemoteK8sExposure] = useState<"nodeport" | "ingress">(
    project.remote_k8s_exposure === "ingress" ? "ingress" : "nodeport"
  );
  const [runtimeScheme, setRuntimeScheme] = useState<"http" | "https">(
    project.runtime_scheme === "https" ? "https" : "http"
  );
  const [localHttpsEnabled, setLocalHttpsEnabled] = useState(Boolean(project.local_https_enabled));
  const [remoteBrowsePath, setRemoteBrowsePath] = useState(project.source_path || "");
  const [remoteEntries, setRemoteEntries] = useState<SshBrowseEntry[]>([]);
  const [localBrowsePath, setLocalBrowsePath] = useState(project.source_path || "");
  const [localRoots, setLocalRoots] = useState<LocalBrowseResponse["roots"]>([]);
  const [localEntries, setLocalEntries] = useState<LocalBrowseEntry[]>([]);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const sourceType = project.source_type || "github";
  const sourceLocationLocked = sourceType !== "github";
  const effectiveRemoteConnectionId = project.remote_connection_id || project.ssh_connection_id || "";
  const showRemoteSourceControls = project.execution_mode === "remote_host" || sourceType === "ssh";
  const selectedRemoteConnectionId = sourceType === "ssh" ? project.ssh_connection_id || "" : effectiveRemoteConnectionId;
  const remoteHttpsAllowed = remoteRuntimeType === "kubernetes" && remoteK8sExposure === "ingress";
  const effectiveRuntimeScheme =
    project.execution_mode === "remote_host"
      ? remoteHttpsAllowed
        ? runtimeScheme
        : "http"
      : localHttpsEnabled
      ? "https"
      : "http";
const segmentedTabsListClass = "grid h-10 w-full grid-cols-2 rounded-xl border border-border bg-muted/30 p-1";
const segmentedButtonClass =
  "h-8 justify-center rounded-lg border border-transparent px-3 text-sm font-semibold text-muted-foreground hover:bg-accent/60 hover:text-foreground";
const segmentedButtonActiveClass =
  "!border-black !bg-black !text-white hover:!bg-black hover:!text-white dark:!border-white dark:!bg-white dark:!text-black dark:hover:!bg-white dark:hover:!text-black";

  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await api.get("/auth/me");
      return res.data as MeResponse;
    },
    enabled: sourceType === "github",
  });

  const githubConnected = Boolean(meQuery.data?.user?.github_connected);
  const githubUsername = meQuery.data?.user?.github_username || "";
  const githubOAuthAvailable = Boolean(meQuery.data?.user?.github_oauth_available);

  const sshConnectionsQuery = useQuery({
    queryKey: ["ssh-connections"],
    queryFn: async () => {
      const res = await api.get("/ssh/connections");
      return res.data as SshConnectionsResponse;
    },
    enabled: showRemoteSourceControls,
  });
  const activeSshConnection = useMemo(
    () =>
      (sshConnectionsQuery.data?.connections || []).find(
        (connection) => connection.id === selectedRemoteConnectionId
      ) ?? null,
    [selectedRemoteConnectionId, sshConnectionsQuery.data?.connections]
  );

  const browseRemoteMutation = useMutation({
    mutationFn: async (path: string) => {
      const res = await api.post(`/ssh/connections/${selectedRemoteConnectionId}/browse`, { path });
      return res.data as SshBrowseResponse;
    },
    onSuccess: (data) => {
      setRemoteBrowsePath(data.path);
      setRemoteEntries(data.entries);
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Unable to browse remote path"
          : "Unable to browse remote path";
      toast.error(message);
    },
  });

  const browseLocalMutation = useMutation({
    mutationFn: async (path: string) => {
      const res = await api.post("/local/sources/browse", { path });
      return res.data as LocalBrowseResponse;
    },
    onSuccess: (data) => {
      setLocalBrowsePath(data.path || "");
      setLocalRoots(data.roots || []);
      setLocalEntries(data.entries || []);
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Unable to browse local source path"
          : "Unable to browse local source path";
      toast.error(message);
    },
  });

  const fetchReposMutation = useMutation({
    mutationFn: async (pat?: string) => {
      const res = pat ? await api.post("/github/repos", { pat }) : await api.get("/github/repos");
      const data = res.data as GitHubRepo[] | GitHubReposResponse;
      return Array.isArray(data)
        ? { repositories: data, warnings: [] }
        : { repositories: data.repositories || [], warnings: data.warnings || [] };
    },
    onSuccess: (data) => {
      setRepos(data.repositories);
      toast.success(`Fetched ${data.repositories.length} repositories`);
      data.warnings.forEach((warning) => toast.warning(warning));
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Unable to load repositories"
          : "Unable to load repositories";
      toast.error(message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await api.put(`/projects/${project.id}`, {
        name,
        description,
        repo_url: repoUrl,
        source_path: sourcePath,
        github_pat: githubPat,
        env_vars: envVars,
        remote_runtime_type: project.execution_mode === "remote_host" ? remoteRuntimeType : "docker",
        remote_k8s_exposure:
          project.execution_mode === "remote_host" && remoteRuntimeType === "kubernetes"
            ? effectiveRuntimeScheme === "https"
              ? "ingress"
              : remoteK8sExposure
            : "nodeport",
        runtime_scheme: effectiveRuntimeScheme,
        local_https_enabled: project.execution_mode !== "remote_host" && localHttpsEnabled,
      });
      return res.data as { message?: string };
    },
    onSuccess: (data) => {
      toast.success(data.message || "Project updated successfully");
      onSaved();
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to update project"
          : "Failed to update project";
      toast.error(message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) {
      toast.error("Project name is required");
      return;
    }
    updateMutation.mutate();
  };

  const handleFetchRepos = () => {
    if (!githubPat) {
      toast.error("Please enter a GitHub PAT first");
      return;
    }
    fetchReposMutation.mutate(githubPat);
  };

  const handleLoadConnectedRepos = () => {
    fetchReposMutation.mutate(undefined);
  };

  const handleRepoSelect = (repo: GitHubRepo) => {
    setRepoUrl(repo.clone_url);
    if (!name) setName(repo.full_name.split("/")[1]);
    if (!description) setDescription(repo.description || "");
  };

  useEffect(() => {
    if (sourceType === "github" && githubConnected && repos.length === 0 && fetchReposMutation.status === "idle") {
      fetchReposMutation.mutate(undefined);
    }
  }, [sourceType, githubConnected, repos.length, fetchReposMutation.status, fetchReposMutation]);

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin p-6 pb-4">
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <Label htmlFor="edit-name" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Project Name
              </Label>
              <Input
                id="edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-awesome-app"
                required
                className="bg-muted/40"
              />
            </div>

            <div className="min-w-0 space-y-2">
              <Label htmlFor="edit-description" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Description
              </Label>
              <Input
                id="edit-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A short description..."
                className="bg-muted/40"
              />
            </div>

            {sourceType === "github" ? (
              <>
                <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4 md:col-span-2">
                  <div className="space-y-3 rounded-xl border border-border bg-muted/25 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          GitHub Account
                        </Label>
                        <p className="text-sm text-foreground">
                          {githubConnected
                            ? `Signed in as ${githubUsername || "GitHub user"}`
                            : "Use your GitHub connection to load repositories automatically."}
                        </p>
                      </div>
                      {githubConnected && (
                        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Signed in
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {githubConnected ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleLoadConnectedRepos}
                          disabled={fetchReposMutation.isPending}
                        >
                          {fetchReposMutation.isPending ? (
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <GitBranch className="mr-2 h-4 w-4" />
                          )}
                          Load Repositories
                        </Button>
                      ) : githubOAuthAvailable ? (
                        <GitHubAuthButton mode="connect" enabled className="rounded-lg" />
                      ) : (
                        <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
                          <Link2 className="h-3.5 w-3.5" />
                          GitHub OAuth not configured
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    <div className="h-px flex-1 bg-border" />
                    <span>or</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>

                  {repos.length > 0 && (
                    <div className="max-h-[160px] divide-y divide-border/60 overflow-y-auto rounded-lg border border-border bg-muted/30 scrollbar-thin">
                      {repos.map((repo) => (
                        <button
                          key={repo.id}
                          type="button"
                          onClick={() => handleRepoSelect(repo)}
                          className={cn(
                            "flex w-full items-start justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-accent",
                            repoUrl === repo.clone_url && "bg-accent"
                          )}
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">{repo.full_name}</div>
                            <div className="truncate text-xs text-muted-foreground">
                              {repo.description || (repo.private ? "Private repository" : "Public repository")}
                            </div>
                          </div>
                          <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                            {repo.private ? "Private" : "Public"}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="min-w-0 space-y-2">
                  <Label htmlFor="edit-repoUrl" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Repository URL
                  </Label>
                  <Input
                    id="edit-repoUrl"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="https://github.com/user/repo"
                    className="bg-muted/40"
                  />
                </div>

                <div className="min-w-0 space-y-2">
                  <Label htmlFor="edit-githubPat" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    GitHub Personal Access Token (Optional)
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="edit-githubPat"
                      type="password"
                      value={githubPat}
                      onChange={(e) => setGithubPat(e.target.value)}
                      placeholder={project.github_pat_configured ? "Leave blank to keep saved token" : "ghp_xxxxxxxxxxxx"}
                      autoComplete="off"
                      className="bg-muted/40"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleFetchRepos}
                      disabled={fetchReposMutation.isPending}
                      className="shrink-0"
                    >
                      {fetchReposMutation.isPending ? (
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      ) : (
                        <GitBranch className="mr-2 h-4 w-4" />
                      )}
                      Fetch
                    </Button>
                  </div>
                </div>

                {project.execution_mode === "remote_host" && (
                  <div className="min-w-0 space-y-3 md:col-span-2">
                    <div className="rounded-xl border border-border bg-muted/20 p-4">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Server Connection
                          </Label>
                          <p className="mt-1 text-sm text-foreground">
                            {activeSshConnection
                              ? `${activeSshConnection.name} - ${activeSshConnection.username}@${activeSshConnection.host}${activeSshConnection.connection_type === "ssh" ? `:${activeSshConnection.port}` : ""}`
                              : effectiveRemoteConnectionId || "Saved connection"}
                          </p>
                        </div>
                        {activeSshConnection && (
                          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-500">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Linked
                          </span>
                        )}
                      </div>
                      <Label htmlFor="edit-remoteWorkspace" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Remote Workspace Path
                      </Label>
                      <div className="mt-2 flex gap-2">
                        <Input
                          id="edit-remoteWorkspace"
                          value={sourcePath}
                          onChange={(e) => setSourcePath(e.target.value)}
                          placeholder="/root/aids-workspaces"
                          className="bg-muted/40"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => browseRemoteMutation.mutate(remoteBrowsePath || sourcePath || "/")}
                          disabled={!selectedRemoteConnectionId || browseRemoteMutation.isPending}
                        >
                          {browseRemoteMutation.isPending ? (
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <FolderTree className="mr-2 h-4 w-4" />
                          )}
                          Browse
                        </Button>
                      </div>
                      {remoteEntries.length > 0 && (
                        <div className="mt-3 max-h-[180px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                          {remoteEntries.map((entry) => (
                            <button
                              key={entry.path}
                              type="button"
                              onClick={() => {
                                setSourcePath(entry.path);
                                setRemoteBrowsePath(entry.path);
                                if (entry.directory) browseRemoteMutation.mutate(entry.path);
                              }}
                              className="flex w-full items-center justify-between border-b border-border/60 px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent"
                            >
                              <span className="truncate text-foreground">{entry.name}</span>
                              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="min-w-0 space-y-2 md:col-span-2">
                <Label htmlFor="edit-sourcePath" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {sourceType === "local" ? "Local Project Path" : "Remote Project Path"}
                </Label>
                {sourceType === "ssh" && (
                  <div className="mb-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                    SSH/VPS connection:{" "}
                    <span className="text-foreground">
                      {activeSshConnection
                        ? `${activeSshConnection.name} - ${activeSshConnection.username}@${activeSshConnection.host}${activeSshConnection.connection_type === "ssh" ? `:${activeSshConnection.port}` : ""}`
                        : project.ssh_connection_id || "Saved connection"}
                    </span>
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    id="edit-sourcePath"
                    value={sourcePath}
                    onChange={(e) => setSourcePath(e.target.value)}
                    placeholder={sourceType === "local" ? "/app/local-projects/my-project" : "/home/user/apps/my-project"}
                    className="bg-muted/40"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      if (sourceType === "local") {
                        browseLocalMutation.mutate(localBrowsePath || sourcePath || "");
                      } else {
                        browseRemoteMutation.mutate(remoteBrowsePath || sourcePath || "/");
                      }
                    }}
                    disabled={
                      sourceType === "local"
                        ? browseLocalMutation.isPending
                        : !selectedRemoteConnectionId || browseRemoteMutation.isPending
                    }
                  >
                    {(sourceType === "local" ? browseLocalMutation.isPending : browseRemoteMutation.isPending) ? (
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <FolderTree className="mr-2 h-4 w-4" />
                    )}
                    Browse
                  </Button>
                </div>
                {sourceLocationLocked && (
                  <p className="text-xs text-muted-foreground">
                    Source folders are fixed after project creation so deployments and rollbacks keep using the same
                    workspace. Create a new project for a different folder or server path.
                  </p>
                )}
                {sourceType === "local" && localRoots.length > 0 && !localBrowsePath && (
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {localRoots.map((root) => (
                      <Button
                        key={root.path}
                        type="button"
                        variant="outline"
                        className="justify-start"
                        onClick={() => browseLocalMutation.mutate(root.path)}
                      >
                        <HardDrive className="mr-2 h-4 w-4" />
                        <span className="truncate">{root.path}</span>
                      </Button>
                    ))}
                  </div>
                )}
                {(sourceType === "local" ? localEntries.length > 0 : remoteEntries.length > 0) && (
                  <div className="mt-3 max-h-[180px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                    {(sourceType === "local" ? localEntries : remoteEntries).map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        onClick={() => {
                          setSourcePath(entry.path);
                          if (sourceType === "local") {
                            setLocalBrowsePath(entry.path);
                            browseLocalMutation.mutate(entry.path);
                          } else {
                            setRemoteBrowsePath(entry.path);
                            browseRemoteMutation.mutate(entry.path);
                          }
                        }}
                        className={cn(
                          "flex w-full items-center justify-between border-b border-border/60 px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent",
                          sourcePath === entry.path && "bg-accent"
                        )}
                      >
                        <span className="truncate text-foreground">{entry.name}</span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {project.execution_mode === "remote_host" && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Remote Runtime
              </Label>
              <div className={segmentedTabsListClass}>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(segmentedButtonClass, remoteRuntimeType === "docker" && segmentedButtonActiveClass)}
                  onClick={() => {
                  setRemoteRuntimeType("docker");
                  setRemoteK8sExposure("nodeport");
                  setRuntimeScheme("http");
                }}
                >
                  <Server className="mr-2 h-4 w-4" />
                  Remote Docker
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(segmentedButtonClass, remoteRuntimeType === "kubernetes" && segmentedButtonActiveClass)}
                  onClick={() => setRemoteRuntimeType("kubernetes")}
                >
                  <Server className="mr-2 h-4 w-4" />
                  Remote Kubernetes
                </Button>
              </div>
              {remoteRuntimeType === "kubernetes" && (
                <div className={segmentedTabsListClass}>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, remoteK8sExposure === "nodeport" && segmentedButtonActiveClass)}
                    onClick={() => {
                    setRemoteK8sExposure("nodeport");
                    setRuntimeScheme("http");
                  }}
                  >
                    NodePort
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, remoteK8sExposure === "ingress" && segmentedButtonActiveClass)}
                    onClick={() => setRemoteK8sExposure("ingress")}
                  >
                    Ingress
                  </Button>
                </div>
              )}

              {remoteRuntimeType === "kubernetes" && remoteK8sExposure === "ingress" ? (
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Runtime URL Scheme
                  </Label>
                  <div className={segmentedTabsListClass}>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(segmentedButtonClass, runtimeScheme === "http" && segmentedButtonActiveClass)}
                      onClick={() => setRuntimeScheme("http")}
                    >
                      HTTP
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(segmentedButtonClass, runtimeScheme === "https" && segmentedButtonActiveClass)}
                      onClick={() => setRuntimeScheme("https")}
                    >
                      HTTPS
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    HTTPS is only available for Kubernetes Ingress with cert-manager or a TLS secret.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  {remoteRuntimeType === "docker"
                    ? "Remote Docker is locked to HTTP. Switch to Kubernetes Ingress if this deployment needs HTTPS."
                    : "NodePort is locked to HTTP. Choose Ingress to use a domain and HTTPS."}
                </div>
              )}
            </div>
          )}

          {project.execution_mode !== "remote_host" && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Local Dev HTTPS
              </Label>
              <div className={segmentedTabsListClass}>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(segmentedButtonClass, !localHttpsEnabled && segmentedButtonActiveClass)}
                  onClick={() => setLocalHttpsEnabled(false)}
                >
                  HTTP
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(segmentedButtonClass, localHttpsEnabled && segmentedButtonActiveClass)}
                  onClick={() => setLocalHttpsEnabled(true)}
                >
                  HTTPS
                </Button>
              </div>
            </div>
          )}

          <ProjectEnvEditor envVars={envVars} onChange={setEnvVars} />
        </div>
      </div>
      <DialogFooter className="shrink-0 border-t border-border bg-muted/30 px-6 pt-4 pb-6 sm:pb-6">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Close
        </Button>
        <Button type="submit" disabled={updateMutation.isPending}>
          {updateMutation.isPending ? (
            <>
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}
