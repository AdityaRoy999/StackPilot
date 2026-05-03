"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface RemoteSshTerminalProps {
  connectionId: string;
  cwd: string;
  className?: string;
}

function getTerminalWsUrl(connectionId: string, cwd: string) {
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

export function RemoteSshTerminal({ connectionId, cwd, className }: RemoteSshTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
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
          background: "#050505",
          foreground: "#f4f4f5",
          cursor: "#f4f4f5",
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
        terminal.writeln("\x1b[90mConnected. Use this like a normal SSH terminal.\x1b[0m");
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

  return (
    <div className={cn("flex h-full min-h-[420px] flex-col overflow-hidden rounded-xl border border-border bg-black", className)}>
      <div className="flex items-center justify-between border-b border-white/10 bg-zinc-950 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-300">
          <TerminalIcon className="h-4 w-4 shrink-0" />
          <span className="truncate font-mono">{cwd}</span>
          <span
            className={cn(
              "ml-2 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide",
              connectionState === "connected" && "bg-emerald-500/15 text-emerald-300",
              connectionState === "connecting" && "bg-yellow-500/15 text-yellow-300",
              connectionState === "closed" && "bg-zinc-500/15 text-zinc-300",
              connectionState === "error" && "bg-red-500/15 text-red-300"
            )}
          >
            {connectionState}
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-zinc-300 hover:bg-white/10 hover:text-white"
          onClick={() => setSessionKey((value) => value + 1)}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Reconnect
        </Button>
      </div>
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden p-2 [&_.xterm-screen]:min-h-full [&_.xterm-viewport]:!overflow-y-auto [&_.xterm]:h-full"
      />
    </div>
  );
}
