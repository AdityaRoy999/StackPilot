"use client";

import { useEffect, useRef, useState } from "react";
import { AxiosError } from "axios";
import { ArrowUp, File, Folder, HardDrive, Loader2, RefreshCw } from "lucide-react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface FolderListing {
  path: string;
  roots?: Array<{ path: string; name?: string }>;
  entries: Array<{ path: string; name: string; directory: boolean }>;
}

export function FolderPickerDialog({ open, onOpenChange, mode, connectionId, initialPath, onSelect }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "local" | "remote";
  connectionId?: string;
  initialPath: string;
  onSelect: (path: string) => void;
}) {
  const [listing, setListing] = useState<FolderListing>({ path: "", entries: [] });
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const browse = async (path: string) => {
    const version = ++request.current;
    setLoading(true);
    setError("");
    try {
      const response = await api.post<FolderListing>(mode === "local" ? "/local/sources/browse" : `/ssh/connections/${connectionId}/browse`, { path });
      if (version !== request.current) return;
      setListing(response.data);
      setAddress(response.data.path || "");
    } catch (cause) {
      if (version !== request.current) return;
      setError(cause instanceof AxiosError ? cause.response?.data?.error || "Unable to open this folder. Check the path and connection." : "Unable to open this folder.");
    } finally {
      if (version === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    // Begin after the opening render, and cancel queued work when dismissed.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setListing({ path: "", entries: [] });
      setAddress(initialPath);
      void browse(initialPath || (mode === "remote" ? "/" : ""));
    });
    return () => { cancelled = true; request.current += 1; };
    // Start a fresh listing when the picker opens; typing in the parent must not reset navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, connectionId]);

  const atLocalRoot = mode === "local" && listing.roots?.some(root => root.path === listing.path);
  const parent = atLocalRoot ? "" : listing.path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || (mode === "remote" ? "/" : "");
  const entries = [...listing.entries].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="!flex !w-[min(calc(100vw-1rem),960px)] !max-w-[960px] h-[min(80dvh,680px)] flex-col gap-0 overflow-hidden p-0">
      <DialogHeader className="border-b border-border px-5 py-4 pr-12">
        <DialogTitle>{mode === "remote" ? "Server folders" : "Project folders"}</DialogTitle>
        <DialogDescription>{mode === "remote" ? "Browse folders on your connected server." : "Browse the folders available to StackPilot on this host."}</DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2 border-b border-border p-3">
        <Button variant="outline" size="icon" aria-label="Parent folder" disabled={loading || !listing.path || (mode === "remote" && listing.path === "/")} onClick={() => void browse(parent)}><ArrowUp className="size-4" /></Button>
        <Input aria-label="Folder path" className="min-w-0 flex-1 font-mono text-sm" placeholder={mode === "local" ? "Choose a source root" : "/"} value={address} onChange={event => setAddress(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void browse(address); } }} />
        <Button variant="outline" disabled={loading} onClick={() => void browse(address)}>Go</Button>
        <Button variant="ghost" size="icon" aria-label="Refresh folders" disabled={loading} onClick={() => void browse(listing.path)}><RefreshCw className="size-4" /></Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {mode === "local" && <aside className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-muted/20 p-3 sm:w-56 sm:flex-col sm:overflow-y-auto sm:border-r sm:border-b-0">
          <p className="hidden px-2 py-1 text-xs font-medium text-muted-foreground sm:block">Source roots</p>
          {listing.roots?.map(root => <Button key={root.path} variant="ghost" className="h-auto min-h-10 justify-start whitespace-normal break-all text-left text-xs" disabled={loading} onClick={() => void browse(root.path)}><HardDrive className="size-4 shrink-0" />{root.name || root.path}</Button>)}
          {!listing.roots?.length && <p className="p-2 text-xs text-muted-foreground">No source roots available.</p>}
        </aside>}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3" aria-busy={loading}>
          {loading ? <div role="status" className="flex justify-center gap-2 p-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading folders…</div> : error ? <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{error}</p> : <>
            {entries.map(entry => <button type="button" key={entry.path} disabled={!entry.directory} onClick={() => void browse(entry.path)} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-ring disabled:opacity-50 disabled:hover:bg-transparent">{entry.directory ? <Folder className="size-4 shrink-0" /> : <File className="size-4 shrink-0" />}<span className="min-w-0 break-all">{entry.name}</span><span className="ml-auto shrink-0 text-xs text-muted-foreground">{entry.directory ? "Folder" : "File"}</span></button>)}
            {!entries.length && <p className="p-8 text-center text-sm text-muted-foreground">{listing.path ? "This folder is empty. You can still select it." : "Choose a source root to browse your projects."}</p>}
          </>}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border p-4">
        <p className="mr-auto w-full truncate text-xs text-muted-foreground sm:w-auto sm:max-w-[50%]" title={listing.path}>{listing.path || "No folder selected"}</p>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button disabled={loading || !!error || !listing.path} onClick={() => { onSelect(listing.path); onOpenChange(false); }}>Use this folder</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
