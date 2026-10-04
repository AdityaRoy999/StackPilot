"use client";

import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import Link from "next/link";
import api from "@/lib/api";
import { Smartphone, ShieldCheck, Link2, Copy, Loader2, RefreshCw, X } from "@/lib/platform-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface Device { id: string; name: string; status: string; confirmation_code: string; last_seen_at: string | null; expires_at: string; }
interface Access { available: boolean; running: boolean; url: string; }
interface Run { id: string; session_id: string; title: string; state: string; }

export default function RemotePage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [access, setAccess] = useState<Access>({ available: false, running: false, url: "" });
  const [baseUrl, setBaseUrl] = useState("");
  const [pairing, setPairing] = useState<{ secret: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const [d, a, r] = await Promise.all([api.get("/remote/devices"), api.get("/remote/access"), api.get("/remote/runs")]);
        if (disposed) return;
        setDevices(d.data.devices); setAccess(a.data); setRuns(r.data.runs); setError("");
        if (a.data.url) setBaseUrl(current => current || a.data.url);
      } catch { if (!disposed) setError("Could not reach the host. Check the backend connection."); }
    };
    void refresh(); const interval = setInterval(() => { setNow(Date.now()); void refresh(); }, 3000);
    return () => { disposed = true; clearInterval(interval); };
  }, []);

  async function changeAccess(action: "start" | "stop") {
    setBusy("access");
    try {
      const res = await api.post("/remote/access", { action }); setAccess(res.data);
      if (action === "stop") { setPairing(null); setBaseUrl(""); }
      else if (res.data.url) setBaseUrl(res.data.url);
    } catch { toast.error("Could not change remote access."); }
    finally { setBusy(""); }
  }
  async function pair() {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
        toast.error("Enter a secure HTTPS origin, such as https://your-host.example.com."); return;
      }
      setBusy("pair"); const response = await api.post("/remote/pairings"); setPairing(response.data);
    } catch { toast.error("Could not create the pairing link. Use a valid HTTPS address."); }
    finally { setBusy(""); }
  }
  async function deviceAction(device: Device, action: "approve" | "deny" | "revoke") {
    setBusy(device.id);
    try {
      await api.post("/remote/devices", { id: device.id, action, confirmation_code: device.confirmation_code });
      setDevices(current => current.map(d => d.id === device.id ? { ...d, status: action === "approve" ? "approved" : action === "deny" ? "denied" : "revoked" } : d));
      if (action === "approve") setPairing(null);
      toast.success(action === "approve" ? "Phone connected" : "Device disconnected");
    } catch { toast.error("The device could not be updated. Refresh and try again."); }
    finally { setBusy(""); }
  }
  const validPairing = pairing && new Date(pairing.expires_at).getTime() > now;
  const pairingUrl = validPairing ? `${baseUrl.replace(/\/$/, "")}/remote#pair=${pairing.secret}` : "";
  const pending = devices.filter(d => d.status === "pending");
  const approved = devices.filter(d => d.status === "approved");

  return <div data-remote-page className="mx-auto w-full min-w-0 max-w-5xl space-y-5 pb-8 sm:space-y-7">
    <div className="flex min-w-0 items-start gap-3 sm:gap-4"><div className="shrink-0 rounded-xl bg-primary/10 p-2.5 text-primary sm:rounded-2xl sm:p-3"><Smartphone className="size-5 sm:size-7" /></div><div className="min-w-0"><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">StackPilot Remote</h1><p className="mt-1 text-sm text-muted-foreground sm:mt-2 sm:text-base">Your whole StackPilot platform on your phone.</p></div></div>
    {error && <p role="alert" className="rounded-xl border border-destructive/30 p-4 text-destructive">{error}</p>}
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <section data-remote-card className="min-w-0 space-y-4 rounded-2xl border bg-card p-4 sm:space-y-5 sm:p-6">
        <div className="flex items-center gap-2"><Link2 className="size-4 shrink-0 sm:size-5" /><h2 className="text-base font-semibold sm:text-lg">Connect your phone</h2></div>
        <p className="text-sm leading-relaxed text-muted-foreground">Keep this computer awake and StackPilot running. Open a secure link on your phone, then confirm its code here.</p>
        <div className="flex flex-wrap items-center gap-3"><span className={`size-2 rounded-full ${access.running || access.url ? "bg-emerald-500" : "bg-muted-foreground"}`} /><span className="text-sm">{access.running ? access.url ? "Remote link ready" : "Creating secure link…" : access.url ? "Custom endpoint configured" : "Remote link is off"}</span>
          {access.available && <Button size="sm" variant="outline" disabled={busy === "access"} onClick={() => void changeAccess(access.running ? "stop" : "start")}>{busy === "access" && <Loader2 className="size-4 animate-spin" />}{access.running ? "Turn off" : "Enable remote link"}</Button>}
        </div>
        <div className="min-w-0 space-y-2"><label htmlFor="remote-origin" className="text-sm font-medium">Secure host address</label><Input id="remote-origin" className="w-full min-w-0" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setPairing(null); }} placeholder="https://your-host.example.com" /><p className="text-xs leading-relaxed text-muted-foreground">Use the generated link or your own HTTPS gateway.</p></div>
        <Button className="w-full sm:w-auto" disabled={!baseUrl || !!busy} onClick={() => void pair()}><Smartphone className="size-4" />Pair a phone</Button>
        {pairingUrl && <div className="min-w-0 space-y-3 rounded-xl border p-3 sm:p-4"><div className="mx-auto w-full max-w-56 rounded-xl bg-white p-3"><QRCode value={pairingUrl} size={192} style={{ width: "100%", height: "auto" }} /></div><p className="text-center text-sm text-muted-foreground">Scan with your phone’s camera. Expires in {Math.max(1, Math.ceil((new Date(pairing!.expires_at).getTime() - now) / 60000))} minutes.</p><Button className="w-full whitespace-normal" variant="outline" onClick={() => void navigator.clipboard.writeText(pairingUrl).then(() => toast.success("Pairing link copied")).catch(() => toast.error("Clipboard unavailable"))}><Copy className="size-4 shrink-0" />Copy private pairing link</Button></div>}
        {pairing && !validPairing && <p className="text-sm text-muted-foreground">This link expired. Create another link to pair.</p>}
        {!access.available && <p className="text-sm text-muted-foreground">The managed tunnel is not installed on this host. Start the Remote Docker profile, or enter your own HTTPS gateway address.</p>}
      </section>
      <div className="min-w-0 space-y-4 sm:space-y-6">
        <section data-remote-card className="min-w-0 space-y-4 rounded-2xl border bg-card p-4 sm:p-6"><h2 className="flex items-center gap-2 text-base font-semibold sm:text-lg"><ShieldCheck className="size-4 shrink-0 sm:size-5" />Devices <span className="ml-auto text-xs font-normal text-muted-foreground">{approved.length} connected</span></h2>
          {pending.map(d => <div key={d.id} className="min-w-0 space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3 sm:p-4"><p className="break-words [overflow-wrap:anywhere] text-sm font-medium">{d.name} wants to connect</p><p className="text-sm text-muted-foreground">Confirm that this code matches the one on your phone:</p><p className="font-mono text-2xl font-semibold tracking-[.2em] sm:text-3xl">{d.confirmation_code}</p><div className="flex flex-wrap gap-2"><Button disabled={busy === d.id} onClick={() => void deviceAction(d, "approve")}>Approve phone</Button><Button variant="outline" disabled={busy === d.id} onClick={() => void deviceAction(d, "deny")}>Deny</Button></div></div>)}
          {!pending.length && !approved.length && <p className="py-5 text-sm text-muted-foreground">No phones connected yet.</p>}
          {approved.map(d => <div key={d.id} className="flex min-w-0 items-center gap-2 rounded-xl border p-3 sm:gap-3 sm:p-4"><Smartphone className="size-4 shrink-0 text-muted-foreground sm:size-5" /><div className="min-w-0 flex-1"><p className="break-words [overflow-wrap:anywhere] text-sm font-medium">{d.name}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{d.last_seen_at ? `Last seen ${new Date(d.last_seen_at).toLocaleString()}` : "Waiting for phone"}</p><p className="text-xs text-muted-foreground">Expires {new Date(d.expires_at).toLocaleDateString()}</p></div><Button className="shrink-0" aria-label={`Disconnect ${d.name}`} size="icon" variant="ghost" disabled={busy === d.id} onClick={() => void deviceAction(d, "revoke")}><X className="size-4" /></Button></div>)}
          <p className="text-xs leading-relaxed text-muted-foreground">Disconnecting a device removes its access. Background work continues on this host and stays in your chat history.</p>
        </section>
        <section data-remote-card className="min-w-0 space-y-4 rounded-2xl border bg-card p-4 sm:p-6"><h2 className="flex items-center gap-2 text-base font-semibold sm:text-lg"><RefreshCw className="size-4 shrink-0 sm:size-5" />Recent activity</h2>{!runs.length && <p className="text-sm text-muted-foreground">Requests from your phone will appear here.</p>}{runs.slice(0, 8).map(r => <Link key={r.id} href={`/dashboard/ai?session_id=${r.session_id}`} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border p-3 hover:bg-muted"><span className="min-w-0 flex-1 basis-32 break-words [overflow-wrap:anywhere] text-sm">{r.title || "Untitled chat"}</span><span className="text-xs text-muted-foreground">{r.state.replaceAll("_", " ")}</span></Link>)}</section>
      </div>
    </div>
  </div>;
}
