"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, Eye, KeyRound, Loader2, Plus, Search, Trash2 } from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { toast } from "sonner";

import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Secret {
  id: string;
  project_id: string;
  project_name?: string;
  key: string;
  description: string;
  environment_id: string;
  environment_name: string;
  version: number;
  last_accessed_at: string;
  updated_at: string;
}

interface Project {
  id: string;
  name: string;
}

interface ProjectEnvironment {
  id: string;
  name: string;
}

const ALL_ENVIRONMENTS = "__all__";

function formatTimestamp(value: string) {
  if (!value) return "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default function SecretsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState(ALL_ENVIRONMENTS);
  const [secretKey, setSecretKey] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [description, setDescription] = useState("");
  const [revealed, setRevealed] = useState<{ key: string; value: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Secret | null>(null);

  const secretsQuery = useQuery({
    queryKey: ["secrets"],
    queryFn: async () => {
      const res = await api.get<{ secrets?: Secret[]; count?: number }>("/secrets");
      return res.data;
    },
  });

  const projectsQuery = useQuery({
    queryKey: ["projects", "secrets-picker"],
    queryFn: async () => {
      const res = await api.get<{ projects?: Project[] }>("/projects");
      return res.data;
    },
  });

  // Environments are per project, so this refetches whenever the picker changes.
  const environmentsQuery = useQuery({
    queryKey: ["project-environments", projectId, "secrets-picker"],
    queryFn: async () => {
      const res = await api.get<{ environments?: ProjectEnvironment[] }>(
        `/projects/${projectId}/environments`
      );
      return res.data;
    },
    enabled: Boolean(projectId),
  });

  const secrets = useMemo(
    () => (Array.isArray(secretsQuery.data?.secrets) ? secretsQuery.data.secrets : []),
    [secretsQuery.data]
  );
  const projects = useMemo(
    () => (Array.isArray(projectsQuery.data?.projects) ? projectsQuery.data.projects : []),
    [projectsQuery.data]
  );
  const environments = useMemo(
    () => (Array.isArray(environmentsQuery.data?.environments) ? environmentsQuery.data.environments : []),
    [environmentsQuery.data]
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return secrets;
    return secrets.filter((secret) =>
      [secret.key, secret.project_name, secret.environment_name, secret.description]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle))
    );
  }, [search, secrets]);

  const resetForm = () => {
    setSecretKey("");
    setSecretValue("");
    setDescription("");
    setEnvironmentId(ALL_ENVIRONMENTS);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post(`/projects/${projectId}/secrets`, {
        key: secretKey,
        value: secretValue,
        description,
        environment_id: environmentId === ALL_ENVIRONMENTS ? "" : environmentId,
      });
      return res.data as { version?: number };
    },
    onSuccess: (data) => {
      toast.success(
        (data?.version ?? 1) > 1 ? `Secret updated to version ${data.version}` : "Secret created"
      );
      setDialogOpen(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["secrets"] });
    },
    onError: (error: unknown) => {
      const message =
        error && typeof error === "object" && "response" in error
          ? ((error as { response?: { data?: { error?: string } } }).response?.data?.error ?? "")
          : "";
      toast.error(message || "Failed to save secret");
    },
  });

  const revealMutation = useMutation({
    mutationFn: async (secret: Secret) => {
      const res = await api.post(`/projects/${secret.project_id}/secrets/${secret.id}/reveal`, {});
      return res.data as { key: string; value: string };
    },
    onSuccess: (data) => {
      setRevealed(data);
      queryClient.invalidateQueries({ queryKey: ["secrets"] });
    },
    onError: () => toast.error("Failed to reveal secret"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (secret: Secret) => {
      await api.delete(`/projects/${secret.project_id}/secrets/${secret.id}`);
    },
    onSuccess: () => {
      toast.success("Secret deleted");
      setPendingDelete(null);
      queryClient.invalidateQueries({ queryKey: ["secrets"] });
    },
    onError: () => toast.error("Failed to delete secret"),
  });

  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Unable to copy");
    }
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
            <AppIcon name="key-round" fallback={KeyRound} className="h-7 w-7 text-primary"  />
            Secrets
          </h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            Encrypted at rest and injected at deploy time. Values are never returned by the list API —
            revealing one is recorded in the audit log.
          </p>
        </div>
        <Button
          onClick={() => {
            resetForm();
            setProjectId(projects[0]?.id ?? "");
            setDialogOpen(true);
          }}
          disabled={projects.length === 0}
        >
          <AppIcon name="plus" fallback={Plus} className="mr-2 h-4 w-4"  />
          New secret
        </Button>
      </section>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Stored secrets</CardTitle>
              <CardDescription>
                {secrets.length} secret{secrets.length === 1 ? "" : "s"} across your projects
              </CardDescription>
            </div>
            <div className="relative w-full sm:max-w-xs">
              <AppIcon name="search" fallback={Search} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"  />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by key, project or environment"
                className="pl-10"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {secretsQuery.isLoading ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  />
              Loading secrets…
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border py-12 text-center">
              <AppIcon name="key-round" fallback={KeyRound} className="mx-auto mb-3 h-8 w-8 text-muted-foreground"  />
              <p className="font-medium">
                {secrets.length === 0 ? "No secrets yet" : "No secrets match that search"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {secrets.length === 0
                  ? "Add API keys, database URLs and tokens here instead of committing them."
                  : "Try a different search term."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Key</th>
                    <th className="pb-2 pr-4 font-medium">Project</th>
                    <th className="pb-2 pr-4 font-medium">Environment</th>
                    <th className="pb-2 pr-4 font-medium">Version</th>
                    <th className="pb-2 pr-4 font-medium">Last revealed</th>
                    <th className="pb-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((secret) => (
                    <tr key={secret.id} className="border-b border-border/60 last:border-0">
                      <td className="py-3 pr-4">
                        <div className="font-mono font-medium text-foreground">{secret.key}</div>
                        {secret.description && (
                          <div className="mt-0.5 text-xs text-muted-foreground">{secret.description}</div>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">{secret.project_name || "—"}</td>
                      <td className="py-3 pr-4 text-muted-foreground">{secret.environment_name}</td>
                      <td className="py-3 pr-4 text-muted-foreground">v{secret.version}</td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {formatTimestamp(secret.last_accessed_at)}
                      </td>
                      <td className="py-3">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title="Reveal value (audited)"
                            onClick={() => revealMutation.mutate(secret)}
                            disabled={revealMutation.isPending}
                          >
                            <AppIcon name="eye" fallback={Eye} className="h-4 w-4"  />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title="Delete secret"
                            onClick={() => setPendingDelete(secret)}
                          >
                            <AppIcon name="trash2" fallback={Trash2} className="h-4 w-4 text-destructive"  />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create / update */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New secret</DialogTitle>
            <DialogDescription>
              Saving an existing key creates a new version rather than a duplicate.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="secret-project">Project</Label>
              {/* This Select can emit null on clear, so coalesce rather than
                  passing the setter directly. */}
              <Select value={projectId} onValueChange={(value) => setProjectId(value ?? "")}>
                <SelectTrigger id="secret-project">
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="secret-environment">Environment</Label>
              <Select
                value={environmentId}
                onValueChange={(value) => setEnvironmentId(value ?? ALL_ENVIRONMENTS)}
              >
                <SelectTrigger id="secret-environment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_ENVIRONMENTS}>All environments</SelectItem>
                  {environments.map((environment) => (
                    <SelectItem key={environment.id} value={environment.id}>
                      {environment.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="secret-key">Key</Label>
              <Input
                id="secret-key"
                value={secretKey}
                onChange={(event) => setSecretKey(event.target.value.toUpperCase())}
                placeholder="DATABASE_URL"
                className="font-mono"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Letters, digits and underscore only; cannot start with a digit.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="secret-value">Value</Label>
              <Input
                id="secret-value"
                type="password"
                value={secretValue}
                onChange={(event) => setSecretValue(event.target.value)}
                placeholder="Paste the secret value"
                className="font-mono"
                autoComplete="off"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="secret-description">Description (optional)</Label>
              <Input
                id="secret-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this is used for"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!projectId || !secretKey.trim() || !secretValue || saveMutation.isPending}
            >
              {saveMutation.isPending && <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />}
              Save secret
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reveal */}
      <Dialog open={!!revealed} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono">{revealed?.key}</DialogTitle>
            <DialogDescription>
              This access has been recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-sm">{revealed?.value}</code>
            <Button
              size="icon"
              variant="secondary"
              className="shrink-0"
              onClick={() => copyValue(revealed?.value ?? "")}
            >
              <AppIcon name="copy" fallback={Copy} className="h-4 w-4"  />
            </Button>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => setRevealed(null)}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="mx-auto mb-1 flex h-10 w-10 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10">
              <AppIcon name="alert-triangle" fallback={AlertTriangle} className="h-5 w-5 text-destructive"  />
            </div>
            <DialogTitle className="text-center">Delete secret?</DialogTitle>
            <DialogDescription className="text-center">
              <span className="font-mono font-medium text-foreground">{pendingDelete?.key}</span> will be
              removed. Deployments that rely on it will fail until it is replaced.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
