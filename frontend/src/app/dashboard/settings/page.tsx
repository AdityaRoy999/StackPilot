"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import api from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CheckCircle2,
  Code2,
  Database,
  Eye,
  EyeOff,
  FolderTree,
  History,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  Save,
  ScrollText,
  Server,
  Shield,
  Terminal,
  Trash2,
  Unplug,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { GitHubAuthButton } from "@/components/auth/GitHubAuthButton";
import { RemoteSshTerminal } from "@/components/RemoteSshTerminal";
import { McpIntegrations } from "./mcp-integrations";

interface MeResponse {
  user: {
    email: string;
    full_name: string;
    github_connected: boolean;
    github_username: string;
    github_oauth_available: boolean;
    google_connected: boolean;
    password_enabled: boolean;
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
  created_at: string;
  updated_at: string;
}

interface SshConnectionsResponse {
  connections: SshConnection[];
  count: number;
}

interface ProbeResponse {
  message?: string;
  capabilities?: Record<string, string>;
  details?: string;
}

interface ProvisionResponse {
  message?: string;
  warning?: string;
  error?: string;
  hint?: string;
  details?: string;
  needs_sudo_password?: boolean;
}

interface LoginHistoryEntry {
  id: string;
  login_method: string;
  ip_address: string;
  device: string;
  user_agent: string;
  created_at: string;
}

interface LoginHistoryResponse {
  history: LoginHistoryEntry[];
  count: number;
}

interface AuditLogEntry {
  id: string;
  action: string;
  target_type: string;
  target_id: string;
  ip_address: string;
  user_agent: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface AuditLogsResponse {
  logs: AuditLogEntry[];
  count: number;
}

function formatLoginDay(value: string) {
  if (!value) return "Unknown day";
  return new Date(value).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatLoginTime(value: string) {
  if (!value) return "Unknown time";
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [fullNameDraft, setFullNameDraft] = useState<string | null>(null);
  const [sshName, setSshName] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUsername, setSshUsername] = useState("");
  const [sshConnectionType, setSshConnectionType] = useState<"ssh" | "tailscale" | "headscale">("ssh");
  const [sshAuthType, setSshAuthType] = useState<"password" | "key">("password");
  const [sshPassword, setSshPassword] = useState("");
  const [showSshPassword, setShowSshPassword] = useState(false);
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [probesByConnection, setProbesByConnection] = useState<Record<string, ProbeResponse>>({});
  const [terminalConnection, setTerminalConnection] = useState<SshConnection | null>(null);
  const [loginHistoryOpen, setLoginHistoryOpen] = useState(false);
  const [auditLogsOpen, setAuditLogsOpen] = useState(false);
  const [sudoPasswordDialog, setSudoPasswordDialog] = useState<{ connectionId: string; action: "docker" | "kubernetes" } | null>(null);
  const [sudoPasswordInput, setSudoPasswordInput] = useState("");
  const [showSudoPassword, setShowSudoPassword] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await api.get("/auth/me");
      return res.data as MeResponse;
    },
  });

  const sshConnectionsQuery = useQuery({
    queryKey: ["ssh-connections"],
    queryFn: async () => {
      const res = await api.get("/ssh/connections");
      return res.data as SshConnectionsResponse;
    },
  });

  const loginHistoryQuery = useQuery({
    queryKey: ["login-history"],
    queryFn: async () => {
      const res = await api.get("/auth/login-history");
      return res.data as LoginHistoryResponse;
    },
    enabled: loginHistoryOpen,
  });

  const auditLogsQuery = useQuery({
    queryKey: ["audit-logs"],
    queryFn: async () => {
      const res = await api.get("/auth/audit-logs");
      return res.data as AuditLogsResponse;
    },
    enabled: auditLogsOpen,
  });

  const fullName = fullNameDraft ?? data?.user?.full_name ?? "";
  const signInMethodParts = [
    data?.user?.github_connected ? "GitHub" : null,
    data?.user?.google_connected ? "Google" : null,
    data?.user?.password_enabled ? "Email + password" : null,
  ].filter(Boolean);
  const signInMethodLabel =
    signInMethodParts.length > 0 ? signInMethodParts.join(" + ") : "No sign-in methods configured";

  const updateMutation = useMutation({
    mutationFn: async (newName: string) => {
      const res = await api.put("/auth/me", { full_name: newName });
      return res.data;
    },
    onSuccess: () => {
      toast.success("Profile updated successfully");
      queryClient.invalidateQueries({ queryKey: ["me"] });
      setFullNameDraft(null);
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to update profile"
          : "Failed to update profile";
      toast.error(message);
    },
  });

  const disconnectGitHubMutation = useMutation({
    mutationFn: async () => {
      const res = await api.delete("/auth/github");
      return res.data;
    },
    onSuccess: () => {
      toast.success("GitHub disconnected successfully");
      queryClient.invalidateQueries({ queryKey: ["me"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to disconnect GitHub"
          : "Failed to disconnect GitHub";
      toast.error(message);
    },
  });

  const createSshConnectionMutation = useMutation({
    mutationKey: ["ssh-create"],
    mutationFn: async () => {
      const payload = {
        name: sshName,
        connection_type: sshConnectionType,
        host: sshHost,
        port: Number(sshPort) || 22,
        username: sshUsername,
        auth_type: sshConnectionType === "ssh" ? sshAuthType : sshConnectionType,
        password: sshConnectionType === "ssh" && sshAuthType === "password" ? sshPassword : "",
        private_key: sshConnectionType === "ssh" && sshAuthType === "key" ? sshPrivateKey : "",
      };
      const res = await api.post("/ssh/connections", payload);
      return res.data;
    },
    onSuccess: () => {
      toast.success("SSH connection saved");
      queryClient.invalidateQueries({ queryKey: ["ssh-connections"] });
      setSshName("");
      setSshHost("");
      setSshPort("22");
      setSshUsername("");
      setSshConnectionType("ssh");
      setSshPassword("");
      setSshPrivateKey("");
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to save SSH connection"
          : "Failed to save SSH connection";
      toast.error(message);
    },
  });

  const testSshConnectionMutation = useMutation({
    mutationKey: ["ssh-test"],
    mutationFn: async (connectionId: string) => {
      const res = await api.post(`/ssh/connections/${connectionId}/test`);
      return { id: connectionId, data: res.data };
    },
    onSuccess: ({ data: responseData }) => {
      toast.success(responseData?.message || "SSH connection is working");
      queryClient.invalidateQueries({ queryKey: ["ssh-connections"] });
    },
    onError: (error: unknown) => {
      const responseData = error instanceof AxiosError
        ? (error.response?.data as { error?: string; details?: string } | undefined)
        : undefined;
      const message =
        error instanceof AxiosError
          ? responseData?.error || "SSH connection test failed"
          : "SSH connection test failed";
      toast.error(message, {
        description: responseData?.details ? responseData.details.slice(0, 240) : undefined,
      });
    },
  });

  const deleteSshConnectionMutation = useMutation({
    mutationKey: ["ssh-delete"],
    mutationFn: async (connectionId: string) => {
      const res = await api.delete(`/ssh/connections/${connectionId}`);
      return { id: connectionId, data: res.data };
    },
    onSuccess: () => {
      toast.success("SSH connection deleted");
      queryClient.invalidateQueries({ queryKey: ["ssh-connections"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to delete SSH connection"
          : "Failed to delete SSH connection";
      toast.error(message);
    },
  });

  const probeSshConnectionMutation = useMutation({
    mutationKey: ["ssh-probe"],
    mutationFn: async (connectionId: string) => {
      const res = await api.post(`/ssh/connections/${connectionId}/probe`);
      return { id: connectionId, data: res.data as ProbeResponse };
    },
    onSuccess: ({ id, data: responseData }) => {
      setProbesByConnection((current) => ({ ...current, [id]: responseData }));
      toast.success(responseData.message || "Remote host probed");
    },
    onError: (error: unknown) => {
      const responseData = error instanceof AxiosError
        ? (error.response?.data as { error?: string; details?: string } | undefined)
        : undefined;
      const message =
        error instanceof AxiosError
          ? responseData?.error || "Failed to probe remote host"
          : "Failed to probe remote host";
      toast.error(message, {
        description: responseData?.details ? responseData.details.slice(0, 240) : undefined,
      });
    },
  });

  const provisionDockerMutation = useMutation({
    mutationKey: ["ssh-provision-docker"],
    mutationFn: async ({ connectionId, sudoPassword }: { connectionId: string; sudoPassword?: string }) => {
      const res = await api.post(`/ssh/connections/${connectionId}/provision/docker`, sudoPassword ? { sudo_password: sudoPassword } : undefined);
      return { id: connectionId, data: res.data as ProvisionResponse };
    },
    onSuccess: ({ id, data: responseData }) => {
      if (responseData.warning) {
        toast.warning(responseData.warning, {
          description: "Reconnect to the SSH session, then probe the host again.",
        });
      } else {
        toast.success(responseData.message || "Docker host prepared");
      }
      probeSshConnectionMutation.mutate(id);
    },
    onError: (error: unknown) => {
      const responseData = error instanceof AxiosError
        ? (error.response?.data as ProvisionResponse | undefined)
        : undefined;
      if (responseData?.needs_sudo_password && provisionDockerMutation.variables) {
        setSudoPasswordDialog({ connectionId: provisionDockerMutation.variables.connectionId, action: "docker" });
        setSudoPasswordInput("");
        return;
      }
      const message =
        error instanceof AxiosError
          ? responseData?.error || "Failed to prepare Docker host"
          : "Failed to prepare Docker host";
      toast.error(message, {
        description: responseData?.hint || (responseData?.details ? responseData.details.slice(0, 240) : undefined),
      });
    },
  });

  const provisionKubernetesMutation = useMutation({
    mutationKey: ["ssh-provision-kubernetes"],
    mutationFn: async ({ connectionId, sudoPassword }: { connectionId: string; sudoPassword?: string }) => {
      const res = await api.post(`/ssh/connections/${connectionId}/provision/kubernetes`, sudoPassword ? { sudo_password: sudoPassword } : undefined);
      return { id: connectionId, data: res.data as ProvisionResponse };
    },
    onSuccess: ({ id, data: responseData }) => {
      toast.success(responseData.message || "Lightweight Kubernetes prepared");
      probeSshConnectionMutation.mutate(id);
    },
    onError: (error: unknown) => {
      const responseData = error instanceof AxiosError
        ? (error.response?.data as ProvisionResponse | undefined)
        : undefined;
      if (responseData?.needs_sudo_password && provisionKubernetesMutation.variables) {
        setSudoPasswordDialog({ connectionId: provisionKubernetesMutation.variables.connectionId, action: "kubernetes" });
        setSudoPasswordInput("");
        return;
      }
      const message =
        error instanceof AxiosError
          ? responseData?.error || "Failed to prepare Kubernetes"
          : "Failed to prepare Kubernetes";
      toast.error(message, {
        description: responseData?.hint || (responseData?.details ? responseData.details.slice(0, 240) : undefined),
      });
    },
  });

  const connections = sshConnectionsQuery.data?.connections ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Settings</h1>
        <p className="text-muted-foreground">Manage account, integrations, and remote build connections.</p>
      </div>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2 text-foreground">
              <Shield className="h-5 w-5 text-primary" />
              <CardTitle>Account Settings</CardTitle>
            </div>
            <CardDescription>Update your personal information and sign-in setup.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 xl:grid-cols-[minmax(420px,0.95fr)_minmax(360px,0.65fr)] xl:items-stretch">
            <div className="min-w-0 space-y-5 rounded-xl border border-border/70 bg-muted/10 p-4 xl:p-5">
              <div className="grid gap-2">
                <Label htmlFor="email">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  value={data?.user?.email || ""}
                  disabled
                  className="w-full max-w-xl cursor-not-allowed bg-muted/50 text-muted-foreground"
                />
                <p className="text-xs text-muted-foreground">Email cannot be changed.</p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="signInType">Sign-In Method</Label>
                <Input
                  id="signInType"
                  value={signInMethodLabel}
                  disabled
                  className="w-full max-w-xl cursor-not-allowed bg-muted/50 text-muted-foreground"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="name">Full Name</Label>
                <Input
                  id="name"
                  placeholder="John Doe"
                  value={fullName}
                  onChange={(e) => setFullNameDraft(e.target.value)}
                  className="w-full max-w-xl"
                />
              </div>

              <Button onClick={() => updateMutation.mutate(fullName)} disabled={updateMutation.isPending || isLoading}>
                {updateMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save Changes
              </Button>
            </div>

            <div className="grid min-w-0 content-stretch gap-4">
              <div className="flex min-h-0 flex-col justify-between rounded-xl border border-border bg-muted/25 p-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-foreground">
                    <History className="h-4 w-4 text-primary" />
                    <h3 className="font-medium">Login History</h3>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Review recent sign-ins with device, IP address, method, and timestamp details.
                  </p>
                </div>
                <Button variant="outline" className="mt-4 w-fit" onClick={() => setLoginHistoryOpen(true)}>
                  <History className="mr-2 h-4 w-4" />
                  Login History
                </Button>
              </div>

              <div className="flex min-h-0 flex-col justify-between rounded-xl border border-border bg-muted/25 p-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-foreground">
                    <ScrollText className="h-4 w-4 text-primary" />
                    <h3 className="font-medium">Audit Logs</h3>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Review important account, project, deployment, and runtime changes.
                  </p>
                </div>
                <Button variant="outline" className="mt-4 w-fit" onClick={() => setAuditLogsOpen(true)}>
                  <ScrollText className="mr-2 h-4 w-4" />
                  Audit Logs
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2 text-foreground">
              <Code2 className="h-5 w-5" />
              <CardTitle>GitHub Integration</CardTitle>
            </div>
            <CardDescription>Connect GitHub once to browse repositories and sign in faster.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-4 rounded-lg border border-border bg-muted/40 p-4 md:flex-row md:items-center md:justify-between">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card">
                  <Code2 className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-medium text-foreground">
                    {data?.user?.github_connected
                      ? `Connected as ${data?.user?.github_username || "GitHub user"}`
                      : "GitHub is not connected"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {data?.user?.github_connected
                      ? "Private and public repositories can be loaded directly from your GitHub account."
                      : "You can still use a Personal Access Token per project if you prefer."}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {data?.user?.github_connected ? (
                  <>
                    <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Connected
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => disconnectGitHubMutation.mutate()}
                      disabled={disconnectGitHubMutation.isPending}
                    >
                      {disconnectGitHubMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Unplug className="mr-2 h-4 w-4" />
                      )}
                      Disconnect
                    </Button>
                  </>
                ) : data?.user?.github_oauth_available ? (
                  <GitHubAuthButton mode="connect" enabled className="rounded-lg" />
                ) : (
                  <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
                    <Link2 className="h-3.5 w-3.5" />
                    GitHub OAuth not configured
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <McpIntegrations />

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2 text-foreground">
              <Server className="h-5 w-5 text-primary" />
              <CardTitle>Remote Connections</CardTitle>
            </div>
            <CardDescription>
              Save SSH or Tailscale nodes once, test them here, then reuse them while creating projects from remote folders.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="rounded-xl border border-border bg-muted/25 p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-2 md:col-span-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Connection Type
                  </Label>
                  <div className="grid grid-cols-3 gap-2 rounded-xl border border-border bg-muted/25 p-1">
                    <Button
                      type="button"
                      variant={sshConnectionType === "ssh" ? "default" : "ghost"}
                      className="h-10 justify-center rounded-lg"
                      onClick={() => setSshConnectionType("ssh")}
                    >
                      Standard SSH
                    </Button>
                    <Button
                      type="button"
                      variant={sshConnectionType === "tailscale" ? "default" : "ghost"}
                      className="h-10 justify-center rounded-lg"
                      onClick={() => {
                        setSshConnectionType("tailscale");
                        setSshAuthType("password");
                        setSshPassword("");
                        setSshPrivateKey("");
                      }}
                    >
                      Tailscale SSH
                    </Button>
                    <Button
                      type="button"
                      variant={sshConnectionType === "headscale" ? "default" : "ghost"}
                      className="h-10 justify-center rounded-lg"
                      onClick={() => {
                        setSshConnectionType("headscale");
                        setSshAuthType("password");
                        setSshPassword("");
                        setSshPrivateKey("");
                      }}
                    >
                      Headscale SSH
                    </Button>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ssh-name">Connection Name</Label>
                  <Input
                    id="ssh-name"
                    value={sshName}
                    onChange={(e) => setSshName(e.target.value)}
                    placeholder="Hostinger VPS"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ssh-host">Host</Label>
                  <Input
                    id="ssh-host"
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    placeholder={sshConnectionType === "ssh" ? "example.hostinger.com" : "100.64.83.114 or linux.tailnet.ts.net"}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ssh-port">Port</Label>
                  <Input
                    id="ssh-port"
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value)}
                    placeholder="22"
                    inputMode="numeric"
                    disabled={sshConnectionType !== "ssh"}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ssh-username">Username</Label>
                  <Input
                    id="ssh-username"
                    value={sshUsername}
                    onChange={(e) => setSshUsername(e.target.value)}
                    placeholder="root"
                  />
                </div>
                {sshConnectionType === "ssh" ? (
                  <div className="grid gap-2 md:col-span-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Authentication Method
                  </Label>
                  <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-muted/25 p-1">
                    <Button
                      type="button"
                      variant={sshAuthType === "password" ? "default" : "ghost"}
                      className="h-10 justify-center rounded-lg"
                      onClick={() => setSshAuthType("password")}
                    >
                      Password
                    </Button>
                    <Button
                      type="button"
                      variant={sshAuthType === "key" ? "default" : "ghost"}
                      className="h-10 justify-center rounded-lg"
                      onClick={() => setSshAuthType("key")}
                    >
                      Private key
                    </Button>
                  </div>
                </div>
                ) : (
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400 md:col-span-2">
                    Uses your backend machine&apos;s authenticated {sshConnectionType === "headscale" ? "Headscale/Tailscale" : "Tailscale"} SSH session. No password or private key is stored for this connection.
                  </div>
                )}
                {sshConnectionType === "ssh" && sshAuthType === "password" ? (
                  <div className="grid gap-2 md:col-span-2">
                    <Label htmlFor="ssh-password">Password</Label>
                    <div className="relative">
                      <Input
                        id="ssh-password"
                        type={showSshPassword ? "text" : "password"}
                        value={sshPassword}
                        onChange={(e) => setSshPassword(e.target.value)}
                        placeholder="SSH password"
                        className="pr-10"
                      />
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
                        onClick={() => setShowSshPassword((current) => !current)}
                        aria-label={showSshPassword ? "Hide SSH password" : "Show SSH password"}
                      >
                        {showSshPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                ) : sshConnectionType === "ssh" ? (
                  <div className="grid gap-2 md:col-span-2">
                    <Label htmlFor="ssh-private-key">Private Key</Label>
                    <textarea
                      id="ssh-private-key"
                      value={sshPrivateKey}
                      onChange={(e) => setSshPrivateKey(e.target.value)}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      className="min-h-[160px] rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm outline-none transition-colors"
                    />
                  </div>
                ) : null}
              </div>

              <div className="mt-4 flex justify-end">
                <Button
                  onClick={() => createSshConnectionMutation.mutate()}
                  disabled={
                    createSshConnectionMutation.isPending ||
                    !sshName ||
                    !sshHost ||
                    !sshUsername ||
                    (sshConnectionType === "ssh" && (sshAuthType === "password" ? !sshPassword : !sshPrivateKey))
                  }
                >
                  {createSshConnectionMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="mr-2 h-4 w-4" />
                  )}
                  Save Connection
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Saved Connections</h3>
                  <p className="text-xs text-muted-foreground">
                    Test a VPS connection here before using it in the project creation flow.
                  </p>
                </div>
                {sshConnectionsQuery.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>

              {connections.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
                  No SSH connections saved yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {connections.map((connection) => {
                    const probe = probesByConnection[connection.id];
                    const capabilities = probe?.capabilities ?? {};
                    const formatProbeCapacity = (label: string, value?: string) => {
                      if (!value) {
                        return value;
                      }
                      const match = value.match(/^(\d+(?:\.\d+)?)KB_(free|available)$/i);
                      if (!match || !["Disk", "Memory"].includes(label)) {
                        return value;
                      }
                      return `${(Number(match[1]) / 1024 / 1024).toFixed(1)} GB ${match[2]}`;
                    };
                    const capabilityBadge = (label: string, value?: string, goodValues: string[] = ["yes"]) => (
                      <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {label}
                        </div>
                        <div className={`mt-1 text-sm font-medium ${value && goodValues.includes(value) ? "text-emerald-500" : "text-foreground"}`}>
                          {formatProbeCapacity(label, value) || "unknown"}
                        </div>
                      </div>
                    );

                    return (
                      <div
                        key={connection.id}
                        className="space-y-4 rounded-xl border border-border bg-card p-4"
                      >
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <p className="font-medium text-foreground">{connection.name}</p>
                              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                {connection.connection_type === "headscale" ? "headscale" : connection.connection_type === "tailscale" ? "tailscale" : connection.auth_type}
                              </span>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {connection.username}@{connection.host}:{connection.port}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {connection.last_tested_at
                                ? `Last tested: ${new Date(connection.last_tested_at).toLocaleString()}`
                                : "Not tested yet"}
                            </p>
                          </div>

                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => testSshConnectionMutation.mutate(connection.id)}
                              disabled={
                                testSshConnectionMutation.isPending ||
                                deleteSshConnectionMutation.isPending ||
                                probeSshConnectionMutation.isPending ||
                                provisionDockerMutation.isPending ||
                                provisionKubernetesMutation.isPending
                              }
                            >
                              {testSshConnectionMutation.isPending &&
                              testSshConnectionMutation.variables === connection.id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <FolderTree className="mr-2 h-4 w-4" />
                              )}
                              Test Connection
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => probeSshConnectionMutation.mutate(connection.id)}
                              disabled={
                                probeSshConnectionMutation.isPending ||
                                deleteSshConnectionMutation.isPending ||
                                testSshConnectionMutation.isPending ||
                                provisionDockerMutation.isPending ||
                                provisionKubernetesMutation.isPending
                              }
                            >
                              {probeSshConnectionMutation.isPending &&
                              probeSshConnectionMutation.variables === connection.id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <Server className="mr-2 h-4 w-4" />
                              )}
                              Probe Host
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setTerminalConnection(connection)}
                              disabled={
                                deleteSshConnectionMutation.isPending ||
                                testSshConnectionMutation.isPending ||
                                probeSshConnectionMutation.isPending ||
                                provisionDockerMutation.isPending ||
                                provisionKubernetesMutation.isPending
                              }
                            >
                              <Terminal className="mr-2 h-4 w-4" />
                              Terminal
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => provisionDockerMutation.mutate({ connectionId: connection.id })}
                              disabled={
                                provisionDockerMutation.isPending ||
                                deleteSshConnectionMutation.isPending ||
                                testSshConnectionMutation.isPending ||
                                probeSshConnectionMutation.isPending ||
                                provisionKubernetesMutation.isPending
                              }
                            >
                              {provisionDockerMutation.isPending &&
                              provisionDockerMutation.variables?.connectionId === connection.id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <Wrench className="mr-2 h-4 w-4" />
                              )}
                              Prepare Docker
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => provisionKubernetesMutation.mutate({ connectionId: connection.id })}
                              disabled={
                                provisionKubernetesMutation.isPending ||
                                provisionDockerMutation.isPending ||
                                deleteSshConnectionMutation.isPending ||
                                testSshConnectionMutation.isPending ||
                                probeSshConnectionMutation.isPending
                              }
                            >
                              {provisionKubernetesMutation.isPending &&
                              provisionKubernetesMutation.variables?.connectionId === connection.id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <Wrench className="mr-2 h-4 w-4" />
                              )}
                              Prepare Kubernetes
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => deleteSshConnectionMutation.mutate(connection.id)}
                              disabled={
                                deleteSshConnectionMutation.isPending ||
                                testSshConnectionMutation.isPending ||
                                probeSshConnectionMutation.isPending ||
                                provisionDockerMutation.isPending ||
                                provisionKubernetesMutation.isPending
                              }
                            >
                              {deleteSshConnectionMutation.isPending &&
                              deleteSshConnectionMutation.variables === connection.id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="mr-2 h-4 w-4" />
                              )}
                              Delete
                            </Button>
                          </div>
                        </div>

                        {probe ? (
                          <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <h4 className="text-sm font-semibold text-foreground">Host Capability Probe</h4>
                                <p className="text-xs text-muted-foreground">
                                  Use this before remote execution so we know whether Docker and the runtime prerequisites are actually ready.
                                </p>
                              </div>
                              <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Probed
                              </div>
                            </div>

                            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                              {capabilityBadge("Docker CLI", capabilities.docker_cli)}
                              {capabilityBadge("Docker Daemon", capabilities.docker_daemon)}
                              {capabilityBadge("Compose", capabilities.docker_compose)}
                              {capabilityBadge("Kubernetes", capabilities.kubernetes_ready)}
                              {capabilityBadge("Kubectl", capabilities.kubectl)}
                              {capabilityBadge("Passwordless sudo", capabilities.sudo_passwordless)}
                              {capabilityBadge("Disk", capabilities.disk, [])}
                              {capabilityBadge("Memory", capabilities.memory, [])}
                            </div>

                            {(capabilities.os || capabilities.user || capabilities.uid) && (
                              <div className="rounded-lg border border-border/70 bg-card px-3 py-2 text-sm text-muted-foreground">
                                {capabilities.os ? `OS: ${capabilities.os}` : "OS: unknown"}
                                {capabilities.user ? ` · User: ${capabilities.user}` : ""}
                                {capabilities.uid ? ` · UID: ${capabilities.uid}` : ""}
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2 text-foreground">
              <Database className="h-5 w-5 text-primary" />
              <CardTitle>Platform Configuration</CardTitle>
            </div>
            <CardDescription>Advanced technical settings for the platform engine.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border/70 bg-muted/30 px-4 py-3">
              <span className="font-medium text-foreground">Build Workspace</span>
              <span className="text-muted-foreground">/app/uploads/builds</span>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border/70 bg-muted/30 px-4 py-3">
              <span className="font-medium text-foreground">Max Build Logs</span>
              <span className="text-muted-foreground">200KB</span>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border/70 bg-muted/30 px-4 py-3">
              <span className="font-medium text-foreground">Docker Engine</span>
              <span className="text-muted-foreground">Connected via Unix socket</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {terminalConnection && (
        <Dialog open={!!terminalConnection} onOpenChange={(open) => !open && setTerminalConnection(null)}>
          <DialogContent className="!flex !h-[min(88dvh,780px)] !w-[min(94vw,64rem)] !max-w-[64rem] !flex-col overflow-hidden rounded-xl border-border bg-card p-0">
            <DialogHeader className="shrink-0 border-b border-border px-6 py-5">
              <DialogTitle className="flex items-center gap-2">
                <Terminal className="h-5 w-5 text-primary" />
                {terminalConnection.name} Terminal
              </DialogTitle>
              <DialogDescription>
                Connected as {terminalConnection.username}@{terminalConnection.host}.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-hidden p-5 pb-7 md:p-6 md:pb-8">
              <RemoteSshTerminal
                connectionId={terminalConnection.id}
                cwd={terminalConnection.username === "root" ? "/root" : `/home/${terminalConnection.username}`}
                className="h-full min-h-0"
              />
            </div>
          </DialogContent>
        </Dialog>
      )}

      <Dialog open={loginHistoryOpen} onOpenChange={setLoginHistoryOpen}>
        <DialogContent className="!flex !w-[min(92vw,760px)] !max-w-[760px] !max-h-[82dvh] flex-col overflow-hidden rounded-2xl p-0">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-5">
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5 text-primary" />
              Login History
            </DialogTitle>
            <DialogDescription>
              Recent successful sign-ins for this account.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-6 scrollbar-thin">
            {loginHistoryQuery.isLoading ? (
              <div className="flex items-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading login history...
              </div>
            ) : (loginHistoryQuery.data?.history ?? []).length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 p-5 text-sm text-muted-foreground">
                No login history has been recorded yet. New successful sign-ins will appear here.
              </div>
            ) : (
              <div className="space-y-3">
                {(loginHistoryQuery.data?.history ?? []).map((entry) => (
                  <div key={entry.id} className="rounded-xl border border-border bg-muted/20 p-4">
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium capitalize text-foreground">{entry.login_method}</span>
                          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                            {entry.device || "Unknown device"}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {formatLoginDay(entry.created_at)} at {formatLoginTime(entry.created_at)}
                        </p>
                      </div>
                      <div className="text-left text-sm md:text-right">
                        <p className="font-mono text-foreground">{entry.ip_address || "Unknown IP"}</p>
                        <p className="max-w-[28rem] truncate text-xs text-muted-foreground">
                          {entry.user_agent || "No user agent recorded"}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={auditLogsOpen} onOpenChange={setAuditLogsOpen}>
        <DialogContent className="!flex !w-[min(92vw,840px)] !max-w-[840px] !max-h-[82dvh] flex-col overflow-hidden rounded-2xl p-0">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-5">
            <DialogTitle className="flex items-center gap-2">
              <ScrollText className="h-5 w-5 text-primary" />
              Audit Logs
            </DialogTitle>
            <DialogDescription>
              Recent security-relevant account, project, deployment, and runtime events.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-6 scrollbar-thin">
            {auditLogsQuery.isLoading ? (
              <div className="flex items-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading audit logs...
              </div>
            ) : (auditLogsQuery.data?.logs ?? []).length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 p-5 text-sm text-muted-foreground">
                No audit events have been recorded yet. New sensitive actions will appear here.
              </div>
            ) : (
              <div className="space-y-3">
                {(auditLogsQuery.data?.logs ?? []).map((entry) => (
                  <div key={entry.id} className="rounded-xl border border-border bg-muted/20 p-4">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{entry.action.replaceAll(".", " ")}</span>
                          {entry.target_type && (
                            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] uppercase text-muted-foreground">
                              {entry.target_type}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {formatLoginDay(entry.created_at)} at {formatLoginTime(entry.created_at)}
                        </p>
                        {Object.keys(entry.metadata ?? {}).length > 0 && (
                          <pre className="mt-3 max-h-28 overflow-auto rounded-lg bg-background/80 p-3 text-xs text-muted-foreground scrollbar-thin">
                            {JSON.stringify(entry.metadata, null, 2)}
                          </pre>
                        )}
                      </div>
                      <div className="min-w-0 text-left text-sm md:text-right">
                        <p className="font-mono text-foreground">{entry.ip_address || "Unknown IP"}</p>
                        <p className="max-w-[28rem] truncate text-xs text-muted-foreground">
                          {entry.user_agent || "No user agent recorded"}
                        </p>
                        {entry.target_id && (
                          <p className="mt-1 max-w-[18rem] truncate font-mono text-xs text-muted-foreground">
                            {entry.target_id}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!sudoPasswordDialog}
        onOpenChange={(open) => {
          if (!open) {
            setSudoPasswordDialog(null);
            setSudoPasswordInput("");
            setShowSudoPassword(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-primary" />
              Sudo Password Required
            </DialogTitle>
            <DialogDescription>
              This server requires a password for <code>sudo</code>.
              Enter the server user password to proceed with{" "}
              {sudoPasswordDialog?.action === "docker" ? "Docker" : "Kubernetes"} provisioning.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!sudoPasswordDialog || !sudoPasswordInput.trim()) return;
              const { connectionId, action } = sudoPasswordDialog;
              setSudoPasswordDialog(null);
              if (action === "docker") {
                provisionDockerMutation.mutate({ connectionId, sudoPassword: sudoPasswordInput });
              } else {
                provisionKubernetesMutation.mutate({ connectionId, sudoPassword: sudoPasswordInput });
              }
              setSudoPasswordInput("");
              setShowSudoPassword(false);
            }}
            className="space-y-4"
          >
            <div className="grid gap-2">
              <Label htmlFor="sudo-password">Server Password</Label>
              <div className="relative">
                <Input
                  id="sudo-password"
                  type={showSudoPassword ? "text" : "password"}
                  value={sudoPasswordInput}
                  onChange={(e) => setSudoPasswordInput(e.target.value)}
                  placeholder="Enter sudo password"
                  className="pr-10"
                  autoFocus
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
                  onClick={() => setShowSudoPassword((current) => !current)}
                  aria-label={showSudoPassword ? "Hide password" : "Show password"}
                >
                  {showSudoPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                This password is used once for this operation and is not stored.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSudoPasswordDialog(null);
                  setSudoPasswordInput("");
                  setShowSudoPassword(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!sudoPasswordInput.trim()}>
                <Lock className="mr-2 h-4 w-4" />
                Continue
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
