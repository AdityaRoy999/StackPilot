import { type ReactNode, useState } from "react";
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
import { Loader2, Key, KeyRound, TerminalSquare, Copy, Trash2, ExternalLink } from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { toast } from "sonner";

interface McpToken {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  last_used_at: string;
  expires_at: string;
  created_at: string;
}

interface McpTokensResponse {
  tokens: McpToken[];
  count: number;
}

export function McpIntegrations() {
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [newToken, setNewToken] = useState<{ raw: string; name: string } | null>(null);
  const [ideSelect, setIdeSelect] = useState<"vscode" | "cursor" | "claude" | "claude-code" | "codex" | "antigravity">("vscode");

  const query = useQuery({
    queryKey: ["mcp-tokens"],
    queryFn: async () => {
      const res = await api.get("/mcp/tokens");
      return res.data as McpTokensResponse;
    },
  });

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await api.post("/mcp/tokens", { name });
      return res.data as { token: string; name: string };
    },
    onSuccess: (data) => {
      setNewToken({ raw: data.token, name: data.name });
      setTokenName("");
      queryClient.invalidateQueries({ queryKey: ["mcp-tokens"] });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to create token"
          : "Failed to create token";
      toast.error(message);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.delete(`/mcp/tokens/${id}`);
      return res.data;
    },
    onSuccess: () => {
      toast.success("Token revoked successfully");
      queryClient.invalidateQueries({ queryKey: ["mcp-tokens"] });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to revoke token"
          : "Failed to revoke token";
      toast.error(message);
    },
  });

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  const tokens = query.data?.tokens || [];

  const serverPath =
    process.env.NEXT_PUBLIC_STACKPILOT_MCP_SERVER_PATH || "/absolute/path/to/StackPilot/mcp-server/src/index.js";
  const localProjectsRoot =
    process.env.NEXT_PUBLIC_STACKPILOT_LOCAL_PROJECTS_HOST_ROOT || "/absolute/path/to/StackPilot/local-projects";

  const serverEnv = (token: string) => ({
    STACKPILOT_MCP_TOKEN: token,
    STACKPILOT_API_URL: "http://localhost:8090/api/v1",
    STACKPILOT_FRONTEND_URL: "http://localhost:3000",
    STACKPILOT_LOCAL_PROJECTS_HOST_ROOT: localProjectsRoot,
    STACKPILOT_LOCAL_PROJECTS_CONTAINER_ROOT: "/app/local-projects",
  });

  // Every client below reads `mcpServers` JSON except Codex, which uses TOML.
  const getIdeConfig = (token: string) =>
    JSON.stringify(
      {
        mcpServers: {
          "stackpilot-platform": { command: "node", args: [serverPath], env: serverEnv(token) },
        },
      },
      null,
      2
    );

  // Codex reads ~/.codex/config.toml, where servers are TOML tables, not JSON.
  const getCodexConfig = (token: string) => {
    const env = serverEnv(token);
    const envLines = Object.entries(env)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
      .join("\n");
    return [
      `[mcp_servers.stackpilot-platform]`,
      `command = "node"`,
      `args = [${JSON.stringify(serverPath)}]`,
      ``,
      `[mcp_servers.stackpilot-platform.env]`,
      envLines,
    ].join("\n");
  };

  // Claude Code registers servers through its CLI rather than a hand-edited file.
  const getClaudeCodeCommand = (token: string) => {
    const env = serverEnv(token);
    const envFlags = Object.entries(env)
      .map(([key, value]) => `  --env ${key}=${value}`)
      .join(" \\\n");
    return `claude mcp add stackpilot-platform \\\n${envFlags} \\\n  -- node ${serverPath}`;
  };

  const ideGuides: {
    id: typeof ideSelect;
    label: string;
    file: string;
    lang: string;
    snippet: (token: string) => string;
    steps: ReactNode[];
  }[] = [
    {
      id: "vscode",
      label: "VS Code / Roo",
      file: "cline_mcp_settings.json",
      lang: "json",
      snippet: getIdeConfig,
      steps: [
        <>
          Install the{" "}
          <a
            href="https://marketplace.visualstudio.com/items?itemName=RooVeterinaryInc.roo-cline"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Roo Code <AppIcon name="external-link" fallback={ExternalLink} className="h-3 w-3"  />
          </a>{" "}
          extension.
        </>,
        <>Open the MCP Servers panel in the Roo sidebar and choose Edit Configuration.</>,
        <>
          Merge this into <code className="rounded bg-muted px-1 py-0.5 text-xs">cline_mcp_settings.json</code>:
        </>,
      ],
    },
    {
      id: "cursor",
      label: "Cursor",
      file: "~/.cursor/mcp.json",
      lang: "json",
      snippet: getIdeConfig,
      steps: [
        <>
          Open Cursor Settings and go to <strong>MCP</strong> (older builds: Features &gt; MCP).
        </>,
        <>
          Add the server to <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.cursor/mcp.json</code>, or{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">.cursor/mcp.json</code> for a single project:
        </>,
      ],
    },
    {
      id: "claude",
      label: "Claude Desktop",
      file: "claude_desktop_config.json",
      lang: "json",
      snippet: getIdeConfig,
      steps: [
        <>
          Open Claude Desktop, then Settings &rarr; <strong>Developer</strong> &rarr; <strong>Edit Config</strong>.
        </>,
        <>
          Merge this into <code className="rounded bg-muted px-1 py-0.5 text-xs">claude_desktop_config.json</code> and
          restart Claude Desktop:
        </>,
      ],
    },
    {
      id: "claude-code",
      label: "Claude Code",
      file: "terminal",
      lang: "bash",
      snippet: getClaudeCodeCommand,
      steps: [
        <>Register the server from your terminal — Claude Code writes the config for you:</>,
        <>
          Add <code className="rounded bg-muted px-1 py-0.5 text-xs">-s project</code> to share it with your team via{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">.mcp.json</code>, or{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">-s user</code> for every project on this machine.
        </>,
      ],
    },
    {
      id: "codex",
      label: "Codex",
      file: "~/.codex/config.toml",
      lang: "toml",
      snippet: getCodexConfig,
      steps: [
        <>
          Codex reads TOML, not JSON. Open{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.codex/config.toml</code>.
        </>,
        <>Append these tables:</>,
      ],
    },
    {
      id: "antigravity",
      label: "Antigravity / Gemini",
      file: "~/.gemini/settings.json",
      lang: "json",
      snippet: getIdeConfig,
      steps: [
        <>
          For Gemini CLI, add this to <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.gemini/settings.json</code>.
          Any other stdio MCP client takes the same block:
        </>,
      ],
    },
  ];

  const activeGuide = ideGuides.find((guide) => guide.id === ideSelect) ?? ideGuides[0];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 text-foreground">
          <AppIcon name="terminal-square" fallback={TerminalSquare} className="h-5 w-5 text-primary"  />
          <CardTitle>MCP Integrations</CardTitle>
        </div>
        <CardDescription>
          Generate tokens for the Model Context Protocol so IDE agents like VS Code, Antigravity, Claude Code, Cursor, Codex, and Gemini CLI can deploy local projects through StackPilot.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            You have {tokens.length} / 10 active tokens.
          </p>
          <Button onClick={() => setIsDialogOpen(true)} disabled={tokens.length >= 10}>
            <AppIcon name="key" fallback={Key} className="mr-2 h-4 w-4"  />
            Generate New Token
          </Button>
        </div>

        {query.isLoading ? (
          <div className="flex items-center text-sm text-muted-foreground">
            <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />
            Loading MCP tokens...
          </div>
        ) : tokens.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
            No MCP tokens generated yet. Create one to connect your IDE.
          </div>
        ) : (
          <div className="space-y-3">
            {tokens.map((token) => (
              <div key={token.id} className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-foreground">{token.name}</p>
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {token.prefix}...
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Created: {new Date(token.created_at).toLocaleDateString()}
                    {token.last_used_at ? ` · Last used: ${new Date(token.last_used_at).toLocaleDateString()}` : " · Never used"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive shrink-0"
                  onClick={() => revokeMutation.mutate(token.id)}
                  disabled={revokeMutation.isPending}
                >
                  {revokeMutation.isPending && revokeMutation.variables === token.id ? (
                    <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />
                  ) : (
                    <AppIcon name="trash2" fallback={Trash2} className="mr-2 h-4 w-4"  />
                  )}
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AppIcon name="key-round" fallback={KeyRound} className="h-5 w-5 text-primary"  />
                Generate MCP Token
              </DialogTitle>
              <DialogDescription>
                This token provides full API access to your account. Do not share it.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor="token-name">Integration Name</Label>
                <Input
                  id="token-name"
                  placeholder="e.g., Cursor IDE, Claude Desktop"
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => createMutation.mutate(tokenName)}
                disabled={!tokenName.trim() || createMutation.isPending}
              >
                {createMutation.isPending && <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />}
                Generate
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={!!newToken} onOpenChange={(open) => !open && setNewToken(null)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto overflow-x-hidden sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-emerald-500">
                <AppIcon name="key-round" fallback={KeyRound} className="h-5 w-5"  />
                Token Generated Successfully
              </DialogTitle>
              <DialogDescription>
                Copy your token now. You will not be able to see it again!
              </DialogDescription>
            </DialogHeader>
            
            <div className="min-w-0 space-y-6 py-2">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3">
                {/* min-w-0 lets the code block shrink so long tokens wrap instead of
                    widening the dialog and forcing a horizontal scrollbar. */}
                <code className="min-w-0 flex-1 break-all font-mono text-sm text-foreground">
                  {newToken?.raw}
                </code>
                <Button variant="secondary" size="icon" onClick={() => handleCopy(newToken?.raw || "", "Token")} className="shrink-0">
                  <AppIcon name="copy" fallback={Copy} className="h-4 w-4"  />
                </Button>
              </div>

              <div className="space-y-3">
                <h4 className="font-medium text-foreground">IDE Setup Instructions</h4>
                <div className="flex flex-wrap gap-2">
                  {ideGuides.map((guide) => (
                    <Button
                      key={guide.id}
                      variant={ideSelect === guide.id ? "default" : "outline"}
                      size="sm"
                      onClick={() => setIdeSelect(guide.id)}
                    >
                      {guide.label}
                    </Button>
                  ))}
                </div>

                <div className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
                  <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground marker:text-muted-foreground">
                    {activeGuide.steps.map((step, index) => (
                      <li key={index}>{step}</li>
                    ))}
                  </ol>
                  <div className="relative min-w-0">
                    <div className="flex items-center justify-between gap-2 rounded-t-lg border border-b-0 border-border bg-muted/60 px-3 py-1.5">
                      <span className="truncate font-mono text-xs text-muted-foreground">{activeGuide.file}</span>
                      <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {activeGuide.lang}
                      </span>
                    </div>
                    {/* Only this pre scrolls sideways, so a long path never widens the dialog. */}
                    <pre className="max-h-72 overflow-auto rounded-b-lg border border-border bg-background p-3 text-xs font-mono leading-relaxed">
                      {newToken ? activeGuide.snippet(newToken.raw) : ""}
                    </pre>
                    <Button
                      variant="secondary"
                      size="icon"
                      onClick={() => handleCopy(newToken ? activeGuide.snippet(newToken.raw) : "", "Config")}
                      className="absolute right-2 top-11 h-7 w-7 opacity-70 transition-opacity hover:opacity-100"
                      aria-label="Copy configuration"
                    >
                      <AppIcon name="copy" fallback={Copy} className="h-3 w-3"  />
                    </Button>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="flex justify-end pt-2">
              <Button onClick={() => setNewToken(null)}>
                I have saved my token
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
