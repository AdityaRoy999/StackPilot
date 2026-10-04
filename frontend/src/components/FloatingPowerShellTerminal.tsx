"use client";

import React, { useState, useRef, useEffect, useCallback, memo } from "react";
import { Loader2, Maximize2, Minimize2, TerminalIcon, Trash2, X } from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import api from "@/lib/api";

export interface TerminalLogEntry {
  id: string;
  command: string;
  status: "running" | "success" | "error";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  cwd?: string;
  timestamp: string;
}

export interface FloatingPowerShellTerminalProps {
  open: boolean;
  onClose: () => void;
  selectedDeploymentId?: string;
  selectedProjectId?: string;
  initialCommand?: string;
  onInitialCommandConsumed?: () => void;
}

function terminalErrorMessage(error: unknown) {
  const candidate = error as { message?: string; response?: { data?: { error?: string } } };
  return candidate.response?.data?.error || candidate.message || "Execution failed";
}

export const FloatingPowerShellTerminal = memo(function FloatingPowerShellTerminal({
  open,
  onClose,
  selectedDeploymentId,
  selectedProjectId,
  initialCommand,
  onInitialCommandConsumed,
}: FloatingPowerShellTerminalProps) {
  const [terminalLogs, setTerminalLogs] = useState<TerminalLogEntry[]>([]);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isExecuting, setIsExecuting] = useState(false);
  const [terminalCwd, setTerminalCwd] = useState("");
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [terminalPos, setTerminalPos] = useState({ x: 40, y: 80 });

  const terminalInputRef = useRef<HTMLInputElement>(null);
  const terminalLogsEndRef = useRef<HTMLDivElement>(null);
  const terminalWindowRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0 });
  const rafDragRef = useRef<number | null>(null);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        terminalInputRef.current?.focus();
        terminalLogsEndRef.current?.scrollIntoView({ behavior: "instant" });
      }, 50);
    }
  }, [open]);

  // Auto-scroll when logs change
  useEffect(() => {
    if (open) {
      terminalLogsEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [terminalLogs, open]);

  // Silky-smooth RAF dragging that doesn't thrash React render loops
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      if (rafDragRef.current !== null) return;

      rafDragRef.current = requestAnimationFrame(() => {
        rafDragRef.current = null;
        const deltaX = e.clientX - dragStartRef.current.startX;
        const deltaY = e.clientY - dragStartRef.current.startY;
        const newX = Math.max(10, Math.min(window.innerWidth - 120, dragStartRef.current.initialX + deltaX));
        const newY = Math.max(10, Math.min(window.innerHeight - 80, dragStartRef.current.initialY + deltaY));
        setTerminalPos({ x: newX, y: newY });
      });
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      if (rafDragRef.current !== null) {
        cancelAnimationFrame(rafDragRef.current);
        rafDragRef.current = null;
      }
    };

    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (rafDragRef.current !== null) {
        cancelAnimationFrame(rafDragRef.current);
      }
    };
  }, []);

  const handleDragStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button") || (e.target as HTMLElement).closest("input")) return;
    if (terminalMaximized) return;

    const rect = terminalWindowRef.current?.getBoundingClientRect();
    if (!rect) return;

    isDraggingRef.current = true;
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: rect.left,
      initialY: rect.top,
    };
  };

  const runCommand = useCallback(async (cmdToRun: string) => {
    const trimmed = cmdToRun.trim();
    if (!trimmed || isExecuting) return;

    if (trimmed.toLowerCase() === "clear" || trimmed.toLowerCase() === "cls") {
      setTerminalLogs([]);
      setTerminalInput("");
      return;
    }

    const execId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newEntry: TerminalLogEntry = {
      id: execId,
      command: trimmed,
      status: "running",
      cwd: terminalCwd || undefined,
      timestamp: new Date().toLocaleTimeString(),
    };

    setTerminalLogs((prev) => [...prev, newEntry]);
    setTerminalHistory((prev) => [...prev, trimmed]);
    setHistoryIndex(-1);
    setTerminalInput("");
    setIsExecuting(true);

    try {
      const res = await api.post("/ai/tools/execute", {
        tool_name: "terminal_run_command",
        arguments: {
          command: trimmed,
          ...(selectedDeploymentId ? { deployment_id: selectedDeploymentId } : {}),
          ...(selectedProjectId ? { project_id: selectedProjectId } : {}),
        },
      });

      const data = (res.data || {}) as Record<string, unknown>;
      const exitCode = typeof data.exit_code === "number" ? data.exit_code : data.error ? 1 : 0;
      const stdout =
        typeof data.stdout === "string"
          ? data.stdout
          : exitCode === 0 && typeof data.output === "string"
          ? data.output
          : "";
      const stderr =
        typeof data.stderr === "string"
          ? data.stderr
          : exitCode !== 0
          ? typeof data.output === "string"
            ? data.output
            : typeof data.error === "string"
            ? data.error
            : ""
          : "";
      const cwd =
        typeof data.cwd === "string"
          ? data.cwd
          : typeof data.working_directory === "string"
          ? data.working_directory
          : undefined;

      if (cwd) {
        setTerminalCwd(cwd);
      }

      setTerminalLogs((prev) =>
        prev.map((item) =>
          item.id === execId
            ? {
                ...item,
                status: exitCode === 0 ? "success" : "error",
                exitCode,
                stdout: stdout || undefined,
                stderr: stderr || undefined,
                cwd,
              }
            : item
        )
      );
    } catch (error: unknown) {
      const errMessage = terminalErrorMessage(error);
      setTerminalLogs((prev) =>
        prev.map((item) =>
          item.id === execId
            ? {
                ...item,
                status: "error",
                exitCode: 1,
                stderr: errMessage,
              }
            : item
        )
      );
    } finally {
      setIsExecuting(false);
      setTimeout(() => {
        terminalInputRef.current?.focus();
      }, 50);
    }
  }, [isExecuting, selectedDeploymentId, selectedProjectId, terminalCwd]);

  useEffect(() => {
    if (open && initialCommand) {
      runCommand(initialCommand);
      onInitialCommandConsumed?.();
    }
  }, [initialCommand, onInitialCommandConsumed, open, runCommand]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (terminalHistory.length === 0) return;
      const nextIndex = historyIndex === -1 ? terminalHistory.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setTerminalInput(terminalHistory[nextIndex] || "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex === -1) return;
      if (historyIndex < terminalHistory.length - 1) {
        const nextIndex = historyIndex + 1;
        setHistoryIndex(nextIndex);
        setTerminalInput(terminalHistory[nextIndex] || "");
      } else {
        setHistoryIndex(-1);
        setTerminalInput("");
      }
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runCommand(terminalInput);
    }
  };

  if (!open) return null;

  return (
    <div
      ref={terminalWindowRef}
      data-slot="floating-terminal"
      data-maximized={terminalMaximized || undefined}
      style={
        terminalMaximized
          ? {
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              width: "100vw",
              height: "100dvh",
              zIndex: 90,
            }
          : {
              position: "fixed",
              left: `${terminalPos.x}px`,
              top: `${terminalPos.y}px`,
              width: "min(680px, 92vw)",
              height: "min(460px, 65dvh)",
              zIndex: 60,
            }
      }
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-2xl transition-shadow",
        !terminalMaximized && "min-w-0 sm:resize sm:min-w-[360px] min-h-[220px] max-w-[95vw] max-h-[85dvh]"
      )}
    >
      <div
        onMouseDown={handleDragStart}
        className={cn(
          "flex h-12 shrink-0 items-center justify-between border-b border-border bg-muted/30 px-3 select-none",
          !terminalMaximized ? "cursor-grab active:cursor-grabbing" : "cursor-default"
        )}
      >
        <div className="pointer-events-none flex min-w-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-primary shadow-sm">
            <AppIcon name="terminal" fallback={TerminalIcon} className="size-4" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-xs font-semibold">StackPilot Terminal</div>
            <div className="truncate text-[11px] text-muted-foreground">{terminalCwd || "Workspace command session"}</div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-md text-muted-foreground hover:text-foreground"
            onClick={() => setTerminalLogs([])}
            title="Clear buffer"
            aria-label="Clear terminal buffer"
          >
            <AppIcon name="trash-2" fallback={Trash2} className="size-3.5" />
          </Button>

          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-md text-muted-foreground hover:text-foreground"
            onClick={() => setTerminalMaximized((prev) => !prev)}
            title={terminalMaximized ? "Restore" : "Maximize"}
            aria-label={terminalMaximized ? "Restore" : "Maximize"}
          >
            {terminalMaximized ? (
              <AppIcon name="minimize-2" fallback={Minimize2} className="size-3.5" />
            ) : (
              <AppIcon name="maximize-2" fallback={Maximize2} className="size-3.5" />
            )}
          </Button>

          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <AppIcon name="x" fallback={X} className="size-3.5" />
          </Button>
        </div>
      </div>

      <div
        onClick={() => terminalInputRef.current?.focus()}
        className="min-h-0 flex-1 cursor-text select-text overflow-y-auto bg-background p-3 font-mono text-xs font-normal leading-relaxed text-foreground scrollbar-thin"
      >
        <div className="pb-2 font-mono text-xs font-normal leading-relaxed text-muted-foreground select-none">
          StackPilot workspace terminal
          <br />Commands run in the selected project or deployment context.
        </div>

        {/* Executed command history */}
        {terminalLogs.map((log) => (
          <div key={log.id} className="space-y-0.5 pt-1">
            <div className="flex items-center gap-1 font-normal text-foreground">
              <span className="text-muted-foreground select-none">stackpilot:{log.cwd || terminalCwd || "workspace"}$</span>
              <span>{log.command}</span>
              {log.status === "running" && <Loader2 className="h-3 w-3 animate-spin text-amber-300 ml-1" />}
            </div>

            {log.stdout && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words py-0.5 font-mono text-xs font-normal leading-relaxed text-foreground">
                {log.stdout}
              </pre>
            )}

            {log.stderr && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words py-0.5 font-mono text-xs font-normal leading-relaxed text-destructive">
                {log.stderr}
              </pre>
            )}
          </div>
        ))}

        {/* Active prompt & input line directly in console */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runCommand(terminalInput);
          }}
          className="flex items-center gap-1.5 pt-1.5"
        >
          <span className="shrink-0 whitespace-nowrap font-normal text-muted-foreground select-none">
            stackpilot:{terminalCwd || "workspace"}$
          </span>
          <div className="relative flex-1 flex items-center min-w-0">
            <input
              ref={terminalInputRef}
              type="text"
              value={terminalInput}
              disabled={isExecuting}
              onChange={(e) => setTerminalInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="m-0 w-full border-none bg-transparent p-0 font-mono text-xs font-normal leading-normal text-foreground shadow-none outline-none focus:outline-none focus:ring-0"
              spellCheck={false}
              autoComplete="off"
            />
            {isExecuting && <Loader2 className="h-3 w-3 animate-spin text-amber-300 ml-1 shrink-0" />}
          </div>
        </form>
        <div ref={terminalLogsEndRef} />
      </div>
    </div>
  );
});
