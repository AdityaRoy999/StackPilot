"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Wrench, ShieldAlert, Check, X, Terminal, ExternalLink, Folder, FileText, Copy, Search, Globe, Maximize2, Eye } from "@/lib/platform-icons";
import { cn } from "@/lib/utils";
import api from "@/lib/api";
import { browserBatchSummary, browserResultSummary, toolArgumentSummary } from "@/lib/tool-summary";

/* ─────────────────────────────────────────────────────────
 * TOOL CHIPS
 * From https://www.beautifului.dev/
 *
 * An agent run as compact rows: tool calls with inline
 * chips, then file-diff chips summarizing the edits.
 * Hover a row to reveal its chevron; every row expands
 * to show what the tool actually did.
 * ───────────────────────────────────────────────────────── */

const STEP_MS = 700;

export const Icons: Record<string, React.ReactNode> = {
  think: <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,
  search: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </g>
  ),
  write: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </g>
  ),
  run: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 17l6-5-6-5M12 19h8" />
    </g>
  ),
  read: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </g>
  ),
  globe: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </g>
  ),
};

export type ToolDetailLine = { text: string; tone?: "add" | "del" | "ctx" };

export type ToolStep = {
  icon: string;
  label: string;
  chip: string;
  mono: boolean;
  detailMono: boolean;
  detail: ToolDetailLine[];
  status?: "pending" | "success" | "error" | "permission_required";
  rawCall?: any;
};

export type ToolDiff = { file: string; add: number; del: number };

export type ToolDiffLine = { text: string; tone: "add" | "del" | "ctx" };

export type ToolChipsLabels = {
  header: string;
  more: string;
};

const DEFAULT_LABELS: ToolChipsLabels = {
  header: "4 tool calls, 2 messages",
  more: "+2 more",
};

const SAMPLE_ROWS: ToolStep[] = [
  {
    icon: "think",
    label: "Thinking",
    chip: "Planning the churn schedule…",
    mono: false,
    detailMono: false,
    detail: [
      { text: "Weekend demand carries pistachio, so it churns first." },
      { text: "Batch capacity leaves two evening freezer windows." },
    ],
  },
  {
    icon: "write",
    label: "Write 204 lines",
    chip: "ChurnSchedule.tsx",
    mono: true,
    detailMono: true,
    detail: [
      { text: "+ const windows = slots.filter((s) => s.temp <= -12)", tone: "add" },
      { text: '+ return schedule(windows, { hero: "pistachio" })', tone: "add" },
    ],
  },
  {
    icon: "run",
    label: "Rebuild and verify",
    chip: "npm run freeze",
    mono: true,
    detailMono: true,
    detail: [{ text: "✓ built in 1.2s" }, { text: "✓ 34 checks passed" }],
  },
  {
    icon: "read",
    label: "Read image",
    chip: "flavor-chart.png",
    mono: true,
    detailMono: false,
    detail: [
      { text: "1280 × 720 · line chart, three summers." },
      { text: "Mint chip trends up 12% through July." },
    ],
  },
];

const SAMPLE_DIFFS: ToolDiff[] = [
  { file: "flavors.css", add: 13, del: 0 },
  { file: "ChurnSchedule.tsx", add: 74, del: 41 },
  { file: "menu.ts", add: 8, del: 2 },
];

const SAMPLE_DIFF_LINES: Record<string, ToolDiffLine[]> = {
  "flavors.css": [
    { text: ".scoop-card {", tone: "ctx" },
    { text: "  gap: 14px;", tone: "del" },
    { text: "  gap: 12px;", tone: "add" },
    { text: "  container-type: inline-size;", tone: "add" },
    { text: "}", tone: "ctx" },
  ],
  "ChurnSchedule.tsx": [
    { text: "const slots = coldSlots(week);", tone: "ctx" },
    { text: "const windows = slots;", tone: "del" },
    { text: "const windows = slots.filter(", tone: "add" },
    { text: "  (s) => s.temp <= -12,", tone: "add" },
    { text: ");", tone: "add" },
  ],
  "menu.ts": [
    { text: 'export const hero = "mint-chip";', tone: "del" },
    { text: 'export const hero = "pistachio";', tone: "add" },
  ],
};

export function ToolChips({
  steps = SAMPLE_ROWS,
  diffs = SAMPLE_DIFFS,
  diffLines = SAMPLE_DIFF_LINES,
  labels,
  className,
  onOpenChange,
  onToggleRow,
}: {
  variant?: string;
  steps?: ToolStep[];
  diffs?: ToolDiff[];
  diffLines?: Record<string, ToolDiffLine[]>;
  labels?: Partial<ToolChipsLabels>;
  className?: string;
  onOpenChange?: (open: boolean) => void;
  onToggleRow?: (label: string, open: boolean) => void;
} = {}) {
  const copy = { ...DEFAULT_LABELS, ...labels };
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(true);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{
    file: string;
    x: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  const openPreview = (file: string) => (event: React.SyntheticEvent) => {
    const chipEl = (event.currentTarget as Element).closest("[data-diffchip]");
    if (!chipEl) return;
    const rect = chipEl.getBoundingClientRect();
    const previewHeight = 38 + (diffLines[file]?.length ?? 0) * 19;
    const fitsBelow = rect.bottom + 6 + previewHeight <= window.innerHeight - 12;
    setPreview({
      file,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      ...(fitsBelow
        ? { top: rect.bottom + 6 }
        : { bottom: window.innerHeight - rect.top + 6 }),
    });
  };

  const closePreview = (file: string) => () =>
    setPreview((current) => (current?.file === file ? null : current));

  const total = steps.length + 1;

  useEffect(() => {
    if (step >= total) return;
    const t = setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [step, total]);

  const toggleRow = (label: string) =>
    setOpenRows((current) => {
      const next = new Set(current);
      next.has(label) ? next.delete(label) : next.add(label);
      onToggleRow?.(label, next.has(label));
      return next;
    });

  return (
    <div className={cn("min-h-[220px] w-full max-w-xl pb-1", className)}>
      {/* collapsed run header */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() =>
          setOpen((current) => {
            onOpenChange?.(!current);
            return !current;
          })
        }
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-2 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2 cursor-pointer"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-transform duration-200"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="tabular-nums font-medium">{copy.header}</span>
      </button>

      {/* tool call rows */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="-mx-1 overflow-hidden px-1.5 pb-1">
          <div className="mt-1.5 flex flex-col gap-1">
            {steps.slice(0, step).map((row, idx) => {
              const rowOpen = openRows.has(row.label + idx);
              return (
                <div
                  key={row.label + idx}
                  style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}
                >
                  <button
                    type="button"
                    aria-expanded={rowOpen}
                    onClick={() => toggleRow(row.label + idx)}
                    className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-2 text-left transition-colors duration-100 hover:bg-hover-2 cursor-pointer"
                  >
                    <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill={row.icon === "think" ? "currentColor" : "none"}
                        stroke="currentColor"
                        className={`transition-opacity duration-100 group-hover/row:opacity-0 ${
                          rowOpen ? "opacity-0" : ""
                        }`}
                      >
                        {Icons[row.icon] || Icons.think}
                      </svg>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100 ${
                          rowOpen ? "opacity-100" : "opacity-0"
                        }`}
                        style={{ transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </span>
                    <span className="shrink-0 text-[12.5px] font-medium text-ink">
                      {row.label}
                    </span>
                    <span
                      className={`inline-flex h-5.5 min-w-0 flex-1 cursor-pointer items-center truncate rounded-chip bg-field px-2
                        text-[11.5px] text-ink-2 shadow-hairline transition-colors duration-100 hover:bg-hover-2
                        ${row.mono ? "font-mono" : ""}`}
                    >
                      {row.chip}
                    </span>
                  </button>

                  {/* expanded detail */}
                  <div
                    className="grid transition-[grid-template-rows,opacity] duration-300"
                    style={{
                      gridTemplateRows: rowOpen ? "1fr" : "0fr",
                      opacity: rowOpen ? 1 : 0,
                      transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                    }}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l border-line py-0.5 pl-3.5">
                        {row.detail.map((line, lIdx) => (
                          <span
                            key={lIdx}
                            className={`truncate text-[11.5px] leading-[1.6] ${
                              row.detailMono ? "font-mono" : ""
                            } ${line.tone === "add" ? "text-green" : "text-ink-2"}`}
                          >
                            {line.text}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* file-diff chips */}
          {step >= total && diffs.length > 0 && (
            <div className="mt-2.5 flex max-w-full flex-wrap gap-1.5 border-t border-line pt-2.5">
              {diffs.map((d, i) => (
                <span
                  key={d.file}
                  data-diffchip
                  className="relative"
                  onMouseEnter={openPreview(d.file)}
                  onMouseLeave={closePreview(d.file)}
                >
                  <button
                    type="button"
                    aria-expanded={preview?.file === d.file}
                    aria-label={`Show diff for ${d.file}`}
                    onFocus={openPreview(d.file)}
                    onBlur={closePreview(d.file)}
                    className="inline-flex h-7 max-w-full items-center gap-2 rounded-chip
                      bg-surface px-2 font-mono text-[11.5px] text-ink shadow-btn
                      transition-colors duration-100 hover:bg-hover cursor-pointer border border-line"
                    style={{
                      animation: `pop-in 250ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both`,
                    }}
                  >
                    <span className="min-w-0 truncate">{d.file}</span>
                    <span className="shrink-0 text-green tabular-nums">+{d.add}</span>
                    {d.del > 0 && (
                      <span className="shrink-0 text-red tabular-nums">−{d.del}</span>
                    )}
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {preview && typeof document !== "undefined" && createPortal(
        <div
          className="fixed z-50 w-80 overflow-hidden rounded-[10px] bg-surface shadow-overlay border border-line"
          style={{
            left: preview.x,
            top: preview.top,
            bottom: preview.bottom,
            animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
            transformOrigin: preview.top === undefined ? "bottom left" : "top left",
          }}
        >
          <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5 font-mono text-[11px] bg-field/60">
            <span className="min-w-0 truncate text-ink-2 font-medium">{preview.file}</span>
            <span className="shrink-0 tabular-nums">
              <span className="text-green">
                +{diffs.find((diff) => diff.file === preview.file)?.add ?? 0}
              </span>
              {(diffs.find((diff) => diff.file === preview.file)?.del ?? 0) > 0 && (
                <span className="text-red">
                  {" "}
                  −{diffs.find((diff) => diff.file === preview.file)?.del}
                </span>
              )}
            </span>
          </div>
          <div className="py-1 font-mono text-[11px] leading-[1.8] max-h-60 overflow-y-auto">
            {(diffLines[preview.file] ?? []).map((line, index) => (
              <div
                key={index}
                className={`flex gap-2 px-2.5 whitespace-pre ${
                  line.tone === "add"
                    ? "bg-green-tint text-green"
                    : line.tone === "del"
                    ? "bg-red-tint text-red"
                    : "text-ink-2"
                }`}
              >
                <span className="w-3 shrink-0 select-none">
                  {line.tone === "add" ? "+" : line.tone === "del" ? "−" : " "}
                </span>
                <span className="min-w-0 truncate">{line.text}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

/**
 * LiveToolChips: Adapts real runtime ToolCall[] objects from StackPilot into
 * the Beautiful UI compact tool chips trace with interactive row expansion,
 * diff previews, and permission gating cards.
 */
export function LiveToolChips({
  toolCalls,
  isGenerating,
  className,
  onOpenTerminal,
  onAllow,
  onDeny,
}: {
  toolCalls: Array<{
    name: string;
    arguments: any;
    result?: any;
    id?: string;
  }>;
  isGenerating?: boolean;
  className?: string;
  onOpenTerminal?: (command?: string) => void;
  onAllow?: (call: any) => void;
  onDeny?: (call: any) => void;
}) {
  const [chosenOpen, setChosenOpen] = useState<boolean | null>(null);
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const open = chosenOpen ?? !phone;
  const [openRows, setOpenRows] = useState<Set<number>>(new Set());
  const [copiedRow, setCopiedRow] = useState<number | null>(null);
  const [preview, setPreview] = useState<{
    file: string;
    x: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const [selectedLightboxFrame, setSelectedLightboxFrame] = useState<string | null>(null);
  const [artifactFrames, setArtifactFrames] = useState<Record<string,string>>({});

  if (!toolCalls || toolCalls.length === 0) return null;

  // Convert ToolCall[] into ToolStep[]
  const steps: ToolStep[] = toolCalls.map((tc) => {
    let icon = "think";
    let label = tc.name;
    let chip = "";
    let mono = false;
    let detailMono = false;
    const detail: ToolDetailLine[] = [];

    const isDone = tc.result !== undefined && tc.result !== null;
    const isError =
      tc.result?.error ||
      (typeof tc.result?.exit_code === "number" && tc.result.exit_code !== 0) ||
      tc.result?.status === "failed";
    const isPermission =
      tc.result?.status === "permission_required" ||
      tc.result?.status === "requires_approval" ||
      tc.result?.action_required === "permission";

    if (tc.name === "define_completion_plan" || tc.name === "get_completion_status") {
      label = tc.name === "define_completion_plan" ? "Completion plan" : "Feature verification";
      const features = Array.isArray(tc.result?.features) ? tc.result.features : [];
      const passed = features.filter((feature: { status?: string }) => feature.status === "passed").length;
      chip = isDone ? `${passed}/${features.length} features verified` : "Reading requirements…";
      if (tc.result?.summary) detail.push({ text: tc.result.summary });
      if (tc.result?.workload) detail.push({ text: `Delivery: ${tc.result.workload}` });
      if (tc.result?.state === "needs_plan") detail.push({ text: "Finished features and acceptance checks have not been defined yet." });
      for (const feature of features) {
        detail.push({ text: `${feature.status === "passed" ? "✓" : feature.status === "failed" ? "✕" : "○"} ${feature.description} — ${feature.status || "unverified"}`,
          tone: feature.status === "passed" ? "add" : feature.status === "failed" ? "del" : "ctx" });
      }
      for (const assumption of tc.result?.assumptions || []) detail.push({ text: `Assumption: ${assumption}` });
      if (tc.result?.revision) detail.push({ text: `Source revision: ${String(tc.result.revision).slice(0, 12)}` });
    } else if (tc.name === "terminal_run_command" || tc.name === "run_worker_command") {
      icon = "run";
      label = "Run command";
      chip = tc.arguments?.command || (Array.isArray(tc.arguments?.argv) ? tc.arguments.argv.join(" ") : "command");
      mono = true;
      detailMono = true;
      if (isDone) {
        if (tc.result?.exit_code !== undefined) {
          detail.push({
            text: `Exit code: ${tc.result.exit_code}`,
            tone: tc.result.exit_code === 0 ? "ctx" : "del",
          });
        }
        if (tc.result?.stdout || tc.result?.output) {
          const stdoutLines = String(tc.result.stdout || tc.result.output).split("\n").slice(0, 10);
          stdoutLines.forEach((l) => detail.push({ text: l }));
        }
        if (tc.result?.stderr) {
          const stderrLines = String(tc.result.stderr).split("\n").slice(0, 5);
          stderrLines.forEach((l) => detail.push({ text: l, tone: "del" }));
        }
        if (detail.length === 0) {
          detail.push({ text: "(command produced no output)" });
        }
      } else {
        detail.push({ text: "Running command in workspace..." });
      }
    } else if (tc.name === "workspace_write_file" || tc.name === "workspace_edit_file") {
      icon = "write";
      const filePath = tc.arguments?.file_path || tc.arguments?.path || "file";
      const fileName = filePath.split("/").pop() || filePath;
      label = tc.name === "workspace_edit_file" ? "Edit" : "Write";
      chip = fileName;
      mono = true;
      detailMono = true;
      if (tc.arguments?.explanation) {
        detail.push({ text: tc.arguments.explanation });
      }
      if (tc.arguments?.content) {
        const lineCount = String(tc.arguments.content).split("\n").length;
        detail.push({ text: `+ ${lineCount} lines written`, tone: "add" });
      } else if (tc.arguments?.replacement) {
        detail.push({ text: "• Applied surgical code patch", tone: "add" });
      }
      if (isDone && tc.result?.message) {
        detail.push({ text: tc.result.message });
      }
    } else if (tc.name === "workspace_read_file") {
      icon = "read";
      const filePath = tc.arguments?.file_path || tc.arguments?.path || "file";
      const fileName = filePath.split("/").pop() || filePath;
      label = "Read";
      chip = fileName;
      mono = true;
      detailMono = false;
      if (isDone) {
        if (tc.result?.error) {
          detail.push({ text: `Error: ${tc.result.error}`, tone: "del" });
        } else if (tc.result?.content !== undefined) {
          const lines = String(tc.result.content).split("\n").length;
          const sizeStr = tc.result?.size ? `${tc.result.size} bytes` : "";
          detail.push({ text: `Read ${lines} lines${sizeStr ? ` (${sizeStr})` : ""}` });
        } else if (tc.result?.message) {
          detail.push({ text: tc.result.message });
        }
      } else {
        detail.push({ text: "Reading file content..." });
      }
    } else if (tc.name === "workspace_list_files") {
      icon = "read";
      label = "List files";
      chip = tc.arguments?.path || tc.arguments?.directory || "workspace";
      mono = true;
      detailMono = false;
      if (isDone) {
        const fileCount = Array.isArray(tc.result?.files)
          ? tc.result.files.length
          : tc.result?.count !== undefined
          ? tc.result.count
          : null;
        if (fileCount !== null) {
          detail.push({ text: `Found ${fileCount} matching files` });
        } else if (tc.result?.message) {
          detail.push({ text: tc.result.message });
        }
      } else {
        detail.push({ text: "Listing directory contents..." });
      }
    } else if (tc.name === "workspace_search") {
      icon = "read";
      label = "Search";
      chip = tc.arguments?.query || tc.arguments?.pattern || "workspace";
      mono = true;
      detailMono = false;
      if (isDone) {
        const matches = Array.isArray(tc.result?.matches)
          ? tc.result.matches.length
          : tc.result?.count !== undefined
          ? tc.result.count
          : null;
        if (matches !== null) {
          detail.push({ text: `Found ${matches} matches` });
        } else if (tc.result?.message) {
          detail.push({ text: tc.result.message });
        }
      } else {
        detail.push({ text: "Searching workspace files..." });
      }
    } else if (tc.name === "web_search" || tc.name === "search_web") {
      icon = "search";
      label = "Web search";
      chip = tc.arguments?.query || "web search";
      mono = false;
      detailMono = false;
      if (isDone) {
        const count = tc.result?.count || (Array.isArray(tc.result?.results) ? tc.result.results.length : 0);
        detail.push({ text: `Searched web for "${tc.arguments?.query || ''}" (${count} sources)` });
      } else {
        detail.push({ text: `Searching web for "${tc.arguments?.query || ''}"...` });
      }
    } else if (tc.name === "web_fetch") {
      icon = "read";
      label = "Fetch URL";
      const url = String(tc.arguments?.url || "");
      const domain = url.split("//")[1]?.split("/")[0] || url;
      chip = domain || "web page";
      mono = true;
      detailMono = false;
      if (isDone) {
        detail.push({ text: `Fetched ${tc.result?.length || 0} characters from ${domain}` });
      } else {
        detail.push({ text: `Fetching ${domain}...` });
      }
    } else if (tc.name === "get_deployment_logs") {
      icon = "read";
      label = "Get logs";
      chip = tc.arguments?.log_type ? `${tc.arguments.log_type} logs` : "runtime logs";
      mono = false;
      detailMono = true;
      if (isDone) {
        const rawLogs = tc.result?.logs || tc.result?.output || tc.result?.content || "";
        const logCount = String(rawLogs).split("\n").filter(Boolean).length;
        detail.push({ text: `Retrieved ${logCount} log entries` });
      } else {
        detail.push({ text: "Fetching deployment logs..." });
      }
    } else if (tc.name === "workspace_trigger_rebuild") {
      icon = "run";
      label = "Rebuild";
      chip = "Trigger rebuild";
      mono = true;
      detailMono = false;
      const queued=["rebuild_queued","build_queued"].includes(tc.result?.status || "") && Boolean(tc.result?.job_id);
      detail.push({ text: queued ? `Rebuild queued · Job ${tc.result.job_id}`
        : isPermission ? "Waiting for approval"
        : !isDone ? "Requesting a rebuild..."
        : `Rebuild not queued: ${tc.result?.error || tc.result?.message || tc.result?.status || "No job receipt returned"}` });
    } else if (tc.name === "wait_for_deployment") {
      icon = "think";
      label = "Monitor";
      chip = tc.result?.status || (isGenerating ? "Building..." : "Checked status");
      mono = false;
      detailMono = false;
      if (tc.result?.status) {
        detail.push({ text: `Status: ${tc.result.status}` });
      }
      if (tc.result?.runtime_url) {
        detail.push({ text: `Live URL: ${tc.result.runtime_url}`, tone: "add" });
      }
    } else if (tc.name === "browser_open_live_session") {
      icon = "globe";
      label = "Live Browser Session";
      chip = tc.arguments?.url || "connected";
      mono = false;
      detailMono = false;
      detail.push({ text: "Connected to Chromium sandbox" });
      detail.push({ text: `Page: ${tc.result?.title || ""}` });
      detail.push({
        text: `Found ${tc.result?.interactive_elements_count || 0} interactive elements`,
      });
    } else if (tc.name === "browser_interact_batch") {
      icon = "run";
      label = "Browser actions";
      chip = browserBatchSummary(tc.arguments?.actions);
      detailMono = true;
      detail.push({ text: JSON.stringify(tc.arguments, null, 2) });
      if (isDone) detail.push({ text: browserResultSummary(tc.result) });
    } else if (tc.name === "browser_observe" || tc.name === "browser_assert") {
      icon = tc.name === "browser_observe" ? "read" : "think";
      label = tc.name === "browser_observe" ? "Observe page" : "Verify page";
      chip = toolArgumentSummary(tc.result?.title || tc.result?.url || tc.arguments?.url) || "Page checks";
      detailMono = true;
      detail.push({ text: JSON.stringify(tc.arguments, null, 2) });
      if (isDone) detail.push({ text: browserResultSummary(tc.result) });
    } else if (tc.name === "browser_interact") {
      const action = tc.arguments?.action || "action";
      let targetLabel =
        tc.result?.target ||
        (tc.arguments?.element_id !== undefined
          ? `Element #${tc.arguments.element_id}`
          : `${action}`);
      targetLabel = String(targetLabel)
        .replace(/^(Clicking|Click:?|Hovering|Hover:?|Double-clicking|Double-click:?|Right-clicking|Right-click:?|Drag & Drop:?|Navigating to|Navigate to|Type '.*' into)\s*/i, "")
        .replace(/<[^>]+>/g, "")
        .trim();
      icon = "run";
      label = `Browser ${action.toUpperCase()}`;
      chip = `${action}: ${targetLabel || action}`;
      mono = true;
      detailMono = true;
      detail.push({ text: `Target: ${targetLabel || action}` });
      detail.push({
        text: `Status: ${String(tc.result?.status || 'pending').toUpperCase()}`,
      });
      detail.push({ text: `URL: ${tc.result?.url || ""}` });
    } else if (tc.name === "browser_get_page_state") {
      icon = "read";
      label = "Browser Page State";
      chip = tc.result?.url || tc.result?.title || "page state";
      mono = false;
      detailMono = false;
      if (tc.result?.title) detail.push({ text: `Title: ${tc.result.title}` });
      if (tc.result?.url) detail.push({ text: `URL: ${tc.result.url}` });
      if (tc.result?.elements_count !== undefined) {
        detail.push({ text: `Elements: ${tc.result.elements_count}` });
      }
    } else if (tc.name === "browser_inspect_console") {
      icon = "read";
      label = "Browser Console";
      chip = `${tc.result?.log_count || 0} logs`;
      mono = false;
      detailMono = true;
      if (tc.result?.log_count !== undefined) {
        detail.push({ text: `Console logs captured: ${tc.result.log_count}` });
      }
    } else if (tc.name === "browser_close_session") {
      icon = "run";
      label = "Close Browser";
      chip = "closed";
      mono = false;
      detailMono = false;
      detail.push({ text: "Chromium sandbox closed" });
    } else {
      icon = "think";
      label = tc.name.replace(/_/g, " ");
      chip = Object.keys(tc.arguments || {})[0]
        ? toolArgumentSummary(tc.arguments[Object.keys(tc.arguments)[0]])
        : "";
      mono = false;
      detailMono = false;
      detail.push({ text: JSON.stringify(tc.arguments) });
    }

    return {
      icon,
      label,
      chip,
      mono,
      detailMono,
      detail,
      status: isPermission
        ? "permission_required"
        : isError
        ? "error"
        : isDone
        ? "success"
        : "pending",
      rawCall: tc,
    };
  });

  // Extract file diffs and diff preview lines from file edit/write tool calls
  const diffs: ToolDiff[] = [];
  const diffLines: Record<string, ToolDiffLine[]> = {};

  toolCalls.forEach((tc) => {
    if (tc.name === "workspace_write_file" || tc.name === "workspace_edit_file") {
      const fullPath = tc.arguments?.file_path || tc.arguments?.path || "";
      if (!fullPath) return;
      const fileName = fullPath.split("/").pop() || fullPath;
      const existing = diffs.find((d) => d.file === fileName);

      let add = 0;
      let del = 0;
      const lines: ToolDiffLine[] = [];

      if (tc.arguments?.content) {
        const fileLines = String(tc.arguments.content).split("\n");
        add = fileLines.length;
        fileLines.slice(0, 20).forEach((l) => lines.push({ text: l, tone: "add" }));
      } else if (tc.arguments?.replacement) {
        const targetLines = String(tc.arguments?.target || "").split("\n");
        const replLines = String(tc.arguments?.replacement || "").split("\n");
        del = targetLines.length;
        add = replLines.length;
        targetLines.slice(0, 10).forEach((l) => lines.push({ text: l, tone: "del" }));
        replLines.slice(0, 10).forEach((l) => lines.push({ text: l, tone: "add" }));
      } else {
        add = 0;
        lines.push({ text: `Updated ${fullPath}`, tone: "add" });
      }

      if (!existing) {
        diffs.push({ file: fileName, add, del });
        diffLines[fileName] = lines;
      }
    }
  });

  const toggleRow = (idx: number) => {
    const result=toolCalls[idx]?.result;
    const artifactId=result?.frame_artifact;
    if (artifactId && result?.run_id && !artifactFrames[artifactId]) {
      api.post('/ai/tools/execute',{tool_name:'agent_event_artifact',arguments:{run_id:result.run_id,artifact_id:artifactId}})
        .then(response=>{if(typeof response.data?.data==='string')setArtifactFrames(current=>({...current,[artifactId]:response.data.data}));})
        .catch(()=>{});
    }
    setOpenRows((current) => {
      const next = new Set(current);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  const openPreview = (file: string) => (event: React.SyntheticEvent) => {
    const chipEl = (event.currentTarget as Element).closest("[data-diffchip]");
    if (!chipEl) return;
    const rect = chipEl.getBoundingClientRect();
    const previewHeight = 38 + (diffLines[file]?.length ?? 0) * 19;
    const fitsBelow = rect.bottom + 6 + previewHeight <= window.innerHeight - 12;
    setPreview({
      file,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      ...(fitsBelow
        ? { top: rect.bottom + 6 }
        : { bottom: window.innerHeight - rect.top + 6 }),
    });
  };

  const closePreview = (file: string) => () =>
    setPreview((current) => (current?.file === file ? null : current));

  const totalToolCalls = toolCalls.length;
  const completedCount = steps.filter((s) => s.status === "success").length;
  const pendingCount = steps.filter((s) => s.status === "pending").length;
  const permissionCount = steps.filter((s) => s.status === "permission_required").length;

  return (
    <div data-tool-activity className={cn("w-full min-w-0 max-w-full transition-[margin,padding] duration-200", open ? "pb-1 mb-2" : "pb-0 mb-0", className)}>
      {/* Run header */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-expanded={open}
          aria-label="Tool activity"
          onClick={() => setChosenOpen(!open)}
          className="-mx-1.5 flex min-w-0 max-w-full flex-wrap items-center gap-1.5 rounded-control px-2 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2 cursor-pointer select-none"
        >
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
          <span className="tabular-nums font-medium">
            {totalToolCalls} {totalToolCalls === 1 ? "tool call" : "tool calls"}
            {completedCount === totalToolCalls ? " completed" : ""}
          </span>
          {permissionCount > 0 && (
            <span className="ml-1.5 rounded-md bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground border border-border">
              {permissionCount} awaiting authorization
            </span>
          )}
        </button>
      </div>

      {/* Tool call rows */}
      <div
        inert={!open}
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="-mx-1 min-h-0 overflow-hidden px-1.5 pb-0.5">
          <div className="mt-1 flex flex-col gap-1">
            {steps.map((row, idx) => {
              const rowOpen = openRows.has(idx) || row.status === "permission_required" ||
                (isGenerating && idx === steps.length - 1 && Boolean(row.rawCall?.result?.frame));
              const isTerminal = row.rawCall?.name === "terminal_run_command";
              return (
                <div
                  key={idx}
                  className={cn(
                    "rounded-md transition-all duration-150",
                    row.status === "permission_required" && "border border-border bg-muted/30 px-2 py-0.5",
                    row.status === "error" && "border border-rose-500/40 bg-rose-500/5 px-2 py-0.5"
                  )}
                  style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}
                >
                  <div className="group/row -mx-[3px] flex min-h-11 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-2 text-left transition-colors duration-150 hover:bg-hover-2 sm:h-7 sm:min-h-0">
                    <button
                      type="button"
                      aria-expanded={rowOpen}
                      onClick={() => toggleRow(idx)}
                      className="flex items-center gap-2 min-w-0 flex-1 h-full text-left cursor-pointer"
                    >
                      <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill={row.icon === "think" ? "currentColor" : "none"}
                          stroke="currentColor"
                          className={`transition-opacity duration-100 group-hover/row:opacity-0 ${
                            rowOpen ? "opacity-0" : ""
                          }`}
                        >
                          {Icons[row.icon] || Icons.think}
                        </svg>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={`absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100 ${
                            rowOpen ? "opacity-100" : "opacity-0"
                          }`}
                          style={{ transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                        >
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </span>
                      <span className="min-w-0 max-w-[45%] truncate text-[12px] font-medium text-ink sm:max-w-none sm:shrink-0">
                        {row.label}
                      </span>
                      <span
                        className={`inline-flex h-5.5 min-w-0 flex-1 items-center truncate rounded-chip bg-field px-2
                          text-[11px] text-ink-2 shadow-hairline transition-colors duration-100 hover:bg-hover-2
                          ${row.mono ? "font-mono" : ""}`}
                      >
                        {row.chip}
                      </span>
                    </button>

                    {/* Quick actions per row */}
                    {isTerminal && onOpenTerminal && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenTerminal(row.rawCall?.arguments?.command);
                        }}
                        title="Open in Workspace Terminal"
                        className="h-5 px-1.5 text-[10px] font-medium rounded text-ink-3 hover:text-ink hover:bg-hover shrink-0 flex items-center gap-1 cursor-pointer"
                      >
                        <Terminal className="h-3 w-3" />
                        <span>Terminal</span>
                      </button>
                    )}
                  </div>

                  {/* Permission required confirmation banner */}
                  {row.status === "permission_required" && (onAllow || onDeny) && (
                    <div className="my-1.5 rounded-lg border border-border bg-muted/30 p-2.5 flex items-center justify-between gap-3 text-xs">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <ShieldAlert className="h-4 w-4 shrink-0" />
                        <span>User authorization required to run this tool</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {onDeny && (
                          <button
                            type="button"
                            onClick={() => onDeny(row.rawCall)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
                          >
                            <X className="h-3 w-3" />
                            Decline
                          </button>
                        )}
                        {onAllow && (
                          <button
                            type="button"
                            onClick={() => onAllow(row.rawCall)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-semibold cursor-pointer shadow-sm"
                          >
                            <Check className="h-3 w-3" />
                            Allow
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Expanded detail */}
                  <div
                    className="grid transition-[grid-template-rows,opacity] duration-300"
                    style={{
                      gridTemplateRows: rowOpen ? "1fr" : "0fr",
                      opacity: rowOpen ? 1 : 0,
                      transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                    }}
                  >
                    <div className="min-h-0 overflow-hidden">
                      {/* Summary lines */}
                      {row.detail.length > 0 && (
                        <div className="mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l border-line py-0.5 pl-3.5">
                          {row.detail.map((line, lIdx) => (
                            <span
                              key={lIdx}
                              className={`min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[11px] leading-[1.6] ${
                                row.detailMono ? "font-mono" : ""
                              } ${line.tone === "add" ? "text-green" : line.tone === "del" ? "text-red" : "text-ink-2"}`}
                            >
                              {line.text}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Visual Browser Test Case Card */}
                      {(row.rawCall?.name === "browser_interact" || row.rawCall?.name === "browser_assert" || row.rawCall?.name === "browser_open_live_session") && (() => {
                        const isSession = row.rawCall?.name === "browser_open_live_session";
                        const actionName = isSession
                          ? "CONNECT"
                          : String(row.rawCall?.arguments?.action || "ACTION").toUpperCase();
                        const isFailed =
                          row.status === "error" ||
                          Boolean(row.rawCall?.result?.error) ||
                          row.rawCall?.result?.status === "failed";
                        const isPassed = row.rawCall?.result?.status === 'passed' || row.rawCall?.result?.status === 'connected';
                        let rawTarget =
                          row.rawCall?.result?.target ||
                          (row.rawCall?.arguments?.element_id !== undefined
                            ? `Element #${row.rawCall.arguments.element_id}`
                            : row.rawCall?.arguments?.text
                            ? `"${row.rawCall.arguments.text}"`
                            : row.rawCall?.arguments?.url || (isSession ? "Chromium Sandbox" : actionName));
                        const targetLabel = String(rawTarget)
                          .replace(/^(Clicking|Click:?|Navigating to|Navigate to|Type '.*' into)\s*/i, "")
                          .replace(/<[^>]+>/g, "")
                          .trim() || actionName;
                        const targetUrl = row.rawCall?.result?.url || row.rawCall?.arguments?.url || "";
                        const docTitle = row.rawCall?.result?.title || "";
                        const rawFrame = row.rawCall?.result?.frame || row.rawCall?.result?.screenshot || artifactFrames[row.rawCall?.result?.frame_artifact];
                        const frameSrc = rawFrame
                          ? (String(rawFrame).startsWith("data:") || String(rawFrame).startsWith("http")
                              ? String(rawFrame)
                              : `data:image/jpeg;base64,${rawFrame}`)
                          : null;
                        const consoleErrCount =
                          row.rawCall?.result?.console_errors_count ??
                          (Array.isArray(row.rawCall?.result?.console_errors) ? row.rawCall.result.console_errors.length : 0);
                        const interactiveCount =
                          row.rawCall?.result?.interactive_elements_count ??
                          row.rawCall?.result?.elements_count ??
                          (Array.isArray(row.rawCall?.result?.interactive_elements)
                            ? row.rawCall.result.interactive_elements.length
                            : 0);

                        return (
                          <div className="mt-2 mb-2 ml-2 rounded-xl border border-line bg-surface/95 p-3.5 shadow-xs">
                            {/* Header: Action Badge, Target Description, Status Badge */}
                            <div className="flex items-center justify-between gap-2 border-b border-line/70 pb-2.5">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10.5px] font-mono font-semibold tracking-wide uppercase bg-muted/80 text-foreground/85 border border-border/60 shadow-xs">
                                  {actionName}
                                </span>
                                <span className="font-mono text-[12px] font-semibold text-ink truncate">
                                  {targetLabel}
                                </span>
                              </div>
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase border shrink-0",
                                  isPassed
                                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                                    : "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
                                )}
                              >
                                <span className={cn("h-1.5 w-1.5 rounded-full", isPassed ? "bg-emerald-500" : "bg-rose-500")} />
                                {isPassed ? "PASSED" : "FAILED"}
                              </span>
                            </div>

                            {/* Target URL and Document Title */}
                            {(targetUrl || docTitle) && (
                              <div className="mt-2.5 flex flex-col gap-1 text-[11.5px] bg-field/60 p-2.5 rounded-lg border border-line/50">
                                {targetUrl && (
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                    <span className="font-mono text-[11px] truncate text-ink font-medium">
                                      {targetUrl}
                                    </span>
                                  </div>
                                )}
                                {docTitle && (
                                  <div className="flex items-center gap-1.5 min-w-0 text-[11px] text-ink-3">
                                    <span className="truncate">
                                      Page Title: <strong className="text-ink-2 font-medium">{docTitle}</strong>
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Error notification if test failed */}
                            {row.rawCall?.result?.error && (
                              <div className="mt-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-500 text-[11px] font-mono leading-relaxed">
                                {row.rawCall.result.error}
                              </div>
                            )}

                            {/* Captured Frame Snapshot with thumbnail expander & lightbox */}
                            {frameSrc && (
                              <div className="my-2.5">
                                <div className="flex items-center justify-between text-[11px] font-medium text-ink-2 mb-1">
                                  <span className="flex items-center gap-1.5">
                                    <Eye className="h-3.5 w-3.5 text-sky-400" />
                                    Captured Frame Snapshot
                                  </span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedLightboxFrame(frameSrc);
                                    }}
                                    className="inline-flex items-center gap-1 text-[10.5px] font-medium text-primary hover:underline cursor-pointer"
                                  >
                                    <Maximize2 className="h-3 w-3" />
                                    Full preview
                                  </button>
                                </div>
                                <div className="relative group/frame rounded-lg overflow-hidden">
                                  <img
                                    src={frameSrc}
                                    alt="Captured browser frame"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedLightboxFrame(frameSrc);
                                    }}
                                    className="w-full max-h-72 object-contain rounded-lg border border-border/70 bg-black/90 shadow-md my-2 cursor-pointer transition-transform duration-200 group-hover/frame:scale-[1.01]"
                                  />
                                  <div
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedLightboxFrame(frameSrc);
                                    }}
                                    className="absolute inset-0 bg-black/30 opacity-0 group-hover/frame:opacity-100 transition-opacity flex items-center justify-center cursor-pointer pointer-events-none"
                                  >
                                    <span className="px-2.5 py-1 rounded-md bg-black/80 text-white text-[11px] font-medium backdrop-blur-sm border border-white/20 flex items-center gap-1.5 shadow-lg">
                                      <Maximize2 className="h-3 w-3" />
                                      Click to expand
                                    </span>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Test Observations */}
                            <div className="mt-2.5 pt-2.5 border-t border-line/60">
                              <span className="text-[10px] font-bold tracking-wider uppercase text-ink-3 block mb-1.5">
                                Test Observations
                              </span>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                <div className="p-2 rounded-lg bg-field/60 border border-line/50 flex flex-col justify-between">
                                  <span className="text-[10px] text-ink-3">URL Reached</span>
                                  <span className="font-mono text-[11px] text-ink font-medium truncate" title={targetUrl || "about:blank"}>
                                    {targetUrl ? targetUrl.replace(/^https?:\/\//, "") : "about:blank"}
                                  </span>
                                </div>
                                <div className="p-2 rounded-lg bg-field/60 border border-line/50 flex flex-col justify-between">
                                  <span className="text-[10px] text-ink-3">Console Health</span>
                                  <div className="flex items-center gap-1.5">
                                    <span
                                      className={cn(
                                        "h-2 w-2 rounded-full shrink-0",
                                        consoleErrCount === 0 ? "bg-emerald-500" : "bg-rose-500"
                                      )}
                                    />
                                    <span
                                      className={cn(
                                        "font-mono text-[11px] font-medium",
                                        consoleErrCount === 0
                                          ? "text-emerald-600 dark:text-emerald-400"
                                          : "text-rose-600 dark:text-rose-400"
                                      )}
                                    >
                                      {consoleErrCount === 0 ? "0 console errors detected" : `${consoleErrCount} console error${consoleErrCount > 1 ? "s" : ""}`}
                                    </span>
                                  </div>
                                </div>
                                <div className="p-2 rounded-lg bg-field/60 border border-line/50 flex flex-col justify-between">
                                  <span className="text-[10px] text-ink-3">DOM Elements</span>
                                  <span className="font-mono text-[11px] text-ink font-medium">
                                    {interactiveCount} interactive element{interactiveCount === 1 ? "" : "s"}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Beautiful Web Search Card (Image 4 style) */}
                      {(row.rawCall?.name === "web_search" || row.rawCall?.name === "search_web") && (
                        <div className="mt-1.5 mb-2 ml-2 rounded-xl border border-line bg-surface/90 p-3 shadow-xs">
                          {/* Query row */}
                          <div className="flex items-center gap-2 text-xs font-medium text-ink mb-2.5 pb-2 border-b border-line/60">
                            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="font-mono text-[12px] text-ink">{row.rawCall?.arguments?.query || "web search"}</span>
                          </div>

                          {/* Sources list */}
                          {Array.isArray(row.rawCall?.result?.results) && row.rawCall.result.results.length > 0 ? (
                            <div className="space-y-1.5">
                              {row.rawCall.result.results.map((item: any, rIdx: number) => {
                                const tone = ["bg-sky-500", "bg-amber-500", "bg-emerald-500", "bg-purple-500", "bg-rose-500"][rIdx % 5];
                                return (
                                  <a
                                    key={rIdx}
                                    href={item.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group/res flex items-center justify-between gap-3 p-1.5 rounded-lg hover:bg-hover-2 transition-colors cursor-pointer text-xs"
                                  >
                                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                      <span className={`flex size-4 shrink-0 items-center justify-center rounded-full text-white ${tone} text-[9px] shadow-xs`}>
                                        <Globe className="h-2.5 w-2.5" />
                                      </span>
                                      <span className="font-medium text-ink truncate text-[12px] group-hover/res:text-primary transition-colors">
                                        {item.title || item.domain}
                                      </span>
                                      <span className="text-[11px] text-ink-3 truncate hidden sm:inline">
                                        {item.domain}
                                      </span>
                                    </div>
                                    <ExternalLink className="h-3 w-3 text-ink-3 group-hover/res:text-primary shrink-0 opacity-40 group-hover/res:opacity-100 transition-opacity" />
                                  </a>
                                );
                              })}
                            </div>
                          ) : (
                            <p className="text-[11px] text-ink-3 italic">
                              {row.rawCall?.result?.error || (row.status === "pending" ? "Searching index..." : "No sources found.")}
                            </p>
                          )}
                        </div>
                      )}

                      {/* File Content Viewer (workspace_read_file) */}
                      {row.rawCall?.result?.content !== undefined && (
                        <div className="mt-1.5 mb-2 ml-2 rounded-md border border-line bg-surface/90 overflow-hidden shadow-xs">
                          <div className="flex items-center justify-between px-3 py-1.5 bg-field/80 border-b border-line text-[11px]">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <FileText className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                              <span className="font-mono truncate font-medium text-ink">
                                {row.rawCall.arguments?.file_path || row.rawCall.arguments?.path || "file"}
                              </span>
                              {row.rawCall.result.size && (
                                <span className="text-[10px] text-ink-3 tabular-nums">
                                  ({row.rawCall.result.size > 1024 ? `${(row.rawCall.result.size / 1024).toFixed(1)} KB` : `${row.rawCall.result.size} B`})
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                navigator.clipboard.writeText(row.rawCall.result.content || "");
                                setCopiedRow(idx);
                                setTimeout(() => setCopiedRow(null), 2000);
                              }}
                              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-ink-3 hover:text-ink hover:bg-hover-2 transition-colors cursor-pointer"
                              title="Copy file content"
                            >
                              {copiedRow === idx ? (
                                <>
                                  <Check className="h-3 w-3 text-green" />
                                  <span className="text-green font-medium">Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3 w-3" />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>
                          </div>
                          <pre className="max-h-72 overflow-y-auto overflow-x-auto p-3 font-mono text-[11.5px] leading-relaxed text-ink whitespace-pre-wrap break-words bg-field/30">
                            {row.rawCall.result.content || "(empty file)"}
                          </pre>
                        </div>
                      )}

                      {/* Directory Listing (workspace_list_files) */}
                      {Array.isArray(row.rawCall?.result?.files) && row.rawCall.result.files.length > 0 && (
                        <div className="mt-1.5 mb-2 ml-2 max-h-56 overflow-y-auto rounded-md border border-line bg-surface/90 p-1.5 space-y-0.5 shadow-xs">
                          {row.rawCall.result.files.map((file: any, fIdx: number) => {
                            const isDir = file.type === "directory" || file.type === "dir" || (typeof file === "string" && file.endsWith("/"));
                            const name = typeof file === "string" ? file : file.path || file.name;
                            const size = typeof file === "object" ? file.size : undefined;
                            return (
                              <div key={fIdx} className="flex items-center gap-2 px-2 py-1 rounded text-[11px] font-mono text-ink-2 hover:bg-hover transition-colors">
                                {isDir ? (
                                  <Folder className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                                ) : (
                                  <FileText className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                                )}
                                <span className="truncate flex-1 text-ink">{name}</span>
                                {size !== undefined && (
                                  <span className="text-[10px] text-ink-3 tabular-nums shrink-0">
                                    {size > 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Log Console (get_deployment_logs) */}
                      {row.rawCall?.name === "get_deployment_logs" && (row.rawCall?.result?.logs || row.rawCall?.result?.output) && (
                        <div className="mt-1.5 mb-2 ml-2 rounded-md border border-line bg-surface/90 overflow-hidden shadow-xs">
                          <div className="flex items-center justify-between px-3 py-1.5 bg-field/80 border-b border-line text-[11px]">
                            <span className="font-mono text-ink font-medium">
                              Deployment Logs ({row.rawCall.arguments?.log_type || "runtime"})
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                const text = row.rawCall.result.logs || row.rawCall.result.output || "";
                                navigator.clipboard.writeText(text);
                                setCopiedRow(idx);
                                setTimeout(() => setCopiedRow(null), 2000);
                              }}
                              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-ink-3 hover:text-ink hover:bg-hover-2 transition-colors cursor-pointer"
                              title="Copy logs"
                            >
                              {copiedRow === idx ? (
                                <>
                                  <Check className="h-3 w-3 text-green" />
                                  <span className="text-green font-medium">Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3 w-3" />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>
                          </div>
                          <pre className="max-h-72 overflow-y-auto overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-ink whitespace-pre-wrap break-words bg-field/30">
                            {row.rawCall.result.logs || row.rawCall.result.output}
                          </pre>
                        </div>
                      )}

                      {/* File Written / Patch Preview */}
                      {row.rawCall?.name === "workspace_write_file" && row.rawCall?.arguments?.content && (
                        <div className="mt-1.5 mb-2 ml-2 rounded-md border border-line bg-surface/90 overflow-hidden shadow-xs">
                          <div className="flex items-center justify-between px-3 py-1.5 bg-field/80 border-b border-line text-[11px]">
                            <span className="font-mono text-ink font-medium">
                              {row.rawCall.arguments.file_path || "file"}
                            </span>
                            <span className="text-[10px] text-green font-medium">Written</span>
                          </div>
                          <pre className="max-h-60 overflow-y-auto overflow-x-auto p-3 font-mono text-[11.5px] leading-relaxed text-ink whitespace-pre-wrap break-words bg-field/30">
                            {row.rawCall.arguments.content}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* file-diff chips at bottom */}
          {diffs.length > 0 && (
            <div className="mt-2.5 flex max-w-full flex-wrap gap-1.5 border-t border-line pt-2">
              {diffs.map((d, i) => (
                <span
                  key={d.file}
                  data-diffchip
                  className="relative"
                  onMouseEnter={openPreview(d.file)}
                  onMouseLeave={closePreview(d.file)}
                >
                  <button
                    type="button"
                    aria-expanded={preview?.file === d.file}
                    aria-label={`Show diff for ${d.file}`}
                    onFocus={openPreview(d.file)}
                    onBlur={closePreview(d.file)}
                    className="inline-flex h-6.5 max-w-full items-center gap-2 rounded-chip
                      bg-surface px-2.5 font-mono text-[11px] text-ink shadow-btn
                      transition-colors duration-100 hover:bg-hover cursor-pointer border border-line"
                    style={{
                      animation: `pop-in 250ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both`,
                    }}
                  >
                    <span className="min-w-0 truncate">{d.file}</span>
                    <span className="shrink-0 text-green tabular-nums">+{d.add}</span>
                    {d.del > 0 && (
                      <span className="shrink-0 text-red tabular-nums">−{d.del}</span>
                    )}
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Viewport-aware Floating Portal Diff Preview */}
      {preview && typeof document !== "undefined" && createPortal(
        <div
          className="fixed z-50 w-80 overflow-hidden rounded-[10px] bg-surface shadow-overlay border border-line"
          style={{
            left: preview.x,
            top: preview.top,
            bottom: preview.bottom,
            animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
            transformOrigin: preview.top === undefined ? "bottom left" : "top left",
          }}
        >
          <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5 font-mono text-[11px] bg-field/60">
            <span className="min-w-0 truncate text-ink-2 font-medium">{preview.file}</span>
            <span className="shrink-0 tabular-nums">
              <span className="text-green">
                +{diffs.find((diff) => diff.file === preview.file)?.add ?? 0}
              </span>
              {(diffs.find((diff) => diff.file === preview.file)?.del ?? 0) > 0 && (
                <span className="text-red">
                  {" "}
                  −{diffs.find((diff) => diff.file === preview.file)?.del}
                </span>
              )}
            </span>
          </div>
          <div className="py-1 font-mono text-[11px] leading-[1.8] max-h-60 overflow-y-auto">
            {(diffLines[preview.file] ?? []).map((line, index) => (
              <div
                key={index}
                className={`flex gap-2 px-2.5 whitespace-pre ${
                  line.tone === "add"
                    ? "bg-green-tint text-green"
                    : line.tone === "del"
                    ? "bg-red-tint text-red"
                    : "text-ink-2"
                }`}
              >
                <span className="w-3 shrink-0 select-none">
                  {line.tone === "add" ? "+" : line.tone === "del" ? "−" : " "}
                </span>
                <span className="min-w-0 truncate">{line.text}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}

      {/* Captured Frame Snapshot Lightbox Modal */}
      {selectedLightboxFrame && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex flex-col items-center justify-center p-4 select-none animate-in fade-in duration-200"
          onClick={() => setSelectedLightboxFrame(null)}
        >
          <div
            className="relative max-w-5xl max-h-[90vh] w-full flex flex-col items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-full flex items-center justify-between pb-2 text-white/90">
              <div className="flex items-center gap-2 text-xs font-mono">
                <Globe className="h-4 w-4 text-sky-400" />
                <span>Captured Browser Frame Snapshot</span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedLightboxFrame(null)}
                className="p-1 rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                title="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-hidden rounded-xl border border-white/20 shadow-2xl bg-black max-h-[82vh] flex items-center justify-center">
              <img
                src={selectedLightboxFrame}
                alt="Full size browser frame snapshot"
                className="max-h-[82vh] max-w-full object-contain"
              />
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default ToolChips;
