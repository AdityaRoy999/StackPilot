"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, RefreshCw, TerminalIcon } from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { readTerminalTheme, useCanvasThemeVersion } from "@/lib/canvas-theme";
import { isRemotePlatform, platformSocketBase } from "@/lib/remote-platform";

interface RemoteSshTerminalProps {
  connectionId: string;
  cwd: string;
  className?: string;
  title?: string;
  connectedInfo?: string;
  onClose?: () => void;
}

function getTerminalWsUrl(connectionId: string, cwd: string) {
  if(isRemotePlatform())return `${platformSocketBase()}/ws/ssh-terminal?${new URLSearchParams({connectionId,cwd})}`;
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8090/api/v1";
  const base = new URL(apiBase);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/ws/ssh-terminal";
  base.search = new URLSearchParams({ connectionId, cwd }).toString();
  return base.toString();
}

function tryParseControlMessage(data: string) {
  if (!data.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(data) as { type?: string; message?: string };
    return parsed.type ? parsed : null;
  } catch {
    return null;
  }
}

export function RemoteSshTerminal({
  connectionId,
  cwd,
  className,
  title,
  connectedInfo,
  onClose,
}: RemoteSshTerminalProps) {
  const themeVersion = useCanvasThemeVersion();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Track the browser's own fullscreen state rather than a local boolean, so
  // pressing Escape (which exits fullscreen without touching our button) does
  // not leave the icon lying about which mode we are in.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await rootRef.current?.requestFullscreen();
      }
      // The ResizeObserver already refits on size change, so xterm reflows to
      // the new dimensions without any extra work here.
    } catch {
      // Fullscreen can be refused by policy or an unsupported browser. Not
      // worth an error toast for a convenience control.
    }
  };
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "closed" | "error">("connecting");
  const [sessionKey, setSessionKey] = useState(0);

  useEffect(() => {
    if (!connectionId || !cwd || !containerRef.current) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let focusHandler: (() => void) | null = null;
    let terminalContainer: HTMLDivElement | null = null;

    async function openTerminal() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (disposed || !containerRef.current) return;
      terminalContainer = containerRef.current;

      setConnectionState("connecting");
      const terminal = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: "var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        lineHeight: 1.25,
        scrollback: 4000,
        scrollOnUserInput: true,
        theme: {
          ...readTerminalTheme(),
          // The ANSI sixteen stay fixed across themes: a program emitting
          // "red" means red, and remapping it would misreport build output.
          black: "#18181b",
          brightBlack: "#71717a",
          red: "#ef4444",
          green: "#22c55e",
          yellow: "#eab308",
          blue: "#3b82f6",
          magenta: "#a855f7",
          cyan: "#06b6d4",
          white: "#f4f4f5",
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalContainer);
      const fitAndFocus = () => {
        fitAddon.fit();
        terminal.scrollToBottom();
        terminal.focus();
      };
      requestAnimationFrame(fitAndFocus);

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      const socket = new WebSocket(getTerminalWsUrl(connectionId, cwd));
      socketRef.current = socket;

      const sendResize = () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        }
      };

      socket.addEventListener("open", () => {
        setConnectionState("connected");
        terminal.writeln("\x1b[90mStackPilot SSH session connected.\x1b[0m");
        terminal.scrollToBottom();
        requestAnimationFrame(() => terminal.scrollToBottom());
        sendResize();
      });

      socket.addEventListener("message", async (event) => {
        const data = typeof event.data === "string" ? event.data : await event.data.text();
        const controlMessage = tryParseControlMessage(data);
        if (controlMessage) {
          if (controlMessage.type === "error") {
            setConnectionState("error");
            terminal.writeln(`\r\n\x1b[31m${controlMessage.message || "Terminal error"}\x1b[0m`);
            terminal.scrollToBottom();
          } else if (controlMessage.type === "closed") {
            setConnectionState("closed");
            terminal.writeln(`\r\n\x1b[90m${controlMessage.message || "Terminal closed"}\x1b[0m`);
            terminal.scrollToBottom();
          }
          return;
        }
        terminal.write(data);
        terminal.scrollToBottom();
        requestAnimationFrame(() => terminal.scrollToBottom());
      });

      socket.addEventListener("close", () => {
        setConnectionState((state) => (state === "error" ? "error" : "closed"));
      });

      socket.addEventListener("error", () => {
        setConnectionState("error");
        terminal.writeln("\r\n\x1b[31mTerminal socket failed.\x1b[0m");
        terminal.scrollToBottom();
      });

      terminal.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(data);
        }
        terminal.scrollToBottom();
      });

      resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        terminal.scrollToBottom();
        sendResize();
      });
      resizeObserver.observe(terminalContainer);
      focusHandler = () => terminal.focus();
      terminalContainer.addEventListener("click", focusHandler);
    }

    openTerminal();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (focusHandler && terminalContainer) {
        terminalContainer.removeEventListener("click", focusHandler);
      }
      socketRef.current?.close();
      socketRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [connectionId, cwd, sessionKey]);

  // Recolour a terminal that is already open. Without this, switching theme
  // leaves the session on the palette it was created with until reconnect.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = { ...terminal.options.theme, ...readTerminalTheme() };
  }, [themeVersion]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "flex h-full min-h-[320px] flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl",
        // In fullscreen the element is the whole viewport, so the rounded
        // corners and border would draw a box around the screen edge.
        isFullscreen && "min-h-0 rounded-none border-0",
        className
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-muted/30 px-3 select-none">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-primary shadow-sm">
            <AppIcon name="terminal" fallback={TerminalIcon} className="size-4" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-xs font-semibold">StackPilot Terminal</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {connectedInfo || title || cwd}
            </div>
          </div>
          <span className={cn(
            "ml-1 size-1.5 shrink-0 rounded-full",
            connectionState === "connected" ? "bg-emerald-500" : connectionState === "connecting" ? "bg-amber-500 animate-pulse" : "bg-destructive"
          )} aria-label={`Terminal ${connectionState}`} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setSessionKey((value) => value + 1)}
            title="Reconnect session"
          >
            <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-1.5 h-3 w-3" />
            Reconnect
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-md text-muted-foreground hover:text-foreground"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Restore" : "Maximize"}
            aria-label={isFullscreen ? "Restore" : "Maximize"}
          >
            {isFullscreen ? (
              <AppIcon name="minimize-2" fallback={Minimize2} className="size-3.5" />
            ) : (
              <AppIcon name="maximize-2" fallback={Maximize2} className="size-3.5" />
            )}
          </Button>
          {onClose && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={onClose}
              title="Close"
              aria-label="Close"
            >
              <span className="text-sm leading-none" aria-hidden="true">×</span>
            </Button>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        className="ssh-terminal-surface min-h-0 flex-1 overflow-hidden bg-background p-1.5 [&_.xterm-screen]:min-h-full [&_.xterm-viewport]:!overflow-y-auto [&_.xterm]:h-full"
      />
    </div>
  );
}
