"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Smartphone, ShieldCheck, Loader2, RefreshCw } from "@/lib/platform-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEVICE_KEY, deviceSecret, remoteRequest, RemoteError } from "@/lib/remote";
import { forgetRemoteDevice, remoteDestination } from "@/lib/remote-platform";

interface Device { name: string; status: string; confirmation_code: string; email: string; }

export default function RemotePhonePage() {
  const [device, setDevice] = useState<Device | null>(null);
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("My phone");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const entering = useRef(false);
  const pairing = useRef(false);

  const refresh = useCallback(async () => {
    const credential = localStorage.getItem(DEVICE_KEY);
    if (!credential || entering.current || pairing.current) return;
    try {
      const current = await remoteRequest<Device>("/device");
      if (localStorage.getItem(DEVICE_KEY) !== credential) return;
      setDevice(current); setError("");
      if (current.status === "approved") {
        entering.current = true;
        try {
          // The revocable HttpOnly cookie also authenticates page navigation,
          // downloads and WebSocket upgrades through the same gateway.
          await remoteRequest("/session", {});
          window.location.replace(remoteDestination(window.location.search));
        } catch (e) { entering.current = false; throw e; }
      }
    } catch (e) {
      if (localStorage.getItem(DEVICE_KEY) !== credential) return;
      setError(e instanceof Error ? e.message : "Could not reach your StackPilot host.");
      if (e instanceof RemoteError && e.status === 401) { forgetRemoteDevice(); setDevice(null); }
    }
  }, []);

  useEffect(() => {
    const initialize = setTimeout(() => {
      const pair = new URLSearchParams(window.location.hash.slice(1)).get("pair") || "";
      if (pair) { setSecret(pair); window.history.replaceState(null, "", window.location.pathname + window.location.search); }
      setReady(true); void refresh();
    }, 0);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/remote-sw.js", { scope: "/" }).catch(() => {});
    const interval = setInterval(() => void refresh(), 3000);
    return () => { clearTimeout(initialize); clearInterval(interval); };
  }, [refresh]);

  async function pair() {
    pairing.current = true;
    setBusy(true); setError("");
    const token = deviceSecret(); localStorage.setItem(DEVICE_KEY, token);
    try {
      const current = await remoteRequest<Device>("/connect", { secret, name: name.trim() || "My phone" });
      setDevice(current); setSecret("");
    } catch (e) { forgetRemoteDevice(); setError(e instanceof Error ? e.message : "Pairing failed."); }
    finally { pairing.current = false; setBusy(false); }
  }

  return <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
    <section className="w-full max-w-md space-y-6 rounded-3xl border bg-card p-6 sm:p-8">
      <div className="flex items-center gap-3"><span className="rounded-2xl bg-primary/10 p-3 text-primary"><Smartphone className="size-7" /></span><div><h1 className="text-2xl font-semibold">StackPilot on your phone</h1><p className="mt-1 text-sm text-muted-foreground">Your entire platform, wherever you are.</p></div></div>
      {error && <p role="alert" className="rounded-xl border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
      {!ready || device?.status === "approved" ? <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />Opening your dashboard...</p>
      : device?.status === "pending" ? <div className="space-y-4"><ShieldCheck className="size-7 text-primary" /><h2 className="text-xl font-semibold">Confirm this phone on your computer</h2><p className="text-sm text-muted-foreground">Open Remote in StackPilot and approve the matching code.</p><p className="rounded-xl bg-muted p-5 text-center font-mono text-4xl font-semibold tracking-[.18em]">{device.confirmation_code}</p><p className="text-sm text-muted-foreground">Your full dashboard opens automatically after approval.</p></div>
      : secret ? <div className="space-y-4"><p className="text-sm leading-relaxed text-muted-foreground">Connect to your existing account to manage projects, deployments, monitoring, infrastructure, AI, secrets, organizations and settings.</p><label htmlFor="phone-name" className="block text-sm font-medium">Device name</label><Input id="phone-name" value={name} onChange={e => setName(e.target.value)} maxLength={80} /><Button className="w-full min-h-11" disabled={busy} onClick={() => void pair()}>{busy && <Loader2 className="size-4 animate-spin" />}Connect this phone</Button></div>
      : <div className="space-y-4"><p className="text-sm leading-relaxed text-muted-foreground">On your computer, open <strong>Remote</strong> above Settings, enable the secure link, and scan the pairing QR code with this phone.</p><Button className="w-full min-h-11" variant="outline" onClick={() => void refresh()}><RefreshCw className="size-4" />Check connection</Button></div>}
      <p className="text-xs leading-relaxed text-muted-foreground">The same projects, controls and permissions as your computer. Keep your StackPilot host running. You can disconnect this phone from Remote at any time.</p>
    </section>
  </main>;
}
