"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import QRCode from "react-qr-code";
import Link from "next/link";
import api from "@/lib/api";
import { Smartphone, ShieldCheck, Link2, Copy, Loader2, X, ChevronDown } from "@/lib/platform-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AnimatedCollapse } from "@/components/ui/animated-collapse";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DisclosureSection } from "@/components/ui/disclosure-section";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";

interface Device { id: string; name: string; status: string; confirmation_code: string; last_seen_at: string | null; expires_at: string; created_at?: string; location_label?: string; timezone?: string; user_agent?: string; request_count?: string; }
interface Access { available: boolean; running: boolean; url: string; ready?: boolean; state?: string; error?: string; }
interface Run { id: string; device_id?: string; session_id: string; title: string; state: string; created_at?: string; }

function deviceDescription(agent = "") {
  const system = /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Windows/.test(agent) ? "Windows" : /Macintosh/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox|FxiOS/.test(agent) ? "Firefox" : /Chrome|CriOS/.test(agent) ? "Chrome" : /Safari/.test(agent) ? "Safari" : "";
  return [system, browser].filter(Boolean).join(" · ") || "Device details unavailable";
}
function formatTime(value?: string | null) { return value ? new Date(value).toLocaleString() : "Not recorded"; }

export default function RemotePage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [access, setAccess] = useState<Access>({ available: false, running: false, url: "" });
  const [baseUrl, setBaseUrl] = useState("");
  const baseUrlRef = useRef("");
  const managedUrlRef = useRef("");
  const customAddressRef = useRef(false);
  const accessRevisionRef = useRef(0);
  const [pairing, setPairing] = useState<{ secret: string; expires_at: string; origin: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [accessError, setAccessError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [connectOpen, setConnectOpen] = useState(false);
  const [historyDevice, setHistoryDevice] = useState("");
  const [expandedDevices, setExpandedDevices] = useState<Record<string, boolean>>({});

  const applyAccess = useCallback((next: Access) => {
    const url = next.url || "";
    managedUrlRef.current = url;
    setAccess(next);
    if (!customAddressRef.current && baseUrlRef.current !== url) {
      baseUrlRef.current = url;
      setBaseUrl(url);
      setPairing(null);
    }
  }, []);

  function editAddress(value: string) {
    customAddressRef.current = !!value && value.replace(/\/$/, "") !== managedUrlRef.current.replace(/\/$/, "");
    const url = value || managedUrlRef.current;
    baseUrlRef.current = url;
    setBaseUrl(url);
    setPairing(null);
  }

  const liveRemote = connectOpen || devices.some(device => device.status === "pending") || runs.some(run => !["completed", "failed", "cancelled"].includes(run.state));
  useEffect(() => {
    let disposed = false, inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      if (disposed || inFlight || document.hidden) return;
      inFlight = true;
      setNow(Date.now());
      try {
        const [d, r] = await Promise.all([api.get("/remote/devices", { signal: controller.signal }), api.get("/remote/runs", { signal: controller.signal })]);
        if (disposed) return;
        setDevices(d.data.devices || []); setRuns(r.data.runs || []); setError("");
      } catch { if (!disposed) setError("Could not reach the host. Check the backend connection."); }
      finally {
        inFlight = false;
        if (!disposed && !document.hidden) timer = setTimeout(() => void refresh(), liveRemote ? 3000 : 30000);
      }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void refresh(); };
    void refresh();
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [liveRemote]);

  // Tunnel readiness must not wait for device/history queries or the idle
  // 30-second refresh. Poll promptly during startup, then back off once ready.
  const accessBusy = busy === "access";
  useEffect(() => {
    if (accessBusy) return;
    let disposed = false, inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      if (disposed || inFlight || document.hidden) return;
      inFlight = true;
      const revision = accessRevisionRef.current;
      let delay = connectOpen ? 3000 : 30000;
      try {
        const response = await api.get<Access>("/remote/access", { signal: controller.signal, timeout: 10000 });
        if (disposed || revision !== accessRevisionRef.current) return;
        applyAccess(response.data);
        setAccessError(response.data.error || "");
        if (response.data.running && !(response.data.ready ?? !!response.data.url)) delay = 500;
      } catch {
        if (!disposed && revision === accessRevisionRef.current) setAccessError("Could not check the remote link. Check Docker and your internet connection.");
        delay = 3000;
      } finally {
        inFlight = false;
        if (!disposed && !document.hidden) timer = setTimeout(() => void refresh(), delay);
      }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void refresh(); };
    void refresh();
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [accessBusy, connectOpen, applyAccess]);

  async function changeAccess(action: "start" | "stop" | "restart") {
    setBusy("access");
    accessRevisionRef.current++;
    setPairing(null);
    setAccessError("");
    try {
      const res = await api.post<Access>("/remote/access", { action }); applyAccess(res.data);
      if (res.data.error) setAccessError(res.data.error);
    } catch { toast.error("Could not change remote access."); }
    finally { accessRevisionRef.current++; setBusy(""); }
  }
  async function pair() {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
        toast.error("Enter a secure HTTPS origin, such as https://your-host.example.com."); return;
      }
      setBusy("pair"); const response = await api.post("/remote/pairings");
      if (baseUrlRef.current.replace(/\/$/, "") === url.origin) setPairing({ ...response.data, origin: url.origin });
    } catch { toast.error("Could not create the pairing link. Use a valid HTTPS address."); }
    finally { setBusy(""); }
  }
  async function deviceAction(device: Device, action: "approve" | "deny" | "revoke") {
    setBusy(device.id);
    try {
      await api.post("/remote/devices", { id: device.id, action, confirmation_code: device.confirmation_code });
      setDevices(current => current.map(d => d.id === device.id ? { ...d, status: action === "approve" ? "approved" : action === "deny" ? "denied" : "revoked" } : d));
      if (action === "approve") { setPairing(null); setConnectOpen(false); }
      toast.success(action === "approve" ? "Phone connected" : "Device disconnected");
    } catch { toast.error("The device could not be updated. Refresh and try again."); }
    finally { setBusy(""); }
  }
  const validPairing = pairing && new Date(pairing.expires_at).getTime() > now;
  const managedReady = access.ready ?? !!access.url;
  const customAddress = !!baseUrl && baseUrl.replace(/\/$/, "") !== access.url.replace(/\/$/, "");
  const canPair = !!baseUrl && (customAddress || managedReady) && !accessError;
  const pairingUrl = validPairing ? `${pairing.origin}/remote#pair=${pairing.secret}` : "";
  const pending = devices.filter(d => d.status === "pending");
  const deviceStatus = (device: Device) => device.status === "approved" && new Date(device.expires_at).getTime() <= now ? "expired" : device.status;
  const approved = devices.filter(d => deviceStatus(d) === "approved");
  const visibleRuns = historyDevice ? runs.filter(run => run.device_id === historyDevice) : runs;

  const pendingCards = pending.map(device => <article key={device.id} className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4"><p className="break-words text-sm font-medium">{device.name} wants to connect</p><p className="text-sm text-muted-foreground">Confirm that this code matches the one on your device.</p><p className="font-mono text-2xl font-semibold tracking-[.2em]">{device.confirmation_code}</p><div className="flex flex-wrap gap-2"><Button disabled={!!busy} onClick={() => void deviceAction(device, "approve")}>Approve device</Button><Button variant="outline" disabled={!!busy} onClick={() => void deviceAction(device, "deny")}>Deny</Button></div></article>);
  return <div data-remote-page className="mx-auto w-full min-w-0 max-w-6xl space-y-6 pb-8">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0"><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">StackPilot Remote</h1><p className="mt-2 text-sm text-muted-foreground">Manage your devices and recent connections.</p></div>
      <Button onClick={() => setConnectOpen(true)}><Link2 className="size-4" />Connect remote device</Button>
    </header>
    {error && <p role="alert" className="rounded-xl border border-destructive/30 p-4 text-destructive">{error}</p>}
    {!connectOpen && pending.length > 0 && <section aria-label="Pending connections" className="space-y-3">{pendingCards}</section>}
    <section data-remote-card aria-label="Recent connections" className="space-y-4 rounded-2xl border bg-card p-4 sm:p-6">
      <h2 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="size-5" />Recent connections<span className="ml-auto text-xs font-normal text-muted-foreground">{approved.length} with access</span></h2>
      {!devices.filter(d => d.status !== "pending").length && <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No connected devices yet. Connect a remote device to get started.</div>}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table aria-label="Remote devices" className="w-full min-w-[760px] table-fixed text-left text-sm">
          <colgroup><col className="w-[26%]" /><col className="w-[13%]" /><col className="w-[18%]" /><col className="w-[24%]" /><col className="w-[10%]" /><col className="w-[9%]" /></colgroup>
          <thead className="border-b bg-muted/30 text-xs text-muted-foreground"><tr>{["Device", "Access", "Location", "Last seen", "Requests", "Details"].map(heading => <th key={heading} scope="col" className="px-4 py-3 font-medium">{heading}</th>)}</tr></thead>
          <tbody>{devices.filter(d => d.status !== "pending").map(device => <Fragment key={device.id}>
            <tr className="border-b border-border"><th scope="row" className="px-4 py-3 text-left font-medium"><span className="block break-words">{device.name}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">{deviceDescription(device.user_agent)}</span></th><td className="px-4 py-3"><span className="rounded-full border px-2 py-1 text-xs">{deviceStatus(device) === "approved" ? "Enabled" : deviceStatus(device)}</span></td><td className="break-words px-4 py-3 text-muted-foreground">{device.location_label || "Not provided"}</td><td className="px-4 py-3 text-xs text-muted-foreground">{formatTime(device.last_seen_at)}</td><td className="px-4 py-3 font-mono">{device.request_count || "0"}</td><td className="px-2 py-3"><Button variant="ghost" size="icon" className="size-11" aria-label={`Device details for ${device.name}`} aria-expanded={!!expandedDevices[device.id]} aria-controls={`device-details-${device.id}`} onClick={() => setExpandedDevices(current => ({ ...current, [device.id]: !current[device.id] }))}><ChevronDown className={`size-4 transition-transform duration-250 motion-reduce:transition-none ${expandedDevices[device.id] ? "rotate-180" : ""}`} /></Button></td></tr>
            <tr><td colSpan={6} className="p-0"><AnimatedCollapse open={!!expandedDevices[device.id]}><div id={`device-details-${device.id}`} className="border-b border-border bg-muted/20 p-4">
              <dl className="grid grid-cols-3 gap-4 text-sm">{[{ label: "Location", value: device.location_label || "Not provided" }, { label: "Time zone", value: device.timezone || "Not recorded" }, { label: "Last seen", value: formatTime(device.last_seen_at) }, { label: "Connected on", value: formatTime(device.created_at) }, { label: "Access expires", value: formatTime(device.expires_at) }, { label: "AI requests", value: device.request_count || "0" }].map(row => <div key={row.label} className="min-w-0"><dt className="text-xs text-muted-foreground">{row.label}</dt><dd className="mt-1 break-words [overflow-wrap:anywhere]">{row.value}</dd></div>)}</dl>
              <div className="mt-4 flex flex-wrap gap-3"><Button size="sm" variant="outline" onClick={() => setHistoryDevice(device.id)}>View history</Button>{deviceStatus(device) === "approved" && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void deviceAction(device, "revoke")}><X className="size-4" />Disconnect</Button>}</div>
            </div></AnimatedCollapse></td></tr>
          </Fragment>)}</tbody>
        </table>
      </div>
    </section>
    <section data-remote-card aria-label="Connection history" className="space-y-4 rounded-2xl border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-semibold">Connection history</h2><p className="mt-1 text-xs text-muted-foreground">Recent AI requests from your devices.</p></div><div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">Device</span><Select value={historyDevice || "all"} onValueChange={value => setHistoryDevice(value === "all" ? "" : String(value || ""))} items={[{ value: "all", label: "All devices" }, ...devices.map(device => ({ value: device.id, label: device.name }))]}><SelectTrigger aria-label="Filter history by device" className="min-h-11 w-52 max-w-full gap-3 bg-card px-3"><Smartphone className="size-4 text-muted-foreground" /><SelectValue /></SelectTrigger><SelectContent>{[{ id: "all", name: "All devices" }, ...devices].map(device => <SelectItem key={device.id} value={device.id} className="min-h-11 gap-3 px-3"><Smartphone className="size-4 text-muted-foreground" />{device.name}</SelectItem>)}</SelectContent></Select></div></div>
      {!visibleRuns.length && <p className="py-4 text-sm text-muted-foreground">No recent requests{historyDevice ? " for this device" : " yet"}.</p>}
      <div className="overflow-x-auto rounded-lg border border-border"><table aria-label="Remote request history" className="w-full min-w-[640px] text-left text-sm"><thead className="border-b bg-muted/30 text-xs text-muted-foreground"><tr>{["Request", "Device", "Time", "Status"].map(heading => <th key={heading} scope="col" className="px-4 py-3 font-medium">{heading}</th>)}</tr></thead><tbody>{visibleRuns.map(run => <tr key={run.id} className="border-b border-border last:border-0 hover:bg-muted/30"><th scope="row" className="px-4 py-3 font-medium"><Link prefetch={false} href={`/dashboard/ai?session_id=${encodeURIComponent(run.session_id)}`} className="inline-block rounded-sm py-1 hover:underline focus-visible:ring-2 focus-visible:ring-ring">{run.title || "Untitled chat"}</Link></th><td className="px-4 py-3 text-muted-foreground">{devices.find(device => device.id === run.device_id)?.name || "Remote device"}</td><td className="px-4 py-3 text-xs text-muted-foreground">{formatTime(run.created_at)}</td><td className="px-4 py-3 text-xs text-muted-foreground">{run.state.replaceAll("_", " ")}</td></tr>)}</tbody></table></div>
    </section>
    <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
      <DialogContent resizeKey={pairing ? "pairing" : access.running ? "running" : "off"} className="flex max-h-[90dvh] flex-col overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b px-5 py-5 pr-12 sm:px-6"><DialogTitle>Connect remote device</DialogTitle><DialogDescription>Open a secure link, then approve the matching device code.</DialogDescription></DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">      <section className="min-w-0 space-y-4 p-5 sm:p-6">

        <p className="text-sm leading-relaxed text-muted-foreground">Keep this computer awake and StackPilot running. Open a secure link on your phone, then confirm its code here.</p>
        <div className="flex flex-wrap items-center gap-3"><span className={`size-2 rounded-full ${managedReady ? "bg-emerald-500" : access.running ? "animate-pulse bg-amber-500 motion-reduce:animate-none" : "bg-muted-foreground"}`} /><span role="status" className="text-sm">{access.running ? managedReady ? "Remote link ready" : access.state === "reconnecting" ? "Reconnecting secure link…" : "Creating secure link…" : access.url ? "Custom endpoint configured" : "Remote link is off"}</span>
          {access.available && <Button size="sm" variant="outline" disabled={busy === "access"} onClick={() => void changeAccess(access.running ? "stop" : "start")}>{busy === "access" && <Loader2 className="size-4 animate-spin" />}{access.running ? "Turn off" : "Enable remote link"}</Button>}
          {access.available && access.running && <Button size="sm" variant="outline" disabled={busy === "access"} onClick={() => void changeAccess("restart")}>Reconnect link</Button>}
        </div>
        {accessError && <p role="alert" className="text-sm text-destructive">{accessError}</p>}
        <DisclosureSection title="Connection address" description={baseUrl ? "Secure endpoint configured · expand to edit" : "Set a custom HTTPS gateway if needed"}>
        <div className="min-w-0 space-y-2"><label htmlFor="remote-origin" className="text-sm font-medium">Secure host address</label><Input id="remote-origin" className="w-full min-w-0" value={baseUrl} onChange={e => editAddress(e.target.value)} placeholder="https://your-host.example.com" /><p className="text-xs leading-relaxed text-muted-foreground">Use the generated link or your own HTTPS gateway.</p></div>
        </DisclosureSection>
        <Button className="w-full sm:w-auto" disabled={!canPair || !!busy || !!error} onClick={() => void pair()}><Smartphone className="size-4" />Pair a phone</Button>
        {pairingUrl && <div className="min-w-0 space-y-3 rounded-xl border p-3 sm:p-4"><div className="mx-auto w-full max-w-56 rounded-xl bg-white p-3"><QRCode value={pairingUrl} size={192} style={{ width: "100%", height: "auto" }} /></div><p className="text-center text-sm text-muted-foreground">Scan with your phone’s camera. Expires in {Math.max(1, Math.ceil((new Date(pairing!.expires_at).getTime() - now) / 60000))} minutes.</p><Button className="w-full whitespace-normal" variant="outline" onClick={() => void navigator.clipboard.writeText(pairingUrl).then(() => toast.success("Pairing link copied")).catch(() => toast.error("Clipboard unavailable"))}><Copy className="size-4 shrink-0" />Copy private pairing link</Button></div>}
        {pairing && !validPairing && <p className="text-sm text-muted-foreground">This link expired. Create another link to pair.</p>}
        {!access.available && <p className="text-sm text-muted-foreground">The managed tunnel is not installed on this host. Start the Remote Docker profile, or enter your own HTTPS gateway address.</p>}
      </section>
          {pending.length > 0 && <div className="space-y-3 px-5 pb-5 sm:px-6">{pendingCards}</div>}
        </div>
        <div className="flex shrink-0 justify-end border-t p-4"><Button variant="outline" onClick={() => setConnectOpen(false)}>Done</Button></div>
      </DialogContent>
    </Dialog>
  </div>;
}
