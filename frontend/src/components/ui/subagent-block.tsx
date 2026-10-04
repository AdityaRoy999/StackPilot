"use client";

import React, { useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Loader2,
  CircleAlert,
  Clock3,
  Target,
  Workflow,
} from "@/lib/platform-icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ThinkingPanel } from "@/components/ui/thinking-panel";
import { ToolsPanel, ToolCall } from "@/components/ui/tool-call-card";
import type { AgentTaskStatus } from "@/lib/agent-team";

export interface SubagentThreadMessage {
  id: string;
  role: "supervisor" | "subagent" | "tool" | "system";
  title?: string;
  content: string;
  timestamp?: string;
  toolCall?: ToolCall;
  badge?: string;
  status?: "running" | "completed" | "failed";
  metadata?: Record<string, any>;
}

export interface SubagentTask {
  id: string;
  role: string;
  title?: string;
  task?: string;
  prompt?: string;
  status: AgentTaskStatus;
  toolCalls?: ToolCall[];
  result?: string;
  response?: string;
  createdAt?: string;
  completedAt?: string;
  thread?: SubagentThreadMessage[];
  objectiveDetails?: string;
  responseDetails?: string;
  lastSequence?: number;
  modelCalls?: number;
  lastModelLatencyMs?: number;
  providerRetry?: number;
  messages?: Array<{id?: string; content: string; recipient?: string}>;
}

export function getSubagentMeta(role: string): {
  icon: any;
  tone: string;
  badgeTone: string;
  textColor: string;
  defaultTitle: string;
} {
  return {
    icon: Bot,
    tone: "border-primary/30 bg-primary/5 text-primary",
    badgeTone: "border-primary/30 bg-primary/5 text-primary",
    textColor: "text-primary",
    defaultTitle: role || "Task worker",
  };
}

export function generateSubagentThread(subagent: SubagentTask): SubagentThreadMessage[] {
  if (subagent.thread && subagent.thread.length > 0) {
    return subagent.thread;
  }

  const thread: SubagentThreadMessage[] = [];
  const meta = getSubagentMeta(subagent.role);
  const title = subagent.title || meta.defaultTitle;
  const taskText = subagent.task || subagent.prompt || "Task instruction unavailable.";

  thread.push({
    id: `${subagent.id}-directive`,
    role: "supervisor",
    title: "Main Agent Directive • Assigned Objective",
    badge: "Directive",
    status: "completed",
    content: taskText,
  });

  if (subagent.toolCalls && subagent.toolCalls.length > 0) {
    subagent.toolCalls.forEach((tc, idx) => {
      thread.push({
        id: `${subagent.id}-tool-${idx}`,
        role: "tool",
        title: `Tool Execution • ${tc.name}`,
        badge: tc.name,
        status: tc.result
          ? tc.result.error || ['failed','blocked','denied','conflict'].includes(String(tc.result.status)) ||
            (typeof tc.result.exit_code === 'number' && tc.result.exit_code !== 0)
            ? "failed"
            : "completed"
          : "running",
        toolCall: tc,
        content: tc.result ? `Observed result from ${tc.name}` : `Dispatched ${tc.name}`,
      });
    });
  }
  for (const [index, message] of (subagent.messages || []).entries()) {
    thread.push({id: message.id || `${subagent.id}-message-${index}`, role: "subagent",
      title: `${title} • Team message`, badge: "Message", content: message.content});
  }

  return thread;
}

/**
 * Extract thinking, tool calls, and response from a SubagentTask
 */
export function extractSubagentDetails(subagent: SubagentTask) {
  const meta = getSubagentMeta(subagent.role);
  const title = subagent.title || meta.defaultTitle;
  const thread = generateSubagentThread(subagent);

  const directiveMsg = thread.find((m) => m.role === "supervisor");
  const directiveText = subagent.task || subagent.prompt || directiveMsg?.content || "Assigned task directive";

  const reasoningMsgs = thread.filter(
    (m) => m.role === "subagent" && (m.badge === "Analysis" || m.badge === "Reasoning" || m.title?.includes("Analysis"))
  );
  const reasoningBlocks = reasoningMsgs.map((m) => m.content);
  if (reasoningBlocks.length === 0 && subagent.objectiveDetails) {
    reasoningBlocks.push(subagent.objectiveDetails);
  }

  // Tool calls
  let tools: ToolCall[] = subagent.toolCalls || [];
  if (tools.length === 0) {
    const toolMsgs = thread.filter((m) => m.role === "tool" && m.toolCall);
    tools = toolMsgs.map((m) => m.toolCall!);
  }

  // Final content
  const deliverableText =
    subagent.result ||
    subagent.response ||
    subagent.responseDetails ||
    "No result has been received from this worker.";

  return {
    title,
    meta,
    directiveText,
    reasoningBlocks,
    tools,
    deliverableText,
  };
}

/**
 * Polished CodeBlock component for Subagent markdown deliverables
 */
function SubagentCodeBlock({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  const [copied, setCopied] = useState(false);
  const isInline = !className;
  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "";
  const code = String(children).replace(/\n$/, "");

  if (isInline) {
    return (
      <code
        className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-ink font-medium break-all [overflow-wrap:anywhere] whitespace-normal"
        {...props}
      >
        {children}
      </code>
    );
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success("Code copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative my-2.5 rounded-lg border border-border/80 bg-field/80 overflow-hidden min-w-0 max-w-full shadow-xs">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/60 px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-[11px] font-mono font-medium uppercase tracking-wider text-ink-3">
          <Code2 className="h-3.5 w-3.5 text-primary" />
          <span>{lang || "code"}</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium text-ink-3 transition-colors hover:bg-hover hover:text-ink cursor-pointer select-none"
        >
          {copied ? (
            <Check className="h-3 w-3 text-emerald-400" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="overflow-x-auto min-w-0 max-w-full p-3 font-mono text-xs leading-relaxed text-ink bg-zinc-950/40">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}

const subagentMarkdownComponents = {
  pre: ({ children }: any) => <div className="min-w-0 max-w-full my-1">{children}</div>,
  code: SubagentCodeBlock,
  p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="mb-2 last:mb-0 break-words [overflow-wrap:anywhere] leading-relaxed" {...props}>
      {children}
    </p>
  ),
  ol: ({ children, ...props }: React.OlHTMLAttributes<HTMLOListElement>) => (
    <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0 break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </ol>
  ),
  ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0 break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </ul>
  ),
  li: ({ children, ...props }: React.LiHTMLAttributes<HTMLLIElement>) => (
    <li className="text-sm break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </li>
  ),
  strong: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <strong className="font-semibold text-ink" {...props}>
      {children}
    </strong>
  ),
  h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className="mb-2 mt-3 text-base font-semibold text-ink first:mt-0 break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </h3>
  ),
  h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4 className="mb-1.5 mt-2.5 text-sm font-semibold text-ink first:mt-0 break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </h4>
  ),
  h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h5 className="mb-1 mt-2 text-sm font-medium text-ink first:mt-0 break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </h5>
  ),
  blockquote: ({ children, ...props }: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => (
    <blockquote className="border-l-2 border-primary/40 pl-3 italic text-ink-3 break-words [overflow-wrap:anywhere]" {...props}>
      {children}
    </blockquote>
  ),
  table: ({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-border/80 max-w-full">
      <table className="w-full text-sm" {...props}>{children}</table>
    </div>
  ),
  th: ({ children, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th className="border-b border-border/80 bg-muted/60 px-3 py-1.5 text-left text-xs font-medium text-ink" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className="border-b border-border/60 px-3 py-1.5 text-ink" {...props}>
      {children}
    </td>
  ),
} as any;

/**
 * SubagentsPanel - Inline full-width section with the exact same opening/closing animation as Tools.
 * No popup modals or cards: subagents expand directly within the chat message flow!
 */
export function SubagentsPanel({
  subagents,
  isGenerating,
  onOpenTerminal,
  className,
}: {
  subagents: SubagentTask[];
  isGenerating?: boolean;
  onOpenTerminal?: (command?: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [userToggledRows, setUserToggledRows] = useState<Set<string>>(new Set());

  if (!subagents || subagents.length === 0) return null;

  const runningCount = subagents.filter((s) => s.status === "running").length;
  const isActive = isGenerating || runningCount > 0;

  const toggleRow = (id: string) => {
    setUserToggledRows((prev) => new Set(prev).add(id));
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className={cn("w-full min-w-0 max-w-full transition-[margin,padding] duration-200", open ? "pb-1 mb-2" : "pb-0 mb-0", className)}>
      {/* Accordion Header - Matches ToolsPanel toggle exactly */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-2 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2 cursor-pointer select-none"
        >
          {/* Rotating Chevron */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition-transform duration-200 shrink-0"
            style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>

          {/* Section Title: '3 sub agents' matching '28 tool calls' */}
          <span className="tabular-nums font-medium">
            {subagents.length} {subagents.length === 1 ? "sub agent" : "sub agents"}
          </span>

          {/* Active running spinner if generating */}
          {isActive && (
            <span className="ml-1.5 inline-flex items-center gap-1 text-[10.5px] font-medium text-primary">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              <span>running</span>
            </span>
          )}
        </button>
      </div>

      {/* Accordion Container with exact same CSS grid animation as tools */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        <div className="-mx-1 overflow-hidden px-1.5 pb-1">
          <div className="mt-1.5 flex flex-col gap-1">
            {subagents.map((subagent, idx) => {
              const {
                title,
                meta,
                directiveText,
                reasoningBlocks,
                tools,
                deliverableText,
              } = extractSubagentDetails(subagent);
              const IconComponent = meta.icon;
              const isRunning = subagent.status === "running";
              const rowOpen =
                openRows.has(subagent.id) ||
                (isRunning && !userToggledRows.has(subagent.id));

              return (
                <div
                  key={subagent.id || idx}
                  className={cn(
                    "rounded-md transition-all duration-150",
                    isRunning && "border border-primary/30 bg-primary/5 px-2 py-0.5"
                  )}
                  style={{
                    animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both",
                  }}
                >
                  {/* Interactive Subagent Row - Matches Tool Call Row */}
                  <div className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-2 text-left transition-colors duration-150 hover:bg-hover-2">
                    <button
                      type="button"
                      aria-expanded={rowOpen}
                      onClick={() => toggleRow(subagent.id)}
                      className="flex items-center gap-2 min-w-0 flex-1 h-full text-left cursor-pointer select-none"
                    >
                      {/* Icon / Rotating Chevron on hover and open */}
                      <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
                        <IconComponent
                          className={cn(
                            "size-3.5 transition-opacity duration-100 group-hover/row:opacity-0",
                            rowOpen ? "opacity-0" : "",
                            meta.textColor
                          )}
                        />
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={cn(
                            "absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100",
                            rowOpen ? "opacity-100" : "opacity-0"
                          )}
                          style={{
                            transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)",
                          }}
                        >
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </span>

                      {/* Subagent Name */}
                      <span className="shrink-0 text-[12px] font-medium text-ink">
                        {title}
                      </span>

                      {/* Chip with Assigned Task / Directive Summary */}
                      <span className="inline-flex h-5.5 min-w-0 flex-1 items-center truncate rounded-chip bg-field px-2 text-[11px] text-ink-2 shadow-hairline transition-colors duration-100 hover:bg-hover-2 font-mono">
                        {subagent.task || subagent.prompt || directiveText}
                      </span>

                      {/* Status indicator */}
                      {isRunning ? (
                        <span className="ml-auto inline-flex items-center gap-1.5 text-[10.5px] font-medium text-primary shrink-0">
                          <Loader2 className="size-3 animate-spin" />
                          <span aria-live="polite">{subagent.providerRetry ? `Reconnecting (${subagent.providerRetry})` : "Running"}</span>
                        </span>
                      ) : (
                        <span className={cn("ml-auto inline-flex items-center gap-1 text-[10.5px] font-medium shrink-0",
                          subagent.status === "completed" ? "text-emerald-400" : subagent.status === "failed" || subagent.status === "blocked" ? "text-amber-500" : "text-ink-3")}>
                          {subagent.status === "completed" ? <Check className="size-3" /> : subagent.status === "blocked" || subagent.status === "failed" ? <CircleAlert className="size-3" /> : <Clock3 className="size-3" />}
                          <span>{subagent.status === "submitted" ? "Awaiting integration" : subagent.status.charAt(0).toUpperCase() + subagent.status.slice(1)}</span>
                        </span>
                      )}
                    </button>

                    {/* Quick copy deliverable button */}
                    {deliverableText && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(deliverableText);
                          toast.success(`${title} deliverable copied to clipboard`);
                        }}
                        title="Copy Subagent Output"
                        className="h-5 w-5 opacity-0 group-hover/row:opacity-100 transition-opacity rounded text-ink-3 hover:text-ink hover:bg-hover shrink-0 flex items-center justify-center cursor-pointer"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    )}
                  </div>

                  {/* Expanded Subagent Execution Section - Occupies the entire section! */}
                  <div
                    className="grid transition-[grid-template-rows,opacity] duration-300"
                    style={{
                      gridTemplateRows: rowOpen ? "1fr" : "0fr",
                      opacity: rowOpen ? 1 : 0,
                      transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                    }}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="mt-1.5 mb-2 ml-2 flex flex-col gap-2 border-l-2 border-line py-1 pl-3.5 pr-0.5">
                        {/* 1. Assigned Objective / Directive */}
                        {directiveText && (
                          <div className="rounded-md bg-field/80 border border-line px-3 py-2 text-xs shadow-xs">
                            <div className="text-[10px] uppercase font-semibold tracking-wider text-ink-3 mb-1 flex items-center gap-1.5">
                              <Target className="h-3 w-3 text-primary" />
                              <span>Assigned Objective</span>
                            </div>
                            <p className="whitespace-pre-wrap break-words text-xs text-ink leading-relaxed font-mono">
                              {directiveText}
                            </p>
                          </div>
                        )}

                        {/* 2. Thinking Panel (Native trace matching Main Agent) */}
                        {reasoningBlocks.length > 0 && (
                          <ThinkingPanel
                            reasoning={reasoningBlocks}
                            isGenerating={isRunning}
                          />
                        )}

                        {/* 3. Tools Panel (Native interactive tool chips) */}
                        {tools.length > 0 && (
                          <ToolsPanel
                            toolCalls={tools}
                            isGenerating={isRunning}
                            onOpenTerminal={onOpenTerminal}
                          />
                        )}

                        {/* 4. Subagent Deliverable Output Markdown */}
                        {deliverableText && (
                          <div className="prose-ai min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-sm leading-relaxed text-ink pt-0.5">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={subagentMarkdownComponents}
                            >
                              {deliverableText}
                            </ReactMarkdown>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Backward-compatible single SubagentBlock wrapper
 */
export function SubagentBlock({
  subagent,
  onOpenTerminal,
  className,
}: {
  subagent: SubagentTask;
  onOpenTerminal?: (command?: string) => void;
  className?: string;
}) {
  return (
    <SubagentsPanel
      subagents={[subagent]}
      onOpenTerminal={onOpenTerminal}
      className={className}
    />
  );
}

/**
 * Deprecated modal kept as no-op to satisfy any legacy imports
 */
export function SubagentDetailModal(_props: any) {
  return null;
}
