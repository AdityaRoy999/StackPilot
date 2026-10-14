"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { rdpApi as api } from "@/lib/rdp";
import { rdpFilePayload, rdpError, type RdpConnection } from "@/lib/rdp";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DisclosureSection } from "@/components/ui/disclosure-section";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Monitor, Upload, Plus, Pencil, Trash2, Loader2 } from "@/lib/platform-icons";
import { toast } from "sonner";

const Viewer = dynamic(() => import("./RemoteDesktopViewer").then(module => module.RemoteDesktopViewer), { ssr: false });
const blank = { name: "", host: "", port: 3389, username: "", domain: "", password: "", security: "nla" as RdpConnection["security"], ignore_certificate: false, keyboard_layout: "en-us-qwerty" };
const securityOptions = [
  { value: "nla", label: "NLA (Windows default)" },
  { value: "tls", label: "TLS" },
  { value: "any", label: "Automatic negotiation" },
] as const;
const keyboardOptions = [
  { value: "en-us-qwerty", label: "English (US)" },
  { value: "en-gb-qwerty", label: "English (UK)" },
  { value: "de-de-qwertz", label: "German" },
  { value: "fr-fr-azerty", label: "French" },
  { value: "ja-jp-qwerty", label: "Japanese" },
  { value: "es-es-qwerty", label: "Spanish" },
] as const;

export function RdpConnections() {
  const [connections, setConnections] = useState<RdpConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(blank);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [unsupported, setUnsupported] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<RdpConnection | null>(null);
  const [removing, setRemoving] = useState<RdpConnection | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    void api.get("/rdp/connections", { signal: abort.signal }).then(({ data }) => setConnections(data.connections || [])).catch(issue => {
      if (!abort.signal.aborted) setError(rdpError(issue, "Remote desktop service is unavailable. Start the RDP gateway and bridge."));
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, []);

  function startEdit(connection?: RdpConnection) {
    setEditing(connection?.id || null); setWarnings([]); setUnsupported([]); setError("");
    setForm(connection ? { name: connection.name, host: connection.host, port: connection.port, username: connection.username, domain: connection.domain, password: "", security: connection.security, ignore_certificate: connection.ignore_certificate, keyboard_layout: connection.keyboard_layout } : blank);
    setOpen(true);
  }

  async function importFile(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      const payload = await rdpFilePayload(file);
      const { data } = await api.post("/rdp/import", payload);
      setEditing(null);
      setForm({ ...blank, ...data.connection, name: file.name.replace(/\.rdp$/i, "") });
      setWarnings(data.warnings || []); setUnsupported(data.unsupported || []); setError(""); setOpen(true);
    } catch (issue) { toast.error(rdpError(issue, issue instanceof Error ? issue.message : "Could not import the RDP file.")); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const payload = { ...form, password: form.password || null };
    try {
      const { data } = editing ? await api.put(`/rdp/connections/${editing}`, payload) : await api.post("/rdp/connections", payload);
      setConnections(current => [data.connection, ...current.filter(item => item.id !== data.connection.id)]);
      setOpen(false); setForm(blank); toast.success("Remote desktop saved");
    } catch (issue) { setError(rdpError(issue, "Could not save this connection.")); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api.delete(`/rdp/connections/${removing.id}`);
      setConnections(current => current.filter(item => item.id !== removing.id)); setRemoving(null);
      toast.success("Remote desktop removed");
    } catch (issue) { toast.error(rdpError(issue, "Could not remove this connection.")); }
    finally { setBusy(false); }
  }

  return <section id="remote-desktops" aria-label="Remote desktops" className="space-y-4 rounded-2xl border bg-card p-4 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="flex items-center gap-2 text-base font-semibold"><Monitor className="size-5" />Remote desktops</h2><p className="mt-1 text-sm text-muted-foreground">Connect to a Windows PC or RDP server directly in StackPilot.</p></div>
      <div className="flex flex-wrap gap-2">
        <input ref={fileInput} type="file" accept=".rdp" aria-label="Choose RDP file" className="sr-only" onChange={event => void importFile(event.target.files?.[0])} />
        <Button variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}><Upload className="size-4" />Import .rdp</Button>
        <Button size="sm" onClick={() => startEdit()}><Plus className="size-4" />Add desktop</Button>
      </div>
    </div>
    {loading ? <p className="flex gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading desktops…</p> : error && !open ? <p role="alert" className="text-sm text-destructive">{error}</p> : !connections.length ? <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Add a desktop or import its .rdp file to get started.</p> : <div className="grid gap-3 sm:grid-cols-2">{connections.map(connection => <article key={connection.id} className="flex min-w-0 items-center gap-3 rounded-xl border p-4">
      <Monitor className="size-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><h3 className="truncate font-medium">{connection.name}</h3><p className="truncate text-xs text-muted-foreground">{connection.host}:{connection.port} · {connection.username}</p></div>
      <Button variant="outline" size="sm" onClick={() => setViewing(connection)}>Open</Button>
      <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Edit ${connection.name}`} onClick={() => startEdit(connection)} />}><Pencil className="size-4" /></TooltipTrigger><TooltipContent>Edit connection</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Remove ${connection.name}`} onClick={() => setRemoving(connection)} />}><Trash2 className="size-4 text-destructive" /></TooltipTrigger><TooltipContent>Remove connection</TooltipContent></Tooltip>
    </article>)}</div>}
    <DisclosureSection title="Enable Remote Desktop" description="Set up a reachable Windows PC or server">
      <p className="text-sm leading-relaxed text-muted-foreground">On the Windows machine, open Settings → System → Remote Desktop and enable it. Allow your account to connect, and use an address reachable from the StackPilot server. Windows Home cannot host RDP. Keep the machine awake and allow the RDP port through its firewall.</p>
      <p className="mt-2 text-xs text-muted-foreground">RDP provides desktop access. A build worker still needs its separate SSH or worker connection.</p>
    </DisclosureSection>
    <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); if (!value) setForm(blank); } }}>
      <DialogContent className="w-[calc(100%-2rem)] sm:max-w-4xl">
        <DialogHeader><DialogTitle>{editing ? "Edit remote desktop" : "Add remote desktop"}</DialogTitle><DialogDescription>Connection details stay with your account. Saved passwords are encrypted on the server.</DialogDescription></DialogHeader>
        <form onSubmit={event => void save(event)} className="space-y-4">
          {warnings.length > 0 && <div className="space-y-1 rounded-lg bg-muted p-3 text-xs text-muted-foreground">{warnings.map(message => <p key={message}>{message}</p>)}</div>}
          {unsupported.length > 0 && <p role="alert" className="text-sm text-destructive">This file requires {unsupported.join(", ")}, which this direct desktop viewer does not support. Import a direct RDP connection instead.</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="min-w-0 space-y-1 text-sm">Name<Input required maxLength={100} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="Windows build VM" /></label>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_6rem] gap-3"><label className="min-w-0 space-y-1 text-sm">Host or IP<Input required value={form.host} onChange={event => setForm({ ...form, host: event.target.value })} placeholder="192.168.1.50" /></label><label className="space-y-1 text-sm">Port<Input type="number" required min={1} max={65535} value={form.port} onChange={event => setForm({ ...form, port: Number(event.target.value) })} /></label></div>
            <label className="min-w-0 space-y-1 text-sm">Windows account<Input required autoComplete="off" value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} placeholder="builduser" /></label>
            <label className="min-w-0 space-y-1 text-sm">Password<Input type="password" required={!editing} autoComplete="new-password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} placeholder={editing ? "Leave blank to keep saved password" : "Windows account password"} /></label>
          </div>
          <DisclosureSection title="Advanced" description="Domain, authentication, certificate, and keyboard">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="min-w-0 space-y-1 text-sm sm:col-span-2">Domain (optional)<Input autoComplete="off" value={form.domain} onChange={event => setForm({ ...form, domain: event.target.value })} placeholder="DOMAIN" /></label>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="rdp-security">Security</Label>
                <Select value={form.security} items={securityOptions} onValueChange={value => { if (value) setForm(current => ({ ...current, security: value })); }}>
                  <SelectTrigger id="rdp-security" className="h-9 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{securityOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="rdp-keyboard">Remote keyboard</Label>
                <Select value={form.keyboard_layout} items={keyboardOptions} onValueChange={value => { if (value) setForm(current => ({ ...current, keyboard_layout: value })); }}>
                  <SelectTrigger id="rdp-keyboard" className="h-9 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{keyboardOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex items-start gap-2 sm:col-span-2">
                <Checkbox id="rdp-certificate" className="mt-0.5" checked={form.ignore_certificate} onCheckedChange={checked => setForm(current => ({ ...current, ignore_certificate: checked }))} aria-describedby="rdp-certificate-help" />
                <div><Label htmlFor="rdp-certificate">Allow this host’s self-signed certificate</Label><p id="rdp-certificate-help" className="mt-1 text-xs text-muted-foreground">Enable only for a machine and network you trust.</p></div>
              </div>
            </div>
          </DisclosureSection>
          <div className="flex justify-end gap-2 border-t pt-4"><Button variant="ghost" type="button" disabled={busy} onClick={() => { setOpen(false); setForm(blank); }}>Cancel</Button><Button type="submit" disabled={busy || unsupported.length > 0}>{busy && <Loader2 className="size-4 animate-spin" />}Save desktop</Button></div>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={!!removing} onOpenChange={value => { if (!value && !busy) setRemoving(null); }}><DialogContent><DialogHeader><DialogTitle>Remove {removing?.name}?</DialogTitle><DialogDescription>This removes the saved connection and disconnects its open sessions.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>Remove desktop</Button></div></DialogContent></Dialog>
    {viewing && <Viewer connection={viewing} onClose={() => setViewing(null)} />}
  </section>;
}
