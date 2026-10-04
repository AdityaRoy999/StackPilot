"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { Check, Plus, Pencil, Trash2, Loader2, Server } from "@/lib/platform-icons";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProviderLogo } from "./ProviderLogo";

export interface ProviderConnection {
  id: string; name: string; vendor: string;
  provider: "nvidia_nim" | "openai_compatible";
  base_url: string; active: boolean; has_key: boolean;
}
const presets = [
  { vendor: "nvidia", name: "NVIDIA NIM", provider: "nvidia_nim", base_url: "https://integrate.api.nvidia.com/v1" },
  { vendor: "openai", name: "OpenAI", provider: "openai_compatible", base_url: "https://api.openai.com/v1" },
  { vendor: "openrouter", name: "OpenRouter", provider: "openai_compatible", base_url: "https://openrouter.ai/api/v1" },
  { vendor: "groq", name: "Groq", provider: "openai_compatible", base_url: "https://api.groq.com/openai/v1" },
  { vendor: "custom", name: "Custom compatible API", provider: "openai_compatible", base_url: "" },
] as const;
type Draft = { id?: string; name: string; vendor: string; provider: string; base_url: string; api_key: string; has_key?: boolean };

export function AiProviderConnections({ onActivated }: { onActivated: (connection?: ProviderConnection) => void | Promise<void> }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const settings = useQuery({ queryKey: ["ai-settings"], queryFn: async () => (await api.get("/ai/settings")).data });
  const connections: ProviderConnection[] = settings.data?.provider_connections || [];
  const mutation = useMutation({
    mutationFn: async (connection: Record<string, unknown>) => (await api.put("/ai/settings", { provider_connection: connection })).data,
    onSuccess: async (data, input) => {
      if (input.name) setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["ai-settings"] });
      if (Object.hasOwn(input, "active") || input.remove) await onActivated(data.provider_connections?.find((c: ProviderConnection) => c.active));
    },
  });
  const error = mutation.error instanceof AxiosError ? mutation.error.response?.data?.error : "Could not save the provider connection.";
  const selectPreset = (vendor: string) => {
    const preset = presets.find((p) => p.vendor === vendor) || presets[4];
    setDraft({ ...preset, api_key: "" });
    mutation.reset();
  };

  return <section className="space-y-4" aria-label="AI provider connections">
    <div className="flex items-start justify-between gap-3">
      <div><h3 className="text-sm font-semibold">AI providers</h3><p className="mt-1 text-xs text-muted-foreground">Save multiple connections and choose which one answers your requests.</p></div>
      <Button size="sm" variant="outline" onClick={() => selectPreset("custom")} disabled={mutation.isPending}><Plus size={16} /> Add</Button>
    </div>
    {settings.isError && <p role="alert" className="text-sm text-destructive">Could not load providers. <button className="underline" onClick={() => settings.refetch()}>Retry</button></p>}
    {settings.isPending && <Loader2 size={20} className="animate-spin" aria-label="Loading providers" />}
    <div className="space-y-2">
      <div className="flex items-center gap-3 rounded-xl border border-border p-3">
        <Server size={22} />
        <div className="min-w-0 flex-1"><p className="text-sm font-medium">Default configuration</p><p className="text-xs text-muted-foreground">Use your existing AI configuration.</p></div>
        <Button size="sm" variant="secondary" disabled={mutation.isPending || !connections.some((connection) => connection.active)} onClick={() => mutation.mutate({ id: connections.find((connection) => connection.active)?.id, active: false })}>
          {connections.some((connection) => connection.active) ? "Use default" : <><Check size={14} />Active</>}
        </Button>
      </div>
      {connections.map((connection) => <div key={connection.id} className={`flex items-center gap-3 rounded-xl border p-3 ${connection.active ? "border-primary/50 bg-primary/5" : "border-border"}`}>
        <ProviderLogo provider={connection.vendor} size={22} />
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{connection.name}</p><p className="truncate text-xs text-muted-foreground">{connection.has_key ? "Key saved" : "No saved key"} · {connection.provider === "nvidia_nim" ? "NVIDIA NIM" : "Compatible API"}</p></div>
        <Button size="sm" variant={connection.active ? "secondary" : "outline"} disabled={connection.active || mutation.isPending} onClick={() => mutation.mutate({ id: connection.id, active: true })}>{connection.active ? <Check size={14} /> : null}{connection.active ? "Active" : "Use"}</Button>
        <Button size="icon-sm" variant="ghost" aria-label={`Edit ${connection.name}`} disabled={mutation.isPending} onClick={() => { mutation.reset(); setDraft({ ...connection, api_key: "" }); }}><Pencil size={15} /></Button>
        <Button size="icon-sm" variant="ghost" aria-label={`Remove ${connection.name}`} disabled={mutation.isPending} onClick={() => mutation.mutate({ id: connection.id, remove: true })}><Trash2 size={15} /></Button>
      </div>)}
      {!settings.isPending && !settings.isError && connections.length === 0 && <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground"><Server size={20} className="mb-2" />Your current platform provider stays available. Add a connection to save and switch between your own providers.</div>}
    </div>
    {draft && <form onSubmit={(event) => { event.preventDefault(); mutation.mutate({ ...draft, active: !draft.id || connections.find((c) => c.id === draft.id)?.active }); }} className="grid gap-3 rounded-xl border bg-muted/20 p-4">
      {!draft.id && <div className="flex flex-wrap gap-2" aria-label="Provider presets">{presets.map((preset) => <Button key={preset.vendor} type="button" size="sm" variant={draft.vendor === preset.vendor ? "secondary" : "outline"} onClick={() => selectPreset(preset.vendor)}><ProviderLogo provider={preset.vendor} size={16} />{preset.name}</Button>)}</div>}
      <div className="space-y-1.5"><Label htmlFor="provider-name">Connection name</Label><Input id="provider-name" required maxLength={120} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
      {draft.provider === "openai_compatible" && <div className="space-y-1.5"><Label htmlFor="provider-endpoint">API endpoint</Label><Input id="provider-endpoint" type="url" required placeholder="https://your-provider.example/v1" value={draft.base_url} onChange={(e) => setDraft({ ...draft, base_url: e.target.value })} /><p className="text-xs text-muted-foreground">Public HTTPS endpoint supporting the OpenAI chat and models API.</p></div>}
      <div className="space-y-1.5"><Label htmlFor="provider-key">API key</Label><Input id="provider-key" type="password" autoComplete="new-password" value={draft.api_key} placeholder={draft.has_key ? "Leave blank to keep the saved key" : "Enter API key"} onChange={(e) => setDraft({ ...draft, api_key: e.target.value })} /><p className="text-xs text-muted-foreground">Encrypted on the server. Saved keys are never returned to the browser.</p></div>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={mutation.isPending} onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" disabled={mutation.isPending}>{mutation.isPending && <Loader2 size={16} className="animate-spin" />}Save connection</Button></div>
    </form>}
    {mutation.isError && <p role="alert" className="text-sm text-destructive">{String(error)}</p>}
  </section>;
}
