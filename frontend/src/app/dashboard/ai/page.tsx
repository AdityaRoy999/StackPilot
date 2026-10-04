"use client";
import { RemoteRunRecovery } from "@/components/RemoteRunRecovery";
import { isRemotePlatform } from "@/lib/remote-platform";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import {
  ArrowDown,
  Brain,
  BrainCircuit,
  Check,
  ChevronDown,
  ClipboardCopy,
  Clock,
  Copy,
  GitFork,
  Globe,
  GripVertical,
  FileText,
  Image as ImageIcon,
  Layers,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  Square,
  Star,
  Terminal,
  Trash2,
  XCircle,
  Maximize2,
  Minimize2,
  CornerDownLeft,
  HelpCircle,
  X,
  Zap,
  ArrowRight,
} from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { useTheme } from "next-themes";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { toast } from "sonner";

import api from "@/lib/api";
import { AiProviderConnections } from "@/components/AiProviderConnections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { StatusVerb } from "@/components/ui/status-verb";
import { ThinkingPanel } from "@/components/ui/thinking-panel";
import { ToolCallCard, ToolCall, ToolsPanel } from "@/components/ui/tool-call-card";
import { ChatMarkdown } from "@/components/ui/chat-markdown";
import { PermissionsPanel, type MessagePermission } from "@/components/ui/permissions-panel";
import { chatMessageId, permissionRequestId, upsertChatMessage, joinContinuation } from "@/lib/chat-continuation";
import dynamic from "next/dynamic";
import { SubagentBlock, SubagentTask, SubagentsPanel } from "@/components/ui/subagent-block";
const FloatingPowerShellTerminal = dynamic(
  () => import("@/components/FloatingPowerShellTerminal").then((mod) => mod.FloatingPowerShellTerminal),
  { ssr: false }
);
const InteractiveBrowserCanvas = dynamic(
  () => import("@/components/InteractiveBrowserCanvas").then((mod) => mod.InteractiveBrowserCanvas),
  { ssr: false }
);
import { streamAgentReply } from "@/lib/stream-agent";
import { useAiSession } from "@/lib/use-ai-session";
import { AiSessionChangedError } from "@/lib/ai-session";
import { requestBrowserMode, type BrowserSandboxMode } from "@/lib/browser-sandbox";
import { applyAgentEvent } from "@/lib/agent-team";
import { AgentTurnLifecycle, permissionMatchesCall, streamOutcome } from "@/lib/agent-stream-state";
import { ModelPickerModal } from "@/components/ModelPickerModal";
import { isVisionModel, getModelMetadata, getModelCategory } from "@/lib/model-capabilities";

// Must exceed the ai-service (90s) and backend (120s) timeouts, otherwise the
// browser aborts while the backend completes the generation and bills for it.
const AI_REQUEST_TIMEOUT_MS = 130000;

type AiMode = "fast" | "thinking";
type AiProvider = "nvidia_nim" | "openai_compatible";
type Role = "user" | "assistant" | "system";

export type ThinkingOrbStyle = OrbState | "off";

export interface OrbStyleDefinition {
  id: ThinkingOrbStyle;
  label: string;
  description: string;
}

const ORB_STYLES: OrbStyleDefinition[] = [
  { id: "solving", label: "Solving", description: "Quarter-turn bands scramble and click back into place" },
  { id: "searching", label: "Searching", description: "A scan meridian sweeps across a dotted globe" },
  { id: "working", label: "Working", description: "Particle dots on tilted multi-axis orbits" },
  { id: "weaving", label: "Weaving", description: "Three helix strands plait smoothly around the sphere" },
  { id: "composing", label: "Composing", description: "An undulating multi-band sash in rhythmic motion" },
  { id: "breathing", label: "Breathing", description: "A gentle face-on ring expanding and contracting" },
  { id: "shaping", label: "Shaping", description: "A dotted outline morphing circle → triangle → square" },
  { id: "connecting", label: "Connecting", description: "A dynamic constellation wiring itself with network packets" },
  { id: "listening", label: "Listening", description: "A rhythmic waveform rolling through latitude rings" },
  { id: "off", label: "Turn Off", description: "Disable the thinking orb animation completely" },
];

interface AiModel {
  id: string;
  label?: string;
  mode?: AiMode;
}

interface AiModelsResponse {
  provider: AiProvider;
  selected_model: string;
  source: "provider" | "provider_verified" | "fallback" | "fallback_probe_failed";
  models: AiModel[];
}

interface AiSettingsResponse {
  enabled: boolean;
  provider: AiProvider;
  model?: string;
  openai_compatible_base_url?: string;
  has_nvidia_key?: boolean;
  has_openai_compatible_key?: boolean;
  confidence_threshold?: number;
  history_retention_days?: number;
}

interface AiResponse {
  status: "ok" | "error";
  confidence?: number;
  summary?: string;
  structured_output?: Record<string, unknown>;
  warnings?: string[];
  error?: string;
  model?: string;
  provider?: string;
  run_id?: string;
  session_id?: string;
  session_title?: string;
  /** Present only for models that emit reasoning_content. */
  reasoning?: string;
  latency_ms?: number;
  token_usage?: Record<string, number>;
  trace_id?: string;
}

interface Project {
  id: string;
  name: string;
  status?: string;
  source_type?: string;
  repo_url?: string;
}

interface Deployment {
  id: string;
  project_id: string;
  project_name: string;
  status: string;
  version: string;
  image_name?: string;
  runtime_url?: string;
  created_at: string;
}

interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  isImage: boolean;
  dataUrl?: string;
  text?: string;
}

interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  images?: string[];
  meta?: string;
  /** The model's working, when it exposes reasoning_content. */
  reasoning?: string;
  toolCalls?: ToolCall[];
  permissions?: MessagePermission[];
  subagents?: SubagentTask[];
  stats?: {
    latencyMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    confidence?: number;
    model?: string;
    provider?: string;
    traceId?: string;
  };
}

interface AiChatSession {
  id: string;
  title: string;
  session_type: string;
  status?: string;
  deployment_id?: string;
  project_id?: string;
  preview?: string;
  message_count?: number;
  last_model?: string;
  memory_summary?: string;
  created_at: string;
  updated_at: string;
}

interface AiChatMessage {
  id: string;
  role: Role | "tool";
  content: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

interface TerminalExecutionLog {
  id: string;
  command: string;
  timestamp: string;
  status: "running" | "success" | "error";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  cwd?: string;
}

interface AgentApplicationTemplate {
  id: string;
  name: string;
  aliases: string[];
  defaultPort: string;
  config: (password: string, rootPassword: string) => Record<string, string>;
  summary: (config: Record<string, string>) => string[];
}

const commands = [
  {
    name: "/architect",
    arg: "none" as const,
    icon: Sparkles,
    usage: "/architect <requirements or architectural goal>",
    description: "Launch Strategic AI Architect subagent swarm to formulate blueprints, inspect dependencies, and plan execution.",
  },
  {
    name: "/swarm",
    arg: "none" as const,
    icon: Sparkles,
    usage: "/swarm <complex goal>",
    description: "Multi-agent collaborative execution: Architect, Coder, and Verifier working in concert.",
  },
  {
    name: "/plan",
    arg: "none" as const,
    icon: Sparkles,
    usage: "/plan <feature or refactor>",
    description: "Produce a structured engineering plan and architectural blueprint with step-by-step phases.",
  },
  {
    name: "/audit",
    arg: "none" as const,
    icon: Sparkles,
    usage: "/audit [target]",
    description: "Comprehensive workspace audit: security posture, container health, and performance analysis.",
  },
  {
    name: "/cost",
    arg: "none" as const,
    icon: Star,
    usage: "/cost [days]",
    description: "What deployments have cost, by project, with preview spend broken out.",
  },
  {
    name: "/drift",
    arg: "deployment" as const,
    icon: Star,
    usage: "/drift <deployment-id>",
    description: "Compare recorded desired state against what the cluster actually has.",
  },
  {
    name: "/secrets",
    arg: "project" as const,
    icon: Star,
    usage: "/secrets [project-id]",
    description: "List stored secret keys. Values are never shown here.",
  },
  {
    name: "/scale",
    arg: "deployment" as const,
    icon: Star,
    usage: "/scale <deployment-id> <replicas>",
    description: "Change replica count on a running Kubernetes deployment.",
  },
  {
    name: "/rollback",
    arg: "deployment" as const,
    icon: Star,
    usage: "/rollback <deployment-id>",
    description: "Roll a Kubernetes deployment back to its previous revision.",
  },
  {
    name: "/pause",
    arg: "deployment" as const,
    icon: Star,
    usage: "/pause <deployment-id>",
    description: "Pause a running runtime so it stops serving traffic.",
  },
  {
    name: "/resume",
    arg: "deployment" as const,
    icon: Star,
    usage: "/resume <deployment-id>",
    description: "Resume a paused runtime.",
  },
  {
    name: "/events",
    arg: "deployment" as const,
    icon: Star,
    usage: "/events <deployment-id>",
    description: "Kubernetes events — often explains a crash loop better than logs.",
  },
  {
    name: "/metrics",
    arg: "deployment" as const,
    icon: Star,
    usage: "/metrics <deployment-id>",
    description: "CPU, memory and runtime metrics for a deployment.",
  },
  {
    name: "/org",
    arg: "none" as const,
    icon: Star,
    usage: "/org",
    description: "Organizations you belong to and your role in each.",
  },
  {
    name: "/environments",
    arg: "project" as const,
    icon: Star,
    usage: "/environments <project-id>",
    description: "A project's environments, branches and auto-deploy settings.",
  },
  {
    name: "/terminal",
    arg: "command" as const,
    icon: Terminal,
    usage: "/terminal <command>",
    description: "Execute a command in the active deployment/project workspace terminal.",
  },
  {
    name: "/run",
    arg: "command" as const,
    icon: Terminal,
    usage: "/run <command>",
    description: "Run a shell or PowerShell command in the workspace.",
  },
  {
    name: "/diagnose",
    arg: "deployment" as const,
    icon: Star,
    usage: "/diagnose <deployment-id>",
    description: "Analyze failed builds or runtime health using logs and deployment context.",
  },
  {
    name: "/repair",
    arg: "deployment" as const,
    icon: Star,
    usage: "/repair <deployment-id>",
    description: "Autonomous AI project repair: diagnose, auto-patch files, and re-deploy.",
  },
  {
    name: "/build",
    arg: "deployment" as const,
    icon: Star,
    usage: "/build <deployment-id>",
    description: "Queue a real deployment build in the platform worker.",
  },
  {
    name: "/deploy",
    arg: "deployment" as const,
    icon: Star,
    usage: "/deploy <deployment-id> [port]",
    description: "Deploy an already built image to Kubernetes with safe defaults.",
  },
  {
    name: "/dockerfile",
    arg: "project" as const,
    icon: Star,
    usage: "/dockerfile <project-id>",
    description: "Generate a Dockerfile plan for scripts, apps, and unknown project types.",
  },
  {
    name: "/analyze",
    arg: "project" as const,
    icon: Star,
    usage: "/analyze <project-id>",
    description: "Classify a project and infer runtime, entrypoint, framework, and port.",
  },
  {
    name: "/app",
    arg: "app" as const,
    icon: Star,
    usage: "/app mysql",
    description: "Create and deploy an Application-source service such as MySQL, PostgreSQL, Redis, Grafana, or MinIO.",
  },
] as const;

const agentApplicationTemplates: AgentApplicationTemplate[] = [
  {
    id: "mysql",
    name: "MySQL database",
    aliases: ["mysql", "my sql"],
    defaultPort: "13306",
    config: (password, rootPassword) => ({
      public_port: "13306",
      database: "app",
      username: "app",
      password,
      root_password: rootPassword,
    }),
    summary: (config) => [
      `Database: ${config.database}`,
      `Username: ${config.username}`,
      `Password: ${config.password}`,
      `Root password: ${config.root_password}`,
      `Host port: ${config.public_port}`,
    ],
  },
  {
    id: "postgres",
    name: "PostgreSQL database",
    aliases: ["postgres", "postgresql", "postgre"],
    defaultPort: "15432",
    config: (password) => ({
      public_port: "15432",
      database: "app",
      username: "app",
      password,
    }),
    summary: (config) => [
      `Database: ${config.database}`,
      `Username: ${config.username}`,
      `Password: ${config.password}`,
      `Host port: ${config.public_port}`,
    ],
  },
  {
    id: "redis",
    name: "Redis cache",
    aliases: ["redis", "cache"],
    defaultPort: "16379",
    config: (password) => ({
      public_port: "16379",
      password,
    }),
    summary: (config) => [`Password: ${config.password}`, `Host port: ${config.public_port}`],
  },
  {
    id: "mongo",
    name: "MongoDB database",
    aliases: ["mongo", "mongodb"],
    defaultPort: "27018",
    config: (password) => ({
      public_port: "27018",
      username: "admin",
      password,
    }),
    summary: (config) => [`Username: ${config.username}`, `Password: ${config.password}`, `Host port: ${config.public_port}`],
  },
  {
    id: "mariadb",
    name: "MariaDB database",
    aliases: ["mariadb", "maria db"],
    defaultPort: "13307",
    config: (password, rootPassword) => ({
      public_port: "13307",
      database: "app",
      username: "app",
      password,
      root_password: rootPassword,
    }),
    summary: (config) => [
      `Database: ${config.database}`,
      `Username: ${config.username}`,
      `Password: ${config.password}`,
      `Root password: ${config.root_password}`,
      `Host port: ${config.public_port}`,
    ],
  },
  {
    id: "rabbitmq",
    name: "RabbitMQ broker",
    aliases: ["rabbitmq", "rabbit mq", "queue"],
    defaultPort: "15672",
    config: (password) => ({
      public_port: "15672",
      public_ui_port: "15673",
      username: "admin",
      password,
    }),
    summary: (config) => [
      `Username: ${config.username}`,
      `Password: ${config.password}`,
      `Broker port: ${config.public_port}`,
      `Management UI port: ${config.public_ui_port}`,
    ],
  },
  {
    id: "minio",
    name: "MinIO object storage",
    aliases: ["minio", "s3", "object storage"],
    defaultPort: "19000",
    config: (password) => ({
      public_port: "19000",
      public_ui_port: "19001",
      username: "minioadmin",
      password,
    }),
    summary: (config) => [
      `Root user: ${config.username}`,
      `Root password: ${config.password}`,
      `S3 API port: ${config.public_port}`,
      `Console port: ${config.public_ui_port}`,
    ],
  },
  {
    id: "grafana",
    name: "Grafana",
    aliases: ["grafana", "dashboard", "monitoring dashboard"],
    defaultPort: "13000",
    config: (password) => ({
      public_port: "13000",
      username: "admin",
      password,
    }),
    summary: (config) => [`Admin user: ${config.username}`, `Admin password: ${config.password}`, `Host port: ${config.public_port}`],
  },
  {
    id: "prometheus",
    name: "Prometheus",
    aliases: ["prometheus", "metrics"],
    defaultPort: "19090",
    config: () => ({
      public_port: "19090",
    }),
    summary: (config) => [`Host port: ${config.public_port}`],
  },
  {
    id: "adminer",
    name: "Adminer",
    aliases: ["adminer", "database admin"],
    defaultPort: "18080",
    config: () => ({
      public_port: "18080",
    }),
    summary: (config) => [`Host port: ${config.public_port}`],
  },
];

const starterMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "I can reason about deployments and run real platform actions. Try “deploy a MySQL database”, /app redis, /diagnose with a failed deployment, /build to queue a build, or ask a normal question.",
  },
];

const defaultModels: AiModel[] = [];

function FilledStarIcon({ className }: { className?: string }) {
  return <AppIcon name="star" fallback={Star} className={className} fill="currentColor" strokeWidth={2.4}  />;
}

function shortId(id?: string, size = 8) {
  if (!id) return "-";
  if (id.length <= size + 4) return id;
  return `${id.slice(0, size)}...${id.slice(-4)}`;
}

function preferredApplicationEndpointPort(config: Record<string, string>, fallbackPort: string | number) {
  return config.public_ui_port || config.public_port || String(fallbackPort);
}

function redactSecretLine(line: string) {
  return /(password|secret|token|api key|apikey|private key)/i.test(line)
    ? line.replace(/:\s*.+$/, ": saved in project environment")
    : line;
}

function safeApplicationSummary(template: AgentApplicationTemplate, config: Record<string, string>) {
  return template.summary(config).map(redactSecretLine);
}

function sanitizeHistoryContent(content: string) {
  return content
    .split("\n")
    .map(redactSecretLine)
    .join("\n");
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof AxiosError) {
    if (error.code === "ECONNABORTED") {
      return "The AI provider took too long to respond. Try Fast mode or a smaller chat model.";
    }
    const data = error.response?.data as { error?: string; summary?: string; detail?: string } | undefined;
    return data?.error || data?.summary || data?.detail || fallback;
  }
  return fallback;
}

function formatAiOutput(result: AiResponse) {
  const lines: string[] = [];
  const output = result.structured_output || {};

  // Architecture section
  const arch = output.architecture as Record<string, unknown> | undefined;
  if (arch && typeof arch === "object") {
    lines.push("### 🏗 Architecture & Stack Overview");
    if (arch.framework || arch.primary_language) {
      lines.push(`- **Framework / Language:** ${arch.framework || "N/A"} (${arch.primary_language || "N/A"})`);
    }
    if (arch.project_type) lines.push(`- **Project Type:** ${arch.project_type}`);
    if (arch.build_system) lines.push(`- **Build System:** ${arch.build_system}`);
    if (arch.entry_point) lines.push(`- **Entry Point:** \`${arch.entry_point}\``);
    if (Array.isArray(arch.key_dependencies) && arch.key_dependencies.length > 0) {
      lines.push(`- **Key Dependencies:** ${arch.key_dependencies.slice(0, 8).map((d) => `\`${d}\``).join(", ")}`);
    }
    lines.push("");
  }

  // Deployment readiness assessment
  const readiness = output.readiness_assessment as Record<string, unknown> | undefined;
  if (readiness && typeof readiness === "object") {
    const score = readiness.readiness_score !== undefined ? `${readiness.readiness_score}/100` : "";
    const status = String(readiness.status || "").toUpperCase();
    lines.push(`### 🎯 Deployment Readiness: **${status}** ${score ? `(${score})` : ""}`);
    if (readiness.verdict) {
      lines.push(`> ${readiness.verdict}\n`);
    }
  }

  // Findings
  const findings = output.findings as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(findings) && findings.length > 0) {
    lines.push("### 🔍 Technical Findings");
    findings.forEach((f) => {
      const sev = String(f.severity || "info").toUpperCase();
      const badge = sev === "BLOCKER" || sev === "CRITICAL" ? "🔴" : sev === "WARNING" ? "🟡" : "🔵";
      const file = f.file_path ? ` (\`${f.file_path}\`)` : "";
      lines.push(`- ${badge} **[${sev}]** ${f.title || f.category || "Issue"}${file}: ${f.description || ""}`);
    });
    lines.push("");
  }

  // Primary summary or error
  if (result.summary) {
    lines.push(result.summary);
  } else if (result.error) {
    lines.push(`⚠️ ${result.error}`);
  }

  const rootCause = output.root_cause || output.likely_root_cause || output.diagnosis;
  if (typeof rootCause === "string" && rootCause.trim() && !lines.join(" ").includes(rootCause.trim())) {
    lines.push(`\n**Root cause:** ${rootCause}`);
  }

  // Recommendations or steps
  const recs = output.recommendations as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(recs) && recs.length > 0) {
    lines.push("\n### 💡 Recommended Actions");
    recs.forEach((rec, idx) => {
      if (typeof rec === "string") {
        lines.push(`${idx + 1}. ${rec}`);
      } else {
        const priority = rec.priority ? `*[${rec.priority}]* ` : "";
        const title = rec.title ? `**${rec.title}**: ` : "";
        const action = rec.action || "";
        const rationale = rec.rationale ? ` _(${rec.rationale})_` : "";
        lines.push(`${idx + 1}. ${priority}${title}${action}${rationale}`);
      }
    });
  } else {
    const steps = output.fix_steps || output.steps || output.safe_remediations;
    if (Array.isArray(steps) && steps.length > 0) {
      lines.push("\n**Next steps:**");
      steps.slice(0, 6).forEach((step, index) => {
        lines.push(`${index + 1}. ${typeof step === "string" ? step : JSON.stringify(step)}`);
      });
    }
  }

  const dockerfile = output.dockerfile;
  if (typeof dockerfile === "string" && dockerfile.trim()) {
    lines.push(`\n**Generated Dockerfile:**\n\`\`\`dockerfile\n${dockerfile.trim()}\n\`\`\``);
  }
  if (result.warnings?.length) {
    lines.push("\n**Warnings:**");
    result.warnings.slice(0, 4).forEach((warning) => {
      lines.push(`- ${warning}`);
    });
  }
  return lines.length > 0 ? lines.join("\n") : "No output returned.";
}

function parseAssistantMessageContent(
  rawContent: string,
  rawReasoning?: string,
  existingSubagents?: SubagentTask[],
  _toolCalls?: ToolCall[]
) {
  const reasoningBlocks = rawReasoning?.trim() ? [rawReasoning.trim()] : [];
  const content = (rawContent || "").replace(/<think>([\s\S]*?)<\/think>/gi, (_, value: string) => {
    if (value.trim()) reasoningBlocks.push(value.trim());
    return "";
  }).trim();
  // Teammates exist only when the runtime recorded their IDs and events.
  // Narration, role labels and dispatch results are not execution evidence.
  return {content, reasoningBlocks, subagents: existingSubagents || []};
}

function CodeBlock({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) {
  const [copied, setCopied] = useState(false);
  const isInline = !className;
  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "";
  const code = String(children).replace(/\n$/, "");

  if (isInline) {
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-foreground break-all [overflow-wrap:anywhere] whitespace-normal" {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="group relative my-2 rounded-lg border border-border bg-muted/50 overflow-hidden min-w-0 max-w-full">
      <div className="flex items-center justify-between border-b border-border bg-muted/80 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {lang || "code"}
        </span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {copied ? <AppIcon name="check" fallback={Check} className="h-3 w-3"  /> : <AppIcon name="clipboard-copy" fallback={ClipboardCopy} className="h-3 w-3"  />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto min-w-0 max-w-full p-3 text-xs leading-relaxed">
        <code className={className} {...props}>{children}</code>
      </pre>
    </div>
  );
}

const markdownComponents = {
  pre: ({ children }: any) => <div className="min-w-0 max-w-full my-1">{children}</div>,
  code: CodeBlock,
  p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="mb-2 last:mb-0 break-words [overflow-wrap:anywhere]" {...props}>{children}</p>
  ),
  ol: ({ children, ...props }: React.OlHTMLAttributes<HTMLOListElement>) => (
    <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0 break-words [overflow-wrap:anywhere]" {...props}>{children}</ol>
  ),
  ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0 break-words [overflow-wrap:anywhere]" {...props}>{children}</ul>
  ),
  li: ({ children, ...props }: React.LiHTMLAttributes<HTMLLIElement>) => (
    <li className="text-[13px] sm:text-sm break-words [overflow-wrap:anywhere]" {...props}>{children}</li>
  ),
  strong: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <strong className="font-semibold text-foreground" {...props}>{children}</strong>
  ),
  h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0 break-words [overflow-wrap:anywhere]" {...props}>{children}</h3>
  ),
  h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4 className="mb-1.5 mt-2.5 text-sm font-semibold first:mt-0 break-words [overflow-wrap:anywhere]" {...props}>{children}</h4>
  ),
  h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h5 className="mb-1 mt-2 text-sm font-medium first:mt-0 break-words [overflow-wrap:anywhere]" {...props}>{children}</h5>
  ),
  blockquote: ({ children, ...props }: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => (
    <blockquote className="border-l-2 border-primary/40 pl-3 italic text-muted-foreground break-words [overflow-wrap:anywhere]" {...props}>{children}</blockquote>
  ),
  table: ({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div role="region" aria-label="Report table" tabIndex={0} className="my-2 min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded-lg border border-border">
      <table className="w-full text-xs sm:text-sm" {...props}>{children}</table>
    </div>
  ),
  th: ({ children, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th className="break-words [overflow-wrap:anywhere] border-b border-border bg-muted/50 px-2 py-1.5 text-left text-xs font-medium sm:px-3" {...props}>{children}</th>
  ),
  td: ({ children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className="break-words [overflow-wrap:anywhere] border-b border-border px-2 py-1.5 sm:px-3" {...props}>{children}</td>
  ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function modelLabel(model?: AiModel) {
  return model?.label || model?.id || "Select model";
}

function modelMode(model?: AiModel): AiMode {
  return model?.mode === "thinking" ? "thinking" : "fast";
}

function arrayFromResponse<T>(value: unknown, keys: string[] = []): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) {
      return record[key] as T[];
    }
  }

  return [];
}

function randomSecret(prefix = "StackPilot") {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function findApplicationIntent(message: string) {
  const normalized = message.toLowerCase();
  const template =
    agentApplicationTemplates.find((candidate) =>
      candidate.aliases.some((alias) => normalized.includes(alias))
    ) || null;
  if (!template) return null;

  const explicit =
    normalized.startsWith("/app ") ||
    /\b(deploy|create|provision|install|run|launch|spin up|start)\b/.test(normalized);
  return explicit ? template : null;
}

function conciseApplicationProjectName(template: AgentApplicationTemplate) {
  const names: Record<string, string> = {
    mysql: "MySQL",
    postgres: "PostgreSQL",
    redis: "Redis",
    mongo: "MongoDB",
    mariadb: "MariaDB",
    rabbitmq: "RabbitMQ",
    minio: "MinIO",
    grafana: "Grafana",
    prometheus: "Prometheus",
    adminer: "Adminer",
  };
  return names[template.id] || template.name;
}

const AssistantMessageBody = memo(function AssistantMessageBody({message, generating, orbStyle, onOpenTerminal}: {
  message: ChatMessage; generating: boolean; orbStyle: ThinkingOrbStyle; onOpenTerminal: (command?: string) => void;
}) {
  const parsed = parseAssistantMessageContent(message.content,message.reasoning,message.subagents,message.toolCalls);
  const tools = message.toolCalls?.filter(tc=>tc.name !== "invoke_subagent" && tc.name !== "subagent_spawn" &&
    !(["requires_approval","permission_required"].includes(tc.result?.status || "") &&
      message.permissions?.some(permission=>permission.status !== "pending" && permissionMatchesCall(permission,tc))));
  return <>
    <ThinkingPanel reasoning={parsed.reasoningBlocks.length ? parsed.reasoningBlocks : undefined} stats={message.stats} isGenerating={generating} orbStyle={orbStyle} />
    {!!parsed.subagents?.length && <SubagentsPanel subagents={parsed.subagents} isGenerating={generating} onOpenTerminal={onOpenTerminal} />}
    {!!tools?.length && <ToolsPanel toolCalls={tools} isGenerating={generating} onOpenTerminal={onOpenTerminal} />}
    {!!parsed.content && <div className="prose-ai min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-[13px] leading-relaxed sm:text-sm"><ChatMarkdown content={parsed.content} components={markdownComponents} /></div>}
  </>;
});

export default function AiAgentPage() {
  const [remoteWorkRunning, setRemoteWorkRunning] = useState(false);
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [messages, setMessages] = useState<ChatMessage[]>(starterMessages);
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [streamMessageId, setStreamMessageId] = useState("");
  const approvedMessageRef = useRef<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [mobileOptionsOpen, setMobileOptionsOpen] = useState(false);
  const [mode, setMode] = useState<AiMode>("fast");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [mounted, setMounted] = useState(false);
  const isLoadedFromStorageRef = useRef(false);
  const [pendingApproval, setPendingApprovalState] = useState<{
    id: string;
    messageId?: string;
    type: "terminal" | "deploy" | "browser";
    title: string;
    description: string;
    command?: string;
    browserStep?: { url: string; label: string; action: string; reason: string; step_index: number };
    sessionId?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
    action: () => Promise<void> | void;
    onDecline: () => void;
  } | null>(null);
  const pendingApprovalRef = useRef(pendingApproval);
  const setPendingApproval = useCallback((value: typeof pendingApproval) => {
    pendingApprovalRef.current = value;
    setPendingApprovalState(value);
  }, []);
  const [pendingAgentQuestion, setPendingAgentQuestion] = useState<{
    id: string;
    question: string;
    fields: Array<{
      id: string;
      label: string;
      type: "dropdown" | "text" | "radio";
      options?: string[];
      placeholder?: string;
      default_value?: string;
    }>;
  } | null>(null);
  const [agentQuestionAnswers, setAgentQuestionAnswers] = useState<Record<string, string>>({});
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedDeploymentId, setSelectedDeploymentId] = useState("");
  const [customTargetUrl, setCustomTargetUrl] = useState("");
  const [customUrlInput, setCustomUrlInput] = useState("");
  const [showCustomUrlDialog, setShowCustomUrlDialog] = useState(false);
  const hasInitializedTargetRef = useRef(false);
  const [showCommands, setShowCommands] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composerModelOpen, setComposerModelOpen] = useState(false);
  const [commandPickerOpen, setCommandPickerOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalInitialCommand, setTerminalInitialCommand] = useState<string | undefined>();
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserActive, setBrowserActive] = useState(false);
  const isUserScrolledUpRef = useRef(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const initDeploymentId = params.get("deploymentId");
      const initCommand = params.get("command");
      const initSession = params.get("session_id") || params.get("session") || params.get("sessionId");
      const initBrowser = params.get("browser");
      const initUrl = params.get("custom_url");
      if (initUrl && /^https?:\/\//i.test(initUrl) && initUrl.length < 4000) {
        setCustomTargetUrl(initUrl);
        setCustomUrlInput(initUrl);
      }

      if (initSession) {
        setActiveSessionId(initSession);
        setBrowserOpen(true);
      }
      if (initBrowser === "true" || initBrowser === "open") {
        setBrowserOpen(true);
      }

      if (initDeploymentId) {
        setSelectedDeploymentId(initDeploymentId);
        if (initCommand === "repair") {
          setInput(`/repair ${initDeploymentId}`);
        }
      }

      try {
        const savedModel = window.localStorage.getItem("ai-default-model");
        if (savedModel) setSelectedModel(savedModel);

        const savedBrowser = window.localStorage.getItem("ai-browser-sandbox-mode");
        if (savedBrowser === "local" || savedBrowser === "remote" || savedBrowser === "host") {
          setBrowserSandboxMode(savedBrowser);
        }

        const savedAccess = window.localStorage.getItem("ai-agent-access-mode");
        if (savedAccess === "ask" || savedAccess === "auto_review" || savedAccess === "full_access") {
          setAgentAccessMode(savedAccess);
        }

        const savedTerminal = window.localStorage.getItem("ai-agent-remote-terminal");
        if (savedTerminal === "ask" || savedTerminal === "allow") {
          setRemoteTerminalPermission(savedTerminal);
        }

        const savedAllowQuestions = window.localStorage.getItem("ai-agent-allow-questions");
        if (savedAllowQuestions !== null) {
          setAllowAgentQuestions(savedAllowQuestions === "true");
        }

        const savedOrb = window.localStorage.getItem("ai-thinking-orb-style");
        if (savedOrb) {
          setOrbStyle(savedOrb as ThinkingOrbStyle);
        }

        const savedWidth = window.localStorage.getItem("ai-browser-drawer-width");
        if (savedWidth) {
          const parsedWidth = parseInt(savedWidth, 10);
          if (!isNaN(parsedWidth)) {
            setDrawerWidth(Math.max(380, Math.min(window.innerWidth * 0.85, parsedWidth)));
          }
        }
      } catch {
        // ignore storage errors
      } finally {
        isLoadedFromStorageRef.current = true;
        setMounted(true);
      }
    }
  }, []);
  const [settingsModelOpen, setSettingsModelOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [deploymentOpen, setDeploymentOpen] = useState(false);
  const { activeSessionId, setActiveSessionId, ensureSession } = useAiSession();
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const turnsRef = useRef(new AgentTurnLifecycle());
  const [browserSessionError, setBrowserSessionError] = useState("");
  const [browserSessionRetry, setBrowserSessionRetry] = useState(0);
  const [isSessionLoading, setIsSessionLoading] = useState(false);
  const [sessionRefreshError, setSessionRefreshError] = useState("");
  const loadedSessionIdRef = useRef("");
  const sessionRequestRef = useRef(0);
  const [provider, setProvider] = useState<AiProvider>("nvidia_nim");
  const [compatibleBaseUrl, setCompatibleBaseUrl] = useState("");
  const [compatibleApiKey, setCompatibleApiKey] = useState("");
  const [compatibleModel, setCompatibleModel] = useState("");
  const [nvidiaApiKey, setNvidiaApiKey] = useState("");
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [customModelList, setCustomModelList] = useState<AiModel[] | null>(null);
  const [agentAccessMode, setAgentAccessMode] = useState<"ask" | "auto_review" | "full_access">("ask");
  const [remoteTerminalPermission, setRemoteTerminalPermission] = useState<"ask" | "allow">("ask");
  const [allowAgentQuestions, setAllowAgentQuestions] = useState<boolean>(true);
  const [orbStyle, setOrbStyle] = useState<ThinkingOrbStyle>("solving");
  const [isListening, setIsListening] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const newAttachments: ChatAttachment[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isImage = file.type.startsWith("image/");
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      if (isImage) {
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          newAttachments.push({
            id,
            name: file.name,
            size: file.size,
            type: file.type,
            isImage: true,
            dataUrl,
          });
        } catch {
          toast.error(`Failed to read image ${file.name}`);
        }
      } else {
        let text: string | undefined = undefined;
        if (file.size < 1024 * 1024) {
          try {
            text = await file.text();
          } catch {
            text = undefined;
          }
        }
        newAttachments.push({
          id,
          name: file.name,
          size: file.size,
          type: file.type,
          isImage: false,
          text,
        });
      }
    }

    setAttachments((prev) => [...prev, ...newAttachments]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((att) => att.id !== id));
  };

  // Live Application Canvas Drawer Width & Resizing
  const [drawerWidth, setDrawerWidth] = useState<number>(680);
  const [isDraggingDrawer, setIsDraggingDrawer] = useState(false);
  const dragStartXRef = useRef<number>(0);
  const dragStartWidthRef = useRef<number>(680);

  const startDraggingDrawer = (e: React.PointerEvent) => {
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    setIsDraggingDrawer(true);
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = drawerWidth;
  };

  useEffect(() => {
    if (!isDraggingDrawer) return;
    const onPointerMove = (e: PointerEvent) => {
      const delta = dragStartXRef.current - e.clientX; // dragging left expands right drawer
      const maxW = typeof window !== "undefined" ? window.innerWidth * 0.85 : 1200;
      const newWidth = Math.max(380, Math.min(maxW, dragStartWidthRef.current + delta));
      setDrawerWidth(newWidth);
    };
    const onPointerUp = () => {
      setIsDraggingDrawer(false);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("ai-browser-drawer-width", String(drawerWidth));
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [isDraggingDrawer, drawerWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const updateMedia = () => setIsDesktop(window.innerWidth >= 1024);
    updateMedia();
    window.addEventListener("resize", updateMedia);
    return () => window.removeEventListener("resize", updateMedia);
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const baseTextRef = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const settingsHydratedRef = useRef(false);

  const settingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: async () => {
      const res = await api.get("/ai/settings");
      return res.data as AiSettingsResponse;
    },
  });

  const modelsQuery = useQuery({
    queryKey: ["ai-models"],
    queryFn: async () => {
      const res = await api.get("/ai/models", { timeout: AI_REQUEST_TIMEOUT_MS });
      return res.data as AiModelsResponse;
    },
  });

  const fetchModelsWithCurrentKey = async () => {
    setIsFetchingModels(true);
    try {
      const data = await modelsQuery.refetch();
      if (data.error) throw data.error;
      setCustomModelList(data.data?.models || []);
    } catch (error) {
      toast.error(errorMessage(error, "Could not fetch models from the active provider."));
    } finally { setIsFetchingModels(false); }
  };

  // These normalize to a bare array, whereas the dashboard and deployments pages
  // cache the raw {projects}/{deployments} object under the same base key. Sharing
  // the key made last-writer-wins corrupt whichever page read the other's shape.
  // The extra segment isolates the cache entry while still matching prefix
  // invalidation on ["projects"] / ["deployments"].
  const projectsQuery = useQuery({
    queryKey: ["projects", "ai-picker"],
    queryFn: async () => {
      const res = await api.get<unknown>("/projects");
      return arrayFromResponse<Project>(res.data, ["projects", "data", "items"]);
    },
  });

  const deploymentsQuery = useQuery({
    queryKey: ["deployments", "ai-picker"],
    queryFn: async () => {
      const res = await api.get<unknown>("/deployments");
      return arrayFromResponse<Deployment>(res.data, ["deployments", "data", "items"]);
    },
    refetchInterval: 8000,
  });

  const sessionsQuery = useQuery({
    queryKey: ["ai-chat-sessions"],
    queryFn: async () => {
      const res = await api.get("/ai/sessions");
      const data = res.data as { sessions?: AiChatSession[] };
      return data.sessions || [];
    },
    refetchInterval: (query) => {
      const sessList = (query.state.data as AiChatSession[] | undefined) || [];
      const hasActiveHealing = sessList.some(
        (s) => s.session_type === "sre_incident" && s.status === "healing"
      );
      return hasActiveHealing ? 3000 : 12000;
    },
  });

  const rawDiscoveredModels = customModelList !== null ? customModelList : arrayFromResponse<AiModel>(modelsQuery.data?.models, []);
  const providerFallbackModels: AiModel[] =
    selectedModel
      ? [{ id: selectedModel, label: selectedModel, mode }]
      : [];
  const availableModels = rawDiscoveredModels.length > 0 ? rawDiscoveredModels : providerFallbackModels;
  const projects = arrayFromResponse<Project>(projectsQuery.data);
  const deployments = arrayFromResponse<Deployment>(deploymentsQuery.data);
  const sessions = sessionsQuery.data || [];
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const visibleMessages = useMemo(
    () => messages.filter((message) => {
      if (message.role === "user" && message.content.startsWith("[System]")) return false;
      return Boolean(
        message.content.trim() ||
        message.reasoning?.trim() ||
        (message.toolCalls && message.toolCalls.length > 0) ||
        (message.subagents && message.subagents.length > 0)
      );
    }),
    [messages]
  );
  const fastModels = availableModels.filter((model) => modelMode(model) === "fast");
  const thinkingModels = availableModels.filter((model) => modelMode(model) === "thinking");
  const modeModels = mode === "thinking" ? thinkingModels : fastModels;
  const selectedModelIsAvailable = availableModels.some((model) => model.id === selectedModel);
  const activeModelId =
    selectedModel ||
    (selectedModelIsAvailable ? selectedModel : "") ||
    modeModels[0]?.id ||
    availableModels[0]?.id ||
    modelsQuery.data?.selected_model ||
    "";
  const activeModel =
    availableModels.find((model) => model.id === activeModelId) ||
    (activeModelId ? { id: activeModelId, label: activeModelId, mode } : undefined);
  const isVisionActive = mounted && isVisionModel(activeModelId);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedDeployment = deployments.find((deployment) => deployment.id === selectedDeploymentId);

  // Auto-resolve active running deployment for the selected project
  const activeProjectDeployment = useMemo(() => {
    if (!selectedProjectId) return selectedDeployment;
    if (selectedDeployment && selectedDeployment.project_id === selectedProjectId) {
      return selectedDeployment;
    }
    // 1. Prioritize a running deployment with runtime_url for the project
    const runningWithUrl = deployments.find(
      (d) => d.project_id === selectedProjectId && d.status === "running" && Boolean(d.runtime_url)
    );
    if (runningWithUrl) return runningWithUrl;
    // 2. Or any running deployment
    const running = deployments.find((d) => d.project_id === selectedProjectId && d.status === "running");
    if (running) return running;
    // 3. Or the latest deployment
    return deployments.find((d) => d.project_id === selectedProjectId);
  }, [selectedProjectId, selectedDeployment, deployments]);

  // Keep selectedDeploymentId in sync when a project is selected, or auto-select running project
  useEffect(() => {
    if (selectedProjectId) {
      if (!selectedDeployment || selectedDeployment.project_id !== selectedProjectId) {
        const matching = deployments.find(
          (d) => d.project_id === selectedProjectId && d.status === "running" && Boolean(d.runtime_url)
        ) || deployments.find((d) => d.project_id === selectedProjectId);
        if (matching) {
          setSelectedDeploymentId(matching.id);
        }
      }
    } else if (!hasInitializedTargetRef.current && deployments.length > 0) {
      hasInitializedTargetRef.current = true;
      // On initial load, prioritize any running project with a runtime_url
      const runningDep = deployments.find(
        (d) => d.status === "running" && Boolean(d.runtime_url) && !d.runtime_url?.includes("localhost:3000")
      );
      if (runningDep?.project_id) {
        setSelectedProjectId(runningDep.project_id);
        setSelectedDeploymentId(runningDep.id);
      }
    }
  }, [selectedProjectId, deployments, selectedDeployment]);

  // Dynamically resolve target URL for Live Application Canvas
  const canvasTargetUrl = useMemo(() => {
    if (customTargetUrl) {
      return customTargetUrl;
    }
    if (activeProjectDeployment?.runtime_url && !activeProjectDeployment.runtime_url.includes("localhost:3000")) {
      return activeProjectDeployment.runtime_url;
    }
    if (selectedDeployment?.runtime_url && !selectedDeployment.runtime_url.includes("localhost:3000")) {
      return selectedDeployment.runtime_url;
    }
    if (selectedProjectId) {
      const dep = deployments.find(
        (d) => d.project_id === selectedProjectId && Boolean(d.runtime_url) && !d.runtime_url?.includes("localhost:3000")
      );
      return dep?.runtime_url || "about:blank";
    }
    // Fallback to any running user project deployment (e.g. portfolio on port 57621)
    const runningUserDep = deployments.find(
      (d) => d.status === "running" && Boolean(d.runtime_url) && !d.runtime_url?.includes("localhost:3000")
    );
    if (runningUserDep?.runtime_url) return runningUserDep.runtime_url;

    // Or any user deployment with a runtime_url
    const anyDepWithUrl = deployments.find(
      (d) => Boolean(d.runtime_url) && !d.runtime_url?.includes("localhost:3000")
    );
    if (anyDepWithUrl?.runtime_url) return anyDepWithUrl.runtime_url;

    return "about:blank";
  }, [customTargetUrl, activeProjectDeployment, selectedDeployment, selectedProjectId, deployments]);
  // A command with a trailing space is a command waiting for its argument.
  // Nobody remembers a project id, so the picker opens on its own and the
  // user chooses by name -- the id is filled in behind the scenes.
  const pendingCommand = useMemo(() => {
    const match = /^(\/[a-z]+)\s+$/i.exec(input);
    if (!match) return null;
    const entry = commands.find((command) => command.name === match[1].toLowerCase());
    if (!entry || entry.arg === "none" || entry.arg === "command") return null;
    return entry;
  }, [input]);

  const argPickerOpen = pendingCommand !== null;

  // Failed deployments first: a command that takes a deployment id is usually
  // being pointed at something broken.
  const pickableDeployments = deployments
    .slice()
    .sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed"));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const commandButtonRef = useRef<HTMLButtonElement>(null);
  const projectButtonRef = useRef<HTMLButtonElement>(null);
  const [pickerOffsets, setPickerOffsets] = useState({
    commandLeft: 12,
    commandBottom: 44,
    projectLeft: 16,
    projectBottom: 44,
  });

  // Keep each menu anchored to the control that opened it. The composer can
  // resize, scroll horizontally, or move with the sticky footer; hard-coded
  // left offsets make the menu float over unrelated content at narrower widths.
  useEffect(() => {
    if (!commandPickerOpen && !projectOpen) return;
    const updatePickerOffsets = () => {
      const box = composerBoxRef.current;
      if (!box) return;
      const boxRect = box.getBoundingClientRect();
      if (window.matchMedia("(max-width: 639px)").matches) {
        setPickerOffsets({ commandLeft: 0, projectLeft: 0, commandBottom: boxRect.height + 8, projectBottom: boxRect.height + 8 });
        return;
      }
      const next = { commandLeft: 12, commandBottom: 44, projectLeft: 16, projectBottom: 44 };
      const commandRect = commandButtonRef.current?.getBoundingClientRect();
      const projectRect = projectButtonRef.current?.getBoundingClientRect();
      if (commandRect) {
        next.commandLeft = Math.max(0, commandRect.left - boxRect.left);
        next.commandBottom = Math.max(8, boxRect.height - (commandRect.top - boxRect.top) + 8);
      }
      if (projectRect) {
        next.projectLeft = Math.max(0, projectRect.left - boxRect.left);
        next.projectBottom = Math.max(8, boxRect.height - (projectRect.top - boxRect.top) + 8);
      }
      setPickerOffsets(next);
    };
    updatePickerOffsets();
    window.addEventListener("resize", updatePickerOffsets);
    return () => window.removeEventListener("resize", updatePickerOffsets);
  }, [commandPickerOpen, projectOpen, selectedProjectId, customTargetUrl]);

  // Clicking anywhere outside the composer dismisses the command palette.
  // Previously it stayed open until something was chosen, which made a
  // mistyped "/" feel like the page had locked up.
  useEffect(() => {
    if (!showCommands) return;
    const onPointerDown = (event: MouseEvent) => {
      if (composerRef.current?.contains(event.target as Node)) return;
      setShowCommands(false);
    };
    // Escape is the other half of the same expectation.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowCommands(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showCommands]);

  useEffect(() => {
    if (isUserScrolledUpRef.current || (browserOpen && !isDesktop)) return;
    const frame=requestAnimationFrame(() => {
      const element=scrollRef.current;
      if (element?.clientHeight && !isUserScrolledUpRef.current) element.scrollTop=element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, browserOpen, isDesktop]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [input]);

  useEffect(() => {
    if (settingsHydratedRef.current || !settingsQuery.data) return;
    settingsHydratedRef.current = true;
    const handle = window.setTimeout(() => {
      setProvider(settingsQuery.data?.provider || "nvidia_nim");
      setCompatibleBaseUrl(settingsQuery.data?.openai_compatible_base_url || "");
      setCompatibleModel(settingsQuery.data?.model || "");
      const stored = typeof window !== "undefined" ? window.localStorage.getItem("ai-default-model") : "";
      if (stored) {
        setSelectedModel(stored);
      } else if (settingsQuery.data?.model) {
        setSelectedModel(settingsQuery.data.model);
        if (typeof window !== "undefined") {
          window.localStorage.setItem("ai-default-model", settingsQuery.data.model);
        }
      }
    }, 0);
    return () => window.clearTimeout(handle);
  }, [settingsQuery.data]);

  useEffect(() => {
    if (typeof window === "undefined" || !isLoadedFromStorageRef.current) return;
    try {
      window.localStorage.setItem("ai-agent-access-mode", agentAccessMode);
      window.localStorage.setItem("ai-agent-remote-terminal", remoteTerminalPermission);
      window.localStorage.setItem("ai-agent-allow-questions", String(allowAgentQuestions));
      window.localStorage.setItem("ai-thinking-orb-style", orbStyle);
      if (selectedModel) {
        window.localStorage.setItem("ai-default-model", selectedModel);
      }
    } catch {}
  }, [agentAccessMode, remoteTerminalPermission, allowAgentQuestions, orbStyle, selectedModel]);

  const startListening = async () => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      toast.error("Voice input is not supported in this browser. Please use Chrome, Edge, or Safari.");
      return;
    }

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }

      const recognition = new SpeechRecognitionClass();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US";

      baseTextRef.current = input;

      recognition.onstart = () => {
        setIsListening(true);
        toast.info("Voice input active. Speak into your microphone...");
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onresult = (event: any) => {
        let interimTranscript = "";
        let finalTranscript = "";

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const item = event.results[i];
          if (item && item[0]) {
            if (item.isFinal) {
              finalTranscript += item[0].transcript;
            } else {
              interimTranscript += item[0].transcript;
            }
          }
        }

        const currentSpeech = (finalTranscript || interimTranscript).trim();
        if (currentSpeech) {
          const prefix = baseTextRef.current.trim();
          const combined = prefix ? `${prefix} ${currentSpeech}` : currentSpeech;
          setInput(combined);
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onerror = (event: any) => {
        console.warn("Speech recognition error:", event.error);
        if (event.error === "not-allowed" || event.error === "permission-denied") {
          toast.error("Microphone permission denied. Please allow microphone access in your browser settings.");
        } else if (event.error === "no-speech") {
          // Normal silence, do not spam toasts
        } else if (event.error === "aborted") {
          // Normal stop, do not spam toasts
        } else {
          toast.error(`Voice recognition error: ${event.error}`);
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      // SpeechRecognition.start() must run inside the original button gesture.
      // Awaiting getUserMedia first consumes the transient user activation in
      // Chrome, which makes the microphone silently fail with NotAllowedError.
      recognition.start();
    } catch (err) {
      console.error("Failed to start speech recognition:", err);
      toast.error("Could not start microphone.");
      setIsListening(false);
    }
  };

  const stopListening = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      recognitionRef.current = null;
    }
    setIsListening(false);
  };

  const toggleListening = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }
    };
  }, []);

  const chooseModel = (model: AiModel) => {
    setSelectedModel(model.id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("ai-default-model", model.id);
    }
    setMode(modelMode(model));
    if (provider === "openai_compatible") {
      setCompatibleModel(model.id);
    }
  };

  const openTerminalWithCommand = useCallback((command?: string) => {
    setTerminalInitialCommand(command);
    setTerminalOpen(true);
  }, []);

  const closePickers = () => {
    setComposerModelOpen(false);
    setCommandPickerOpen(false);
    setSettingsModelOpen(false);
    setProjectOpen(false);
    setDeploymentOpen(false);
  };

  const appendMessage = (message: Omit<ChatMessage, "id">) => {
    if (message.role === "assistant" && approvedMessageRef.current) {
      const id = approvedMessageRef.current;
      setMessages(current => current.map(item => item.id === id ? {...item,...message,content:joinContinuation(item.content,message.content)} : item));
      return;
    }
    setMessages((current) => [
      ...current,
      {
        ...message,
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      },
    ]);
  };

  const startNewChat = () => {
    discardActiveTurn();
    sessionRequestRef.current += 1;
    loadedSessionIdRef.current = "";
    setActiveSessionId("");
    setBrowserSessionError("");
    setBrowserSessionRetry(attempt => attempt + 1);
    setMessages(starterMessages);
    setIsSessionLoading(false);
    setSessionRefreshError("");
    setPendingApproval(null);
    setPendingAgentQuestion(null);
    setAgentQuestionAnswers({});
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/dashboard/ai");
      const defaultModel = window.localStorage.getItem("ai-default-model");
      if (defaultModel) {
        setSelectedModel(defaultModel);
      }
    }
  };

  const loadSession = useCallback(async (sessionId: string, background = false) => {
    if (!background && turnsRef.current.current?.sessionId && turnsRef.current.current.sessionId !== sessionId) discardActiveTurn();
    const requestId = ++sessionRequestRef.current;
    if (!background) setIsSessionLoading(true);
    try {
      const res = await api.get(`/ai/sessions/${sessionId}`, {
        params: background ? { refresh: Date.now() } : undefined,
      });
      if (requestId !== sessionRequestRef.current) return;
      const data = res.data as { session?: AiChatSession; messages?: AiChatMessage[] };
      setActiveSessionId(sessionId);
      setSessionRefreshError("");
      loadedSessionIdRef.current = sessionId;
      if (!background) {
        setPendingApproval(null);
        setPendingAgentQuestion(null);
        setAgentQuestionAnswers({});
      }
      if (data.session?.last_model) {
        setSelectedModel(data.session.last_model);
        if (typeof window !== "undefined") {
          window.localStorage.setItem("ai-default-model", data.session.last_model);
        }
      }
      const mappedMessages = (data.messages || [])
        .filter((message) => !message.metadata?.continuation && (message.role === "user" || message.role === "assistant" || message.role === "system"))
        .map((message) => {
          const meta = (message.metadata || {}) as Record<string, any>;
          const usage = (meta.token_usage || {}) as Record<string, number>;
          return {
            id: message.id,
            role: message.role as Role,
            content: message.content || "",
            reasoning: typeof meta.reasoning === "string" && meta.reasoning.trim() ? meta.reasoning : undefined,
            toolCalls: Array.isArray(meta.tool_calls) && meta.tool_calls.length > 0 ? meta.tool_calls : undefined,
            permissions: Array.isArray(meta.permissions) ? meta.permissions : undefined,
            subagents: Array.isArray(meta.agent_events) ? meta.agent_events.reduce(applyAgentEvent, [] as SubagentTask[]) : undefined,
            stats: {
              latencyMs: typeof meta.latency_ms === "number" ? meta.latency_ms : undefined,
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
              model: typeof meta.model === "string" ? meta.model : undefined,
              provider: typeof meta.provider === "string" ? meta.provider : undefined,
              traceId: typeof meta.trace_id === "string" ? meta.trace_id : undefined,
            },
          };
        })
        .filter((message) => Boolean(
          message.content.trim() ||
          message.reasoning?.trim() ||
          (message.toolCalls && message.toolCalls.length > 0) ||
          (message.subagents && message.subagents.length > 0)
        ));

      setMessages(mappedMessages);

      if (!background && mappedMessages.length > 0) {
        const lastMsg = mappedMessages[mappedMessages.length - 1];
        if (lastMsg.role === "assistant" && lastMsg.toolCalls && lastMsg.toolCalls.length > 0) {
          const lastTool = lastMsg.toolCalls[lastMsg.toolCalls.length - 1];
          if (lastTool.name === "ask_user_question" && !lastTool.result) {
            try {
              const args = typeof lastTool.arguments === "string"
                ? JSON.parse(lastTool.arguments)
                : (lastTool.arguments || {});
              const qFields = args.fields || [];
              const initialAnswers: Record<string, string> = {};
              qFields.forEach((field: any) => {
                initialAnswers[field.id] = field.default_value || (field.options && field.options[0]) || "";
              });
              setAgentQuestionAnswers(initialAnswers);
              setPendingAgentQuestion({
                id: `q-restored-${Date.now()}`,
                question: args.question || "Please clarify:",
                fields: qFields,
              });
            } catch {}
          }
        }
      }

      if (!background && typeof window !== "undefined") {
        window.history.replaceState(null, "", `/dashboard/ai?session_id=${sessionId}`);
      }
    } catch (error) {
      if (requestId === sessionRequestRef.current) {
        setSessionRefreshError(errorMessage(error, "Could not refresh healing activity."));
      }
      throw error;
    } finally {
      if (!background && requestId === sessionRequestRef.current) {
        setIsSessionLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!activeSessionId || loadedSessionIdRef.current === activeSessionId) return;
    loadSession(activeSessionId).catch(() => {
      setMessages([
        {
          id: `session-load-error-${Date.now()}`,
          role: "assistant",
          content: "I could not load that chat. It may have been deleted or belongs to another account.",
          meta: "Error",
        },
      ]);
    });
  }, [activeSessionId, loadSession]);

  useEffect(() => {
    if (!activeSessionId || activeSession?.session_type !== "sre_incident" || activeSession?.status !== "healing") {
      return;
    }
    const refresh = () => {
      loadSession(activeSessionId, true)
        .then(() => queryClient.invalidateQueries({ queryKey: ["ai-chat-sessions"] }))
        .catch(() => {});
    };
    const interval = window.setInterval(refresh, 2000);
    return () => window.clearInterval(interval);
  }, [activeSessionId, activeSession?.session_type, activeSession?.status, loadSession, queryClient]);

  const deployApplicationTemplate = async (template: AgentApplicationTemplate) => {
    const password = randomSecret(template.id);
    const rootPassword = randomSecret(`${template.id}_root`);
    const config = template.config(password, rootPassword);
    const projectName = conciseApplicationProjectName(template);

    const projectRes = await api.post("/projects", {
      name: projectName,
      description: `Created from AI chat request for ${template.name}.`,
      source_type: "application",
      application_template_id: template.id,
      application_config: config,
      source_path: "",
      execution_mode: "local",
      remote_runtime_type: "docker",
      remote_k8s_exposure: "nodeport",
      runtime_scheme: "http",
      local_https_enabled: false,
      env_vars: [],
    });
    const projectId = projectRes.data?.project?.id as string | undefined;
    if (!projectId) {
      throw new Error("Application project was created but the API did not return a project id.");
    }

    const deploymentRes = await api.post(`/projects/${projectId}/deployments`, {
      version: "v-ai-app",
      commit_hash: "",
    });
    const deploymentId = deploymentRes.data?.deployment?.id as string | undefined;
    if (!deploymentId) {
      throw new Error("Application deployment was created but the API did not return a deployment id.");
    }

    const triggerRes = await api.post(`/deployments/${deploymentId}/trigger`);
    return {
      projectName,
      projectId,
      deploymentId,
      config,
      triggerMessage: triggerRes.data?.message || "Build queued.",
    };
  };

  const shouldAttachDeploymentContext = (text: string) => {
    if (!selectedDeploymentId) return false;
    const normalized = text.toLowerCase();
    return (
      normalized.startsWith("/diagnose") ||
      /\b(failed|failure|error|logs?|diagnose|debug|why|fix|runtime|health|crash|port|container|compose|kubernetes|deploy|build)\b/.test(
        normalized
      )
    );
  };

  const runAgentMutation = useMutation({
    mutationFn: async (message: string) => {
      const uuidMatch = message.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
      const parsedUuid = uuidMatch ? uuidMatch[0] : "";
      const commandMatch = message.match(/^\/([a-zA-Z0-9_-]+)/);
      const parsedCommand = commandMatch ? commandMatch[0].toLowerCase() : "";

      const isDeploymentTarget =
        deployments.some((d) => d.id === parsedUuid) ||
        parsedCommand === "/repair" ||
        parsedCommand === "/diagnose" ||
        parsedCommand === "/fix" ||
        parsedCommand === "/deploy";
      const targetDeploymentId = (parsedUuid && isDeploymentTarget)
        ? parsedUuid
        : (selectedDeploymentId || activeSession?.deployment_id || undefined);
      const targetProjectId = (parsedUuid && !isDeploymentTarget)
        ? parsedUuid
        : (selectedProjectId || activeSession?.project_id || undefined);
      const workflowType = activeSession?.session_type || (parsedCommand ? "agent_chat" : undefined);

      const res = await api.post(
        "/ai/chat",
        {
          message,
          command: parsedCommand || (message.startsWith("/") ? message.split(/\s+/)[0] : ""),
          model: activeModelId,
          model_mode: mode,
          sandbox_mode: browserSandboxMode,
          custom_url: customTargetUrl || undefined,
          allow_agent_questions: allowAgentQuestions,
          session_id: activeSessionId || undefined,
          project_id: targetProjectId,
          deployment_id: targetDeploymentId,
          workflow_type: workflowType,
          runtime: {
            permissions: {
              agent_access_mode: agentAccessMode,
              remote_terminal: remoteTerminalPermission,
              require_confirmation: agentAccessMode !== "full_access",
            },
          },
          history: messages.slice(-8).map((item) => ({ role: item.role, content: sanitizeHistoryContent(item.content) })),
        },
        { timeout: AI_REQUEST_TIMEOUT_MS }
      );
      return res.data as AiResponse;
    },
    onMutate: () => {
      window.setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["ai-chat-sessions"] });
      }, 700);
    },
    onSuccess: (result) => {
      if (result.session_id && result.session_id !== activeSessionId) {
        setActiveSessionId(result.session_id);
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", `/dashboard/ai?session_id=${result.session_id}`);
        }
      }
      const usage = (result.token_usage || {}) as Record<string, number>;
      appendMessage({
        role: "assistant",
        content: formatAiOutput(result),
        reasoning: typeof result.reasoning === "string" ? result.reasoning : "",
        stats: {
          latencyMs: result.latency_ms,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          confidence: result.confidence,
          model: result.model || activeModelId,
          provider: result.provider,
          traceId: result.trace_id,
        },
      });
      queryClient.invalidateQueries({ queryKey: ["ai-chat-sessions"] });
      sessionsQuery.refetch();
    },
    onError: (error) => {
      appendMessage({ role: "assistant", content: errorMessage(error, "Agent chat failed."), meta: "Error" });
    },
  });

  const commandMutation = useMutation({
    mutationFn: async (raw: string) => {
      const trimmed = raw.trim();
      const uuidMatch = trimmed.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
      const parsedUuid = uuidMatch ? uuidMatch[0] : "";
      const tokens = trimmed.split(/\s+/);
      const command = tokens[0]?.toLowerCase();
      const firstArg = tokens[1];
      const secondArg = tokens[2];
      const targetDeploymentId = parsedUuid || (firstArg && !firstArg.startsWith("/") && firstArg.length > 8 ? firstArg : selectedDeploymentId);
      const targetProjectId = parsedUuid || (firstArg && !firstArg.startsWith("/") && firstArg.length > 8 ? firstArg : selectedProjectId);

      // Extract custom user prompt/question after command and UUID
      let customUserPrompt = trimmed.replace(new RegExp(`^${command}\\b`, "i"), "").trim();
      if (parsedUuid) {
        customUserPrompt = customUserPrompt.replace(parsedUuid, "").trim();
      } else if (firstArg && (firstArg === targetProjectId || firstArg === targetDeploymentId)) {
        customUserPrompt = customUserPrompt.replace(firstArg, "").trim();
      }

      // ── platform capability commands ───────────────────────────
      // Each wraps an endpoint the backend already access-gates via
      // has_project_access(), so an unauthorised caller gets a 404/403 from
      // the server rather than being filtered here.

      if (command === "/cost") {
        const days = Number.parseInt(firstArg || "30", 10) || 30;
        const res = await api.get(`/cost?days=${days}`);
        const report = res.data;
        const rows = (report.projects || [])
          .filter((p: { millicents: number }) => p.millicents > 0)
          .map(
            (p: { project_name: string; formatted: string; deployments: number }) =>
              `  ${p.project_name}: ${p.formatted} (${p.deployments} deployment${p.deployments === 1 ? "" : "s"})`
          );
        return {
          title: `Cost, last ${report.window_days} day${report.window_days === 1 ? "" : "s"}`,
          body:
            `Total: ${report.total_formatted}\nPreview environments: ${report.preview_formatted}\n\n` +
            (rows.length ? rows.join("\n") : "  Nothing has accrued yet — cost starts once a deployment runs.") +
            `\n\n${report.note || ""}`,
        };
      }

      if (command === "/drift") {
        if (!targetDeploymentId) throw new Error("Usage: /drift <deployment-id>");
        const res = await api.get(`/deployments/${targetDeploymentId}/drift`);
        const report = res.data;
        if (report.status === "unreachable") {
          return {
            title: "Drift unknown",
            body: "Could not read live state from the runtime. This is not the same as 'no drift' — the deployment has not been confirmed healthy.",
          };
        }
        if (!report.drifted) {
          return { title: "No drift", body: "Live state matches what StackPilot recorded." };
        }
        const findings = (report.findings || [])
          .map(
            (f: { severity: string; field: string; desired: string; actual: string; detail: string }) =>
              `  [${f.severity}] ${f.field}\n      recorded: ${f.desired}\n      live:     ${f.actual}\n      ${f.detail}`
          )
          .join("\n\n");
        return { title: report.summary, body: findings };
      }

      if (command === "/secrets") {
        const path = targetProjectId ? `/projects/${targetProjectId}/secrets` : "/secrets";
        const res = await api.get(path);
        const secrets = res.data.secrets || res.data || [];
        return {
          title: `${secrets.length} secret${secrets.length === 1 ? "" : "s"}`,
          body: secrets.length
            ? "Keys only — values are never returned by a list.\n\n" +
              secrets
                .map((s: { key: string; version?: number }) => `  ${s.key} (v${s.version || 1})`)
                .join("\n")
            : "No secrets stored.",
        };
      }

      if (command === "/scale") {
        if (!targetDeploymentId) throw new Error("Usage: /scale <deployment-id> <replicas>");
        const replicas = Number.parseInt(secondArg || "", 10);
        if (Number.isNaN(replicas) || replicas < 0 || replicas > 50) {
          throw new Error("Usage: /scale <deployment-id> <replicas>  (0-50)");
        }
        const res = await api.post(`/deployments/${targetDeploymentId}/kubernetes/scale`, { replicas });
        return {
          title: `Scaled to ${replicas}`,
          body: `${shortId(targetDeploymentId)} now targets ${replicas} replica${replicas === 1 ? "" : "s"}.\n${res.data.message || ""}`,
        };
      }

      if (command === "/rollback") {
        if (!targetDeploymentId) throw new Error("Usage: /rollback <deployment-id>");
        const res = await api.post(`/deployments/${targetDeploymentId}/kubernetes/rollback`, {});
        return {
          title: "Rollback requested",
          body: `${shortId(targetDeploymentId)} is rolling back to its previous revision.\n${res.data.message || ""}`,
        };
      }

      if (command === "/pause" || command === "/resume") {
        if (!targetDeploymentId) throw new Error(`Usage: ${command} <deployment-id>`);
        const action = command === "/pause" ? "pause" : "resume";
        const res = await api.post(`/deployments/${targetDeploymentId}/runtime/${action}`, {});
        return {
          title: action === "pause" ? "Runtime paused" : "Runtime resumed",
          body: `${shortId(targetDeploymentId)}: ${res.data.message || `${action}d`}.`,
        };
      }

      if (command === "/events") {
        if (!targetDeploymentId) throw new Error("Usage: /events <deployment-id>");
        const res = await api.get(`/deployments/${targetDeploymentId}/kubernetes/events`);
        return {
          title: "Kubernetes events",
          body: res.data.events || res.data.logs || "No events returned.",
        };
      }

      if (command === "/metrics") {
        if (!targetDeploymentId) throw new Error("Usage: /metrics <deployment-id>");
        const res = await api.get(`/deployments/${targetDeploymentId}/metrics`);
        return { title: "Deployment metrics", body: JSON.stringify(res.data, null, 2) };
      }

      if (command === "/org") {
        const res = await api.get("/organizations");
        const orgs = res.data.organizations || [];
        return {
          title: `${orgs.length} organization${orgs.length === 1 ? "" : "s"}`,
          body: orgs
            .map(
              (o: { name: string; slug: string; role: string; member_count: number; is_personal: boolean }) =>
                `  ${o.name} (${o.slug}) — you are ${o.role}, ${o.member_count} member${o.member_count === 1 ? "" : "s"}${o.is_personal ? " [personal]" : ""}`
            )
            .join("\n"),
        };
      }

      if (command === "/environments") {
        if (!targetProjectId) throw new Error("Usage: /environments <project-id>");
        const res = await api.get(`/projects/${targetProjectId}/environments`);
        const envs = res.data.environments || res.data || [];
        return {
          title: `${envs.length} environment${envs.length === 1 ? "" : "s"}`,
          body: envs.length
            ? envs
                .map(
                  (e: { name: string; branch?: string; auto_deploy?: boolean; require_ci?: boolean }) =>
                    `  ${e.name} — branch ${e.branch || "(none)"}, auto-deploy ${e.auto_deploy ? "on" : "off"}, CI required ${e.require_ci ? "yes" : "no"}`
                )
                .join("\n")
            : "No environments configured.",
        };
      }

      if (command === "/repair" || command === "/fix") {
        if (!targetDeploymentId) throw new Error("Usage: /repair <deployment-id> [instructions]");
        const res = await api.post(`/deployments/${targetDeploymentId}/ai/repair`, {
          model: activeModelId,
          model_mode: mode,
          message: customUserPrompt || undefined,
          problem_description: customUserPrompt || undefined,
        }, { timeout: 615000 });
        const data = res.data;
        const changes = (data.applied_changes || [])
          .map((c: { path: string; description: string; action: string }) => `  • [${c.action || 'modify'}] \`${c.path}\` — ${c.description || 'Updated'}`)
          .join('\n');
        const usage = (data.token_usage || {}) as Record<string, number>;
        const repairToolCalls: ToolCall[] = (data.applied_changes || []).map((c: any) => ({
          name: c.action === "create" ? "workspace_write_file" : "workspace_edit_file",
          arguments: { path: c.path, description: c.description, action: c.action },
          result: { status: "applied", path: c.path },
        }));
        return {
          title: data.verified === true ? "Repair verified: page renders" : "Repair remains unverified",
          body: `### Findings\n${data.structured_output?.root_cause || data.summary || "No diagnosis returned."}\n\n### Executed changes\n${changes || "No successful file changes recorded."}\n\n**Deployment:** \`${data.repaired_deployment_id || targetDeploymentId}\`\n**Verification:** ${data.verified === true ? "Browser render smoke passed; business workflows require separate tests." : (data.structured_output?.verification?.reason || "No completed, verified build was recorded.")}`,
          reasoning: typeof data.reasoning === "string" ? data.reasoning : (typeof data.structured_output?.root_cause === "string" ? data.structured_output.root_cause : ""),
          toolCalls: repairToolCalls.length > 0 ? repairToolCalls : undefined,
          stats: {
            latencyMs: data.latency_ms,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            confidence: data.confidence,
            model: data.model || activeModelId,
            provider: data.provider,
            traceId: data.trace_id,
          },
        };
      }

      if (command === "/build") {
        if (!targetDeploymentId) throw new Error("Usage: /build <deployment-id>");
        const res = await api.post(`/deployments/${targetDeploymentId}/trigger`);
        return {
          title: "Build queued",
          body: `Deployment ${shortId(targetDeploymentId)} is queued for the worker.\n${res.data.message || ""}`,
        };
      }

      if (command === "/deploy") {
        if (!targetDeploymentId) throw new Error("Usage: /deploy <deployment-id> [port]");
        const extraText = trimmed.replace(new RegExp(`^${command}`, "i"), "").replace(targetDeploymentId, "").trim();
        if (extraText.length > 5 && !/^\d+$/.test(extraText)) {
          // Problem description or instructions provided with /deploy
          const res = await api.post(`/deployments/${targetDeploymentId}/ai/repair`, {
            model: activeModelId,
            model_mode: mode,
            message: extraText,
            problem_description: extraText,
          }, { timeout: 615000 });
          const data = res.data;
          const changes = (data.applied_changes || [])
            .map((c: { path: string; description: string; action: string }) => `  • [${c.action || 'modify'}] \`${c.path}\` — ${c.description || 'Updated'}`)
            .join('\n');
          const usage = (data.token_usage || {}) as Record<string, number>;
          const repairToolCalls: ToolCall[] = (data.applied_changes || []).map((c: any) => ({
            name: c.action === "create" ? "workspace_write_file" : "workspace_edit_file",
            arguments: { path: c.path, description: c.description, action: c.action },
            result: { status: "applied", path: c.path },
          }));
          return {
            title: data.verified === true ? "Repair verified: page renders" : "Repair remains unverified",
            body: `### Findings\n${data.structured_output?.root_cause || data.summary || "No diagnosis returned."}\n\n### Executed changes\n${changes || "No successful file changes recorded."}\n\n**Deployment:** \`${data.repaired_deployment_id || targetDeploymentId}\`\n**Verification:** ${data.verified === true ? "Browser render smoke passed; business workflows require separate tests." : (data.structured_output?.verification?.reason || "No completed, verified build was recorded.")}`,
            reasoning: typeof data.reasoning === "string" ? data.reasoning : (typeof data.structured_output?.root_cause === "string" ? data.structured_output.root_cause : ""),
            toolCalls: repairToolCalls.length > 0 ? repairToolCalls : undefined,
            stats: {
              latencyMs: data.latency_ms,
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
              confidence: data.confidence,
              model: data.model || activeModelId,
              provider: data.provider,
              traceId: data.trace_id,
            },
          };
        }

        try {
          const port = Number.parseInt(secondArg || "3000", 10) || 3000;
          const res = await api.post(`/deployments/${targetDeploymentId}/kubernetes/deploy`, {
            namespace: "stackpilot-apps",
            exposure_mode: "nodeport",
            replicas: 1,
            container_port: port,
            resource_preset: "small",
            health_path: "/",
          });
          return {
            title: "Deploy started",
            body: `Kubernetes deploy started for ${shortId(targetDeploymentId)} on port ${port}.\n${res.data.message || ""}`,
          };
        } catch {
          const triggerRes = await api.post(`/deployments/${targetDeploymentId}/trigger`);
          return {
            title: "Deployment build queued",
            body: `Triggered deployment build for ${shortId(targetDeploymentId)}.\n${triggerRes.data.message || ""}`,
          };
        }
      }

      if (command === "/diagnose") {
        if (!targetDeploymentId) throw new Error("Usage: /diagnose <deployment-id> [details]");
        const deployment = deployments.find((item) => item.id === targetDeploymentId);
        const logs = await api.get(`/deployments/${targetDeploymentId}/logs`);
        const useRuntime = deployment?.image_name && deployment.status !== "failed";
        const res = useRuntime
          ? await api.post(`/deployments/${targetDeploymentId}/ai/analyze-runtime`, {
              model: activeModelId,
              model_mode: mode,
              message: customUserPrompt || undefined,
              runtime: {
                status: deployment.status,
                runtime_url: deployment.runtime_url,
              },
            }, { timeout: AI_REQUEST_TIMEOUT_MS })
          : await api.post(`/deployments/${targetDeploymentId}/ai/analyze-build-failure`, {
              model: activeModelId,
              model_mode: mode,
              message: customUserPrompt || undefined,
              logs: logs.data?.deployment?.logs || "",
            }, { timeout: AI_REQUEST_TIMEOUT_MS });
        const diagData = res.data as AiResponse;
        const diagUsage = (diagData.token_usage || {}) as Record<string, number>;
        return {
          title: "Diagnosis",
          body: formatAiOutput(diagData),
          reasoning: typeof diagData.reasoning === "string" ? diagData.reasoning : "",
          stats: {
            latencyMs: diagData.latency_ms,
            promptTokens: diagUsage.prompt_tokens,
            completionTokens: diagUsage.completion_tokens,
            totalTokens: diagUsage.total_tokens,
            confidence: diagData.confidence,
            model: diagData.model || activeModelId,
            provider: diagData.provider,
            traceId: diagData.trace_id,
          },
        };
      }

      if (command === "/dockerfile") {
        if (!targetProjectId) throw new Error("Usage: /dockerfile <project-id> [requirements]");
        const res = await api.post(`/projects/${targetProjectId}/ai/dockerfile`, {
          model: activeModelId,
          model_mode: mode,
          message: customUserPrompt || undefined,
        }, { timeout: AI_REQUEST_TIMEOUT_MS });
        const dfData = res.data as AiResponse;
        const dfUsage = (dfData.token_usage || {}) as Record<string, number>;
        return {
          title: "Dockerfile plan",
          body: formatAiOutput(dfData),
          reasoning: typeof dfData.reasoning === "string" ? dfData.reasoning : "",
          stats: {
            latencyMs: dfData.latency_ms,
            promptTokens: dfUsage.prompt_tokens,
            completionTokens: dfUsage.completion_tokens,
            totalTokens: dfUsage.total_tokens,
            confidence: dfData.confidence,
            model: dfData.model || activeModelId,
            provider: dfData.provider,
            traceId: dfData.trace_id,
          },
        };
      }

      if (command === "/analyze") {
        if (!targetProjectId) throw new Error("Usage: /analyze <project-id> [instructions]");
        const res = await api.post(`/projects/${targetProjectId}/ai/analyze`, {
          model: activeModelId,
          model_mode: mode,
          message: customUserPrompt || undefined,
        }, { timeout: AI_REQUEST_TIMEOUT_MS });
        const anData = res.data as AiResponse;
        const anUsage = (anData.token_usage || {}) as Record<string, number>;
        return {
          title: "Project Analysis",
          body: formatAiOutput(anData),
          reasoning: typeof anData.reasoning === "string" ? anData.reasoning : "",
          stats: {
            latencyMs: anData.latency_ms,
            promptTokens: anUsage.prompt_tokens,
            completionTokens: anUsage.completion_tokens,
            totalTokens: anUsage.total_tokens,
            confidence: anData.confidence,
            model: anData.model || activeModelId,
            provider: anData.provider,
            traceId: anData.trace_id,
          },
        };
      }

      if (command === "/app") {
        const template = agentApplicationTemplates.find((item) =>
          item.id === firstArg?.toLowerCase() || item.aliases.includes((firstArg || "").toLowerCase())
        );
        if (!template) {
          throw new Error("Usage: /app mysql | postgres | redis | mongo | mariadb | rabbitmq | minio | grafana | prometheus | adminer");
        }
        if (agentAccessMode !== "full_access") {
          setPendingApproval({
            id: `deploy-app-${Date.now()}`,
            type: "deploy",
            title: `Deploy ${template.name}`,
            description: `Agent requested permission to create and deploy ${template.name} container with local Compose runtime and generated credentials.`,
            command: `/app ${template.id}`,
            action: async () => {
              const result = await deployApplicationTemplate(template);
              appendMessage({
                role: "assistant",
                content:
                  `Created ${result.projectName} and queued deployment ${shortId(result.deploymentId)}.\n\n` +
                  `Expected local endpoint: localhost:${preferredApplicationEndpointPort(result.config, template.defaultPort)}\n\n` +
                  `**Configuration**\n${safeApplicationSummary(template, result.config).map((line) => `- ${line}`).join("\n")}\n\n` +
                  `${result.triggerMessage}`,
                meta: "Application deploy started",
              });
              deploymentsQuery.refetch();
            },
            onDecline: () => {
              appendMessage({
                role: "assistant",
                content: `Deployment of **${template.name}** was declined by user.`,
                meta: "Action Declined",
              });
            },
          });
          return {
            title: "Approval Required",
            body: `I prepared the deployment plan for **${template.name}**. Please review and click **Accept & Run** or **Decline** below to proceed.`,
          };
        }
        const result = await deployApplicationTemplate(template);
        return {
          title: "Application deploy started",
          body:
            `Created ${result.projectName} and queued deployment ${shortId(result.deploymentId)}.\n\n` +
            `Expected local endpoint: localhost:${preferredApplicationEndpointPort(result.config, template.defaultPort)}\n\n` +
            `**Configuration**\n${safeApplicationSummary(template, result.config).map((line) => `- ${line}`).join("\n")}\n\n` +
            `${result.triggerMessage}`,
        };
      }

      if (command === "/help") {
        return {
          title: "Commands",
          body: commands.map((item) => `${item.usage} - ${item.description}`).join("\n"),
        };
      }

      // Unrecognized slash command: seamlessly route to AI streaming agent
      void sendStreaming(raw);
      return null;
    },
    onSuccess: (result) => {
      if (!result) return;
      appendMessage({
        role: "assistant",
        content: result.body,
        meta: result.title,
        reasoning: result.reasoning,
        toolCalls: (result as any).toolCalls,
        stats: result.stats,
      });
      deploymentsQuery.refetch();
    },
    onError: (error) => {
      appendMessage({
        role: "assistant",
        content: error instanceof Error ? error.message : errorMessage(error, "Command failed."),
        meta: "Command error",
      });
    },
  });

  const findProjectForText = (text: string) => {
    if (selectedProject) return selectedProject;
    const normalized = text.toLowerCase();
    return projects.find((project) => normalized.includes(project.name.toLowerCase()));
  };

  const isDeployIntent = (text: string) => {
    const normalized = text.toLowerCase();
    // The question guard MUST run before the template match. Previously
    // findApplicationIntent returned true unconditionally first, so
    // "How do I run a redis cache in production?" matched the redis template and
    // was routed to autonomous provisioning — creating a project, credentials and
    // a real build in response to a question.
    if (/\b(what|how|why|can|could|would|should|explain|tell me|help)\b/.test(normalized)) {
      return false;
    }
    if (normalized.trim().endsWith("?")) {
      return false;
    }
    if (findApplicationIntent(text)) return true;
    const hasActionVerb = /\b(deploy|redeploy|ship|release)\b/.test(normalized);
    if (!hasActionVerb) return false;
    if (/\b(this|current|selected|project|deployment|app|application)\b/.test(normalized)) {
      return Boolean(selectedProject || findProjectForText(text));
    }
    return Boolean(findProjectForText(text));
  };

  const autonomousDeployMutation = useMutation({
    mutationFn: async (message: string) => {
      const applicationTemplate = findApplicationIntent(message);
      if (applicationTemplate) {
        if (agentAccessMode !== "full_access") {
          setPendingApproval({
            id: `deploy-app-${Date.now()}`,
            type: "deploy",
            title: `Deploy ${applicationTemplate.name}`,
            description: `Agent requested permission to create and deploy ${applicationTemplate.name} container with local Compose runtime and generated credentials.`,
            command: `/app ${applicationTemplate.id}`,
            action: async () => {
              const result = await deployApplicationTemplate(applicationTemplate);
              appendMessage({
                role: "assistant",
                content:
                  `I created ${result.projectName} and queued deployment ${shortId(result.deploymentId)}.\n\n` +
                  `Expected local endpoint: localhost:${preferredApplicationEndpointPort(result.config, applicationTemplate.defaultPort)}\n\n` +
                  `**Configuration**\n${safeApplicationSummary(applicationTemplate, result.config).map((line) => `- ${line}`).join("\n")}\n\n` +
                  `The deployment will move to running after Docker Compose finishes starting the service. ${result.triggerMessage}`,
                meta: "Application deploy started",
              });
              deploymentsQuery.refetch();
            },
            onDecline: () => {
              appendMessage({
                role: "assistant",
                content: `Deployment of **${applicationTemplate.name}** was declined by user.`,
                meta: "Action Declined",
              });
            },
          });
          return {
            title: "Approval Required",
            body: `I prepared the deployment plan for **${applicationTemplate.name}**. Please review and click **Accept & Run** or **Decline** below to proceed.`,
          };
        }

        const result = await deployApplicationTemplate(applicationTemplate);
        return {
          title: "Application deploy started",
          body:
            `I created ${result.projectName} and queued deployment ${shortId(result.deploymentId)}.\n\n` +
            `Expected local endpoint: localhost:${preferredApplicationEndpointPort(result.config, applicationTemplate.defaultPort)}\n\n` +
            `**Configuration**\n${safeApplicationSummary(applicationTemplate, result.config).map((line) => `- ${line}`).join("\n")}\n\n` +
            "The deployment will move to running after Docker Compose finishes starting the service. " +
            `${result.triggerMessage}`,
        };
      }

      const project = findProjectForText(message);
      if (!project) {
        return {
          title: "Permission needed",
          body:
            "I can deploy for you, but I need a project context first. Select a project in Agent Settings or mention the exact project name.",
        };
      }

      if (agentAccessMode !== "full_access") {
        setPendingApproval({
          id: `deploy-proj-${Date.now()}`,
          type: "deploy",
          title: `Deploy ${project.name}`,
          description: `Agent requested permission to create a deployment for project "${project.name}", inspect/build source, and queue the build.`,
          command: `/deploy ${project.id}`,
          action: async () => {
            const createRes = await api.post(`/projects/${project.id}/deployments`, {
              version: "v-ai",
              commit_hash: "",
            });
            const deploymentId = createRes.data?.deployment?.id as string | undefined;
            if (!deploymentId) {
              throw new Error("Deployment was created but the API did not return a deployment id.");
            }
            const triggerRes = await api.post(`/deployments/${deploymentId}/trigger`);
            appendMessage({
              role: "assistant",
              content:
                `I created deployment ${shortId(deploymentId)} for ${project.name} and queued the build.\n\n` +
                "During the build, the worker will inspect the source tree and use deterministic generators first. If no deterministic generator can classify the project, AI scans the actual files and creates the Dockerfile fallback.\n\n" +
                `${triggerRes.data?.message || "Build queued."}`,
              meta: "Deployment Started",
            });
            deploymentsQuery.refetch();
          },
          onDecline: () => {
            appendMessage({
              role: "assistant",
              content: `Deployment for **${project.name}** was declined by user.`,
              meta: "Action Declined",
            });
          },
        });
        return {
          title: "Approval Required",
          body: `I prepared the deployment plan for **${project.name}**. Please review and click **Accept & Run** or **Decline** below to proceed.`,
        };
      }

      const createRes = await api.post(`/projects/${project.id}/deployments`, {
        version: "v-ai",
        commit_hash: "",
      });
      const deploymentId = createRes.data?.deployment?.id as string | undefined;
      if (!deploymentId) {
        throw new Error("Deployment was created but the API did not return a deployment id.");
      }
      const triggerRes = await api.post(`/deployments/${deploymentId}/trigger`);
      return {
          title: "Autonomous deploy started",
          body:
            `I created deployment ${shortId(deploymentId)} for ${project.name} and queued the build.\n\n` +
          "During the build, the worker will inspect the source tree and use deterministic generators first. If no deterministic generator can classify the project, AI scans the actual files and creates the Dockerfile fallback.\n\n" +
          `${triggerRes.data?.message || "Build queued."}`,
      };
    },
    onSuccess: (result) => {
      appendMessage({ role: "assistant", content: result.body, meta: result.title });
      deploymentsQuery.refetch();
    },
    onError: (error) => {
      appendMessage({
        role: "assistant",
        content: error instanceof Error ? error.message : errorMessage(error, "Autonomous deploy failed."),
        meta: "Agent action error",
      });
    },
  });

  const saveSettingsMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        enabled: true,
        provider,
        model: selectedModel || compatibleModel || activeModelId,
      };
      if (provider === "openai_compatible") {
        payload.openai_compatible_base_url = compatibleBaseUrl.trim();
        if (compatibleApiKey.trim()) {
          payload.openai_compatible_api_key = compatibleApiKey.trim();
        }
      } else {
        if (nvidiaApiKey.trim()) {
          payload.nvidia_api_key = nvidiaApiKey.trim();
        }
      }
      const res = await api.put("/ai/settings", payload);
      return res.data as { success?: boolean };
    },
    onSuccess: () => {
      setCompatibleApiKey("");
      setNvidiaApiKey("");
      settingsQuery.refetch();
      modelsQuery.refetch();
    },
  });

  // Live stream state. Kept separate from `messages` so a partial reply is
  // never mistaken for a finished one -- it is rendered as its own transient
  // bubble and only committed on the done frame.
  // On by default: watching the answer form is the whole point. Off is for
  // when someone wants the single atomic reply the blocking path gives.
  const [streamingEnabled, setStreamingEnabled] = useState(true);
  const [browserSandboxMode, setBrowserSandboxMode] = useState<"local" | "remote" | "host">("local");
  const [browserSwitchPending, setBrowserSwitchPending] = useState<BrowserSandboxMode | null>(null);
  const [browserSwitchError, setBrowserSwitchError] = useState("");
  const browserSwitchRef = useRef(false);
  const browserSwitchGeneration = useRef(0);
  const selectBrowserSandboxMode = async (mode: BrowserSandboxMode) => {
    if (browserSwitchRef.current) return;
    browserSwitchRef.current = true;
    const generation = ++browserSwitchGeneration.current;
    setBrowserSwitchPending(mode);
    setBrowserSwitchError("");
    discardActiveTurn();
    try {
      const sessionId = await ensureChatSession();
      const actual = await requestBrowserMode(sessionId, mode, canvasTargetUrl);
      if (generation !== browserSwitchGeneration.current || sessionId !== activeSessionIdRef.current) return;
      if (actual !== mode) throw new Error("The browser worker did not confirm the selected sandbox.");
      setBrowserSandboxMode(actual);
      try { window.localStorage.setItem("ai-browser-sandbox-mode", actual); } catch { /* Storage is optional. */ }
    } catch (error) {
      if (generation === browserSwitchGeneration.current) {
        const detail = error instanceof Error && !(error instanceof AxiosError)
          ? error.message
          : errorMessage(error, "Could not switch the browser sandbox.");
        setBrowserSwitchError(detail);
        toast.error(detail);
      }
    } finally {
      if (generation === browserSwitchGeneration.current) {
        browserSwitchRef.current = false;
        setBrowserSwitchPending(null);
      }
    }
  };

  useEffect(() => {
    let disposed = false;
    const generation = browserSwitchGeneration.current;
    if (browserSwitchRef.current) return;
    setBrowserSwitchError("");
    if (!activeSessionId) {
      try {
        const saved = window.localStorage.getItem("ai-browser-sandbox-mode");
        if (saved === "local" || saved === "remote" || saved === "host") setBrowserSandboxMode(saved);
      } catch { /* Storage is optional. */ }
    } else {
      requestBrowserMode(activeSessionId).then(actual => {
        if (!disposed && generation === browserSwitchGeneration.current && !browserSwitchRef.current && actual) setBrowserSandboxMode(actual);
      }).catch(() => { /* A failed settings lookup must not interrupt chat loading. */ });
    }
    return () => { disposed = true; };
  }, [activeSessionId]);

  const ensureChatSession = useCallback(async () => {
    const sessionId = await ensureSession();
    // A newly created empty chat has no history to reload over the current
    // composer/stream. Existing chats still use the normal history loader.
    if (!activeSessionId) {
      loadedSessionIdRef.current = sessionId;
      window.history.replaceState(null, "", `/dashboard/ai?session_id=${sessionId}`);
      void queryClient.invalidateQueries({ queryKey: ["ai-chat-sessions"] });
    }
    return sessionId;
  }, [activeSessionId, ensureSession, queryClient]);

  useEffect(() => {
    if (!browserOpen || activeSessionId) return;
    let cancelled = false;
    setBrowserSessionError("");
    ensureChatSession().catch(error => {
      if (!cancelled && !(error instanceof AiSessionChangedError)) {
        setBrowserSessionError(errorMessage(error, "Could not create a chat for Live App."));
      }
    });
    return () => { cancelled = true; };
  }, [browserOpen, activeSessionId, ensureChatSession, browserSessionRetry]);
  const [streamReasoning, setStreamReasoning] = useState("");
  const [streamContent, setStreamContent] = useState("");
  const [streamToolCalls, setStreamToolCalls] = useState<ToolCall[]>([]);
  const [streamSubagents, setStreamSubagents] = useState<SubagentTask[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);

  const discardActiveTurn = useCallback(() => {
    const turn = turnsRef.current.cancel(true);
    const sessionId = turn?.sessionId || pendingApprovalRef.current?.sessionId;
    if (sessionId && !isRemotePlatform()) api.post("/ai/chat/stop", { session_id: sessionId }).catch(() => {});
    streamAbortRef.current = null;
    setPendingApproval(null);
    setPendingAgentQuestion(null);
    setIsStreaming(false);
    setStreamReasoning("");
    setStreamContent("");
    setStreamToolCalls([]);
    setStreamSubagents([]);
  }, [setPendingApproval]);

  useEffect(() => () => {
    const turn = turnsRef.current.cancel(true);
    const sessionId = turn?.sessionId || pendingApprovalRef.current?.sessionId;
    if (sessionId && !isRemotePlatform()) api.post("/ai/chat/stop", { session_id: sessionId }).catch(() => {});
  }, []);

  // Project/mode changes invalidate a displayed approval. Live navigation has
  // its own page binding below, so normal agent navigation never cancels it.
  useEffect(() => {
    setPendingApproval(null);
  }, [selectedProjectId, selectedDeploymentId, browserSandboxMode, setPendingApproval]);

  const handleStopGeneration = useCallback(() => {
    // 1. Abort client-side fetch stream
    const turn = turnsRef.current.cancel();
    streamAbortRef.current?.abort();
    setPendingApproval(null);
    setPendingAgentQuestion(null);

    // 2. Notify backend stop endpoint to immediately halt agent & browser testing
    const sessionId = turn?.sessionId || activeSessionIdRef.current;
    if (sessionId) api.post("/ai/chat/stop", { session_id: sessionId }).catch(() => {});

    // 3. Notify the authenticated browser session if window has active connection
    try {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("stackpilot:browser:stop"));
      }
    } catch {}
  }, [setPendingApproval]);

  const handleChatScroll = useCallback(() => {
    if (!scrollRef.current?.clientHeight || (browserOpen && !isDesktop)) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const isUp = distanceFromBottom > 60;
    isUserScrolledUpRef.current = isUp;
    setShowScrollBottom(current => current === isUp ? current : isUp);
  }, [browserOpen, isDesktop]);


  const sendStreaming = async (prompt: string, images?: string[], continueThread: boolean = false, approvalToken?: string) => {
    const turn = turnsRef.current.begin();
    if (!turn) {
      toast.info("Wait for the current turn to finish, or stop it first.");
      return;
    }
    const controller = turn.controller;
    streamAbortRef.current = controller;
    setPendingApproval(null);
    isUserScrolledUpRef.current = false;
    setShowScrollBottom(false);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "auto" });

    // Notify browser canvas to return to live feed on new AI action
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("stackpilot:browser:stream_start"));
    }

    // Check if prompt contains an explicit URL or fallback to current canvas URL
    let effectiveTargetUrl = customTargetUrl || canvasTargetUrl || undefined;
    if (effectiveTargetUrl === "about:blank" || effectiveTargetUrl?.includes("localhost:3000") || effectiveTargetUrl?.includes("127.0.0.1:3000")) {
      effectiveTargetUrl = undefined;
    }
    const urlMatch = prompt.match(/https?:\/\/[^\s<>"']+/);
    if (urlMatch) {
      const explicitUrl = urlMatch[0];
      if (!explicitUrl.includes("localhost:3000") && !explicitUrl.includes("127.0.0.1:3000")) {
        setCustomTargetUrl(explicitUrl);
        effectiveTargetUrl = explicitUrl;
      }
    }

    // Extract UUID and slash command
    const uuidMatch = prompt.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    const parsedUuid = uuidMatch ? uuidMatch[0] : "";
    const commandMatch = prompt.match(/^\/([a-zA-Z0-9_-]+)/);
    const parsedCommand = commandMatch ? commandMatch[0].toLowerCase() : "";

    const isDeploymentTarget =
      deployments.some((d) => d.id === parsedUuid) ||
      parsedCommand === "/repair" ||
      parsedCommand === "/diagnose" ||
      parsedCommand === "/fix" ||
      parsedCommand === "/deploy";
    let targetDeploymentId = (parsedUuid && isDeploymentTarget)
      ? parsedUuid
      : (selectedDeploymentId || activeSession?.deployment_id || undefined);
    let targetProjectId = (parsedUuid && !isDeploymentTarget)
      ? parsedUuid
      : (selectedProjectId || activeSession?.project_id || undefined);

    // Auto-resolve active running deployment if targetProjectId is set
    if (!targetDeploymentId && targetProjectId) {
      const activeDep = deployments.find(
        (d) => d.project_id === targetProjectId && d.status === "running" && Boolean(d.runtime_url)
      ) || deployments.find((d) => d.project_id === targetProjectId);
      if (activeDep) {
        targetDeploymentId = activeDep.id;
      }
    }

    // Detect project by name if mentioned in prompt (e.g. "portfolio")
    if (!targetProjectId) {
      const lowerPrompt = prompt.toLowerCase();
      const matchedProj = projects.find((p) => p.name && lowerPrompt.includes(p.name.toLowerCase()));
      if (matchedProj) {
        targetProjectId = matchedProj.id;
        const activeDep = deployments.find(
          (d) => d.project_id === matchedProj.id && d.status === "running" && Boolean(d.runtime_url)
        ) || deployments.find((d) => d.project_id === matchedProj.id);
        if (activeDep) {
          targetDeploymentId = activeDep.id;
        }
      }
    }

    const workflowType = activeSession?.session_type || (parsedCommand ? "agent_chat" : undefined);

    if (parsedUuid && isDeploymentTarget && parsedUuid !== selectedDeploymentId) {
      setSelectedDeploymentId(parsedUuid);
      const matchedDep = deployments.find((d) => d.id === parsedUuid);
      if (matchedDep?.project_id && matchedDep.project_id !== selectedProjectId) {
        setSelectedProjectId(matchedDep.project_id);
      }
    } else if (parsedUuid && !isDeploymentTarget && parsedUuid !== selectedProjectId) {
      setSelectedProjectId(parsedUuid);
    }

    const initReasoning = parsedCommand
      ? `Analyzing deployment context and files for \`${parsedCommand}\`...`
      : "Analyzing request and inspecting project workspace...";

    const previous = continueThread ? [...messagesRef.current].reverse().find(message => message.role === "assistant") : undefined;
    const messageId = previous?.id || chatMessageId();
    setStreamMessageId(messageId);
    const prevContent = previous?.content && !/^(Waiting for|Completed workspace actions)/.test(previous.content) ? previous.content : "";
    const prevReasoning = previous?.reasoning ? previous.reasoning + "\n" : "";
    const prevToolCalls = previous?.toolCalls || [];
    const prevSubagents = previous?.subagents || [];
    let permissions = previous?.permissions || [];
    const priorBody = prevContent ? prevContent.trimEnd() + "\n\n" : "";
    setStreamReasoning(continueThread ? prevReasoning : initReasoning);
    setStreamContent(continueThread ? prevContent : "");
    setStreamToolCalls(continueThread ? prevToolCalls : []);
    setStreamSubagents(continueThread ? prevSubagents : []);
    setIsStreaming(true);

    let reasoning = continueThread ? prevReasoning : initReasoning + "\n";
    let content = continueThread ? priorBody : "";
    let toolCalls: ToolCall[] = continueThread ? [...prevToolCalls] : [];
    let subagents: SubagentTask[] = continueThread ? [...prevSubagents] : [];
    let stats: ChatMessage["stats"] = {};
    let messageAppended = false;
    let doneStatus: string | undefined;
    let doneVerified: boolean | undefined;
    let doneReceived = false;
    let browserUsed = false;
    let streamFailed = false;

    let contentBuffer = content;
    let reasoningBuffer = reasoning;
    let streamRafId: ReturnType<typeof setTimeout> | null = null;
    const saveResponse = (body: string, details: Partial<ChatMessage> = {}) => {
      setMessages(current => upsertChatMessage(current, {id:messageId,role:"assistant",content:body,reasoning:reasoning.trim() || undefined,toolCalls,subagents,permissions,stats,...details}));
    };

    const flushStream = () => {
      if (!turnsRef.current.owns(turn)) return;
      setStreamContent(contentBuffer);
      setStreamReasoning(reasoningBuffer);
      streamRafId = null;
      saveResponse(contentBuffer);
    };

    const queueStreamFlush = () => {
      if (streamRafId === null) {
        streamRafId = setTimeout(flushStream, 100);
      }
    };

    const appendStoppedResponse = () => {
      if (!turnsRef.current.owns(turn)) return;
      if (messageAppended) return;
      if (!content.trim() && !reasoning.trim() && toolCalls.length === 0 && subagents.length === 0) return;
      messageAppended = true;

      let finalBody = content.trim();
      const finalReasoning: string | undefined = reasoning.trim() || undefined;

      finalBody = finalBody ? `${finalBody}\n\n*(Generation stopped by user)*` : "*(Generation stopped by user)*";

      saveResponse(finalBody, {
        reasoning: finalReasoning,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        subagents: subagents.length > 0 ? subagents : undefined,
        stats,
      });

      if (turn.sessionId) {
        api.post(`/ai/sessions/${turn.sessionId}/messages`, {
          role: "assistant",
          content: finalBody,
          metadata: {
            reasoning: finalReasoning,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            stopped: true,
          },
        }).catch(() => {});
      }
    };

    saveResponse(content);
    try {
      const sessionId = await ensureChatSession();
      turn.sessionId = sessionId;
      if (controller.signal.aborted || !turnsRef.current.owns(turn)) return;
      await streamAgentReply({
        approvalToken,
        continuation: continueThread,
        message: prompt,
        command: parsedCommand || undefined,
        deploymentId: targetDeploymentId,
        projectId: targetProjectId,
        customUrl: effectiveTargetUrl,
        workflowType,
        sessionId,
        modelMode: mode === "thinking" ? "thinking" : "fast",
        model: activeModelId,
        provider,
        agentAccessMode,
        remoteTerminal: remoteTerminalPermission,
        allowAgentQuestions,
        images,
        sandboxMode: browserSandboxMode,
        signal: controller.signal,
        onEvent: (event) => {
          if (!turnsRef.current.owns(turn) || controller.signal.aborted) return;
          const observedAgents = applyAgentEvent(subagents, event);
          if (observedAgents !== subagents) {
            subagents = observedAgents;
            setStreamSubagents([...subagents]);
            queueStreamFlush();
            if (event.type !== "done") return;
          }
          if (event.type === "start" && event.session_id) {
            if (event.session_id !== activeSessionId) {
              setActiveSessionId(event.session_id);
              if (typeof window !== "undefined") {
                window.history.replaceState(null, "", `/dashboard/ai?session_id=${event.session_id}`);
              }
              queryClient.invalidateQueries({ queryKey: ["ai-chat-sessions"] });
            }
          } else if (event.type === "reasoning") {
            reasoningBuffer += event.delta;
            reasoning = reasoningBuffer;
            queueStreamFlush();
          } else if (event.type === "tool_call") {
            const newCall: ToolCall = {
              id: event.id,
              name: event.name,
              arguments: event.arguments,
            };
            toolCalls = [...toolCalls, newCall];
            setStreamToolCalls([...toolCalls]);
            queueStreamFlush();
            if (event.name.startsWith("browser_")) {
              browserUsed = true;
              setBrowserOpen(true);
              setBrowserActive(true);
            }
          } else if (event.type === "tool_step") {
            toolCalls = [...toolCalls, {id:event.id, name:event.name, arguments:event.arguments, result:event.result}];
            setStreamToolCalls([...toolCalls]);
            queueStreamFlush();
          } else if (event.type === "tool_result") {
            let foundIdx = -1;
            for (let i = toolCalls.length - 1; i >= 0; i--) {
              if ((event.id ? toolCalls[i].id === event.id : toolCalls[i].name === event.name) && (toolCalls[i].result === undefined || toolCalls[i].result === null)) {
                foundIdx = i;
                break;
              }
            }
            if (foundIdx === -1) {
              foundIdx = toolCalls.map((c) => c.name).lastIndexOf(event.name);
            }
            if (foundIdx !== -1) {
              toolCalls = [
                ...toolCalls.slice(0, foundIdx),
                { ...toolCalls[foundIdx], result: event.result },
                ...toolCalls.slice(foundIdx + 1),
              ];
            } else {
              toolCalls = [...toolCalls, { name: event.name, arguments: {}, result: event.result }];
            }
            setStreamToolCalls([...toolCalls]);
            queueStreamFlush();
          } else if (event.type === "permission_request") {
            const toolName = event.tool_name || "Action";
            const args = event.arguments || {};
            const cmd = toolName === "terminal_run_command" ? (args.command as string) : undefined;
            const browserStep = event.browser_step;
            const permissionId = permissionRequestId(event);
            const title = browserStep?.label || toolName;
            permissions = [...permissions, {id:permissionId,toolName,title,description:event.description || browserStep?.reason,command:cmd,arguments:args,browserStep,status:"pending"}];
            queueStreamFlush();
            setPendingApproval({
              id: permissionId,
              messageId,
              sessionId,
              toolName,
              arguments: args,
              type: browserStep ? "browser" : toolName === "terminal_run_command" ? "terminal" : "deploy",
              title: browserStep ? `Approve browser step ${browserStep.step_index + 1}: ${browserStep.label}` : `Permission Needed: ${toolName}`,
              description: event.description || browserStep?.reason || `Agent requested permission to execute high-risk action "${toolName}". Review parameters below.`,
              command: cmd,
              browserStep,
              action: async () => {
                if (browserStep) {
                  await sendStreaming("Approve this browser step and continue the website test.", undefined, true, event.token);
                  return;
                }
                const approvalMsg = cmd
                  ? `Confirmed: Accept & run \`${cmd}\``
                  : `Confirmed: Approve execution of ${toolName}`;
                await sendStreaming(approvalMsg, undefined, true, event.token);
              },
              onDecline: () => {
                api.post("/ai/chat/stop", { session_id: sessionId }).catch(() => {});
                setMessages(current => current.map(message => message.id === messageId ? {...message,permissions:message.permissions?.map(p => p.id === permissionId ? {...p,status:"declined"} : p)} : message));
              },
            });
          } else if (event.type === "agent_question") {
            const initialAnswers: Record<string, string> = {};
            (event.fields || []).forEach((f) => {
              initialAnswers[f.id] = f.default_value || (f.options && f.options[0]) || "";
            });
            setAgentQuestionAnswers(initialAnswers);
            setPendingAgentQuestion({
              id: event.question_id || `q-${Date.now()}`,
              question: event.question,
              fields: event.fields || [],
            });
          } else if (event.type === "content") {
            contentBuffer += event.delta;
            content = contentBuffer;
            queueStreamFlush();
          } else if (event.type === "error") {
            streamFailed = true;
            contentBuffer += `\n\n_${event.error || event.message || "The agent reported an error."}_`;
            content = contentBuffer;
            queueStreamFlush();
          } else if (event.type === "done") {
            doneReceived = true;
            doneStatus = event.stopped ? "stopped" : event.status;
            doneVerified = event.verified;
            if (event.session_id && event.session_id !== activeSessionId) {
              setActiveSessionId(event.session_id);
              if (typeof window !== "undefined") {
                window.history.replaceState(null, "", `/dashboard/ai?session_id=${event.session_id}`);
              }
            }
            // The done frame carries the authoritative assembled text; trust it
            // over the accumulated deltas in case a frame was dropped.
            content = event.content ? priorBody + event.content : contentBuffer;
            reasoning = event.reasoning ? prevReasoning + event.reasoning : reasoningBuffer;
            contentBuffer = content;
            reasoningBuffer = reasoning;
            if (streamRafId !== null) {
              clearTimeout(streamRafId);
              streamRafId = null;
            }
            flushStream();
            const usage = event.token_usage || {};
            stats = {
              latencyMs: event.latency_ms,
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
              model: event.model || activeModelId,
              provider: event.provider,
              traceId: event.trace_id,
            };
          }
        },
      });

      if (streamRafId !== null) {
        clearTimeout(streamRafId);
        streamRafId = null;
      }
      flushStream();

      if (!turnsRef.current.owns(turn)) return;

      if (controller.signal.aborted) {
        appendStoppedResponse();
      } else {
        messageAppended = true;
        const incompleteStream = !doneReceived && !streamFailed;
        const responseBody = content.trim() ? content : streamOutcome(streamFailed ? "error" : incompleteStream ? "unverified" : doneStatus,
          doneVerified, browserUsed, toolCalls.length > 0).text;
        saveResponse(incompleteStream ? `${responseBody}\n\n_Stream ended before a completion result was received. This task remains unverified._` : responseBody, {
          reasoning: reasoning.trim() ? reasoning : undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          subagents: subagents.length > 0 ? subagents : undefined,
          stats,
        });
      }
    } catch (error) {
      if (!turnsRef.current.owns(turn)) return;
      streamFailed = true;
      if (controller.signal.aborted) {
        appendStoppedResponse();
      } else {
        saveResponse(joinContinuation(content,errorMessage(error, "Streaming failed.")));
      }
    } finally {
      if (streamRafId !== null) {
        clearTimeout(streamRafId);
        streamRafId = null;
      }
      if (controller.signal.aborted) {
        appendStoppedResponse();
      }
      if (!turnsRef.current.finish(turn)) return;
      setIsStreaming(false);
      setStreamMessageId("");
      approvedMessageRef.current = null;
      setStreamReasoning("");
      setStreamContent("");
      setStreamToolCalls([]);
      setStreamSubagents([]);
      streamAbortRef.current = null;
      if (typeof window !== "undefined") {
        try {
          if (doneReceived && !controller.signal.aborted && !streamFailed && streamOutcome(doneStatus, doneVerified, browserUsed, toolCalls.length > 0).browserCompleted) {
            window.dispatchEvent(new CustomEvent("stackpilot:browser:test_completed"));
          }
        } catch {}
      }
      queryClient.invalidateQueries({ queryKey: ["ai-chat-sessions"] });
      sessionsQuery.refetch();
    }
  };

  const isRunning = remoteWorkRunning || !!browserSwitchPending || isStreaming || runAgentMutation.isPending || commandMutation.isPending || autonomousDeployMutation.isPending;

  const approvePendingPermission = async (permission: NonNullable<typeof pendingApproval>) => {
    if (pendingApprovalRef.current !== permission || turnsRef.current.current || isRunning) return;
    if (permission.sessionId && permission.sessionId !== activeSessionIdRef.current) {
      setPendingApproval(null);
      toast.info("The active chat changed. Request a fresh review before approving this step.");
      return;
    }
    setPendingApproval(null);
    const id=permission.messageId || [...messagesRef.current].reverse().find(m=>m.role === "assistant")?.id;
    approvedMessageRef.current=id || null;
    if (id) {
      const updated=messagesRef.current.map(m=>m.id === id ? {...m,permissions:(m.permissions || [{...permission,status:"pending" as const}]).map(p=>p.id === permission.id ? {...p,status:"approved" as const} : p)} : m);
      messagesRef.current=updated;
      setMessages(updated);
    }
    try { await permission.action(); } finally { approvedMessageRef.current=null; }
  };

  const declinePendingPermission = (permission: NonNullable<typeof pendingApproval>) => {
    if (pendingApprovalRef.current !== permission) return;
    turnsRef.current.cancel();
    setPendingApproval(null);
    const id=permission.messageId || [...messagesRef.current].reverse().find(m=>m.role === "assistant")?.id;
    approvedMessageRef.current=id || null;
    if (id) setMessages(current=>current.map(m=>m.id === id ? {...m,permissions:(m.permissions || [{...permission,status:"pending" as const}]).map(p=>p.id === permission.id ? {...p,status:"declined" as const} : p)} : m));
    try { permission.onDecline(); } finally { approvedMessageRef.current=null; }
  };

  const changeTargetUrl = (url: string) => {
    discardActiveTurn();
    setCustomTargetUrl(url);
  };

  const closeBrowser = useCallback(() => setBrowserOpen(false), []);

  const observeBrowserUrl = useCallback((url: string) => {
    const permission = pendingApprovalRef.current;
    if (permission?.browserStep && permission.browserStep.url !== url) {
      setPendingApproval(null);
      if (permission.sessionId) api.post("/ai/chat/stop", { session_id: permission.sessionId }).catch(() => {});
    }
    if (url && !url.includes("localhost:3000") && !url.includes("127.0.0.1:3000") && url !== "about:blank") setCustomTargetUrl(url);
  }, []);

  // The verb is picked from what was actually asked, so the indicator keys off
  // the most recent user turn rather than the composer (which is cleared on
  // submit).
  const lastUserPrompt = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") return messages[i].content;
    }
    return "";
  }, [messages]);

  const submit = () => {
    if (isListening) {
      stopListening();
    }
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || isRunning) return;

    // Collect images
    const outgoingImages = attachments.filter((a) => a.isImage && a.dataUrl).map((a) => a.dataUrl as string);
    const docAttachments = attachments.filter((a) => !a.isImage && a.text);

    let combinedPrompt = trimmed;
    if (docAttachments.length > 0) {
      const docsContext = docAttachments
        .map((d) => `--- Attached File: ${d.name} ---\n${d.text}\n--- End of ${d.name} ---`)
        .join("\n\n");
      combinedPrompt = combinedPrompt ? `${combinedPrompt}\n\n[Attached Files & Context]:\n${docsContext}` : docsContext;
    }

    appendMessage({
      role: "user",
      content: trimmed || (outgoingImages.length > 0 ? "Attached photos" : "Attached files"),
      images: outgoingImages.length > 0 ? outgoingImages : undefined,
    });
    setInput("");
    setAttachments([]);
    setShowCommands(false);

    const isAiCommand =
      /^\/(architect|swarm|plan|audit|review|code|repair|fix|diagnose|analyze|dockerfile|terminal|run|exec)\b/i.test(trimmed) ||
      (/^\/deploy\b/i.test(trimmed) && trimmed.replace(/^\/deploy\b/i, "").trim().length > 10);

    const isPlatformCommand = /^\/(cost|org|environments|build|app|help|events|metrics|rollback|pause|resume|scale|drift|secrets)\b/i.test(trimmed);

    if (isAiCommand || (!isPlatformCommand && trimmed.startsWith("/"))) {
      void sendStreaming(combinedPrompt, outgoingImages);
    } else if (trimmed.startsWith("/")) {
      commandMutation.mutate(trimmed);
    } else if (isDeployIntent(trimmed)) {
      autonomousDeployMutation.mutate(trimmed);
    } else if (streamingEnabled) {
      void sendStreaming(combinedPrompt, outgoingImages);
    } else {
      runAgentMutation.mutate(combinedPrompt);
    }
  };

  const handleAllowToolCall = async (call: ToolCall) => {
    const permission = pendingApprovalRef.current;
    if (turnsRef.current.current) {
      toast.info("Wait for the current turn to finish before approving an action.");
      return;
    }
    if (permission) {
      if (!permissionMatchesCall(permission, call)) {
        toast.info("This tool row belongs to another step. Review the current permission banner.");
        return;
      }
      await approvePendingPermission(permission);
      return;
    }
    if (call.name.startsWith("browser_")) {
      toast.info("This saved step needs a fresh review of the current page before approval.");
      await sendStreaming("Review the current page before continuing this website test, and ask for fresh approval of any critical step.");
      return;
    }

    // 2. Interactive execution for terminal commands
    if (call.name === "terminal_run_command" && call.arguments?.command) {
      const cmd = call.arguments.command as string;
      toast.info(`Executing: ${cmd}`);
      try {
        const res = await api.post("/ai/tools/execute", {
          name: "terminal_run_command",
          arguments: {
            command: cmd,
            deployment_id: selectedDeploymentId || undefined,
            project_id: selectedProjectId || undefined,
          },
        });
        const toolResult = res.data?.result || res.data;
        // Update live stream tool calls
        setStreamToolCalls((current) =>
          current.map((tc) =>
            tc === call || (tc.name === call.name && tc.arguments?.command === cmd)
              ? { ...tc, result: toolResult }
              : tc
          )
        );
        // Also update any message in history containing this tool call
        setMessages((prev) =>
          prev.map((msg) => {
            if (!msg.toolCalls) return msg;
            return {
              ...msg,
              toolCalls: msg.toolCalls.map((tc) =>
                tc === call || (tc.name === call.name && tc.arguments?.command === cmd)
                  ? { ...tc, result: toolResult }
                  : tc
              ),
            };
          })
        );
        await sendStreaming(
          `Confirmed: Accept & run \`${cmd}\`\nOutput:\n\`\`\`\n${
            toolResult?.stdout || toolResult?.output || toolResult?.stderr || "Done"
          }\n\`\`\``
        );
      } catch (err) {
        toast.error("Failed to execute command");
      }
      return;
    }

    // 3. For any other mutating action
    const toolTitle = call.name;
    toast.success(`Approved ${toolTitle}`);
    await sendStreaming(
      `Confirmed: Approve execution of ${toolTitle} with arguments: ${JSON.stringify(call.arguments)}`
    );
  };

  const handleDenyToolCall = (call: ToolCall) => {
    const permission = pendingApprovalRef.current;
    if (permission && permissionMatchesCall(permission, call)) {
      declinePendingPermission(permission);
    }
    const declinedResult = { status: "declined", error: "User declined execution of this tool." };
    setStreamToolCalls((current) =>
      current.map((tc) =>
        tc === call || (tc.name === call.name && JSON.stringify(tc.arguments) === JSON.stringify(call.arguments))
          ? { ...tc, result: declinedResult }
          : tc
      )
    );
    setMessages((prev) =>
      prev.map((msg) => {
        if (!msg.toolCalls) return msg;
        return {
          ...msg,
          toolCalls: msg.toolCalls.map((tc) =>
            tc === call || (tc.name === call.name && JSON.stringify(tc.arguments) === JSON.stringify(call.arguments))
              ? { ...tc, result: declinedResult }
              : tc
          ),
        };
      })
    );
    appendMessage({
      role: "assistant",
      content: `Execution of **${call.name}** was declined by user.`,
      meta: "Action Declined",
    });
    toast.info(`Declined ${call.name}`);
  };

  const handleCopy = (id: string, text: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedId(id);
      toast.success("Copied to clipboard");
      setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 2000);
    }
  };

  const handleBranchChat = async (messageIndex: number) => {
    discardActiveTurn();
    const branchMessages = messages.slice(0, messageIndex + 1);
    if (activeSessionId) {
      try {
        const res = await api.post(`/ai/sessions/${activeSessionId}/branch`, {
          message_index: messageIndex,
        });
        if (res.data?.id) {
          setActiveSessionId(res.data.id);
          setMessages(branchMessages);
          if (typeof window !== "undefined") {
            window.history.replaceState(null, "", `/dashboard/ai?session_id=${res.data.id}`);
          }
          queryClient.invalidateQueries({ queryKey: ["ai-chat-sessions"] });
          toast.success("Branched into new chat session");
          return;
        }
      } catch (err) {
        console.error("Failed to branch server session:", err);
      }
    }
    setMessages(branchMessages);
    toast.success("Branched into new conversation");
  };

  const handleRegenerate = async (assistantIndex: number) => {
    if (isRunning) return;
    let userPrompt = "";
    let userIndex = -1;
    for (let i = assistantIndex - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        userPrompt = messages[i].content;
        userIndex = i;
        break;
      }
    }
    if (!userPrompt || userIndex === -1) return;

    setMessages(messages.slice(0, userIndex + 1));
    const isAiCommand =
      /^\/(architect|swarm|plan|audit|review|code|repair|fix|diagnose|analyze|dockerfile|terminal|run|exec)\b/i.test(userPrompt) ||
      (/^\/deploy\b/i.test(userPrompt) && userPrompt.replace(/^\/deploy\b/i, "").trim().length > 10);

    const isPlatformCommand = /^\/(cost|org|environments|build|app|help|events|metrics|rollback|pause|resume|scale|drift|secrets)\b/i.test(userPrompt);

    if (isAiCommand || (!isPlatformCommand && userPrompt.startsWith("/"))) {
      void sendStreaming(userPrompt);
    } else if (userPrompt.startsWith("/")) {
      commandMutation.mutate(userPrompt);
    } else if (isDeployIntent(userPrompt)) {
      autonomousDeployMutation.mutate(userPrompt);
    } else if (streamingEnabled) {
      void sendStreaming(userPrompt);
    } else {
      runAgentMutation.mutate(userPrompt);
    }
  };

  const filteredCommands = useMemo(() => {
    if (!input.startsWith("/")) return commands;
    const token = input.split(/\s+/)[0].toLowerCase();
    return commands.filter((command) => command.name.startsWith(token));
  }, [input]);

  const chooseDeploymentForCommand = (deployment: Deployment) => {
    setSelectedDeploymentId(deployment.id);
    setSelectedProjectId(deployment.project_id);
    // Keep whichever command is pending rather than hardcoding one.
    setInput(`${pendingCommand?.name || "/diagnose"} ${deployment.id} `);
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  const chooseProjectForCommand = (project: Project) => {
    setSelectedProjectId(project.id);
    setInput(`${pendingCommand?.name || "/analyze"} ${project.id} `);
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  const chooseAppForCommand = (template: string) => {
    setInput(`/app ${template} `);
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  const commandDraft = (name: (typeof commands)[number]["name"]) => {
    if (name === "/diagnose") return selectedDeploymentId ? `/diagnose ${selectedDeploymentId}` : "/diagnose ";
    if (name === "/build") return selectedDeploymentId ? `/build ${selectedDeploymentId}` : "/build ";
    if (name === "/deploy") return selectedDeploymentId ? `/deploy ${selectedDeploymentId} ` : "/deploy ";
    if (name === "/dockerfile") return selectedProjectId ? `/dockerfile ${selectedProjectId}` : "/dockerfile ";
    if (name === "/analyze") return selectedProjectId ? `/analyze ${selectedProjectId}` : "/analyze ";
    return `${name} `;
  };

  const chooseCommand = (name: (typeof commands)[number]["name"]) => {
    setInput(commandDraft(name));
    setShowCommands(false);
    setCommandPickerOpen(false);
  };

  const renderModelButtons = (items: AiModel[], onAfterSelect?: () => void) =>
    items.length === 0 ? (
      <div className="px-2 py-2 text-sm text-muted-foreground">No models available</div>
    ) : (
      items.map((model) => (
        <button
          key={model.id}
          type="button"
          onClick={() => {
            chooseModel(model);
            onAfterSelect?.();
          }}
          className="flex min-h-9 w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground"
        >
          <span className="min-w-0 truncate">{modelLabel(model)}</span>
          {model.id === activeModelId && <AppIcon name="check" fallback={Check} className="h-4 w-4"  />}
        </button>
      ))
    );

  const renderModelPicker = (onAfterSelect?: () => void) => (
    <div className="max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl ring-1 ring-foreground/10">
      {availableModels.length === 0 ? (
        <div className="p-3 text-center text-xs text-muted-foreground">
          No models found. Enter an API key and click &ldquo;Fetch Models&rdquo; in settings, or type any custom model ID.
        </div>
      ) : (
        <>
          {fastModels.length > 0 && (
            <>
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Fast models ({fastModels.length})</div>
              {renderModelButtons(fastModels, onAfterSelect)}
            </>
          )}
          {thinkingModels.length > 0 && (
            <>
              <div className="my-1 h-px bg-border" />
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Thinking models ({thinkingModels.length})</div>
              {renderModelButtons(thinkingModels, onAfterSelect)}
            </>
          )}
        </>
      )}
    </div>
  );

  const renderCommandPicker = () => (
    <div className="max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl ring-1 ring-foreground/10">
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Agent commands</div>
      {commands.map((command) => (
        <button
          key={command.name}
          type="button"
          onClick={() => chooseCommand(command.name)}
          className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left outline-none hover:bg-accent hover:text-accent-foreground"
        >
          {command.icon === Terminal ? (
            <Terminal className="mt-0.5 size-4 shrink-0 text-primary" />
          ) : (
            <FilledStarIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{command.usage}</span>
            <span className="block text-xs text-muted-foreground">{command.description}</span>
          </span>
        </button>
      ))}
    </div>
  );

  const browserSessionPlaceholder = (
    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl border border-border bg-background px-6 text-center" role="status" aria-live="polite">
      {browserSessionError ? (
        <>
          <p className="text-sm text-muted-foreground">{browserSessionError}</p>
          <Button variant="outline" size="sm" onClick={() => setBrowserSessionRetry(attempt => attempt + 1)}>Retry connection</Button>
        </>
      ) : (
        <>
          <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">Preparing Live App…</p>
        </>
      )}
    </div>
  );

  return (
    <>
      <Dialog open={mobileOptionsOpen} onOpenChange={setMobileOptionsOpen}>
        <DialogContent className="max-w-sm" data-mobile-chat-options>
          <DialogHeader>
            <DialogTitle>Chat options</DialogTitle>
            <DialogDescription>Choose context or add something to your message.</DialogDescription>
          </DialogHeader>
          <div className="grid min-w-0 gap-1">
            <Button variant="ghost" className="justify-start gap-3" disabled={isRunning} onClick={() => { setMobileOptionsOpen(false); fileInputRef.current?.click(); }}><Paperclip className="size-4" />Attach files or photos</Button>
            <Button variant="ghost" className="justify-start gap-3" onClick={() => { setMobileOptionsOpen(false); setCommandPickerOpen(true); setProjectOpen(false); }}><FilledStarIcon className="size-4" />Commands</Button>
            <Button variant="ghost" className="h-auto min-w-0 justify-start gap-3 py-3 text-left" onClick={() => { setMobileOptionsOpen(false); setProjectOpen(true); setCommandPickerOpen(false); }}><Layers className="size-4 shrink-0" /><span className="min-w-0"><span className="block">Choose project or website</span><span className="block truncate text-xs text-muted-foreground">{customTargetUrl || selectedProject?.name || "All projects"}</span></span></Button>
            {customTargetUrl && <Button variant="ghost" className="justify-start gap-3" onClick={() => { changeTargetUrl(""); setMobileOptionsOpen(false); }}><X className="size-4" />Clear website target</Button>}
          </div>
        </DialogContent>
      </Dialog>
      <div className="flex h-full min-h-0 min-w-0 overflow-hidden bg-background text-foreground">
        <section className={cn("min-h-0 min-w-0 flex-1 flex-col", browserOpen && !isDesktop ? "hidden" : "flex")}>
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/40 px-3 py-2 sm:px-6 sm:py-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={startNewChat}
            >
              <AppIcon name="plus" fallback={Plus} className="h-3.5 w-3.5" />
              New Chat
            </Button>
            {activeSession?.title && (
              <div className="hidden items-center gap-2 sm:flex">
                <span className="max-w-xs truncate text-xs text-muted-foreground">
                  {activeSession.title}
                </span>
                {activeSession.session_type === "sre_incident" && activeSession.status === "healing" && (
                  <Badge variant="outline" className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-400 py-0 h-5">
                    <AppIcon name="loader2" fallback={Loader2} className="h-2.5 w-2.5 animate-spin" />
                    Auto-Healing
                  </Badge>
                )}
                {activeSession.session_type === "sre_incident" && activeSession.status === "healed" && (
                  <Badge variant="outline" className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-400 py-0 h-5">
                    <AppIcon name="check" fallback={Check} className="h-2.5 w-2.5" />
                    Healed & Live
                  </Badge>
                )}
                {activeSession.session_type === "sre_incident" && activeSession.status === "failed" && (
                  <Badge variant="outline" className="gap-1 border-red-500/40 bg-red-500/10 text-[10px] text-red-400 py-0 h-5">
                    <AppIcon name="x-circle" fallback={XCircle} className="h-2.5 w-2.5" />
                    Healing Failed
                  </Badge>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant={browserOpen ? "secondary" : "ghost"}
              size="sm"
              className={cn(
                "h-8 gap-1.5 px-3 text-xs transition-colors",
                browserOpen ? "text-foreground font-medium bg-muted" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setBrowserOpen((open) => !open)}
              title="Toggle Live Application Screen (Computer Use)"
            >
              <Globe className="h-3.5 w-3.5 text-sky-400" />
              <span className="sr-only sm:not-sr-only">Live App</span>
              {browserActive && (
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              )}
            </Button>
            <Button
              type="button"
              variant={terminalOpen ? "secondary" : "ghost"}
              size="sm"
              className={cn(
                "h-8 gap-1.5 px-3 text-xs transition-colors",
                terminalOpen ? "text-foreground font-medium bg-muted" : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setTerminalOpen((open) => !open)}
              title="Toggle Workspace Terminal"
            >
              <AppIcon name="terminal" fallback={Terminal} className="h-3.5 w-3.5 mr-1" />
              <span className="sr-only sm:not-sr-only">Terminal</span>
            </Button>
            <Link href="/dashboard/ai/history">
              <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-3 text-xs text-muted-foreground hover:text-foreground">
                <AppIcon name="clock" fallback={Clock} className="h-3.5 w-3.5" />
                <span className="sr-only sm:not-sr-only">History</span>
              </Button>
            </Link>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              aria-label="Agent settings"
              onClick={() => setSettingsOpen(true)}
            >
              <AppIcon name="settings" fallback={Settings} className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <div ref={scrollRef} onScroll={handleChatScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-2 py-3 sm:px-4 sm:py-8 md:px-8">
          <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:gap-6">
            {activeSession?.session_type === "sre_incident" && visibleMessages.length === 0 && (
              <div className="rounded-xl border border-border bg-card px-5 py-4 text-sm" role="status" aria-live="polite">
                <div className="flex items-center gap-2 font-medium">
                  {activeSession.status === "healing" && <Loader2 className="h-4 w-4 animate-spin text-amber-400" aria-hidden="true" />}
                  {activeSession.status === "healing" ? "Preparing deployment recovery" : "Deployment recovery update"}
                </div>
                <p className="mt-1 text-muted-foreground">
                  {activeSession.status === "healing"
                    ? "Checking the failed build and starting the AI repair agent. Steps will appear here as they are recorded."
                    : "This recovery did not record any visible steps. Check the deployment logs for the failure reason."}
                </p>
              </div>
            )}
            <RemoteRunRecovery sessionId={activeSessionId} busy={isStreaming || isSessionLoading}
              onWorking={setRemoteWorkRunning}
              onSettled={() => { void loadSession(activeSessionId, true).catch(() => {}); }}
              onPermission={event => {
                const toolName=event.tool_name || "Action";
                const id=permissionRequestId(event);
                const messageId=[...messagesRef.current].reverse().find(message=>message.role === "assistant")?.id;
                const permission:MessagePermission={id,toolName,title:toolName,arguments:event.arguments,description:event.description,browserStep:event.browser_step,status:"pending"};
                if(messageId)setMessages(current=>current.map(message=>message.id === messageId ? {...message,permissions:[
                  ...(message.permissions || []).filter(old=>old.id !== id && (old.id || !permissionMatchesCall(permission,{name:old.toolName || "",arguments:old.arguments}))),permission
                ]} : message));
                setPendingApproval({id,messageId,sessionId:activeSessionId,toolName,arguments:event.arguments,
                  type:event.browser_step ? "browser" : "deploy",title:toolName,description:event.description || "Approve this exact action to continue.",browserStep:event.browser_step,
                  action:async()=>{await sendStreaming("Approve this exact step and continue.",undefined,true,event.token);},
                  onDecline:()=>{void api.post("/ai/chat/stop",{session_id:activeSessionId}).catch(()=>{});}
                });
              }}
              onQuestion={event => {
                setAgentQuestionAnswers(Object.fromEntries((event.fields || []).map(f => [f.id, f.default_value || f.options?.[0] || ""])));
                setPendingAgentQuestion({id: event.question_id, question: event.question, fields: event.fields || []});
              }} />
            {sessionRefreshError && activeSession?.session_type === "sre_incident" && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{sessionRefreshError}</p>
            )}
            {messages.filter(m => !(m.role === "user" && m.content.startsWith("[System]"))).map((message, messageIndex) => (
              <div
                key={message.id}
                data-chat-message={message.role}
                data-message-id={message.id}
                className={cn("flex gap-2 sm:gap-3", message.role === "user" ? "justify-end" : "justify-start")}
              >
                {message.role !== "user" && (
                  <div className="mt-1 hidden h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background sm:flex">
                    <AppIcon name="star" fallback={Star} className="h-3.5 w-3.5 sm:h-4 sm:w-4"  />
                  </div>
                )}
                <div
                  className={cn(
                    "min-w-0 overflow-hidden break-words text-[13px] sm:max-w-[min(56rem,88%)] sm:rounded-2xl sm:px-5 sm:py-4 sm:text-sm",
                    message.role === "user" ? "max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-foreground sm:bg-primary sm:text-primary-foreground" : "w-full max-w-full px-2 py-2 sm:w-auto sm:border sm:border-border sm:bg-background"
                  )}
                >
                  {message.role === "assistant" && <AssistantMessageBody message={message} generating={isStreaming && message.id === streamMessageId} orbStyle={orbStyle} onOpenTerminal={openTerminalWithCommand} />}
                  {message.role === "assistant" && <PermissionsPanel
                    permissions={message.permissions?.length ? message.permissions : pendingApproval && !pendingApproval.messageId && messageIndex === messages.length - 1 ? [{...pendingApproval,status:"pending"}] : []}
                    pendingId={pendingApproval?.id} disabled={isRunning}
                    onApprove={() => { if (pendingApproval) void approvePendingPermission(pendingApproval); }}
                    onDecline={() => { if (pendingApproval) declinePendingPermission(pendingApproval); }} />}
                        {message.role === "assistant" && pendingAgentQuestion && messageIndex === messages.filter(m => !(m.role === "user" && m.content.startsWith("[System]"))).length - 1 && (
                          <div className="mt-3 rounded-xl border border-border bg-card p-4 shadow-sm animate-in fade-in slide-in-from-bottom-2">
                            <div className="flex items-start gap-3.5">
                              <div className="rounded-md border border-border bg-muted p-2.5 text-foreground shrink-0">
                                <HelpCircle className="h-4 w-4" />
                              </div>
                              <div className="flex-1 space-y-3 min-w-0">
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                  <h4 className="font-medium text-foreground text-sm">{pendingAgentQuestion.question}</h4>
                                  <Badge variant="secondary" className="text-[10px] uppercase tracking-wider font-mono">
                                    Clarification Needed
                                  </Badge>
                                </div>

                                <div className="space-y-3 pt-1">
                                  {pendingAgentQuestion.fields.map((field) => (
                                    <div key={field.id} className="space-y-1.5">
                                      <label className="text-xs font-medium text-foreground/90 block">
                                        {field.label}
                                      </label>
                                      {field.type === "dropdown" || (field.options && field.options.length > 0) ? (
                                        <Select
                                          value={agentQuestionAnswers[field.id] || field.default_value || (field.options && field.options[0]) || ""}
                                          onValueChange={(val: string | null) => setAgentQuestionAnswers((prev) => ({ ...prev, [field.id]: val || "" }))}
                                        >
                                          <SelectTrigger className="w-full h-9">
                                            <SelectValue placeholder="Select an option..." />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {(field.options || []).map((opt, oIdx) => (
                                              <SelectItem key={oIdx} value={opt}>
                                                {opt}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                      ) : (
                                        <Input
                                          type="text"
                                          value={agentQuestionAnswers[field.id] || ""}
                                          placeholder={field.placeholder || "Enter value..."}
                                          onChange={(e) => setAgentQuestionAnswers((prev) => ({ ...prev, [field.id]: e.target.value }))}
                                          className="h-9"
                                        />
                                      )}
                                    </div>
                                  ))}
                                </div>

                                <div className="flex items-center gap-2 pt-2">
                                  <Button
                                    size="sm"
                                    className="h-8 px-4 gap-1.5 text-xs shadow-sm"
                                    onClick={async () => {
                                      const answers = { ...agentQuestionAnswers };
                                      setPendingAgentQuestion(null);
                                      setAgentQuestionAnswers({});
                                      const replyStr = Object.entries(answers)
                                        .map(([k, v]) => `${k}: ${v}`)
                                        .join("\n");
                                      await sendStreaming(`[System] User answered the question:\n${replyStr}`, undefined, true);
                                    }}
                                  >
                                    Submit & Continue
                                    <ArrowRight className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                        {message.role === "user" && (
                          <div className="space-y-2">
                            {message.images && message.images.length > 0 && (
                              <div className="flex flex-wrap gap-2 mb-2">
                                {message.images.map((imgUrl, i) => (
                                  <img
                                    key={i}
                                    src={imgUrl}
                                    alt={`Attachment ${i + 1}`}
                                    className="max-h-52 max-w-full rounded-xl border border-white/20 object-cover shadow-sm"
                                  />
                                ))}
                              </div>
                            )}
                            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-relaxed sm:text-sm">{message.content}</p>
                          </div>
                        )}
                  {isStreaming && message.id === streamMessageId && <Button size="sm" variant="ghost" className="mt-2 h-7 text-xs text-muted-foreground" onClick={handleStopGeneration}><Square className="size-3" />Stop generation</Button>}
                  {message.role === "assistant" && !(isStreaming && message.id === streamMessageId) && (
                    <div className="mt-2.5 flex items-center gap-0.5 text-muted-foreground">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={copiedId === message.id ? "Copied" : "Copy"}
                        aria-label="Copy message"
                        onClick={() => handleCopy(message.id, message.content)}
                      >
                        {copiedId === message.id ? (
                          <AppIcon name="check" fallback={Check} className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <AppIcon name="copy" fallback={Copy} className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Branch into new chat"
                        aria-label="Branch into new chat"
                        onClick={() => handleBranchChat(messageIndex)}
                      >
                        <AppIcon name="git-fork" fallback={GitFork} className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={isRunning}
                        className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Regenerate response"
                        aria-label="Regenerate response"
                        onClick={() => handleRegenerate(messageIndex)}
                      >
                        <AppIcon name="refresh-cw" fallback={RefreshCw} className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isRunning && !isStreaming && (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                {orbStyle !== "off" && (
                  <ThinkingOrb
                    state={orbStyle}
                    size={20}
                    theme={isDark ? "dark" : "light"}
                  />
                )}
                <StatusVerb prompt={lastUserPrompt} />
              </div>
            )}
          </div>
        </div>

        {/* Floating Workspace PowerShell Terminal Window */}
        <FloatingPowerShellTerminal
          open={terminalOpen}
          onClose={() => setTerminalOpen(false)}
          selectedDeploymentId={selectedDeploymentId}
          selectedProjectId={selectedProjectId}
          initialCommand={terminalInitialCommand}
          onInitialCommandConsumed={() => setTerminalInitialCommand(undefined)}
        />

        <div className="sticky bottom-0 z-20 shrink-0 bg-gradient-to-t from-background via-background/95 to-transparent px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 sm:px-4 sm:pb-4 md:px-6">
          <div ref={composerRef} className="relative mx-auto max-w-5xl">
            {/* Floating Scroll to Bottom Button - Positioned directly above the right side of the chat box */}
            {showScrollBottom && (
              <div className="absolute -top-11 right-2 z-30">
                <button
                  type="button"
                  onClick={() => {
                    isUserScrolledUpRef.current = false;
                    setShowScrollBottom(false);
                    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
                  }}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg backdrop-blur hover:bg-muted cursor-pointer transition-all animate-in fade-in slide-in-from-bottom-2"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                  <span>Scroll to bottom</span>
                </button>
              </div>
            )}
            {argPickerOpen && pendingCommand?.arg === "deployment" && (
              <div className="mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Pick a deployment for {pendingCommand.name}
                </div>
                {pickableDeployments.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-muted-foreground">No deployments yet.</div>
                ) : (
                  pickableDeployments.map((deployment) => (
                    <button
                      key={deployment.id}
                      type="button"
                      className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted"
                      onClick={() => chooseDeploymentForCommand(deployment)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{deployment.project_name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {deployment.version || "unversioned"} · {shortId(deployment.id)}
                        </span>
                      </span>
                      <Badge variant={deployment.status === "failed" ? "destructive" : "outline"}>
                        {deployment.status}
                      </Badge>
                    </button>
                  ))
                )}
              </div>
            )}

            {argPickerOpen && pendingCommand?.arg === "project" && (
              <div className="mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Pick a project for {pendingCommand.name}
                </div>
                {projects.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-muted-foreground">No projects yet.</div>
                ) : (
                  projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted"
                      onClick={() => chooseProjectForCommand(project)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{project.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {project.source_type || "project"} · {shortId(project.id)}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            {argPickerOpen && pendingCommand?.arg === "app" && (
              <div className="mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Pick an application to deploy
                </div>
                {/* Straight from the list /app actually accepts, so the
                    picker cannot drift from the handler. */}
                {agentApplicationTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted"
                    onClick={() => chooseAppForCommand(template.id)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{template.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        /app {template.id}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            {showCommands && !argPickerOpen && filteredCommands.length > 0 && (
              // Capped and scrollable. Unbounded, twenty commands covered the
              // entire conversation behind it.
              <div className="mb-2 max-h-64 overflow-y-auto overflow-x-hidden rounded-xl border border-border bg-popover shadow-xl">
                {filteredCommands.map((command) => (
                  <button
                    key={command.name}
                    type="button"
                    className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-muted"
                    onClick={() => {
                      // Trailing space is the signal that an argument is
                      // expected, which is what opens the next picker.
                      setInput(`${command.name} `);
                      setShowCommands(false);
                      textareaRef.current?.focus();
                    }}
                  >
                    {command.icon === Terminal ? (
                      <Terminal className="mt-0.5 size-4 shrink-0 text-primary" />
                    ) : (
                      <FilledStarIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                    )}
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{command.usage}</span>
                      <span className="block text-xs text-muted-foreground">{command.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div data-chat-composer ref={composerBoxRef} className="relative min-w-0 rounded-2xl border border-border bg-background px-2 py-2 shadow-sm sm:px-3">
              {/* Popovers rendered at the chat-box level so they NEVER get clipped by horizontal overflow or masks */}
              {commandPickerOpen && (
                <div
                  className="absolute z-50 w-full max-w-full sm:w-96 sm:max-w-[calc(100vw-3rem)]"
                  style={{ left: pickerOffsets.commandLeft, bottom: pickerOffsets.commandBottom }}
                >
                  {renderCommandPicker()}
                </div>
              )}

              {projectOpen && (
                <div
                  className="absolute z-50 w-full max-w-full rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl sm:w-64"
                  style={{ left: pickerOffsets.projectLeft, bottom: pickerOffsets.projectBottom }}
                >
                  <div className="px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Target Project
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedProjectId("");
                      setSelectedDeploymentId("");
                      setProjectOpen(false);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground text-left"
                  >
                    <span>All Projects (Auto-detect)</span>
                    {!selectedProjectId && <Check className="h-3.5 w-3.5 text-primary" />}
                  </button>
                  <div className="my-1 border-t border-border/50" />
                  <button
                    type="button"
                    onClick={() => {
                      setCustomUrlInput(customTargetUrl || "");
                      setShowCustomUrlDialog(true);
                      setProjectOpen(false);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground text-left text-sky-400 font-medium"
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <Globe className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">Custom Website / URL...</span>
                    </div>
                    {customTargetUrl && (
                      <span className="text-[9px] px-1 py-0 rounded bg-sky-500/20 text-sky-300 shrink-0 font-mono">
                        Active
                      </span>
                    )}
                  </button>
                  <div className="my-1 border-t border-border/50" />
                  <div className="max-h-52 overflow-y-auto space-y-0.5">
                    {projects.map((p) => {
                      const dep = deployments.find(
                        (d) => d.project_id === p.id && d.status === "running" && Boolean(d.runtime_url)
                      );
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setSelectedProjectId(p.id);
                            if (dep) setSelectedDeploymentId(dep.id);
                            setProjectOpen(false);
                          }}
                          className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground text-left"
                        >
                          <span className="truncate font-medium">{p.name}</span>
                          <div className="flex items-center gap-1 shrink-0">
                            {dep && (
                              <Badge variant="outline" className="text-[9px] px-1 py-0 border-emerald-500/40 text-emerald-400 bg-emerald-500/10">
                                Running
                              </Badge>
                            )}
                            {p.id === selectedProjectId && <Check className="h-3.5 w-3.5 text-primary" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Attachment Preview Chips */}
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 pb-2 mb-2 border-b border-border/50">
                  {attachments.map((att) => (
                    <div
                      key={att.id}
                      className="group relative flex items-center gap-2 rounded-lg border border-border bg-muted/50 pl-2 pr-1.5 py-1 text-xs max-w-xs transition-all hover:bg-muted/80"
                    >
                      {att.isImage ? (
                        <div className="h-7 w-7 rounded overflow-hidden bg-black/20 shrink-0 border border-border/50">
                          <img
                            src={att.dataUrl}
                            alt={att.name}
                            className="h-full w-full object-cover"
                          />
                        </div>
                      ) : (
                        <FileText className="h-4 w-4 text-primary shrink-0" />
                      )}
                      <div className="flex flex-col min-w-0 pr-1">
                        <span className="truncate font-medium text-[11px] max-w-[130px]" title={att.name}>
                          {att.name}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          {att.size < 1024 ? `${att.size} B` : `${(att.size / 1024).toFixed(1)} KB`}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeAttachment(att.id)}
                        className="rounded-full p-0.5 text-muted-foreground hover:bg-rose-500/20 hover:text-rose-500 transition-colors shrink-0"
                        title="Remove attachment"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {(selectedProject || customTargetUrl) && <div className="mb-1 flex min-w-0 sm:hidden">
                <button type="button" aria-label="Change chat target" className="flex min-w-0 max-w-full items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted" onClick={() => { setProjectOpen(open => !open); setCommandPickerOpen(false); }}>
                  {customTargetUrl ? <Globe className="size-3.5 shrink-0" /> : <Layers className="size-3.5 shrink-0" />}
                  <span className="truncate">{customTargetUrl?.replace(/^https?:\/\//, "") || selectedProject?.name}</span><ChevronDown className="size-3 shrink-0" />
                </button>
              </div>}
              <textarea
                aria-label="Message StackPilot"
                ref={textareaRef}
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  // Only while the command name itself is being typed. Once a
                  // space is entered the user has moved on to the argument,
                  // and the palette reappearing over the picker is noise.
                  setShowCommands(/^\/[a-z-]*$/i.test(event.target.value));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={
                  attachments.length > 0
                    ? "Add a prompt for your attachments, or press Enter to analyze..."
                    : "Ask the agent, or type / for commands..."
                }
                rows={1}
                className="max-h-44 min-h-10 w-full resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground"
              />
              <div data-mobile-composer-controls className="flex min-w-0 items-center gap-1 pt-1 sm:hidden">
                <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0 rounded-full" aria-label="Chat options" onClick={() => { closePickers(); setMobileOptionsOpen(true); }}><Plus className="size-5" /></Button>
                <Button type="button" variant="ghost" className="h-11 min-w-0 flex-1 justify-start gap-1.5 px-2 text-xs" aria-label={`Choose model: ${modelLabel(activeModel)}`} onClick={() => setModelPickerOpen(true)} suppressHydrationWarning>
                  <span className="truncate" suppressHydrationWarning>{mode === "thinking" ? "Think" : isVisionActive ? "Vision" : "Fast"} · {mounted ? shortId(modelLabel(activeModel).split("/").pop() || "Select model", 16) : "Select model"}</span><ChevronDown className="size-3 shrink-0" />
                </Button>
                <Button type="button" variant={isListening ? "destructive" : "ghost"} size="icon" className="size-11 shrink-0 rounded-full" disabled={isRunning} onClick={toggleListening} aria-label={isListening ? "Stop voice input" : "Start voice input"}>{isListening ? <Square className="size-4" /> : <Mic className="size-4" />}</Button>
                <Button type="button" size="icon" className="size-11 shrink-0 rounded-full" onClick={isStreaming ? handleStopGeneration : submit} disabled={!isStreaming && ((!input.trim() && attachments.length === 0) || isRunning)} aria-label={isStreaming ? "Stop generating response" : "Send message"}>{isStreaming ? <Square className="size-4 fill-current" /> : isRunning ? <Loader2 className="size-4 animate-spin" /> : <ArrowDown className="size-5 rotate-180" />}</Button>
              </div>
              <div className="relative hidden min-w-0 items-center justify-between gap-1 pt-1 sm:flex">
                {/* Scrollable Left Controls Track with Right Fade Mask */}
                <div
                  className="flex w-full min-w-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain py-0.5 sm:w-auto sm:flex-1 sm:pr-6 sm:[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent_100%)]"
                  onWheel={(e) => {
                    if (e.deltaY !== 0 && e.currentTarget.scrollWidth > e.currentTarget.clientWidth) {
                      e.currentTarget.scrollLeft += e.deltaY;
                    }
                  }}
                >
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="max-w-[130px] sm:max-w-[170px] md:max-w-[210px] justify-start h-8 text-xs font-medium px-2.5 shrink-0"
                    suppressHydrationWarning
                    onClick={() => setModelPickerOpen(true)}
                    title="Open Categorized Model Picker"
                  >
                    {!mounted ? (
                      <AppIcon name="zap" fallback={Zap} className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                    ) : mode === "thinking" ? (
                      <AppIcon name="brain-circuit" fallback={BrainCircuit} className="h-3.5 w-3.5 text-purple-400 shrink-0" />
                    ) : isVisionActive ? (
                      <Sparkles className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <AppIcon name="zap" fallback={Zap} className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                    )}
                    <span className="truncate max-w-[85px] sm:max-w-[125px] md:max-w-[165px]" suppressHydrationWarning>
                      {!mounted
                        ? "Fast | Select model"
                        : `${mode === "thinking" ? "Think" : isVisionActive ? "Vision" : "Fast"} | ${shortId(modelLabel(activeModel), 16)}`}
                    </span>
                    <ChevronDown className="ml-1 h-3 w-3 opacity-60 shrink-0" />
                  </Button>

                  <Button
                    ref={commandButtonRef}
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-8 px-2.5 text-xs font-medium gap-1 shrink-0"
                    onClick={() => {
                      setCommandPickerOpen((open) => !open);
                      setComposerModelOpen(false);
                      setSettingsModelOpen(false);
                      setProjectOpen(false);
                      setDeploymentOpen(false);
                    }}
                  >
                    <FilledStarIcon className="size-3.5 shrink-0" />
                    Commands
                    <AppIcon name="chevron-down" fallback={ChevronDown} className="ml-0.5 h-3 w-3 shrink-0" />
                  </Button>

                  {/* Custom URL or Target Project Selector Pill */}
                  {customTargetUrl ? (
                    <div className="flex items-center gap-1.5 bg-sky-500/10 border border-sky-500/30 rounded-lg px-2 h-8 text-xs text-sky-400 font-medium shrink-0">
                      <Globe className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                      <span
                        className="truncate max-w-[90px] sm:max-w-[140px] cursor-pointer hover:underline"
                        title={`Custom URL target: ${customTargetUrl}. Click to change.`}
                        onClick={() => {
                          setCustomUrlInput(customTargetUrl);
                          setShowCustomUrlDialog(true);
                        }}
                      >
                        {customTargetUrl.replace(/^https?:\/\//, "")}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          changeTargetUrl("");
                        }}
                        className="p-0.5 hover:bg-sky-500/20 rounded text-sky-400 hover:text-sky-200 transition-colors"
                        title="Clear custom target URL"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <Button
                      ref={projectButtonRef}
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-8 gap-1 text-xs font-medium px-2.5 shrink-0"
                      onClick={() => {
                        setProjectOpen((open) => !open);
                        setCommandPickerOpen(false);
                        setComposerModelOpen(false);
                        setSettingsModelOpen(false);
                        setDeploymentOpen(false);
                      }}
                      title="Select Target Project or Custom Website for AI Agent & Live Browser"
                    >
                      <Layers className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                      <span className="truncate max-w-[75px] sm:max-w-[105px]">
                        {selectedProject ? selectedProject.name : "All Projects"}
                      </span>
                      {activeProjectDeployment?.status === "running" && (
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" title="Live Running Deployment" />
                      )}
                      <ChevronDown className="h-3 w-3 opacity-60 ml-0.5 shrink-0" />
                    </Button>
                  )}
                </div>

                {/* Pinned Right Controls Group with Gradient Overlay */}
                <div className="relative z-10 ml-auto flex shrink-0 items-center gap-1.5 bg-background sm:pl-1.5">
                  {/* Fade gradient overlay to the left of the right buttons */}
                  <div className="pointer-events-none absolute -left-8 top-0 bottom-0 w-8 bg-gradient-to-r from-transparent to-background" />

                  {/* Hidden Multi-file Input */}
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={(e) => handleFilesSelected(e.target.files)}
                    multiple
                    accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx,.yaml,.yml,.py,.ts,.tsx,.js,.jsx,.go,.rs,.cpp,.c,.h,.sh,.sql"
                    className="hidden"
                  />

                  {/* '+' File & Photo Attachment Button */}
                  <Button
                    type="button"
                    variant={isVisionActive ? "secondary" : "outline"}
                    size="icon"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isRunning}
                    className={cn(
                      "h-8 w-8 shrink-0 transition-all",
                      isVisionActive
                        ? "border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-400 shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    title={
                      isVisionActive
                        ? "Attach photos & documents (Multimodal Vision Active)"
                        : "Attach files, documents, or photos"
                    }
                    aria-label="Attach files or photos"
                  >
                    <Plus className={cn("h-4 w-4", isVisionActive && "text-emerald-500 stroke-[2.5]")} />
                  </Button>

                  <Button
                    type="button"
                    variant={isListening ? "destructive" : "outline"}
                    size={isListening ? "default" : "icon"}
                    onClick={toggleListening}
                    disabled={isRunning}
                    className={cn(
                      "h-8 shrink-0 transition-all",
                      isListening
                        ? "gap-2 px-3 bg-red-500 hover:bg-red-600 text-white shadow-md animate-pulse border-red-500"
                        : "w-8 text-muted-foreground hover:text-foreground"
                    )}
                    title={isListening ? "Listening... Click to finish voice input" : "Voice input (Speech to text)"}
                    aria-label={isListening ? "Stop voice input" : "Start voice input"}
                  >
                    {isListening ? (
                      <>
                        <ThinkingOrb state="listening" size={20} theme="dark" />
                        <span className="text-xs font-medium">Listening...</span>
                        <AppIcon name="square" fallback={Square} className="h-3 w-3 fill-current ml-0.5" />
                      </>
                    ) : (
                      <AppIcon name="mic" fallback={Mic} className="h-3.5 w-3.5" />
                    )}
                  </Button>

                  {isStreaming ? (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={handleStopGeneration}
                      className="h-8 px-3 text-xs gap-1.5 shadow-sm bg-red-600 hover:bg-red-700 text-white font-medium active:scale-95 transition-all shrink-0"
                      title="Stop generating response"
                    >
                      <Square className="h-3 w-3 fill-current" />
                      Stop
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 px-3 text-xs font-medium gap-1.5 shrink-0"
                      onClick={submit}
                      disabled={(!input.trim() && attachments.length === 0) || isRunning}
                    >
                      {isRunning ? (
                        <AppIcon name="loader2" fallback={Loader2} className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <AppIcon name="send" fallback={Send} className="h-3.5 w-3.5" />
                      )}
                      Send
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        </section>

        {/* Phones use a dedicated view in the dashboard instead of a floating
            desktop window over messages. The chat stays mounted with its draft. */}
        {browserOpen && !isDesktop && (
          <div data-mobile-computer className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
            {activeSessionId ? <InteractiveBrowserCanvas
              sessionId={activeSessionId}
              initialUrl={canvasTargetUrl}
              sandboxMode={browserSandboxMode}
              isOpen={browserOpen}
              onClose={closeBrowser}
              embedded
              closeLabel="Back to chat"
              className="rounded-none border-0 shadow-none"
              onUrlChange={observeBrowserUrl}
            /> : <div className="flex min-h-0 flex-1 flex-col"><Button variant="ghost" className="self-end" aria-label="Close browser" onClick={closeBrowser}>Back to chat</Button>{browserSessionPlaceholder}</div>}
          </div>
        )}

        {/* Live Application Canvas Drawer (Desktop Side-by-Side Split View) */}
        {browserOpen && isDesktop && (
          <>
            {/* Full-screen Shield during Resizing to prevent canvas pointer interception */}
            {isDraggingDrawer && (
              <div className="fixed inset-0 z-[99999] cursor-col-resize select-none pointer-events-auto bg-transparent" />
            )}

            {/* Draggable Vertical Resizer Handle */}
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startDraggingDrawer}
              className={cn(
                "flex w-3.5 -mx-1.5 cursor-col-resize items-center justify-center z-40 transition-colors group select-none shrink-0 relative hover:bg-primary/20",
                isDraggingDrawer && "bg-primary/30"
              )}
              title="Drag to resize Live App Drawer"
            >
              <div
                className={cn(
                  "w-1.5 h-16 rounded-full flex items-center justify-center transition-all",
                  isDraggingDrawer ? "bg-primary w-2 shadow-lg shadow-primary/40" : "bg-muted-foreground/40 group-hover:bg-primary group-hover:h-20"
                )}
              >
                <GripVertical className="h-3 w-3 text-background pointer-events-none opacity-80" />
              </div>
            </div>
            <div
              style={{ width: `${drawerWidth}px` }}
              className="flex h-full border-l border-border/60 bg-muted/10 p-3 flex-col shrink-0 relative"
            >
              {activeSessionId ? <InteractiveBrowserCanvas
                sessionId={activeSessionId}
                initialUrl={canvasTargetUrl}
                sandboxMode={browserSandboxMode}
                isOpen={browserOpen}
                onClose={closeBrowser}
                embedded={true}
                onUrlChange={observeBrowserUrl}
              /> : browserSessionPlaceholder}
            </div>
          </>
        )}
      </div>

      <Dialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) closePickers();
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-6xl max-w-[calc(100vw-2rem)] [--dialog-padding:1.25rem] sm:[--dialog-padding:1.75rem]">
          <DialogHeader>
            <DialogTitle>Agent Settings</DialogTitle>
            <DialogDescription>Configure provider keys, model, reasoning mode, project context, and deployment context.</DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
            <div className="space-y-6">
            {/* ── 1. How it answers ─────────────────────────────── */}
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-medium">How it answers</h3>
                <p className="text-xs text-muted-foreground">
                  Applies immediately. No need to save.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Reasoning mode</Label>
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/30 p-1">
                  <Button
                    type="button"
                    variant={mode === "fast" ? "default" : "ghost"}
                    onClick={() => {
                      setMode("fast");
                      setSelectedModel(fastModels[0]?.id || "");
                    }}
                  >
                    <AppIcon name="zap" fallback={Zap} className="h-4 w-4"  />
                    Fast
                  </Button>
                  <Button
                    type="button"
                    variant={mode === "thinking" ? "default" : "ghost"}
                    onClick={() => {
                      setMode("thinking");
                      setSelectedModel(thinkingModels[0]?.id || "");
                    }}
                  >
                    <AppIcon name="brain-circuit" fallback={BrainCircuit} className="h-4 w-4"  />
                    Thinking
                  </Button>
                </div>
                {/* Sits under the control it describes, rather than at the
                    bottom of the dialog where it read as a general footnote. */}
                <p className="text-xs text-muted-foreground">
                  {mode === "fast"
                    ? "Quick replies for chat and simple commands. Switching modes also picks a matching model."
                    : "Slower and more careful. Use for diagnosing failures, planning Dockerfiles, and deployment decisions."}
                </p>
              </div>

              <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-muted/20 p-3">
                <div className="min-w-0">
                  <Label className="cursor-pointer" htmlFor="stream-toggle">
                    Stream the reply
                  </Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Show reasoning and text as the model produces them. Turn off to wait for
                    one complete reply instead.
                  </p>
                </div>
                <button
                  id="stream-toggle"
                  type="button"
                  role="switch"
                  aria-checked={streamingEnabled}
                  onClick={() => setStreamingEnabled((value) => !value)}
                  className={cn(
                    "mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                    streamingEnabled ? "bg-primary" : "bg-muted-foreground/30"
                  )}
                >
                  <span
                    className={cn(
                      "inline-block h-4 w-4 rounded-full bg-background transition-transform",
                      streamingEnabled ? "translate-x-4" : "translate-x-0.5"
                    )}
                  />
                </button>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label>Browser sandbox</Label>
                  <div className="relative group">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 text-muted-foreground cursor-help">
                      <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM8.94 6.94a.75.75 0 1 1-1.061-1.061 .75.75 0 0 1 1.06 1.06ZM10 16.25a.75.75 0 0 1-.75-.75v-5a.75.75 0 0 1 1.5 0v5a.75.75 0 0 1-.75.75Z" clipRule="evenodd" />
                    </svg>
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50">
                      <p className="font-medium mb-1">Browser modes</p>
                      <p><span className="font-semibold">Local:</span> Runs in Docker with adaptive capture and hardware encoding when available.</p>
                      <p className="mt-1"><span className="font-semibold">Remote:</span> Runs on a configured remote browser worker. Performance depends on its hardware and network.</p>
                    </div>
                  </div>
                </div>
                <div aria-busy={!!browserSwitchPending} className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/30 p-1">
                  <Button
                    type="button"
                    variant={(browserSwitchPending || browserSandboxMode) === "local" ? "default" : "ghost"}
                    size="sm"
                    onClick={() => selectBrowserSandboxMode("local")}
                    disabled={!!browserSwitchPending}
                    className="gap-1.5"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                      <path fillRule="evenodd" d="M2 4.25A2.25 2.25 0 0 1 4.25 2h11.5A2.25 2.25 0 0 1 18 4.25v8.5A2.25 2.25 0 0 1 15.75 15h-3.105a3.501 3.501 0 0 0 1.1 1.677A.75.75 0 0 1 13.26 18H6.74a.75.75 0 0 1-.484-1.323A3.501 3.501 0 0 0 7.355 15H4.25A2.25 2.25 0 0 1 2 12.75v-8.5Zm1.5 0a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-.75.75H4.25a.75.75 0 0 1-.75-.75v-7.5Z" clipRule="evenodd" />
                    </svg>
                    Local
                  </Button>
                  <Button
                    type="button"
                    variant={(browserSwitchPending || browserSandboxMode) === "remote" ? "default" : "ghost"}
                    size="sm"
                    onClick={() => selectBrowserSandboxMode("remote")}
                    disabled={!!browserSwitchPending}
                    className="gap-1.5"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                      <path d="M5.127 3.502 5.25 3.5h9.5c.041 0 .082 0 .123.002A2.251 2.251 0 0 0 12.75 2h-5.5a2.25 2.25 0 0 0-2.123 1.502ZM1 10.25A2.25 2.25 0 0 1 3.25 8h13.5A2.25 2.25 0 0 1 19 10.25v5.5A2.25 2.25 0 0 1 16.75 18H3.25A2.25 2.25 0 0 1 1 15.75v-5.5Zm15.5.25a.75.75 0 0 0-1.5 0v.5a.75.75 0 0 0 1.5 0v-.5ZM4.25 5a.75.75 0 0 0-.75.75v.5c0 .414.336.75.75.75h11.5a.75.75 0 0 0 .75-.75v-.5a.75.75 0 0 0-.75-.75H4.25Z" />
                    </svg>
                    Remote
                  </Button>
                  <Button type="button" size="sm" disabled={!!browserSwitchPending} variant={(browserSwitchPending || browserSandboxMode) === "host" ? "default" : "ghost"} onClick={() => selectBrowserSandboxMode("host")}>Host Chrome</Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {browserSwitchPending ? `Connecting to ${browserSwitchPending === "host" ? "Host Chrome" : browserSwitchPending === "remote" ? "Remote" : "Local"} for this chat…` : browserSandboxMode === "local"
                    ? "Runs locally in Docker with adaptive streaming."
                    : browserSandboxMode === "host" ? "Uses the dedicated host Chrome worker for this chat."
                    : "Uses the configured remote browser worker."}
                </p>
                {browserSwitchError && <p role="alert" className="text-xs text-destructive">{browserSwitchError}</p>}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Model</Label>
                  <span className="text-xs text-muted-foreground">
                    {availableModels.length > 0 ? `${availableModels.length} models available` : "Enter any model"}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={selectedModel}
                    onChange={(event) => setSelectedModel(event.target.value)}
                    placeholder={activeModelId || "Type or choose any model ID"}
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setModelPickerOpen(true);
                    }}
                    title="Open Categorized Model Picker"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Pick from the dynamic provider list or type any custom model ID directly.
                </p>
              </div>

              {/* ── Thinking Orb Effect ───────────────────────────── */}
              <div className="space-y-2 border-t border-border/70 pt-3">
                <div className="flex items-center justify-between">
                  <Label>Thinking Orb Effect</Label>
                  <span className="text-xs font-mono text-muted-foreground">
                    {orbStyle === "off" ? "Off" : orbStyle}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Select which animated orb to show during thinking & streaming, or disable it completely.
                </p>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 rounded-lg border border-border bg-muted/20 p-2">
                  {ORB_STYLES.map((style) => {
                    const isSelected = orbStyle === style.id;
                    return (
                      <button
                        key={style.id}
                        type="button"
                        onClick={() => setOrbStyle(style.id)}
                        className={cn(
                          "flex flex-col items-center justify-center rounded-md p-2 text-xs transition-all border",
                          isSelected
                            ? "bg-primary text-primary-foreground shadow-sm border-primary font-semibold"
                            : "border-transparent hover:bg-muted text-muted-foreground hover:text-foreground"
                        )}
                        title={style.description}
                      >
                        <div className="h-6 w-6 flex items-center justify-center mb-1">
                          {style.id === "off" ? (
                            <span className="text-xs font-bold opacity-75">✕</span>
                          ) : (
                            <ThinkingOrb
                              state={style.id}
                              size={20}
                              theme={isSelected ? (isDark ? "dark" : "light") : "auto"}
                            />
                          )}
                        </div>
                        <span className="truncate max-w-[4.2rem] text-[11px] leading-tight">
                          {style.label.split(" ")[0]}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Live Preview Card */}
                <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-muted/30 p-2.5">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-background border border-border">
                    {orbStyle === "off" ? (
                      <span className="text-xs font-bold text-muted-foreground">OFF</span>
                    ) : (
                      <ThinkingOrb state={orbStyle} size={20} theme={isDark ? "dark" : "light"} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <span>{ORB_STYLES.find((s) => s.id === orbStyle)?.label || "Solving"}</span>
                      {orbStyle === "off" ? (
                        <span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground font-normal">Disabled</span>
                      ) : (
                        <span className="text-[10px] rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 font-normal">Active</span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground line-clamp-1 mt-0.5">
                      {ORB_STYLES.find((s) => s.id === orbStyle)?.description || ""}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* ── 3. What it can see ────────────────────────────── */}
            <section className="space-y-3 border-t border-border pt-4">
              <div>
                <h3 className="text-sm font-medium">What it can see</h3>
                <p className="text-xs text-muted-foreground">
                  Scopes the agent to one project or deployment so it stops guessing which you mean.
                  Applies immediately.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Project</Label>
                  <div className="relative">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-between"
                      onClick={() => {
                        setProjectOpen((open) => !open);
                        setSettingsModelOpen(false);
                        setDeploymentOpen(false);
                        setComposerModelOpen(false);
                      }}
                    >
                      <span className="truncate">{selectedProject?.name || "Any project"}</span>
                      <AppIcon name="chevron-down" fallback={ChevronDown} className="h-4 w-4"  />
                    </Button>
                    {projectOpen && (
                      <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl ring-1 ring-foreground/10">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedProjectId("");
                            setProjectOpen(false);
                          }}
                          className="flex min-h-9 w-full items-center rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                        >
                          Any project
                          {!selectedProjectId && <AppIcon name="check" fallback={Check} className="ml-auto h-4 w-4"  />}
                        </button>
                        <div className="my-1 h-px bg-border" />
                        {projects.map((project) => (
                          <button
                            key={project.id}
                            type="button"
                            onClick={() => {
                              setSelectedProjectId(project.id);
                              setProjectOpen(false);
                            }}
                            className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                          >
                            <span className="min-w-0 truncate">{project.name}</span>
                            {project.id === selectedProjectId && <AppIcon name="check" fallback={Check} className="ml-auto h-4 w-4"  />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Deployment</Label>
                  <div className="relative">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-between"
                      onClick={() => {
                        setDeploymentOpen((open) => !open);
                        setSettingsModelOpen(false);
                        setProjectOpen(false);
                        setComposerModelOpen(false);
                      }}
                    >
                      <span className="truncate">
                        {selectedDeployment
                          ? `${selectedDeployment.project_name} · ${selectedDeployment.status}`
                          : "Any deployment"}
                      </span>
                      <AppIcon name="chevron-down" fallback={ChevronDown} className="h-4 w-4"  />
                    </Button>
                    {deploymentOpen && (
                      <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl ring-1 ring-foreground/10">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDeploymentId("");
                            setDeploymentOpen(false);
                          }}
                          className="flex min-h-9 w-full items-center rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                        >
                          Any deployment
                          {!selectedDeploymentId && <AppIcon name="check" fallback={Check} className="ml-auto h-4 w-4"  />}
                        </button>
                        <div className="my-1 h-px bg-border" />
                        {deployments.map((deployment) => (
                          <button
                            key={deployment.id}
                            type="button"
                            onClick={() => {
                              setSelectedDeploymentId(deployment.id);
                              setDeploymentOpen(false);
                            }}
                            className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                          >
                            <span className="min-w-0 truncate">
                              {deployment.project_name} · {deployment.status} · {shortId(deployment.id)}
                            </span>
                            {deployment.id === selectedDeploymentId && <AppIcon name="check" fallback={Check} className="ml-auto h-4 w-4"  />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>
            </div>

            {/* Right Column: Where it runs & Permissions */}
            <div className="space-y-6">
            <AiProviderConnections onActivated={async (connection) => {
              const refreshed = await settingsQuery.refetch();
              const engine = connection?.provider || refreshed.data?.provider || "nvidia_nim";
              setProvider(engine);
              setCompatibleBaseUrl(connection?.base_url || refreshed.data?.openai_compatible_base_url || "");
              setCustomModelList(null);
              const catalog = await modelsQuery.refetch();
              const models = catalog.data?.models || [];
              setCustomModelList(models);
              if (models.length && !models.some((model) => model.id === selectedModel)) {
                setSelectedModel(models[0].id);
                await api.put("/ai/settings", { provider: engine, model: models[0].id });
              }
            }} />

            <div className="space-y-2 rounded-lg border border-border p-3">
              <div>
                <Label>Agent Permissions</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  These permissions are persisted locally, sent with agent context, and used to gate natural-language deploy actions.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <Button
                  type="button"
                  variant={agentAccessMode === "ask" ? "default" : "outline"}
                  onClick={() => setAgentAccessMode("ask")}
                >
                  Ask first
                </Button>
                <Button
                  type="button"
                  variant={agentAccessMode === "auto_review" ? "default" : "outline"}
                  onClick={() => setAgentAccessMode("auto_review")}
                >
                  Auto review
                </Button>
                <Button
                  type="button"
                  variant={agentAccessMode === "full_access" ? "default" : "outline"}
                  onClick={() => setAgentAccessMode("full_access")}
                >
                  Full access
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  variant={remoteTerminalPermission === "ask" ? "default" : "outline"}
                  onClick={() => setRemoteTerminalPermission("ask")}
                >
                  Ask for remote terminal
                </Button>
                <Button
                  type="button"
                  variant={remoteTerminalPermission === "allow" ? "default" : "outline"}
                  onClick={() => setRemoteTerminalPermission("allow")}
                >
                  Allow remote terminal
                </Button>
              </div>

              <div className="space-y-1.5 pt-3 border-t border-border/50">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label className="text-xs font-semibold text-foreground">Interactive Questions by AI Agent</Label>
                  <Badge variant="outline" className={cn("shrink-0 text-[10px] font-mono", allowAgentQuestions ? "border-sky-500/40 text-sky-400" : "border-amber-500/40 text-amber-400")}>
                    {allowAgentQuestions ? "Interactive" : "Autonomous"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  When ambiguous choices are encountered (e.g. multiple railway stations or airport codes for a city like Mumbai), the AI will prompt you with interactive dropdowns directly in chat.
                </p>
                <div className="grid grid-cols-1 gap-2 pt-1 lg:grid-cols-2">
                  <Button
                    type="button"
                    variant={allowAgentQuestions ? "default" : "outline"}
                    className={cn(
                      "h-auto min-h-8 w-full min-w-0 justify-center px-3 py-2 text-center text-xs leading-tight whitespace-normal",
                      allowAgentQuestions && "bg-sky-600 font-medium text-white hover:bg-sky-700",
                    )}
                    onClick={() => setAllowAgentQuestions(true)}
                  >
                    Ask when needed (Recommended)
                  </Button>
                  <Button
                    type="button"
                    variant={!allowAgentQuestions ? "default" : "outline"}
                    className={cn(
                      "h-auto min-h-8 w-full min-w-0 justify-center px-3 py-2 text-center text-xs leading-tight whitespace-normal",
                      !allowAgentQuestions && "bg-amber-600 font-medium text-white hover:bg-amber-700",
                    )}
                    onClick={() => setAllowAgentQuestions(false)}
                  >
                    Autonomous (Never ask)
                  </Button>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                {agentAccessMode === "full_access"
                  ? "Full access lets natural-language deploy requests create deployments and queue builds."
                  : "Ask first and Auto review prepare the action plan, then require your explicit approval before real deploy work."}
              </p>
            </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Categorized Model Picker Dialog */}
      <ModelPickerModal
        open={modelPickerOpen}
        onOpenChange={setModelPickerOpen}
        selectedModelId={activeModelId}
        onSelectModel={(modelId: string, newMode?: "fast" | "thinking") => {
          setSelectedModel(modelId);
          // Background recovery reads ai_preferences, not this tab's local
          // storage. Keep the saved model in sync when using that provider.
          if (provider === settingsQuery.data?.provider) {
            api.put("/ai/settings", { model: modelId })
              .then(() => settingsQuery.refetch())
              .catch(() => toast.error("Model selected for this chat, but it could not be saved for background recovery."));
          }
          if (newMode) {
            setMode(newMode);
          }
          if (provider === "openai_compatible") {
            setCompatibleModel(modelId);
          }
          if (typeof window !== "undefined") {
            window.localStorage.setItem("ai-default-model", modelId);
          }
        }}
        availableModels={availableModels}
        onRefresh={fetchModelsWithCurrentKey}
        isRefreshing={isFetchingModels}
      />

      {/* Custom Target Website / URL Modal */}
      <Dialog
        open={showCustomUrlDialog}
        onOpenChange={setShowCustomUrlDialog}
      >
        <DialogContent className="sm:max-w-md [--dialog-padding:1.5rem]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Globe className="h-5 w-5 text-sky-400" />
              Test Any Website / Custom URL
            </DialogTitle>
            <DialogDescription className="text-xs">
              Enter any external website URL or local development port (e.g.{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-sky-400">https://github.com</code> or{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-sky-400">http://localhost:52249</code>) to test with the AI Agent and Live Browser.
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              let trimmed = customUrlInput.trim();
              if (trimmed) {
                if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
                  trimmed = `https://${trimmed}`;
                }
                changeTargetUrl(trimmed);
                setShowCustomUrlDialog(false);
              }
            }}
            className="space-y-4 pt-2"
          >
            <div className="space-y-2">
              <Label htmlFor="custom-url-input" className="text-xs font-semibold">
                Target URL
              </Label>
              <Input
                id="custom-url-input"
                type="text"
                placeholder="https://example.com or http://localhost:5173"
                value={customUrlInput}
                onChange={(e) => setCustomUrlInput(e.target.value)}
                className="font-mono text-xs"
                autoFocus
              />
            </div>

            <DialogFooter className="flex items-center justify-between sm:justify-between gap-2 pt-2">
              {customTargetUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    changeTargetUrl("");
                    setCustomUrlInput("");
                    setShowCustomUrlDialog(false);
                  }}
                  className="text-destructive hover:text-destructive text-xs"
                >
                  Clear Custom URL
                </Button>
              ) : (
                <div />
              )}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => setShowCustomUrlDialog(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!customUrlInput.trim()}
                  className="bg-sky-600 hover:bg-sky-700 text-white font-medium text-xs"
                >
                  Set Target URL
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
