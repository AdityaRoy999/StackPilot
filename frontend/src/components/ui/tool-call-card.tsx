import { useState } from "react";
import {
  Terminal,
  FolderTree,
  FileCode,
  FileEdit,
  Wrench,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Copy,
  Check,
  Folder,
  FileText,
  ScrollText,
  Sparkles,
  Search,
  AlertCircle,
  ShieldAlert,
  X,
} from "@/lib/platform-icons";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface ToolCall {
  id?: string;
  name: string;
  arguments: any;
  result?: any;
}

export function ToolCallCard({
  call,
  className,
  onOpenTerminal,
  isGenerating,
  pendingPermission,
  onAllow,
  onDeny,
}: {
  call: ToolCall;
  className?: string;
  onOpenTerminal?: (command?: string) => void;
  isGenerating?: boolean;
  pendingPermission?: boolean;
  onAllow?: (call: ToolCall) => void;
  onDeny?: (call: ToolCall) => void;
}) {
  const hasExecuted =
    call.result !== undefined &&
    call.result !== null &&
    call.result?.status !== "permission_required" &&
    call.result?.status !== "requires_approval" &&
    (call.result?.exit_code !== undefined ||
      call.result?.stdout !== undefined ||
      call.result?.stderr !== undefined ||
      call.result?.output !== undefined ||
      call.result?.status === "ok" ||
      call.result?.status === "success" ||
      call.result?.lines !== undefined ||
      call.result?.count !== undefined ||
      call.result?.files !== undefined ||
      call.result?.content !== undefined);

  const isDeclined =
    call.result?.status === "declined" ||
    call.result?.status === "rejected" ||
    call.result?.declined === true;

  const isPermissionRequired =
    !hasExecuted &&
    !isDeclined &&
    (Boolean(pendingPermission) ||
      call.result?.status === "permission_required" ||
      call.result?.status === "requires_approval" ||
      call.result?.action_required === "permission");

  const isPending = !isPermissionRequired && !isDeclined && !hasExecuted;
  const isTerminal = call.name === "terminal_run_command";
  const isReadFile = call.name === "workspace_read_file";
  const isListFiles = call.name === "workspace_list_files";
  const isWriteFile = call.name === "workspace_write_file" || call.name === "workspace_edit_file";
  const isLogs = call.name === "get_deployment_logs";
  const isRepair = call.name === "repair_deployment";
  const isSearch = call.name === "workspace_search";

  // Check exit code for terminal commands
  const exitCode = typeof call.result?.exit_code === "number" ? call.result.exit_code : undefined;
  const isError = exitCode !== undefined && exitCode !== 0;

  // Auto-expand if pending, permission needed, or if command failed with error
  const [open, setOpen] = useState(isPending || isPermissionRequired || isError);
  const [copied, setCopied] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const handleCopy = (text: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyCmd = (text: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  const command = call.arguments?.command || "";
  const path = call.arguments?.path || call.arguments?.file_path || "";

  return (
    <div
      className={cn(
        "my-2 rounded-lg border border-border/70 bg-muted/20 text-xs transition-all duration-150 min-w-0 max-w-full overflow-hidden",
        isPending && "border-blue-500/30",
        isError && "border-rose-500/40",
        isPermissionRequired && "border-amber-500/40",
        isDeclined && "opacity-70",
        className
      )}
    >
      {/* Header bar */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(!open);
          }
        }}
        className="w-full flex items-center justify-between px-3.5 py-2.5 text-left hover:bg-muted/40 transition-colors cursor-pointer select-none"
      >
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {/* Tool Icon */}
          {isTerminal ? (
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-900 border border-zinc-700/60 text-emerald-400">
              <Terminal className="h-3.5 w-3.5" />
            </div>
          ) : isReadFile ? (
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-950/50 border border-blue-800/40 text-blue-400">
              <FileCode className="h-3.5 w-3.5" />
            </div>
          ) : isListFiles ? (
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-950/50 border border-amber-800/40 text-amber-400">
              <FolderTree className="h-3.5 w-3.5" />
            </div>
          ) : isWriteFile ? (
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-purple-950/50 border border-purple-800/40 text-purple-400">
              <FileEdit className="h-3.5 w-3.5" />
            </div>
          ) : isLogs ? (
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-cyan-950/50 border border-cyan-800/40 text-cyan-400">
              <ScrollText className="h-3.5 w-3.5" />
            </div>
          ) : isRepair ? (
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-rose-950/50 border border-rose-800/40 text-rose-400">
              <Sparkles className="h-3.5 w-3.5" />
            </div>
          ) : isSearch ? (
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-emerald-950/50 border border-emerald-800/40 text-emerald-400">
              <Search className="h-3.5 w-3.5" />
            </div>
          ) : (
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted border border-border text-muted-foreground">
              <Wrench className="h-3.5 w-3.5" />
            </div>
          )}

          {/* Title / Description */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {isTerminal ? (
              <span className="font-mono text-xs font-semibold text-foreground/90 truncate">
                $ {command || "terminal"}
              </span>
            ) : isReadFile ? (
              <span className="text-xs font-medium text-foreground/90 truncate">
                Read <span className="font-mono font-semibold text-foreground">{path}</span>
              </span>
            ) : isListFiles ? (
              <span className="text-xs font-medium text-foreground/90 truncate">
                List files in <span className="font-mono font-semibold text-foreground">{path || "."}</span>
              </span>
            ) : isWriteFile ? (
              <span className="text-xs font-medium text-foreground/90 truncate">
                Edit <span className="font-mono font-semibold text-foreground">{path}</span>
              </span>
            ) : isLogs ? (
              <span className="text-xs font-medium text-foreground/90 truncate">
                Inspect logs for <span className="font-mono font-semibold text-foreground">{(call.arguments?.deployment_id || "").slice(0, 8) || "deployment"}</span>
              </span>
            ) : isRepair ? (
              <span className="text-xs font-medium text-foreground/90 truncate">
                Auto-repair deployment <span className="font-mono font-semibold text-foreground">{(call.arguments?.deployment_id || "").slice(0, 8) || "target"}</span>
              </span>
            ) : isSearch ? (
              <span className="text-xs font-medium text-foreground/90 truncate">
                Search codebase for <span className="font-mono font-semibold text-foreground">&quot;{call.arguments?.query || ""}&quot;</span>
              </span>
            ) : (
              <span className="text-xs font-medium text-foreground/90 truncate">
                {call.name}
              </span>
            )}
          </div>
        </div>

        {/* Status indicator, permission buttons & badge */}
        <div className="flex items-center gap-2 shrink-0 ml-3">
          {isPermissionRequired ? (
            <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onAllow?.(call);
                }}
                className="h-6 px-2.5 text-[11px] font-medium rounded bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1 shadow-xs transition-colors cursor-pointer"
                title="Allow execution"
              >
                <Check className="h-3 w-3" />
                <span>Allow</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeny?.(call);
                }}
                className="h-6 px-2 text-[11px] font-medium rounded border border-border/80 hover:bg-muted text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors cursor-pointer"
                title="Decline execution"
              >
                <X className="h-3 w-3" />
                <span>Decline</span>
              </button>
            </div>
          ) : isDeclined ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-mono border-zinc-700 text-zinc-400 bg-zinc-800/40">
              Declined
            </Badge>
          ) : isPending ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />
              <span>Running...</span>
            </div>
          ) : isTerminal ? (
            exitCode === 0 ? (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-mono border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
                exit 0
              </Badge>
            ) : (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-mono border-rose-500/30 text-rose-400 bg-rose-500/10">
                exit {exitCode ?? 1}
              </Badge>
            )
          ) : isReadFile && call.result?.lines !== undefined ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-mono border-blue-500/30 text-blue-400 bg-blue-500/10">
              {call.result.lines} lines
            </Badge>
          ) : isListFiles && (call.result?.count !== undefined || Array.isArray(call.result?.files)) ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-mono border-amber-500/30 text-amber-400 bg-amber-500/10">
              {call.result.count ?? call.result.files.length} items
            </Badge>
          ) : isLogs && call.result?.status ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-mono border-cyan-500/30 text-cyan-400 bg-cyan-500/10">
              logs fetched
            </Badge>
          ) : isRepair && (call.result?.status || call.result?.job_id) ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-mono border-rose-500/30 text-rose-400 bg-rose-500/10">
              {call.result.status || "repair queued"}
            </Badge>
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          )}

          <div className="text-muted-foreground/70">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </div>
        </div>
      </div>

      {/* Expanded Content Body */}
      {open && (
        <div className="border-t border-border/60 bg-muted/10">
          {isDeclined && (
            <div className="px-3 py-2 bg-rose-500/5 border-b border-rose-500/20 text-xs text-rose-400 flex items-center gap-2">
              <X className="h-3.5 w-3.5 shrink-0" />
              <span>Execution of this tool was declined by the user.</span>
            </div>
          )}

          {/* Terminal View */}
          {isTerminal ? (
            <div className="p-2.5">
              <div className="rounded-md border border-zinc-800/80 bg-zinc-950 font-mono text-xs text-zinc-300 overflow-hidden">
                {/* Minimal terminal header */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/60 border-b border-zinc-800/80 text-[11px] text-zinc-400">
                  <span className="truncate max-w-xs font-mono text-zinc-400">{call.result?.cwd || call.result?.working_directory || call.arguments?.cwd || "workspace"}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {hasExecuted && (
                      <button
                        type="button"
                        onClick={(e) => handleCopy(call.result?.stdout || call.result?.output || call.result?.stderr || command, e)}
                        className="text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors px-1 py-0.5 rounded hover:bg-zinc-800 flex items-center gap-1"
                        title="Copy output"
                      >
                        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                        <span>{copied ? "Copied" : "Copy"}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Terminal body */}
                <div className="p-3 space-y-2 max-h-72 overflow-y-auto font-mono text-xs select-text min-w-0 max-w-full">
                  <div className="text-zinc-300 font-semibold flex items-start gap-1.5 break-all">
                    <span className="text-zinc-600 select-none">$</span>
                    <span className="break-all">{command}</span>
                  </div>

                  {isPending && (
                    <div className="text-zinc-500 italic text-[11px] flex items-center gap-2 py-1">
                      <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />
                      <span>Executing in workspace environment...</span>
                    </div>
                  )}

                  {isPermissionRequired && (
                    <div className="text-zinc-500 italic text-[11px] py-1">
                      Waiting for user authorization to execute command...
                    </div>
                  )}

                  {hasExecuted && (
                    <div className="pt-1">
                      {call.result?.stdout && (
                        <pre className="whitespace-pre-wrap break-words text-zinc-300 leading-relaxed min-w-0 max-w-full">
                          {call.result.stdout}
                        </pre>
                      )}

                      {call.result?.stderr && (
                        <pre className="whitespace-pre-wrap break-words text-rose-400 leading-relaxed min-w-0 max-w-full">
                          {call.result.stderr}
                        </pre>
                      )}

                      {!call.result?.stdout && !call.result?.stderr && (
                        <div className="text-zinc-600 italic text-[11px]">(command finished with no output)</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : isReadFile ? (
            /* File Reader View */
            <div className="p-3">
              <div className="rounded-lg border border-border bg-muted/40 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border text-[11px] text-muted-foreground">
                  <span className="font-mono truncate">{path}</span>
                  <button
                    type="button"
                    onClick={(e) => handleCopy(call.result?.content || "", e)}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                    <span>{copied ? "Copied" : "Copy"}</span>
                  </button>
                </div>
                <div className="p-2 max-h-64 overflow-y-auto">
                  {isPending ? (
                    <div className="text-xs text-muted-foreground italic flex items-center gap-2 p-2">
                      <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                      <span>Reading file...</span>
                    </div>
                  ) : (
                    <pre className="font-mono text-xs whitespace-pre-wrap break-words p-2 leading-relaxed text-foreground/90">
                      {call.result?.content || "(empty file)"}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          ) : isListFiles ? (
            /* File Listing View */
            <div className="p-3">
              {isPending ? (
                <div className="text-xs text-muted-foreground italic flex items-center gap-2 p-2">
                  <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
                  <span>Scanning files...</span>
                </div>
              ) : Array.isArray(call.result?.files) ? (
                <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-background/50 p-2 space-y-1">
                  {call.result.files.map((file: any, index: number) => {
                    const isDir = file.type === "directory" || file.type === "dir";
                    return (
                      <div
                        key={index}
                        className="flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-muted/60 font-mono text-foreground/80"
                      >
                        {isDir ? (
                          <Folder className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                        )}
                        <span className="truncate flex-1">{file.path || file.name}</span>
                        {file.size !== undefined && (
                          <span className="text-[10px] text-muted-foreground shrink-0">{file.size}B</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <pre className="p-2 rounded bg-background/50 text-xs overflow-x-auto max-h-40 min-w-0 max-w-full break-words">
                  {JSON.stringify(call.result, null, 2)}
                </pre>
              )}
            </div>
          ) : (
            /* Generic Tool View */
            <div className="p-3 space-y-2.5">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  Parameters
                </div>
                <pre className="p-2 rounded-lg bg-background/60 border border-border/50 text-xs font-mono overflow-x-auto min-w-0 max-w-full break-words">
                  {JSON.stringify(call.arguments, null, 2)}
                </pre>
              </div>
              {!isPending && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                    Output
                  </div>
                  <pre className="p-2 rounded-lg bg-background/60 border border-border/50 text-xs font-mono overflow-x-auto max-h-48 min-w-0 max-w-full break-words">
                    {JSON.stringify(call.result, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { LiveToolChips } from "@/components/ui/beautiful-tool-chips";

/**
 * Collapsible accordion for grouping multiple tool execution cards.
 * Renders modern Beautiful UI compact tool chips with interactive row expansion,
 * diff previews, and permission gating cards.
 */
export function ToolsPanel({
  toolCalls,
  isGenerating,
  className,
  onOpenTerminal,
  onAllow,
  onDeny,
}: {
  toolCalls: ToolCall[];
  isGenerating?: boolean;
  className?: string;
  onOpenTerminal?: (command?: string) => void;
  onAllow?: (call: ToolCall) => void;
  onDeny?: (call: ToolCall) => void;
}) {
  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <LiveToolChips
      toolCalls={toolCalls}
      isGenerating={isGenerating}
      className={className}
      onOpenTerminal={onOpenTerminal}
      onAllow={onAllow}
      onDeny={onDeny}
    />
  );
}
