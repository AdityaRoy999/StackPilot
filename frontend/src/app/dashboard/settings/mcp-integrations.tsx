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
import { Loader2, Key, KeyRound, TerminalSquare, Copy, Trash2, ExternalLink } from "lucide-react";
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

  const getIdeConfig = (token: string) => {
    const serverPath = process.env.NEXT_PUBLIC_STACKPILOT_MCP_SERVER_PATH || "/absolute/path/to/StackPilot/mcp-server/src/index.js";
    const localProjectsRoot =
      process.env.NEXT_PUBLIC_STACKPILOT_LOCAL_PROJECTS_HOST_ROOT || "/absolute/path/to/StackPilot/local-projects";
    
    const config = {
      mcpServers: {
        "stackpilot-platform": {
          command: "node",
          args: [serverPath],
          env: {
            STACKPILOT_MCP_TOKEN: token,
            STACKPILOT_API_URL: "http://localhost:8090/api/v1",
            STACKPILOT_FRONTEND_URL: "http://localhost:3000",
            STACKPILOT_LOCAL_PROJECTS_HOST_ROOT: localProjectsRoot,
            STACKPILOT_LOCAL_PROJECTS_CONTAINER_ROOT: "/app/local-projects",
          },
        },
      },
    };
    return JSON.stringify(config, null, 2);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 text-foreground">
          <TerminalSquare className="h-5 w-5 text-primary" />
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
            <Key className="mr-2 h-4 w-4" />
            Generate New Token
          </Button>
        </div>

        {query.isLoading ? (
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
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
                <KeyRound className="h-5 w-5 text-primary" />
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
                {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={!!newToken} onOpenChange={(open) => !open && setNewToken(null)}>
          <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-emerald-500">
                <KeyRound className="h-5 w-5" />
                Token Generated Successfully
              </DialogTitle>
              <DialogDescription>
                Copy your token now. You will not be able to see it again!
              </DialogDescription>
            </DialogHeader>
            
            <div className="space-y-6 py-2">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3">
                <code className="flex-1 overflow-x-auto text-sm text-foreground">
                  {newToken?.raw}
                </code>
                <Button variant="secondary" size="icon" onClick={() => handleCopy(newToken?.raw || "", "Token")} className="shrink-0">
                  <Copy className="h-4 w-4" />
                </Button>
              </div>

              <div className="space-y-3">
                <h4 className="font-medium text-foreground">IDE Setup Instructions</h4>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={ideSelect === "vscode" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setIdeSelect("vscode")}
                  >
                    VS Code / Roo
                  </Button>
                  <Button
                    variant={ideSelect === "cursor" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setIdeSelect("cursor")}
                  >
                    Cursor
                  </Button>
                  <Button
                    variant={ideSelect === "claude" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setIdeSelect("claude")}
                  >
                    Claude Desktop
                  </Button>
                  <Button
                    variant={ideSelect === "claude-code" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setIdeSelect("claude-code")}
                  >
                    Claude Code
                  </Button>
                  <Button
                    variant={ideSelect === "codex" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setIdeSelect("codex")}
                  >
                    Codex
                  </Button>
                  <Button
                    variant={ideSelect === "antigravity" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setIdeSelect("antigravity")}
                  >
                    Antigravity / Gemini
                  </Button>
                </div>

                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  {ideSelect === "cursor" ? (
                    <div className="space-y-3 text-sm text-muted-foreground">
                      <p>1. Open Cursor Settings <code className="text-xs">Ctrl/Cmd + Shift + J</code></p>
                      <p>2. Go to <strong>Features &gt; MCP</strong></p>
                      <p>3. Add this server config. The local deploy tool stages any IDE workspace into StackPilot local mode automatically:</p>
                      <div className="relative mt-2">
                        <pre className="p-3 bg-background rounded-lg border overflow-x-auto text-xs font-mono">
                          {newToken ? getIdeConfig(newToken.raw) : ""}
                        </pre>
                        <Button variant="secondary" size="icon" onClick={() => handleCopy(newToken ? getIdeConfig(newToken.raw) : "", "Config")} className="absolute top-2 right-2 h-7 w-7 opacity-70 hover:opacity-100 transition-opacity">
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ) : ideSelect === "claude" ? (
                    <div className="space-y-3 text-sm text-muted-foreground">
                      <p>1. Open Claude Desktop</p>
                      <p>2. Open Settings and go to the <strong>Developer</strong> section</p>
                      <p>3. Click <strong>Edit Config</strong>. Add this to the <code className="text-xs">mcpServers</code> section:</p>
                      <div className="relative mt-2">
                        <pre className="p-3 bg-background rounded-lg border overflow-x-auto text-xs font-mono">
                          {newToken ? getIdeConfig(newToken.raw) : ""}
                        </pre>
                        <Button variant="secondary" size="icon" onClick={() => handleCopy(newToken ? getIdeConfig(newToken.raw) : "", "Config")} className="absolute top-2 right-2 h-7 w-7 opacity-70 hover:opacity-100 transition-opacity">
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ) : ideSelect === "vscode" ? (
                    <div className="space-y-3 text-sm text-muted-foreground">
                      <p>1. Ensure you have the <a href="https://marketplace.visualstudio.com/items?itemName=RooVeterinaryInc.roo-cline" target="_blank" className="text-primary hover:underline inline-flex items-center gap-1">Roo Code <ExternalLink className="h-3 w-3" /></a> extension installed</p>
                      <p>2. Click the MCP Servers icon (🧩) in the Roo sidebar</p>
                      <p>3. Add the following to your <code className="text-xs">cline_mcp_settings.json</code>:</p>
                      <div className="relative mt-2">
                        <pre className="p-3 bg-background rounded-lg border overflow-x-auto text-xs font-mono">
                          {newToken ? getIdeConfig(newToken.raw) : ""}
                        </pre>
                        <Button variant="secondary" size="icon" onClick={() => handleCopy(newToken ? getIdeConfig(newToken.raw) : "", "Config")} className="absolute top-2 right-2 h-7 w-7 opacity-70 hover:opacity-100 transition-opacity">
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ) : ideSelect === "claude-code" || ideSelect === "codex" ? (
                    <div className="space-y-3 text-sm text-muted-foreground">
                      <p>1. Add the StackPilot MCP server to your agent MCP configuration.</p>
                      <p>2. Use the tool <strong>STACKPILOT_deploy_local_project</strong> when the prompt says deploy the current local project.</p>
                      <div className="relative mt-2">
                        <pre className="p-3 bg-background rounded-lg border overflow-x-auto text-xs font-mono">
                          {newToken ? getIdeConfig(newToken.raw) : ""}
                        </pre>
                        <Button variant="secondary" size="icon" onClick={() => handleCopy(newToken ? getIdeConfig(newToken.raw) : "", "Config")} className="absolute top-2 right-2 h-7 w-7 opacity-70 hover:opacity-100 transition-opacity">
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3 text-sm text-muted-foreground">
                      <p>1. For Antigravity, Gemini CLI, or any standard stdio MCP client, add this server config:</p>
                      <div className="relative mt-2">
                        <pre className="p-3 bg-background rounded-lg border overflow-x-auto text-xs font-mono">
                          {newToken ? getIdeConfig(newToken.raw) : ""}
                        </pre>
                        <Button variant="secondary" size="icon" onClick={() => handleCopy(newToken ? getIdeConfig(newToken.raw) : "", "Config")} className="absolute top-2 right-2 h-7 w-7 opacity-70 hover:opacity-100 transition-opacity">
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  )}
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
