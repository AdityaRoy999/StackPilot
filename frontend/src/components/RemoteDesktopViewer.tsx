"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { rdpApi as api } from "@/lib/rdp";
import { loadGuacamole, type GuacamoleClient } from "@/lib/guacamole";
import { rdpError, type RdpConnection } from "@/lib/rdp";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Maximize2, RefreshCw, Unplug } from "@/lib/platform-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function RemoteDesktopViewer({ connection, onClose }: { connection: RdpConnection; onClose(): void }) {
  const frame = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const [screenNode, setScreenNode] = useState<HTMLDivElement | null>(null);
  const attachScreen = useCallback((node: HTMLDivElement | null) => { screen.current = node; setScreenNode(node); }, []);
  const clientRef = useRef<GuacamoleClient | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState("Connecting…");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const element = screenNode;
    if (!element) return;
    let disposed = false;
    let cleanup = () => {};
    const abort = new AbortController();
    void (async () => {
      try {
        const Guacamole = await loadGuacamole();
        if (disposed) return;
        const { data } = await api.post(`/rdp/connections/${connection.id}/ticket`, {}, { signal: abort.signal });
        if (disposed) return;
        const endpoint = new URL("/ws/rdp", window.location.origin);
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        const tunnel = new Guacamole.WebSocketTunnel(endpoint.href);
        const client = new Guacamole.Client(tunnel);
        clientRef.current = client;
        const display = client.getDisplay();
        element.replaceChildren(display.getElement());
        const reportError = (message: string) => { if (!disposed) { setError(message); setState("Connection failed"); setConnected(false); } };
        client.onerror = issue => reportError(issue.message);
        tunnel.onerror = issue => reportError(issue.message || "The desktop connection closed. Reconnect to try again.");
        client.onstatechange = value => {
          if (disposed) return;
          if (value === 3) { setState("Connected"); setConnected(true); element.focus(); }
          if (value === 5) { setState("Disconnected"); setConnected(false); }
        };
        const keyboard = new Guacamole.Keyboard(element);
        keyboard.onkeydown = key => { client.sendKeyEvent(1, key); return false; };
        keyboard.onkeyup = key => client.sendKeyEvent(0, key);
        const releaseKeys = () => keyboard.reset();
        const displayElement = display.getElement();
        // Guacamole's legacy coordinate helper uses offsetLeft/offsetTop and
        // does not account for the translated dialog. Capture viewport events
        // first, then pass coordinates relative to the visible display bounds.
        const pointerPosition = { x: 0, y: 0 };
        const captureMouse = (event: MouseEvent) => {
          const bounds = displayElement.getBoundingClientRect();
          pointerPosition.x = Math.max(0, Math.min(bounds.width - 1, event.clientX - bounds.left));
          pointerPosition.y = Math.max(0, Math.min(bounds.height - 1, event.clientY - bounds.top));
        };
        const mouseEvents = ["mousemove", "mousedown", "mouseup", "wheel"] as const;
        for (const event of mouseEvents) displayElement.addEventListener(event, captureMouse, true);
        const mouse = new Guacamole.Mouse(displayElement);
        const touch = new Guacamole.Mouse.Touchpad(displayElement);
        const focusDesktop = () => { if (document.activeElement !== element) element.focus({ preventScroll: true }); };
        const moveMouse = (position: unknown) => {
          focusDesktop(); client.sendMouseState({ ...(position as object), ...pointerPosition }, true);
        };
        const moveTouch = (position: unknown) => { focusDesktop(); client.sendMouseState(position, true); };
        mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = moveMouse;
        touch.onmousedown = touch.onmouseup = touch.onmousemove = moveTouch;
        let resizeTimer: ReturnType<typeof setTimeout>;
        const fit = () => {
          const width = display.getWidth(), height = display.getHeight();
          if (width && height) display.scale(Math.min(element.clientWidth / width, element.clientHeight / height));
        };
        display.onresize = fit;
        const dimensions = () => [Math.max(320, Math.min(3840, Math.round(element.clientWidth))), Math.max(240, Math.min(2160, Math.round(element.clientHeight)))];
        const observer = new ResizeObserver(() => {
          fit(); clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => { const [width, height] = dimensions(); client.sendSize(width, height); }, 150);
        });
        observer.observe(element);
        element.addEventListener("blur", releaseKeys);
        window.addEventListener("blur", releaseKeys);
        cleanup = () => {
          observer.disconnect(); clearTimeout(resizeTimer);
          element.removeEventListener("blur", releaseKeys); window.removeEventListener("blur", releaseKeys);
          keyboard.reset(); keyboard.onkeydown = null; keyboard.onkeyup = null;
          for (const event of mouseEvents) displayElement.removeEventListener(event, captureMouse, true);
          for (const pointer of [mouse, touch]) pointer.onmousedown = pointer.onmouseup = pointer.onmousemove = null;
          client.onstatechange = null; client.onerror = null; tunnel.onerror = null;
          client.disconnect(); clientRef.current = null; element.replaceChildren();
        };
        const [width, height] = dimensions();
        client.connect(new URLSearchParams({ ticket: data.ticket, width: String(width), height: String(height) }).toString());
      } catch (issue) {
        if (!disposed) { setError(rdpError(issue, issue instanceof Error ? issue.message : "Could not connect to the desktop.")); setState("Connection failed"); }
      }
    })();
    return () => { disposed = true; abort.abort(); cleanup(); };
  }, [connection.id, attempt, screenNode]);

  function secureAttention() {
    const client = clientRef.current;
    if (!client) return;
    for (const key of [0xffe3, 0xffe9, 0xffff]) client.sendKeyEvent(1, key);
    for (const key of [0xffff, 0xffe9, 0xffe3]) client.sendKeyEvent(0, key);
    screen.current?.focus();
  }

  return <Dialog open onOpenChange={(open, details) => {
    if (details.reason === "escape-key" && screen.current?.contains(document.activeElement)) { details.cancel(); return; }
    if (!open) onClose();
  }}>
    <DialogContent ref={frame} className="flex h-[min(88dvh,1000px)] w-[calc(100%-2rem)] flex-col overflow-hidden p-0 sm:max-w-[min(96vw,1800px)]">
      <DialogHeader className="shrink-0 border-b p-4 pr-12">
        <DialogTitle>{connection.name}</DialogTitle>
        <DialogDescription>{state} · {connection.host}:{connection.port}</DialogDescription>
      </DialogHeader>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button variant="outline" size="sm" disabled={!connected} onClick={secureAttention}>Ctrl + Alt + Delete</Button>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Fullscreen" onClick={() => { void frame.current?.requestFullscreen().catch(() => setError("Fullscreen is unavailable in this browser.")); }} />}><Maximize2 className="size-4" /></TooltipTrigger><TooltipContent>Fullscreen</TooltipContent></Tooltip>
        <Button variant="outline" size="sm" onClick={() => { setState("Connecting…"); setError(""); setConnected(false); setAttempt(value => value + 1); }}><RefreshCw className="size-4" />Reconnect</Button>
        <Button variant="ghost" size="sm" onClick={onClose}><Unplug className="size-4" />Disconnect</Button>
        <span className="ml-auto hidden text-xs text-muted-foreground sm:block">Click the desktop to control it</span>
      </div>
      {error && <p role="alert" className="shrink-0 border-b bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <div ref={attachScreen} data-rdp-screen tabIndex={0} aria-label="Remote desktop" className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" />
    </DialogContent>
  </Dialog>;
}
