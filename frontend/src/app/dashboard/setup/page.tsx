"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { AxiosError } from "axios";
import api from "@/lib/api";
import { AiProviderConnections } from "@/components/AiProviderConnections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, Loader2 } from "@/lib/platform-icons";

interface ConnectionTest { ok: boolean; model?: string; latency_ms?: number; error?: string }
function errorMessage(error: unknown) {
  return error instanceof AxiosError ? error.response?.data?.error || "Could not reach the service. Check that the AI profile is running and retry." : "Could not save setup. Please retry.";
}

export default function SetupPage() {
  const router = useRouter();
  const client = useQueryClient();
  const [step, setStep] = useState(0);
  const [modelInput, setModelInput] = useState<string | null>(null);
  const health = useQuery({ queryKey: ["setup-health"], queryFn: async () => (await api.get("/health")).data, retry: false });
  const settings = useQuery({ queryKey: ["ai-settings"], queryFn: async () => (await api.get("/ai/settings")).data });
  const model = (modelInput ?? settings.data?.model ?? "").trim();
  const activeConnection = settings.data?.provider_connections?.find((connection: { active: boolean }) => connection.active)?.id || "default";
  const catalog = useQuery({ queryKey: ["setup-models", activeConnection], queryFn: async () => (await api.get("/ai/models")).data, enabled: step === 1 && settings.isSuccess, retry: false });
  const models: { id: string; label?: string }[] = catalog.data?.models || [];
  const test = useMutation({
    mutationFn: async (input: { model: string; connection: string }) => {
      const result: ConnectionTest = (await api.post("/ai/connection-test", { model: input.model })).data;
      if (result.ok) {
        await api.put("/ai/settings", { model: input.model });
        await client.invalidateQueries({ queryKey: ["ai-settings"] });
      }
      return result;
    },
  });
  const verified = test.data?.ok === true && test.variables?.model === model && test.variables?.connection === activeConnection;
  const finish = useMutation({
    mutationFn: async (skip: boolean) => api.put("/auth/preferences", { preferences: { setup_completed: true, setup_ai_verified: skip ? false : verified } }),
    onSuccess: () => router.push("/dashboard"),
  });
  return <main className="mx-auto w-full max-w-2xl space-y-6 pb-8">
    <div><p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Getting started</p><h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Welcome to your StackPilot</h1><p className="mt-2 text-sm text-muted-foreground">Keep your infrastructure on your computer. Connect AI when you need it.</p></div>
    <ol className="grid grid-cols-3 gap-2 text-xs sm:text-sm" aria-label="Setup progress">{["Platform", "Connect AI", "Ready"].map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined} className={`rounded-lg border px-3 py-3 ${step === index ? "border-foreground/40 bg-muted" : "border-border text-muted-foreground"}`}>{index < step ? <Check size={14} className="mr-1 inline" aria-label="Completed" /> : `${index + 1}. `}{label}</li>)}</ol>
    <section className="min-w-0 space-y-5 rounded-2xl border border-border bg-card p-5 sm:p-6">
      {step === 0 && <>
        <h2 className="text-lg font-semibold">Check your platform</h2><p className="text-sm text-muted-foreground">Your account is ready. Check that the backend is responding before continuing.</p>
        <p role="status" className="flex items-center gap-2 text-sm">{health.isPending ? <><Loader2 size={16} className="animate-spin" />Checking backend…</> : health.isSuccess ? <><Check size={16} />Backend responding</> : "The backend health check failed."}</p>
        {health.isError && <Button variant="outline" className="min-h-11" onClick={() => health.refetch()}>Check again</Button>}
        <p className="text-sm text-muted-foreground">Projects and credentials stay in your installation. You can revisit this guide from the sidebar at any time.</p>
        <Button className="min-h-11" disabled={!health.isSuccess} onClick={() => setStep(1)}>Continue</Button>
      </>}
      {step === 1 && <>
        <h2 className="text-lg font-semibold">Connect your AI provider</h2><fieldset disabled={test.isPending || finish.isPending} className="min-w-0 space-y-5 [&_button]:min-h-11 [&_button]:min-w-11">
          <AiProviderConnections onActivated={() => { test.reset(); setModelInput(""); }} />
          {models.length > 0 && <div className="space-y-2"><Label htmlFor="setup-model-choice">Choose a chat model</Label><select id="setup-model-choice" className="min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm" value={model} onChange={event => { setModelInput(event.target.value); test.reset(); }}><option value="">Choose a model</option>{model && !models.some(item => item.id === model) && <option value={model}>{model}</option>}{models.map(item => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select><p className="text-xs text-muted-foreground">{catalog.data?.source === "provider" ? "Models returned by your provider. Test your selection to check access." : "Showing configured model suggestions. Availability still needs a connection test."}</p></div>}
          {catalog.isFetching && <p role="status" className="text-xs text-muted-foreground">Loading model choices…</p>}
          <div className="space-y-2"><Label htmlFor="setup-model">Model identifier</Label><Input id="setup-model" maxLength={200} value={modelInput ?? settings.data?.model ?? ""} onChange={event => { setModelInput(event.target.value); test.reset(); }} placeholder="Exact chat model ID from your provider" /><p className="text-xs text-muted-foreground">Use a chat model available to your saved key. Your provider documents its model IDs.</p></div>
        </fieldset>
        <p className="text-xs text-muted-foreground">The connection test sends one small model request and may incur your provider&apos;s normal API charge. It runs no agent tools.</p>
        <Button variant="outline" className="min-h-11" disabled={!model || settings.isPending || settings.isError || test.isPending || finish.isPending} onClick={() => test.mutate({ model, connection: activeConnection })}>{test.isPending && <Loader2 size={16} className="animate-spin" />}Test AI connection</Button>
        {test.data && <p role={test.data.ok ? "status" : "alert"} className={`text-sm ${test.data.ok ? "text-foreground" : "text-destructive"}`}>{test.data.ok ? `Model responded in ${test.data.latency_ms} ms. Your selection is saved.` : test.data.error}</p>}
        {test.isError && <p role="alert" className="text-sm text-destructive">{String(errorMessage(test.error))}</p>}
        <div className="flex flex-wrap gap-2 border-t border-border pt-4"><Button variant="ghost" className="min-h-11" disabled={test.isPending || finish.isPending} onClick={() => setStep(0)}>Back</Button><Button className="min-h-11" disabled={!verified || test.isPending || finish.isPending} onClick={() => setStep(2)}>Continue</Button><Button variant="ghost" className="min-h-11" disabled={test.isPending || finish.isPending} onClick={() => finish.mutate(true)}>Skip AI for now</Button></div>
      </>}
      {step === 2 && <><h2 className="text-lg font-semibold">Ready to build</h2><p className="text-sm text-muted-foreground">Your platform is responding and your selected AI model returned a real response. Create a project to deploy a repository, or open AI Agent to test a website.</p><p className="text-xs text-muted-foreground">Install updates from your local setup launcher, or run <code>stackpilot update --check</code>. Updates back up your database and preserve existing volumes.</p><div className="flex flex-wrap gap-2"><Button variant="ghost" className="min-h-11" disabled={finish.isPending} onClick={() => setStep(1)}>Back</Button><Button className="min-h-11" disabled={!verified || finish.isPending} onClick={() => finish.mutate(false)}>{finish.isPending && <Loader2 size={16} className="animate-spin" />}Open projects</Button></div></>}
      {finish.isError && <p role="alert" className="text-sm text-destructive">{String(errorMessage(finish.error))}</p>}
    </section>
  </main>;
}
