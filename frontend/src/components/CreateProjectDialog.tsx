"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  CheckCircle2,
  ChevronRight,
  FolderTree,
  GitBranch,
  HardDrive,
  Info,
  Link2,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { GitHubAuthButton } from "@/components/auth/GitHubAuthButton";
import { ProjectEnvEditor, ProjectEnvVar } from "@/components/ProjectEnvEditor";
import { RemoteSshTerminal } from "@/components/RemoteSshTerminal";

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

interface GitHubBranch {
  name: string;
  protected?: boolean;
  commit_sha?: string;
}

interface GitHubBranchesResponse {
  repository: string;
  branches: GitHubBranch[];
  count: number;
}

interface MeResponse {
  user: {
    github_connected: boolean;
    github_username: string;
    github_oauth_available: boolean;
  };
}

interface SshConnection {
  id: string;
  name: string;
  connection_type: "ssh" | "tailscale" | "headscale";
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "key" | "tailscale" | "headscale";
  last_tested_at: string;
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

type SourceType = "github" | "ssh" | "local";
type ExecutionMode = "local" | "remote_host";
type RuntimeScheme = "http" | "https";
type RemoteRuntimeType = "docker" | "kubernetes";
type RemoteK8sExposure = "nodeport" | "ingress";

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

interface ProjectEnvironmentDraft {
  id: string;
  name: string;
  branch: string;
  auto_deploy: boolean;
  require_ci: boolean;
  cleanup_previous_on_success: boolean;
  env_vars: ProjectEnvVar[];
}

function GuideSection({ heading, items }: { heading: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <h3 className="font-medium text-foreground">{heading}</h3>
      <div className="mt-3 space-y-2">
        {items.map((item) => (
          <p key={item} className="text-sm leading-relaxed text-muted-foreground">
            {item}
          </p>
        ))}
      </div>
    </div>
  );
}

const selectedTabClass =
  "h-full rounded-lg px-3 text-sm font-semibold data-[active]:!border-black data-[active]:!bg-black data-[active]:!text-white dark:data-[active]:!border-white dark:data-[active]:!bg-white dark:data-[active]:!text-black";

const segmentedTabsListClass = "grid h-10 w-full rounded-xl border border-border bg-muted/30 p-1";
const segmentedButtonClass =
  "h-8 justify-center rounded-lg border border-transparent px-3 text-sm font-semibold text-muted-foreground hover:bg-accent/60 hover:text-foreground";
const segmentedButtonActiveClass =
  "!border-black !bg-black !text-white hover:!bg-black hover:!text-white dark:!border-white dark:!bg-white dark:!text-black dark:hover:!bg-white dark:hover:!text-black";

function getRemoteHomePath(username?: string) {
  if (!username) return "/home";
  return username === "root" ? "/root" : `/home/${username}`;
}

function defaultProjectEnvironments(): ProjectEnvironmentDraft[] {
  return [
    {
      id: "development",
      name: "development",
      branch: "dev",
      auto_deploy: true,
      require_ci: false,
      cleanup_previous_on_success: true,
      env_vars: [],
    },
    {
      id: "production",
      name: "production",
      branch: "main",
      auto_deploy: false,
      require_ci: true,
      cleanup_previous_on_success: false,
      env_vars: [],
    },
  ];
}

export function CreateProjectDialog() {
  const [open, setOpen] = useState(false);
  const [sourceType, setSourceType] = useState<SourceType>("github");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [githubPat, setGithubPat] = useState("");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [envVars, setEnvVars] = useState<ProjectEnvVar[]>([]);
  const [sshConnectionId, setSshConnectionId] = useState("");
  const [sshSourcePath, setSshSourcePath] = useState("");
  const [githubRemoteWorkspacePath, setGithubRemoteWorkspacePath] = useState("");
  const [sshBrowsePath, setSshBrowsePath] = useState("");
  const [sshEntries, setSshEntries] = useState<SshBrowseEntry[]>([]);
  const [hasBrowsedSshPath, setHasBrowsedSshPath] = useState(false);
  const [showSshConnectionPicker, setShowSshConnectionPicker] = useState(false);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("local");
  const [remoteRuntimeType, setRemoteRuntimeType] = useState<RemoteRuntimeType>("docker");
  const [remoteK8sExposure, setRemoteK8sExposure] = useState<RemoteK8sExposure>("nodeport");
  const [runtimeScheme, setRuntimeScheme] = useState<RuntimeScheme>("http");
  const [, setLocalHttpsEnabled] = useState(false);
  const [localSourcePath, setLocalSourcePath] = useState("");
  const [localBrowsePath, setLocalBrowsePath] = useState("");
  const [localRoots, setLocalRoots] = useState<LocalBrowseResponse["roots"]>([]);
  const [localEntries, setLocalEntries] = useState<LocalBrowseEntry[]>([]);
  const [showRemoteTerminal, setShowRemoteTerminal] = useState(false);
  const [remoteTerminalCwd, setRemoteTerminalCwd] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [environments, setEnvironments] = useState<ProjectEnvironmentDraft[]>(() => defaultProjectEnvironments());

  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await api.get("/auth/me");
      return res.data as MeResponse;
    },
    enabled: open,
  });

  const sshConnectionsQuery = useQuery({
    queryKey: ["ssh-connections"],
    queryFn: async () => {
      const res = await api.get("/ssh/connections");
      return res.data as SshConnectionsResponse;
    },
    enabled: open,
  });

  const githubConnected = Boolean(meQuery.data?.user?.github_connected);
  const githubUsername = meQuery.data?.user?.github_username || "";
  const githubOAuthAvailable = Boolean(meQuery.data?.user?.github_oauth_available);
  const sshConnections = sshConnectionsQuery.data?.connections;
  const activeSshConnection = useMemo(
    () => sshConnections?.find((connection) => connection.id === sshConnectionId) ?? null,
    [sshConnectionId, sshConnections]
  );
  const runtimeHttpsAllowed =
    (executionMode === "remote_host" && remoteRuntimeType === "docker") ||
    (remoteRuntimeType === "kubernetes" && remoteK8sExposure === "ingress");
  const effectiveRuntimeScheme: RuntimeScheme = runtimeHttpsAllowed ? runtimeScheme : "http";
  const effectiveRemoteK8sExposure: RemoteK8sExposure =
    remoteRuntimeType === "kubernetes" ? remoteK8sExposure : "nodeport";
  const effectiveLocalHttpsEnabled = executionMode === "local" && effectiveRuntimeScheme === "https";

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

  const fetchBranchesMutation = useMutation({
    mutationFn: async (targetRepoUrl: string) => {
      const res = await api.post("/github/branches", {
        repo_url: targetRepoUrl,
        pat: githubPat || undefined,
      });
      return res.data as GitHubBranchesResponse;
    },
    onSuccess: (data) => {
      const nextBranches = data.branches || [];
      setBranches(nextBranches);
      if (nextBranches.length === 0) {
        toast.warning("No branches were returned for this repository");
        return;
      }

      const names = nextBranches.map((branch) => branch.name);
      setEnvironments((current) => {
        const used = new Set<string>();
        return current.map((environment) => {
          const preferred =
            environment.name.toLowerCase() === "production"
              ? (names.includes("main") ? "main" : names.includes("master") ? "master" : names[0])
              : (names.includes(environment.branch) ? environment.branch : names.includes("dev") ? "dev" : names.find((name) => name !== "main" && name !== "master") || names[0]);
          const branch = used.has(preferred)
            ? names.find((name) => !used.has(name)) || preferred
            : preferred;
          used.add(branch);
          return { ...environment, branch };
        });
      });
      toast.success(`Loaded ${nextBranches.length} branches`);
    },
    onError: (error: unknown) => {
      setBranches([]);
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string; details?: string } | undefined)?.details ||
            (error.response?.data as { error?: string } | undefined)?.error ||
            "Unable to load repository branches"
          : "Unable to load repository branches";
      toast.error(message);
    },
  });

  const browseSshMutation = useMutation({
    mutationFn: async (path: string) => {
      const res = await api.post(`/ssh/connections/${sshConnectionId}/browse`, { path });
      return res.data as SshBrowseResponse;
    },
    onSuccess: (data) => {
      setSshBrowsePath(data.path);
      setRemoteTerminalCwd(data.path);
      setSshEntries(data.entries);
      setHasBrowsedSshPath(true);
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
      setLocalRoots(data.roots || []);
      setLocalBrowsePath(data.path || "");
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

  const createMutation = useMutation({
    mutationFn: async () => {
      const environmentPayload = environments.map((environment) => ({
        name: environment.name.trim().toLowerCase(),
        branch: environment.branch.trim(),
        auto_deploy: environment.auto_deploy,
        require_ci: environment.require_ci,
        cleanup_previous_on_success: environment.cleanup_previous_on_success,
        env_vars: environment.env_vars,
        execution_mode: executionMode,
        remote_connection_id: executionMode === "remote_host" ? sshConnectionId : "",
        remote_runtime_type: remoteRuntimeType,
        remote_k8s_exposure: effectiveRemoteK8sExposure,
        runtime_scheme: effectiveRuntimeScheme,
      }));
      const payload =
        sourceType === "ssh"
          ? {
              name,
              description,
              env_vars: envVars,
              source_type: "ssh",
              ssh_connection_id: sshConnectionId,
              source_path: sshSourcePath,
              execution_mode: executionMode,
              remote_connection_id: executionMode === "remote_host" ? sshConnectionId : "",
              remote_runtime_type: remoteRuntimeType,
              remote_k8s_exposure: effectiveRemoteK8sExposure,
              runtime_scheme: effectiveRuntimeScheme,
              local_https_enabled: effectiveLocalHttpsEnabled,
            }
          : sourceType === "local"
          ? {
              name,
              description,
              env_vars: envVars,
              source_type: "local",
              source_path: localSourcePath,
              execution_mode: "local",
              remote_runtime_type: remoteRuntimeType,
              remote_k8s_exposure: effectiveRemoteK8sExposure,
              runtime_scheme: effectiveRuntimeScheme,
              local_https_enabled: effectiveLocalHttpsEnabled,
            }
          : {
              name,
              description,
              env_vars: envVars,
              source_type: "github",
              repo_url: repoUrl,
              github_pat: githubPat,
              source_path: executionMode === "remote_host" ? githubRemoteWorkspacePath : "",
              execution_mode: executionMode,
              remote_connection_id: executionMode === "remote_host" ? sshConnectionId : "",
              remote_runtime_type: remoteRuntimeType,
              remote_k8s_exposure: effectiveRemoteK8sExposure,
              runtime_scheme: effectiveRuntimeScheme,
              local_https_enabled: effectiveLocalHttpsEnabled,
            };
      const res = await api.post("/projects", { ...payload, environments: environmentPayload });
      return res.data;
    },
    onSuccess: (data) => {
      toast.success("Project created successfully");
      (data?.warnings || []).forEach((warning: string) => toast.warning(warning));
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      setOpen(false);
      resetForm();
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to create project"
          : "Failed to create project";
      toast.error(message);
    },
  });

  const resetForm = () => {
    setSourceType("github");
    setName("");
    setDescription("");
    setRepoUrl("");
    setGithubPat("");
    setRepos([]);
    setBranches([]);
    setEnvVars([]);
    setSshConnectionId("");
    setSshSourcePath("");
    setGithubRemoteWorkspacePath("");
    setSshBrowsePath("");
    setSshEntries([]);
    setHasBrowsedSshPath(false);
    setShowSshConnectionPicker(false);
    setExecutionMode("local");
    setRemoteRuntimeType("docker");
    setRemoteK8sExposure("nodeport");
    setRuntimeScheme("http");
    setLocalHttpsEnabled(false);
    setLocalSourcePath("");
    setLocalBrowsePath("");
    setLocalRoots([]);
    setLocalEntries([]);
    setShowRemoteTerminal(false);
    setRemoteTerminalCwd("");
    setEnvironments(defaultProjectEnvironments());
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
    fetchBranchesMutation.mutate(repo.clone_url);
  };

  const handleBrowseCurrentPath = () => {
    if (!sshConnectionId) {
      toast.error("Choose an SSH connection first");
      return;
    }
    const defaultRemoteHome = getRemoteHomePath(activeSshConnection?.username);
    const targetPath =
      sourceType === "github"
        ? sshBrowsePath || githubRemoteWorkspacePath || defaultRemoteHome
        : sshBrowsePath || sshSourcePath || defaultRemoteHome;
    const normalizedPath =
      activeSshConnection?.username === "root" && targetPath === "/home/root" ? "/root" : targetPath;
    if (normalizedPath !== targetPath) {
      if (sourceType === "github") {
        setGithubRemoteWorkspacePath(normalizedPath);
      } else {
        setSshSourcePath(normalizedPath);
      }
      setRemoteTerminalCwd(normalizedPath);
    }
    browseSshMutation.mutate(normalizedPath);
  };

  const handleBrowseParent = () => {
    const current = sourceType === "github" ? sshBrowsePath || githubRemoteWorkspacePath : sshBrowsePath || sshSourcePath;
    if (!current || current === "/") {
      browseSshMutation.mutate("/");
      return;
    }
    const segments = current.split("/").filter(Boolean);
    segments.pop();
    const parent = segments.length > 0 ? `/${segments.join("/")}` : "/";
    browseSshMutation.mutate(parent);
  };

  const handleSelectSshDirectory = (entry: SshBrowseEntry) => {
    if (sourceType === "github") {
      setGithubRemoteWorkspacePath(entry.path);
    } else {
      setSshSourcePath(entry.path);
    }
    setRemoteTerminalCwd(entry.path);
    if (entry.directory) {
      browseSshMutation.mutate(entry.path);
    }
  };

  const handleBrowseLocalPath = () => {
    browseLocalMutation.mutate(localBrowsePath || localSourcePath || "");
  };

  const handleBrowseLocalParent = () => {
    const current = localBrowsePath || localSourcePath;
    if (!current) {
      browseLocalMutation.mutate("");
      return;
    }
    const segments = current.split("/").filter(Boolean);
    segments.pop();
    browseLocalMutation.mutate(segments.length > 0 ? `/${segments.join("/")}` : "/");
  };

  const handleSelectLocalDirectory = (entry: LocalBrowseEntry) => {
    setLocalSourcePath(entry.path);
    browseLocalMutation.mutate(entry.path);
  };

  const updateEnvironment = (id: string, patch: Partial<ProjectEnvironmentDraft>) => {
    setEnvironments((current) =>
      current.map((environment) =>
        environment.id === id ? { ...environment, ...patch } : environment
      )
    );
  };

  const addEnvironment = () => {
    setEnvironments((current) => [
      ...current,
      {
        id: `environment-${Date.now()}`,
        name: `environment-${current.length + 1}`,
        branch: "",
        auto_deploy: true,
        require_ci: false,
        cleanup_previous_on_success: false,
        env_vars: [],
      },
    ]);
  };

  const removeEnvironment = (id: string) => {
    setEnvironments((current) => (current.length <= 1 ? current : current.filter((environment) => environment.id !== id)));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) {
      toast.error("Project name is required");
      return;
    }
    if (sourceType === "github" && !repoUrl) {
      toast.error("Repository URL is required");
      return;
    }
    if (sourceType === "github" && executionMode === "remote_host" && !sshConnectionId) {
      toast.error("Choose a saved SSH/VPS connection for server-side GitHub builds");
      return;
    }
    if (sourceType === "github" && executionMode === "remote_host" && !githubRemoteWorkspacePath) {
      toast.error("Choose the remote workspace path where the GitHub repo should be cloned");
      return;
    }
    if (sourceType === "ssh" && (!sshConnectionId || !sshSourcePath)) {
      toast.error("Choose an SSH connection and remote path");
      return;
    }
    if (sourceType === "local" && !localSourcePath) {
      toast.error("Choose a local source path");
      return;
    }
    const normalizedNames = environments.map((environment) => environment.name.trim().toLowerCase());
    const normalizedBranches = environments.map((environment) => environment.branch.trim());
    if (normalizedNames.some((value) => !value) || normalizedBranches.some((value) => !value)) {
      toast.error("Every environment needs a name and branch");
      return;
    }
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      toast.error("Environment names must be unique");
      return;
    }
    createMutation.mutate();
  };

  useEffect(() => {
    if (open && sourceType === "github" && githubConnected && repos.length === 0 && fetchReposMutation.status === "idle") {
      fetchReposMutation.mutate(undefined);
    }
  }, [open, sourceType, githubConnected, repos.length, fetchReposMutation.status, fetchReposMutation]);

  useEffect(() => {
    if (open && sourceType === "local" && localRoots.length === 0 && browseLocalMutation.status === "idle") {
      browseLocalMutation.mutate("");
    }
  }, [open, sourceType, localRoots.length, browseLocalMutation.status, browseLocalMutation]);

  const renderRuntimePreferences = () => {
    const runtimeScope = executionMode === "remote_host" ? "Remote" : "Local";
    const segmentedGroupClass = cn(segmentedTabsListClass, "grid-cols-2");

    return (
      <div className="space-y-3">
        <div className="space-y-2">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {runtimeScope} Runtime
          </Label>
          <div className={segmentedGroupClass}>
            <Button
              type="button"
              variant="ghost"
              className={cn(segmentedButtonClass, remoteRuntimeType === "docker" && segmentedButtonActiveClass)}
              onClick={() => {
                setRemoteRuntimeType("docker");
                setRemoteK8sExposure("nodeport");
                setLocalHttpsEnabled(false);
              }}
            >
              <Server className="mr-2 h-4 w-4" />
              {runtimeScope} Docker
            </Button>
            <Button
              type="button"
              variant="ghost"
              className={cn(segmentedButtonClass, remoteRuntimeType === "kubernetes" && segmentedButtonActiveClass)}
              onClick={() => setRemoteRuntimeType("kubernetes")}
            >
              <Server className="mr-2 h-4 w-4" />
              {runtimeScope} Kubernetes
            </Button>
          </div>
        </div>

        {remoteRuntimeType === "kubernetes" ? (
          <>
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Kubernetes Exposure
              </Label>
              <div className={segmentedGroupClass}>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(segmentedButtonClass, remoteK8sExposure === "nodeport" && segmentedButtonActiveClass)}
                  onClick={() => {
                    setRemoteK8sExposure("nodeport");
                    setRuntimeScheme("http");
                    setLocalHttpsEnabled(false);
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
            </div>

            {remoteK8sExposure === "ingress" ? (
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Runtime URL Scheme
                </Label>
                <div className={segmentedGroupClass}>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, runtimeScheme === "http" && segmentedButtonActiveClass)}
                    onClick={() => {
                      setRuntimeScheme("http");
                      setLocalHttpsEnabled(false);
                    }}
                  >
                    HTTP
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, runtimeScheme === "https" && segmentedButtonActiveClass)}
                    onClick={() => {
                      setRuntimeScheme("https");
                      setLocalHttpsEnabled(executionMode === "local");
                    }}
                  >
                    HTTPS
                  </Button>
                </div>
              </div>
            ) : (
              <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                NodePort exposes HTTP on a node port. Choose Ingress when you need a domain and optional HTTPS.
              </p>
            )}
          </>
        ) : executionMode === "remote_host" ? (
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Runtime URL Scheme
            </Label>
            <div className={segmentedGroupClass}>
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
            <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              Remote Docker can use HTTPS when the server reverse proxy terminates TLS.
            </p>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Local Docker publishes a container port directly and uses HTTP. Choose Kubernetes Ingress when you need
            HTTPS.
          </p>
        )}
      </div>
    );
  };

  const renderEnvironmentSettings = () => (
    <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Branch Environments
          </Label>
          <p className="mt-1 text-sm text-muted-foreground">
            Map GitHub branches to deployable environments and choose how CI and replacement cleanup behave.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addEnvironment}>
          <Plus className="mr-2 h-4 w-4" />
          Add
        </Button>
      </div>

      <div className="space-y-3">
        {environments.map((environment) => (
          <div key={environment.id} className="rounded-xl border border-border bg-card p-3">
            <div className="grid gap-3 lg:grid-cols-[1fr,1fr,auto]">
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Environment
                </Label>
                <Input
                  value={environment.name}
                  onChange={(event) => updateEnvironment(environment.id, { name: event.target.value })}
                  placeholder="development"
                  className="bg-muted/40"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Branch
                </Label>
                {sourceType === "github" && branches.length > 0 ? (
                  <Select
                    value={environment.branch}
                    onValueChange={(value) => value && updateEnvironment(environment.id, { branch: value })}
                  >
                    <SelectTrigger className="h-10 w-full bg-muted/40">
                      <SelectValue placeholder="Select branch" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {branches.map((branch) => (
                        <SelectItem key={branch.name} value={branch.name}>
                          <span className="truncate">{branch.name}</span>
                          {branch.protected ? (
                            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              protected
                            </span>
                          ) : null}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={environment.branch}
                    onChange={(event) => updateEnvironment(environment.id, { branch: event.target.value })}
                    placeholder="dev"
                    className="bg-muted/40"
                  />
                )}
              </div>
              <div className="flex items-end justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  disabled={environments.length <= 1}
                  onClick={() => removeEnvironment(environment.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="mt-3 grid gap-2 lg:grid-cols-3">
              <Button
                type="button"
                variant="outline"
                className={cn(
                  "justify-start",
                  environment.auto_deploy && "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                )}
                onClick={() => updateEnvironment(environment.id, { auto_deploy: !environment.auto_deploy })}
              >
                <GitBranch className="mr-2 h-4 w-4" />
                {environment.auto_deploy ? "Auto deploy on push" : "Manual deploy only"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={cn(
                  "justify-start",
                  environment.require_ci && "border-blue-500/40 bg-blue-500/10 text-blue-500"
                )}
                onClick={() => updateEnvironment(environment.id, { require_ci: !environment.require_ci })}
              >
                <ShieldCheck className="mr-2 h-4 w-4" />
                {environment.require_ci ? "Require CI checks" : "Do not wait for CI"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={cn(
                  "justify-start",
                  environment.cleanup_previous_on_success && "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                )}
                onClick={() =>
                  updateEnvironment(environment.id, {
                    cleanup_previous_on_success: !environment.cleanup_previous_on_success,
                  })
                }
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {environment.cleanup_previous_on_success ? "Clean old runtime" : "Keep old runtime"}
              </Button>
            </div>

            <div className="mt-3">
              <ProjectEnvEditor
                title={`${environment.name || "Environment"} variables`}
                description="These override shared project variables only for this branch environment."
                envVars={environment.env_vars}
                onChange={(nextEnvVars) => updateEnvironment(environment.id, { env_vars: nextEnvVars })}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) resetForm();
      }}
    >
      <DialogTrigger
        render={
          <Button>
            <Plus className="mr-2 h-4 w-4" /> New Project
          </Button>
        }
      />
      <DialogContent className="!flex h-[min(82vh,760px)] !w-[min(92vw,820px)] !max-w-[820px] flex-col overflow-hidden rounded-2xl p-0">
        <DialogHeader className="shrink-0 border-b border-border p-6">
          <div className="flex items-start justify-between gap-4 pr-8">
            <div className="space-y-2">
              <DialogTitle className="flex items-center gap-2">
                <Plus className="h-5 w-5 text-primary" />
                Create New Project
              </DialogTitle>
              <DialogDescription>
                Choose GitHub, a saved SSH/VPS folder, or an allowed local folder as the project source.
              </DialogDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setHelpOpen(true)} className="shrink-0">
              <Info className="mr-2 h-4 w-4" />
              Guide
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin p-6 pb-4">
          <form onSubmit={handleSubmit} className="space-y-5 pb-2">
            <div className="space-y-3">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Project Source</Label>
              <div className={cn(segmentedTabsListClass, "grid-cols-3")}>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, sourceType === "github" && segmentedButtonActiveClass)}
                    onClick={() => setSourceType("github")}
                  >
                    <GitBranch className="mr-2 h-4 w-4" />
                    GitHub
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, sourceType === "ssh" && segmentedButtonActiveClass)}
                    onClick={() => setSourceType("ssh")}
                  >
                    <Server className="mr-2 h-4 w-4" />
                    SSH / VPS
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, sourceType === "local" && segmentedButtonActiveClass)}
                    onClick={() => setSourceType("local")}
                  >
                    <HardDrive className="mr-2 h-4 w-4" />
                    Local
                  </Button>
              </div>
            </div>

            {sourceType === "github" ? (
              <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
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

                <div className="space-y-2">
                  <Label htmlFor="githubPat" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    GitHub Personal Access Token (PAT)
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="githubPat"
                      type="password"
                      value={githubPat}
                      onChange={(e) => setGithubPat(e.target.value)}
                      placeholder="ghp_xxxxxxxxxxxx"
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

                {repos.length > 0 && (
                  <div className="space-y-2">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Select Repository</Label>
                    <div className="max-h-[160px] divide-y divide-border/60 overflow-y-auto rounded-lg border border-border bg-muted/30 scrollbar-thin">
                      {repos.map((repo) => (
                        <button
                          key={repo.id}
                          type="button"
                          onClick={() => handleRepoSelect(repo)}
                          className={cn(
                            "group flex w-full items-center justify-between px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent",
                            repoUrl === repo.clone_url ? "bg-accent" : "bg-transparent"
                          )}
                        >
                          <div className="flex flex-col">
                            <span className="font-medium text-foreground">{repo.full_name}</span>
                            {repo.private && <span className="text-[10px] font-medium text-amber-500">Private</span>}
                          </div>
                          {repoUrl === repo.clone_url && <CheckCircle2 className="h-4 w-4 text-primary" />}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="repoUrl" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Repository URL
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="repoUrl"
                      value={repoUrl}
                      onChange={(e) => {
                        setRepoUrl(e.target.value);
                        setBranches([]);
                      }}
                      onBlur={() => {
                        if (repoUrl.trim()) fetchBranchesMutation.mutate(repoUrl.trim());
                      }}
                      placeholder="https://github.com/user/repo"
                      className="bg-muted/40"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => fetchBranchesMutation.mutate(repoUrl.trim())}
                      disabled={!repoUrl.trim() || fetchBranchesMutation.isPending}
                      className="shrink-0"
                    >
                      {fetchBranchesMutation.isPending ? (
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <GitBranch className="mr-2 h-4 w-4" />
                      )}
                      Branches
                    </Button>
                  </div>
                  {sourceType === "github" && repoUrl && (
                    <p className="text-xs text-muted-foreground">
                      {fetchBranchesMutation.isPending
                        ? "Loading branches from GitHub..."
                        : branches.length > 0
                          ? `${branches.length} branches loaded. Environment branch fields now use the selector.`
                          : "Load branches to select dev/main instead of typing them manually."}
                    </p>
                  )}
                </div>

                <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Execution Target
                  </Label>
                  <div className={cn(segmentedTabsListClass, "grid-cols-2")}>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(segmentedButtonClass, executionMode === "local" && segmentedButtonActiveClass)}
                      onClick={() => setExecutionMode("local")}
                    >
                      <HardDrive className="mr-2 h-4 w-4" />
                      Run locally
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(segmentedButtonClass, executionMode === "remote_host" && segmentedButtonActiveClass)}
                      onClick={() => setExecutionMode("remote_host")}
                    >
                      <Server className="mr-2 h-4 w-4" />
                      Run on server
                    </Button>
                  </div>

                  {renderRuntimePreferences()}

                  {executionMode === "remote_host" && (
                    <div className="space-y-3">
                      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
                        The first deployment will run on the selected server using the runtime above. Docker stays
                        HTTP; Kubernetes Ingress can use HTTPS when the host is prepared.
                      </div>

                      <div className="grid gap-3 lg:grid-cols-[1fr,auto]">
                        <div className="grid gap-2">
                          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Server Connection
                          </Label>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-11 w-full justify-between bg-muted/40 px-3 font-normal"
                            onClick={() => setShowSshConnectionPicker((current) => !current)}
                          >
                            <span className={cn("truncate", !activeSshConnection && "text-muted-foreground")}>
                              {activeSshConnection
                                ? `${activeSshConnection.name} - ${activeSshConnection.username}@${activeSshConnection.host}${activeSshConnection.connection_type === "ssh" ? `:${activeSshConnection.port}` : ""}`
                                : "Select a saved connection"}
                            </span>
                            <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", showSshConnectionPicker && "rotate-90")} />
                          </Button>
                        </div>
                        <div className="self-end">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => queryClient.invalidateQueries({ queryKey: ["ssh-connections"] })}
                            disabled={sshConnectionsQuery.isFetching}
                          >
                            {sshConnectionsQuery.isFetching ? (
                              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-2 h-4 w-4" />
                            )}
                            Refresh
                          </Button>
                        </div>
                      </div>

                      {showSshConnectionPicker && (
                        <div className="max-h-[180px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                          {sshConnections && sshConnections.length > 0 ? (
                            sshConnections.map((connection) => {
                              const isActive = connection.id === sshConnectionId;
                              return (
                                <button
                                  key={connection.id}
                                  type="button"
                                  onClick={() => {
                                    setSshConnectionId(connection.id);
                                    const defaultPath = getRemoteHomePath(connection.username);
                                    setGithubRemoteWorkspacePath((current) => current || defaultPath);
                                    setRemoteTerminalCwd(defaultPath);
                                    setSshBrowsePath("");
                                    setSshEntries([]);
                                    setHasBrowsedSshPath(false);
                                    setShowRemoteTerminal(false);
                                    setShowSshConnectionPicker(false);
                                  }}
                                  className={cn(
                                    "flex w-full items-start justify-between gap-3 border-b border-border/60 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-accent",
                                    isActive && "bg-accent"
                                  )}
                                >
                                  <div className="min-w-0">
                                    <div className="truncate font-medium text-foreground">{connection.name}</div>
                                    <div className="truncate text-sm text-muted-foreground">
                                      {connection.username}@{connection.host}
                                      {connection.connection_type === "ssh" ? `:${connection.port}` : ""}
                                    </div>
                                  </div>
                                  {isActive ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : null}
                                </button>
                              );
                            })
                          ) : (
                            <div className="px-3 py-4 text-sm text-muted-foreground">
                              No saved SSH connections yet. Create one in Settings first.
                            </div>
                          )}
                        </div>
                      )}

                      {activeSshConnection && (
                        <>
                          <div className="space-y-2">
                            <Label
                              htmlFor="githubRemoteWorkspacePath"
                              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                            >
                              Remote Workspace Path
                            </Label>
                            <div className="flex gap-2">
                              <Input
                                id="githubRemoteWorkspacePath"
                                value={githubRemoteWorkspacePath}
                                onChange={(e) => setGithubRemoteWorkspacePath(e.target.value)}
                                placeholder={`${getRemoteHomePath(activeSshConnection.username)}/dokscp-workspaces`}
                                className="bg-muted/40"
                              />
                              <Button
                                type="button"
                                variant="outline"
                                onClick={handleBrowseCurrentPath}
                                disabled={!sshConnectionId || browseSshMutation.isPending}
                              >
                                {browseSshMutation.isPending ? (
                                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                  <FolderTree className="mr-2 h-4 w-4" />
                                )}
                                Browse
                              </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              DOKSCP will clone each GitHub deployment under this folder in an isolated
                              <span className="font-mono"> dokscp-builds/&lt;deployment-id&gt;</span> workspace.
                            </p>
                          </div>

                          {hasBrowsedSshPath && (
                            <div className="space-y-3 rounded-xl border border-border bg-muted/25 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                    Remote Browser
                                  </p>
                                  <p className="text-sm text-foreground">
                                    {sshBrowsePath || githubRemoteWorkspacePath || getRemoteHomePath(activeSshConnection.username)}
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={handleBrowseParent}
                                  disabled={browseSshMutation.isPending}
                                >
                                  Up
                                </Button>
                              </div>
                              {sshEntries.length > 0 ? (
                                <div className="max-h-[160px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                                  {sshEntries.map((entry) => (
                                    <button
                                      key={entry.path}
                                      type="button"
                                      onClick={() => handleSelectSshDirectory(entry)}
                                      className={cn(
                                        "flex w-full items-center justify-between border-b border-border/60 px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent",
                                        githubRemoteWorkspacePath === entry.path ? "bg-accent" : "bg-transparent"
                                      )}
                                    >
                                      <div className="flex items-center gap-2">
                                        <FolderTree className="h-4 w-4 text-muted-foreground" />
                                        <span className="text-foreground">{entry.name}</span>
                                      </div>
                                      {entry.directory && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                                    </button>
                                  ))}
                                </div>
                              ) : (
                                <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                                  This remote folder is empty. You can still use it as the workspace path.
                                </div>
                              )}
                            </div>
                          )}

                          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                  Server Terminal
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  Optional shell access for this server before creating the project.
                                </p>
                              </div>
                              <Button
                                type="button"
                                variant={showRemoteTerminal ? "default" : "outline"}
                                onClick={() => {
                                  setRemoteTerminalCwd(githubRemoteWorkspacePath || getRemoteHomePath(activeSshConnection.username));
                                  setShowRemoteTerminal((current) => !current);
                                }}
                              >
                                <Terminal className="mr-2 h-4 w-4" />
                                Terminal
                              </Button>
                            </div>
                            {showRemoteTerminal && (
                              <RemoteSshTerminal
                                connectionId={sshConnectionId}
                                cwd={remoteTerminalCwd || githubRemoteWorkspacePath || getRemoteHomePath(activeSshConnection.username)}
                              />
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : sourceType === "ssh" ? (
              <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
                <div className="space-y-3">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Execution Target
                  </Label>
                  <div className={cn(segmentedTabsListClass, "grid-cols-2")}>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(segmentedButtonClass, executionMode === "local" && segmentedButtonActiveClass)}
                      onClick={() => setExecutionMode("local")}
                    >
                      <HardDrive className="mr-2 h-4 w-4" />
                      Run locally
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(segmentedButtonClass, executionMode === "remote_host" && segmentedButtonActiveClass)}
                      onClick={() => setExecutionMode("remote_host")}
                    >
                      <Server className="mr-2 h-4 w-4" />
                      Run on server
                    </Button>
                  </div>
                  {renderRuntimePreferences()}
                  {executionMode === "remote_host" && (
                    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
                      The first deployment will run on this server using the runtime above. Docker stays HTTP;
                      Kubernetes Ingress can use HTTPS when the host is prepared.
                    </div>
                  )}
                </div>

                <div className="grid gap-4 lg:grid-cols-[1fr,auto]">
                  <div className="grid gap-2">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Saved SSH Connection
                    </Label>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 w-full justify-between bg-muted/40 px-3 font-normal"
                      onClick={() => setShowSshConnectionPicker((current) => !current)}
                    >
                      <span className={cn("truncate", !activeSshConnection && "text-muted-foreground")}>
                        {activeSshConnection
                          ? `${activeSshConnection.name} - ${activeSshConnection.username}@${activeSshConnection.host}${activeSshConnection.connection_type === "ssh" ? `:${activeSshConnection.port}` : ""}`
                          : "Select a saved connection"}
                      </span>
                      <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", showSshConnectionPicker && "rotate-90")} />
                    </Button>
                  </div>
                  <div className="self-end">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => queryClient.invalidateQueries({ queryKey: ["ssh-connections"] })}
                      disabled={sshConnectionsQuery.isFetching}
                    >
                      {sshConnectionsQuery.isFetching ? (
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
                      Refresh
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Local HTTPS is stored for local Kubernetes/Ingress experiments. Plain Docker builds stay HTTP.
                  </p>
                </div>

                {showSshConnectionPicker && (
                  <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-3">
                    {sshConnections && sshConnections.length > 0 ? (
                      <div className="max-h-[220px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                        {sshConnections.map((connection) => {
                          const isActive = connection.id === sshConnectionId;
                          return (
                            <button
                              key={connection.id}
                              type="button"
                              onClick={() => {
                                setSshConnectionId(connection.id);
                                setSshEntries([]);
                                setSshBrowsePath("");
                                setHasBrowsedSshPath(false);
                                const defaultPath = getRemoteHomePath(connection.username);
                                setSshSourcePath(defaultPath);
                                setRemoteTerminalCwd(defaultPath);
                                setShowSshConnectionPicker(false);
                              }}
                              className={cn(
                                "flex w-full items-start justify-between gap-3 border-b border-border/60 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-accent",
                                isActive && "bg-accent"
                              )}
                            >
                              <div className="min-w-0">
                                <div className="truncate font-medium text-foreground">{connection.name}</div>
                                <div className="truncate text-sm text-muted-foreground">
                                  {connection.username}@{connection.host}
                                  {connection.connection_type === "ssh" ? `:${connection.port}` : ""}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                  {connection.connection_type === "headscale" ? "headscale" : connection.connection_type === "tailscale" ? "tailscale" : connection.auth_type}
                                </span>
                                {isActive ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-primary" /> : null}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                        No saved SSH connections yet. Create one in Settings first.
                      </div>
                    )}
                  </div>
                )}

                {activeSshConnection && (
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-500">
                    Using {activeSshConnection.username}@{activeSshConnection.host}
                    {activeSshConnection.connection_type === "ssh" ? `:${activeSshConnection.port}` : ""} via{" "}
                    {activeSshConnection.connection_type === "headscale" ? "Headscale SSH" : activeSshConnection.connection_type === "tailscale" ? "Tailscale SSH" : "standard SSH"}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="sshSourcePath" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Remote Project Path
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="sshSourcePath"
                      value={sshSourcePath}
                      onChange={(e) => setSshSourcePath(e.target.value)}
                      placeholder="/home/user/apps/my-project"
                      className="bg-muted/40"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleBrowseCurrentPath}
                      disabled={!sshConnectionId || browseSshMutation.isPending}
                    >
                      {browseSshMutation.isPending ? (
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <FolderTree className="mr-2 h-4 w-4" />
                      )}
                      Browse
                    </Button>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant={showRemoteTerminal ? "default" : "outline"}
                            size="icon-lg"
                            onClick={() => {
                              setRemoteTerminalCwd(sshBrowsePath || sshSourcePath || getRemoteHomePath(activeSshConnection?.username));
                              setShowRemoteTerminal((current) => !current);
                            }}
                            disabled={!sshConnectionId}
                          >
                            <Terminal className="h-4 w-4" />
                          </Button>
                        }
                      />
                      <TooltipContent side="top">Open SSH terminal</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                {sshConnectionId && (
                  <div className="space-y-3 rounded-xl border border-border bg-muted/25 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Remote Browser
                        </p>
                        <p className="text-sm text-foreground">{sshBrowsePath || sshSourcePath || getRemoteHomePath(activeSshConnection?.username)}</p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleBrowseParent}
                        disabled={browseSshMutation.isPending}
                      >
                        Up
                      </Button>
                    </div>

                    {sshEntries.length > 0 ? (
                      <div className="max-h-[180px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                        {sshEntries.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            onClick={() => handleSelectSshDirectory(entry)}
                            className={cn(
                              "flex w-full items-center justify-between border-b border-border/60 px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent",
                              sshSourcePath === entry.path ? "bg-accent" : "bg-transparent"
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <FolderTree className="h-4 w-4 text-muted-foreground" />
                              <span className="text-foreground">{entry.name}</span>
                            </div>
                            {entry.directory && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                        Browse a remote folder to pick the exact VPS path you want to build from.
                      </div>
                    )}
                  </div>
                )}

                {showRemoteTerminal && (
                  <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          SSH Terminal
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Interactive shell on the selected SSH/VPS connection. You can run git, install tools, and navigate normally.
                        </p>
                      </div>
                      <Terminal className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <RemoteSshTerminal
                      connectionId={sshConnectionId}
                      cwd={remoteTerminalCwd || sshBrowsePath || sshSourcePath || getRemoteHomePath(activeSshConnection?.username)}
                      className="h-[min(56vh,520px)] min-h-[420px]"
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
                <div className="space-y-2">
                  <Label htmlFor="localSourcePath" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Local Project Path
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="localSourcePath"
                      value={localSourcePath}
                      onChange={(e) => setLocalSourcePath(e.target.value)}
                      placeholder="/app/local-projects/my-project"
                      className="bg-muted/40"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleBrowseLocalPath}
                      disabled={browseLocalMutation.isPending}
                    >
                      {browseLocalMutation.isPending ? (
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <FolderTree className="mr-2 h-4 w-4" />
                      )}
                      Browse
                    </Button>
                  </div>
                </div>

                {renderRuntimePreferences()}

                <div className="space-y-3 rounded-xl border border-border bg-muted/25 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Allowed Local Roots
                      </p>
                      <p className="text-sm text-foreground">{localBrowsePath || "Select a mounted local source root"}</p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleBrowseLocalParent}
                      disabled={browseLocalMutation.isPending || !localBrowsePath}
                    >
                      Up
                    </Button>
                  </div>

                  {!localBrowsePath && localRoots.length > 0 && (
                    <div className="grid gap-2 lg:grid-cols-2">
                      {localRoots.map((root) => (
                        <Button
                          key={root.path}
                          type="button"
                          variant="outline"
                          className="justify-start truncate"
                          onClick={() => {
                            setLocalSourcePath(root.path);
                            browseLocalMutation.mutate(root.path);
                          }}
                        >
                          <HardDrive className="mr-2 h-4 w-4" />
                          <span className="truncate">{root.path}</span>
                        </Button>
                      ))}
                    </div>
                  )}

                  {localEntries.length > 0 ? (
                    <div className="max-h-[180px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                      {localEntries.map((entry) => (
                        <button
                          key={entry.path}
                          type="button"
                          onClick={() => handleSelectLocalDirectory(entry)}
                          className={cn(
                            "flex w-full items-center justify-between border-b border-border/60 px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent",
                            localSourcePath === entry.path ? "bg-accent" : "bg-transparent"
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="truncate text-foreground">{entry.name}</span>
                          </div>
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      Local projects must live under the configured mounted local source root.
                    </div>
                  )}
                </div>
              </div>
            )}

            {renderEnvironmentSettings()}

            <ProjectEnvEditor envVars={envVars} onChange={setEnvVars} />

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Project Name
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-awesome-app"
                  required
                  className="bg-muted/40"
                />
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor="description"
                  className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  Description
                </Label>
                <Input
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A short description..."
                  className="bg-muted/40"
                />
              </div>
            </div>
          </form>
        </div>

        <DialogFooter className="shrink-0 border-t border-border bg-muted/30 px-6 pt-4 pb-6 sm:pb-6">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" onClick={handleSubmit} disabled={createMutation.isPending} className="min-w-[140px]">
            {createMutation.isPending ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Project"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="!w-[min(90vw,620px)] !max-w-[620px] rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Info className="h-5 w-5 text-primary" />
            Project Creation Guide
          </DialogTitle>
          <DialogDescription>
            These choices decide where the source comes from and where the first Docker build runs. Runtime upgrades
            happen after creation from the deployment screen.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="github" className="max-h-[56vh] overflow-hidden">
              <TabsList className={cn(segmentedTabsListClass, "grid-cols-3")}>
            <TabsTrigger value="github" className={selectedTabClass}>
              GitHub
            </TabsTrigger>
            <TabsTrigger value="ssh" className={selectedTabClass}>
              SSH / VPS
            </TabsTrigger>
            <TabsTrigger value="local" className={selectedTabClass}>
              Local
            </TabsTrigger>
          </TabsList>

          <div className="mt-4 max-h-[44vh] overflow-y-auto pr-1 scrollbar-thin">
            <TabsContent value="github" className="space-y-3">
              <GuideSection
                heading="GitHub source"
                items={[
                  "Use GitHub OAuth or a PAT to load public and private repositories.",
                  "Pick a repository, then DOKSCP stores the project record and creates the first Docker deployment.",
                  "If you choose Run on server, select the server and a remote workspace path. The repo is cloned under dokscp-builds/<deployment-id> inside that path.",
                ]}
              />
              <GuideSection
                heading="After creation"
                items={[
                  "Open Deployments to view logs, metrics, runtime details, or delete the deployment.",
                  "Use the runtime controls later if you want Kubernetes, NodePort, or Ingress instead of plain Docker.",
                ]}
              />
            </TabsContent>

            <TabsContent value="ssh" className="space-y-3">
              <GuideSection
                heading="SSH / VPS source"
                items={[
                  "Use this when the source folder already exists on a saved server or Tailscale machine.",
                  "Browse to the actual project folder, not only the parent folder.",
                  "Run locally copies the remote source to DOKSCP and builds on this machine. Run on server builds and runs on that same remote server.",
                ]}
              />
              <GuideSection
                heading="Terminal"
                items={[
                  "The terminal lets you run normal shell commands on the selected connection.",
                  "You can git clone, install missing tools, inspect files, then choose the final project folder.",
                ]}
              />
            </TabsContent>

            <TabsContent value="local" className="space-y-3">
              <GuideSection
                heading="Local source"
                items={[
                  "Use this for folders already available on the host running DOKSCP.",
                  "Local projects must live inside the allowed local source roots configured for the backend container.",
                  "Direct arbitrary laptop paths are intentionally blocked; mount or import the project into the allowed root so builds are reproducible and safe.",
                ]}
              />
              <GuideSection
                heading="NodePort vs Ingress"
                items={[
                  "NodePort exposes a Kubernetes app on a high node port, useful for local testing.",
                  "Ingress routes domain-based HTTP traffic through an ingress controller, better for production-style URLs and TLS.",
                ]}
              />
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter>
          <Button type="button" onClick={() => setHelpOpen(false)}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
