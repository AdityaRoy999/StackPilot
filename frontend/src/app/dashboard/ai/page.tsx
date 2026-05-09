"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AxiosError } from "axios";
import {
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardCopy,
  Clock,
  Loader2,
  Send,
  Settings,
  Star,
  Zap,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";

import api from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type AiMode = "fast" | "thinking";
type AiProvider = "nvidia_nim" | "openai_compatible";
type Role = "user" | "assistant" | "system";

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

interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  meta?: string;
}

const commands = [
  {
    name: "/diagnose",
    icon: Star,
    usage: "/diagnose <deployment-id>",
    description: "Analyze failed builds or runtime health using logs and deployment context.",
  },
  {
    name: "/build",
    icon: Star,
    usage: "/build <deployment-id>",
    description: "Queue a real deployment build in the platform worker.",
  },
  {
    name: "/deploy",
    icon: Star,
    usage: "/deploy <deployment-id> [port]",
    description: "Deploy an already built image to Kubernetes with safe defaults.",
  },
  {
    name: "/dockerfile",
    icon: Star,
    usage: "/dockerfile <project-id>",
    description: "Generate a Dockerfile plan for scripts, apps, and unknown project types.",
  },
  {
    name: "/analyze",
    icon: Star,
    usage: "/analyze <project-id>",
    description: "Classify a project and infer runtime, entrypoint, framework, and port.",
  },
] as const;

const starterMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "I can reason about deployments and run real platform actions. Try /diagnose with a failed deployment, /build to queue a build, /deploy to launch Kubernetes, or ask a normal question.",
    meta: "DOKSCP Agent",
  },
];

const defaultModels: AiModel[] = [
  { id: "meta/llama-3.1-8b-instruct", label: "meta/llama-3.1-8b-instruct", mode: "fast" },
  { id: "meta/llama-3.1-70b-instruct", label: "meta/llama-3.1-70b-instruct", mode: "thinking" },
];

function FilledStarIcon({ className }: { className?: string }) {
  return <Star className={className} fill="currentColor" strokeWidth={2.4} />;
}

function shortId(id?: string, size = 8) {
  if (!id) return "-";
  if (id.length <= size + 4) return id;
  return `${id.slice(0, size)}...${id.slice(-4)}`;
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
  const lines = [result.summary || result.error || "No summary returned."];
  const output = result.structured_output || {};
  const rootCause = output.root_cause || output.likely_root_cause || output.diagnosis;
  const steps = output.fix_steps || output.steps || output.recommendations || output.safe_remediations;
  const dockerfile = output.dockerfile;

  if (typeof rootCause === "string" && rootCause.trim()) {
    lines.push(`\n**Root cause:** ${rootCause}`);
  }
  if (Array.isArray(steps) && steps.length > 0) {
    lines.push("\n**Next steps:**");
    steps.slice(0, 6).forEach((step, index) => {
      lines.push(`${index + 1}. ${typeof step === "string" ? step : JSON.stringify(step)}`);
    });
  }
  if (typeof dockerfile === "string" && dockerfile.trim()) {
    lines.push(`\n**Generated Dockerfile:**\n\`\`\`dockerfile\n${dockerfile.trim()}\n\`\`\``);
  }
  if (result.warnings?.length) {
    lines.push("\n**Warnings:**");
    result.warnings.slice(0, 4).forEach((warning) => {
      lines.push(`- ${warning}`);
    });
  }
  return lines.join("\n");
}

function CodeBlock({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) {
  const [copied, setCopied] = useState(false);
  const isInline = !className;
  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "";
  const code = String(children).replace(/\n$/, "");

  if (isInline) {
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-foreground" {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="group relative my-2 rounded-lg border border-border bg-muted/50 overflow-hidden">
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
          {copied ? <Check className="h-3 w-3" /> : <ClipboardCopy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code className={className} {...props}>{children}</code>
      </pre>
    </div>
  );
}

const markdownComponents = {
  code: CodeBlock,
  p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="mb-2 last:mb-0" {...props}>{children}</p>
  ),
  ol: ({ children, ...props }: React.OlHTMLAttributes<HTMLOListElement>) => (
    <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0" {...props}>{children}</ol>
  ),
  ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0" {...props}>{children}</ul>
  ),
  li: ({ children, ...props }: React.LiHTMLAttributes<HTMLLIElement>) => (
    <li className="text-sm" {...props}>{children}</li>
  ),
  strong: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <strong className="font-semibold text-foreground" {...props}>{children}</strong>
  ),
  h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0" {...props}>{children}</h3>
  ),
  h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4 className="mb-1.5 mt-2.5 text-sm font-semibold first:mt-0" {...props}>{children}</h4>
  ),
  h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h5 className="mb-1 mt-2 text-sm font-medium first:mt-0" {...props}>{children}</h5>
  ),
  blockquote: ({ children, ...props }: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => (
    <blockquote className="border-l-2 border-primary/40 pl-3 italic text-muted-foreground" {...props}>{children}</blockquote>
  ),
  table: ({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm" {...props}>{children}</table>
    </div>
  ),
  th: ({ children, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th className="border-b border-border bg-muted/50 px-3 py-1.5 text-left text-xs font-medium" {...props}>{children}</th>
  ),
  td: ({ children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className="border-b border-border px-3 py-1.5" {...props}>{children}</td>
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

export default function AiAgentPage() {
  const [messages, setMessages] = useState<ChatMessage[]>(starterMessages);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<AiMode>("fast");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedDeploymentId, setSelectedDeploymentId] = useState("");
  const [showCommands, setShowCommands] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composerModelOpen, setComposerModelOpen] = useState(false);
  const [commandPickerOpen, setCommandPickerOpen] = useState(false);
  const [settingsModelOpen, setSettingsModelOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [deploymentOpen, setDeploymentOpen] = useState(false);
  const [provider, setProvider] = useState<AiProvider>("nvidia_nim");
  const [compatibleBaseUrl, setCompatibleBaseUrl] = useState("");
  const [compatibleApiKey, setCompatibleApiKey] = useState("");
  const [compatibleModel, setCompatibleModel] = useState("");
  const [agentAccessMode, setAgentAccessMode] = useState<"ask" | "auto_review" | "full_access">(() => {
    if (typeof window === "undefined") return "ask";
    const saved = window.localStorage.getItem("ai-agent-access-mode");
    return saved === "ask" || saved === "auto_review" || saved === "full_access" ? saved : "ask";
  });
  const [remoteTerminalPermission, setRemoteTerminalPermission] = useState<"ask" | "allow">(() => {
    if (typeof window === "undefined") return "ask";
    const saved = window.localStorage.getItem("ai-agent-remote-terminal");
    return saved === "ask" || saved === "allow" ? saved : "ask";
  });
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
      const res = await api.get("/ai/models");
      return res.data as AiModelsResponse;
    },
  });

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const res = await api.get<unknown>("/projects");
      return arrayFromResponse<Project>(res.data, ["projects", "data", "items"]);
    },
  });

  const deploymentsQuery = useQuery({
    queryKey: ["deployments"],
    queryFn: async () => {
      const res = await api.get<unknown>("/deployments");
      return arrayFromResponse<Deployment>(res.data, ["deployments", "data", "items"]);
    },
    refetchInterval: 8000,
  });

  const discoveredModels = arrayFromResponse<AiModel>(modelsQuery.data?.models, []);
  const providerFallbackModels: AiModel[] =
    provider === "openai_compatible"
      ? [
          {
            id: compatibleModel || selectedModel || "gpt-4o-mini",
            label: compatibleModel || selectedModel || "gpt-4o-mini",
            mode: "fast",
          },
          {
            id: compatibleModel || selectedModel || "gpt-4o",
            label: compatibleModel || selectedModel || "gpt-4o",
            mode: "thinking",
          },
        ]
      : defaultModels;
  const availableModels = discoveredModels.length > 0 ? discoveredModels : providerFallbackModels;
  const projects = arrayFromResponse<Project>(projectsQuery.data);
  const deployments = arrayFromResponse<Deployment>(deploymentsQuery.data);
  const fastModels = availableModels.filter((model) => modelMode(model) === "fast");
  const thinkingModels = availableModels.filter((model) => modelMode(model) === "thinking");
  const modeModels = mode === "thinking" ? thinkingModels : fastModels;
  const selectedModelIsAvailable = availableModels.some((model) => model.id === selectedModel);
  const activeModelId =
    (selectedModelIsAvailable ? selectedModel : "") ||
    modeModels[0]?.id ||
    availableModels[0]?.id ||
    modelsQuery.data?.selected_model ||
    "";
  const activeModel =
    availableModels.find((model) => model.id === activeModelId) ||
    (activeModelId ? { id: activeModelId, label: activeModelId, mode } : undefined);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectedDeployment = deployments.find((deployment) => deployment.id === selectedDeploymentId);
  const diagnoseDeploymentPickerOpen = /^\/diagnose\s*$/i.test(input.trimEnd());
  const diagnoseDeployments = deployments
    .slice()
    .sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed"));

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (settingsHydratedRef.current || !settingsQuery.data) return;
    settingsHydratedRef.current = true;
    const handle = window.setTimeout(() => {
      setProvider(settingsQuery.data?.provider || "nvidia_nim");
      setCompatibleBaseUrl(settingsQuery.data?.openai_compatible_base_url || "");
      setCompatibleModel(settingsQuery.data?.model || "");
      if (settingsQuery.data?.model) {
        setSelectedModel(settingsQuery.data.model);
      }
    }, 0);
    return () => window.clearTimeout(handle);
  }, [settingsQuery.data]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("ai-agent-access-mode", agentAccessMode);
    window.localStorage.setItem("ai-agent-remote-terminal", remoteTerminalPermission);
  }, [agentAccessMode, remoteTerminalPermission]);

  const chooseModel = (model: AiModel) => {
    setSelectedModel(model.id);
    setMode(modelMode(model));
    if (provider === "openai_compatible") {
      setCompatibleModel(model.id);
    }
  };

  const closePickers = () => {
    setComposerModelOpen(false);
    setCommandPickerOpen(false);
    setSettingsModelOpen(false);
    setProjectOpen(false);
    setDeploymentOpen(false);
  };

  const appendMessage = (message: Omit<ChatMessage, "id">) => {
    setMessages((current) => [
      ...current,
      {
        ...message,
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      },
    ]);
  };

  const runAgentMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await api.post(
        "/ai/chat",
        {
          message,
          command: message.startsWith("/") ? message.split(/\s+/)[0] : "",
          model: activeModelId,
          model_mode: mode,
          project_id: selectedProjectId,
          deployment_id: selectedDeploymentId,
          runtime: {
            permissions: {
              agent_access_mode: agentAccessMode,
              remote_terminal: remoteTerminalPermission,
              require_confirmation: agentAccessMode !== "full_access",
            },
          },
          history: messages.slice(-8).map((item) => ({ role: item.role, content: item.content })),
        },
        { timeout: 90000 }
      );
      return res.data as AiResponse;
    },
    onSuccess: (result) => {
      appendMessage({
        role: "assistant",
        content: formatAiOutput(result),
        meta: `${result.model || activeModelId} | ${Math.round((result.confidence || 0) * 100)}%`,
      });
    },
    onError: (error) => {
      appendMessage({ role: "assistant", content: errorMessage(error, "Agent chat failed."), meta: "Error" });
    },
  });

  const commandMutation = useMutation({
    mutationFn: async (raw: string) => {
      const [command, firstArg, secondArg] = raw.trim().split(/\s+/);
      const targetDeploymentId = firstArg || selectedDeploymentId;
      const targetProjectId = firstArg || selectedProjectId;

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
        const port = Number.parseInt(secondArg || "3000", 10) || 3000;
        const res = await api.post(`/deployments/${targetDeploymentId}/kubernetes/deploy`, {
          namespace: "dokscp-apps",
          exposure_mode: "ingress",
          replicas: 1,
          container_port: port,
          resource_preset: "small",
          health_path: "/",
        });
        return {
          title: "Deploy started",
          body: `Kubernetes deploy started for ${shortId(targetDeploymentId)} on port ${port}.\n${res.data.message || ""}`,
        };
      }

      if (command === "/diagnose") {
        if (!targetDeploymentId) throw new Error("Usage: /diagnose <deployment-id>");
        const deployment = deployments.find((item) => item.id === targetDeploymentId);
        const logs = await api.get(`/deployments/${targetDeploymentId}/logs`);
        const useRuntime = deployment?.image_name && deployment.status !== "failed";
        const res = useRuntime
          ? await api.post(`/deployments/${targetDeploymentId}/ai/analyze-runtime`, {
              model: activeModelId,
              model_mode: mode,
              runtime: {
                status: deployment.status,
                runtime_url: deployment.runtime_url,
              },
            })
          : await api.post(`/deployments/${targetDeploymentId}/ai/analyze-build-failure`, {
              model: activeModelId,
              model_mode: mode,
              logs: logs.data?.deployment?.logs || "",
            });
        return {
          title: "Diagnosis",
          body: formatAiOutput(res.data as AiResponse),
        };
      }

      if (command === "/dockerfile") {
        if (!targetProjectId) throw new Error("Usage: /dockerfile <project-id>");
        const res = await api.post(`/projects/${targetProjectId}/ai/dockerfile`, {
          model: activeModelId,
          model_mode: mode,
        });
        return {
          title: "Dockerfile plan",
          body: formatAiOutput(res.data as AiResponse),
        };
      }

      if (command === "/analyze") {
        if (!targetProjectId) throw new Error("Usage: /analyze <project-id>");
        const res = await api.post(`/projects/${targetProjectId}/ai/analyze`, {
          model: activeModelId,
          model_mode: mode,
        });
        return {
          title: "Project analysis",
          body: formatAiOutput(res.data as AiResponse),
        };
      }

      if (command === "/help") {
        return {
          title: "Commands",
          body: commands.map((item) => `${item.usage} - ${item.description}`).join("\n"),
        };
      }

      throw new Error(`Unknown command: ${command}`);
    },
    onSuccess: (result) => {
      appendMessage({ role: "assistant", content: result.body, meta: result.title });
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
    return /\bdeploy\b/.test(normalized) || /\bship\b/.test(normalized) || /\brun\b/.test(normalized);
  };

  const autonomousDeployMutation = useMutation({
    mutationFn: async (message: string) => {
      const project = findProjectForText(message);
      if (!project) {
        return {
          title: "Permission needed",
          body:
            "I can deploy for you, but I need a project context first. Select a project in Agent Settings or mention the exact project name.",
        };
      }

      if (agentAccessMode !== "full_access") {
        return {
          title: "Approval required",
          body:
            `I found project ${project.name}. To deploy autonomously I would create a deployment, inspect/build the source, generate a Dockerfile if needed, and queue the build.\n\n` +
            "Switch Agent Permissions to Full access, or use explicit commands like /build and /deploy when you want each action controlled step by step.",
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
        model: provider === "openai_compatible" ? compatibleModel || selectedModel : activeModelId,
        openai_compatible_base_url: compatibleBaseUrl.trim(),
      };
      if (compatibleApiKey.trim()) {
        payload.openai_compatible_api_key = compatibleApiKey.trim();
      }
      const res = await api.put("/ai/settings", payload);
      return res.data as { success?: boolean };
    },
    onSuccess: () => {
      setCompatibleApiKey("");
      settingsQuery.refetch();
      modelsQuery.refetch();
    },
  });

  const isRunning = runAgentMutation.isPending || commandMutation.isPending || autonomousDeployMutation.isPending;

  const submit = () => {
    const trimmed = input.trim();
    if (!trimmed || isRunning) return;
    appendMessage({ role: "user", content: trimmed, meta: mode === "thinking" ? "Thinking mode" : "Fast mode" });
    setInput("");
    setShowCommands(false);

    if (trimmed.startsWith("/")) {
      commandMutation.mutate(trimmed);
    } else if (isDeployIntent(trimmed)) {
      autonomousDeployMutation.mutate(trimmed);
    } else {
      runAgentMutation.mutate(trimmed);
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
    setInput(`/diagnose ${deployment.id}`);
    setShowCommands(false);
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
          {model.id === activeModelId && <Check className="h-4 w-4" />}
        </button>
      ))
    );

  const renderModelPicker = (onAfterSelect?: () => void) => (
    <div className="max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl ring-1 ring-foreground/10">
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Fast models</div>
      {renderModelButtons(fastModels, onAfterSelect)}
      <div className="my-1 h-px bg-border" />
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Thinking models</div>
      {renderModelButtons(thinkingModels, onAfterSelect)}
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
          <FilledStarIcon className="mt-0.5 h-4 w-4 text-primary" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{command.usage}</span>
            <span className="block text-xs text-muted-foreground">{command.description}</span>
          </span>
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="flex h-[calc(100dvh-8rem)] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground">
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FilledStarIcon className="h-5 w-5 text-primary" />
              <h1 className="font-semibold">Agent Playground</h1>
              <Badge variant="outline">{mode === "thinking" ? "thinking" : "fast"}</Badge>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {selectedDeployment
                ? `Deployment: ${selectedDeployment.project_name} | ${selectedDeployment.status}`
                : selectedProject
                  ? `Project: ${selectedProject.name}`
                  : "Use natural language or slash commands."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden max-w-52 truncate md:inline-flex">
              {shortId(activeModelId, 16)}
            </Badge>
            <Link href="/dashboard/ai/history">
              <Button type="button" variant="ghost" size="sm" className="hidden sm:inline-flex">
                <Clock className="h-4 w-4" />
                History
              </Button>
            </Link>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Agent settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto flex max-w-4xl flex-col gap-5">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn("flex gap-3", message.role === "user" ? "justify-end" : "justify-start")}
              >
                {message.role !== "user" && (
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background">
                    <Star className="h-4 w-4" />
                  </div>
                )}
                <div
                  className={cn(
                    "max-w-[min(44rem,85%)] rounded-xl px-4 py-3",
                    message.role === "user" ? "bg-primary text-primary-foreground" : "border border-border bg-background"
                  )}
                >
                  {message.meta && (
                    <div
                      className={cn(
                        "mb-2 text-xs font-medium",
                        message.role === "user" ? "text-primary-foreground/70" : "text-muted-foreground"
                      )}
                    >
                      {message.meta}
                    </div>
                  )}
                  {message.role === "user" ? (
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>
                  ) : (
                    <div className="prose-ai text-sm leading-relaxed">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isRunning && (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Agent is working...
              </div>
            )}
          </div>
        </div>

        <div className="sticky bottom-0 z-20 shrink-0 border-t border-border bg-card p-4">
          <div className="mx-auto max-w-4xl">
            {diagnoseDeploymentPickerOpen && (
              <div className="mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Deployments
                </div>
                {diagnoseDeployments.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-muted-foreground">No deployment found.</div>
                ) : (
                  diagnoseDeployments.map((deployment) => (
                    <button
                      key={deployment.id}
                      type="button"
                      className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted"
                      onClick={() => chooseDeploymentForCommand(deployment)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{deployment.project_name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {deployment.version || "unversioned"} | {deployment.status} | {shortId(deployment.id)}
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

            {showCommands && !diagnoseDeploymentPickerOpen && filteredCommands.length > 0 && (
              <div className="mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
                {filteredCommands.map((command) => (
                    <button
                      key={command.name}
                      type="button"
                      className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-muted"
                      onClick={() => {
                        setInput(`${command.usage} `);
                        setShowCommands(false);
                      }}
                    >
                      <FilledStarIcon className="mt-0.5 h-4 w-4 text-primary" />
                      <span>
                        <span className="block text-sm font-medium">{command.usage}</span>
                        <span className="text-xs text-muted-foreground">{command.description}</span>
                      </span>
                    </button>
                ))}
              </div>
            )}

            <div className="rounded-xl border border-border bg-background p-2">
              <textarea
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  setShowCommands(event.target.value.startsWith("/"));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder="Ask the agent, or type / for commands..."
                className="min-h-20 w-full resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground"
              />
              <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="relative">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="max-w-[18rem] justify-start"
                      onClick={() => {
                        setComposerModelOpen((open) => !open);
                        setSettingsModelOpen(false);
                        setProjectOpen(false);
                        setDeploymentOpen(false);
                      }}
                    >
                      {mode === "thinking" ? <BrainCircuit className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
                      <span className="truncate">
                        {mode === "thinking" ? "Think" : "Fast"} | {shortId(modelLabel(activeModel), 18)}
                      </span>
                      <ChevronDown className="ml-1 h-3.5 w-3.5" />
                    </Button>
                    {composerModelOpen && (
                      <div className="absolute bottom-full left-0 z-50 mb-2 w-80">
                        {renderModelPicker(closePickers)}
                      </div>
                    )}
                  </div>

                  <div className="relative">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setCommandPickerOpen((open) => !open);
                        setComposerModelOpen(false);
                        setSettingsModelOpen(false);
                        setProjectOpen(false);
                        setDeploymentOpen(false);
                      }}
                    >
                      <FilledStarIcon className="h-4 w-4" />
                      Commands
                      <ChevronDown className="ml-1 h-3.5 w-3.5" />
                    </Button>
                    {commandPickerOpen && (
                      <div className="absolute bottom-full left-0 z-50 mb-2 w-96 max-w-[calc(100vw-3rem)]">
                        {renderCommandPicker()}
                      </div>
                    )}
                  </div>
                </div>
                <Button type="button" onClick={submit} disabled={!input.trim() || isRunning}>
                  {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Send
                </Button>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Commands execute platform APIs. AI reasoning stays separate from irreversible actions.
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) closePickers();
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Agent Settings</DialogTitle>
            <DialogDescription>Configure provider keys, model, reasoning mode, project context, and deployment context.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Mode</Label>
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/30 p-1">
                  <Button
                    type="button"
                    variant={mode === "fast" ? "default" : "ghost"}
                    onClick={() => {
                      setMode("fast");
                      setSelectedModel(fastModels[0]?.id || "");
                    }}
                  >
                    <Zap className="h-4 w-4" />
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
                    <BrainCircuit className="h-4 w-4" />
                    Thinking
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Provider</Label>
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/30 p-1">
                  <Button
                    type="button"
                    variant={provider === "nvidia_nim" ? "default" : "ghost"}
                    onClick={() => setProvider("nvidia_nim")}
                  >
                    NVIDIA
                  </Button>
                  <Button
                    type="button"
                    variant={provider === "openai_compatible" ? "default" : "ghost"}
                    onClick={() => setProvider("openai_compatible")}
                  >
                    Compatible
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{modelsQuery.data?.provider || provider}</Badge>
                <Badge variant="outline">{modelsQuery.data?.source || "loading"}</Badge>
                <Badge variant={settingsQuery.data?.has_nvidia_key ? "default" : "outline"}>
                  NVIDIA {settingsQuery.data?.has_nvidia_key ? "key detected" : "env key missing"}
                </Badge>
                {provider === "openai_compatible" && (
                  <Badge variant={settingsQuery.data?.has_openai_compatible_key ? "default" : "outline"}>
                    Compatible {settingsQuery.data?.has_openai_compatible_key ? "key saved" : "key not saved"}
                  </Badge>
                )}
              </div>

              {provider === "openai_compatible" && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2">
                    <Label>OpenAI-compatible base URL</Label>
                    <Input
                      value={compatibleBaseUrl}
                      onChange={(event) => setCompatibleBaseUrl(event.target.value)}
                      placeholder="https://api.openai.com/v1 or provider /v1 endpoint"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Model ID</Label>
                    <Input
                      value={compatibleModel}
                      onChange={(event) => {
                        setCompatibleModel(event.target.value);
                        setSelectedModel(event.target.value);
                      }}
                      placeholder="gpt-4o-mini, claude..., gemini..."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>API key</Label>
                    <Input
                      type="password"
                      value={compatibleApiKey}
                      onChange={(event) => setCompatibleApiKey(event.target.value)}
                      placeholder={
                        settingsQuery.data?.has_openai_compatible_key
                          ? "Leave blank to keep saved key"
                          : "Paste API key"
                      }
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={() => saveSettingsMutation.mutate()}
                  disabled={saveSettingsMutation.isPending}
                >
                  {saveSettingsMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Save AI settings
                </Button>
              </div>
              {saveSettingsMutation.isError && (
                <p className="text-xs text-destructive">
                  {errorMessage(saveSettingsMutation.error, "Failed to save AI settings.")}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Model</Label>
              <div className="relative">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-between"
                  onClick={() => {
                    setSettingsModelOpen((open) => !open);
                    setProjectOpen(false);
                    setDeploymentOpen(false);
                    setComposerModelOpen(false);
                  }}
                >
                  <span className="truncate">{modelLabel(activeModel)}</span>
                  <ChevronDown className="h-4 w-4" />
                </Button>
                {settingsModelOpen && (
                  <div className="absolute left-0 right-0 top-full z-50 mt-2">
                    {renderModelPicker(closePickers)}
                  </div>
                )}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Project Context</Label>
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
                    <span className="truncate">{selectedProject?.name || "No project selected"}</span>
                    <ChevronDown className="h-4 w-4" />
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
                        No project selected
                        {!selectedProjectId && <Check className="ml-auto h-4 w-4" />}
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
                          {project.id === selectedProjectId && <Check className="ml-auto h-4 w-4" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Deployment Context</Label>
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
                        ? `${selectedDeployment.project_name} | ${selectedDeployment.status}`
                        : "No deployment selected"}
                    </span>
                    <ChevronDown className="h-4 w-4" />
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
                        No deployment selected
                        {!selectedDeploymentId && <Check className="ml-auto h-4 w-4" />}
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
                            {deployment.project_name} | {deployment.status} | {shortId(deployment.id)}
                          </span>
                          {deployment.id === selectedDeploymentId && <Check className="ml-auto h-4 w-4" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
              Fast mode is for low-latency chat and simple commands. Thinking mode is for diagnosis, Dockerfile planning, and safer deployment reasoning.
            </div>

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
              <p className="text-xs text-muted-foreground">
                {agentAccessMode === "full_access"
                  ? "Full access lets natural-language deploy requests create deployments and queue builds."
                  : "Ask first and Auto review prepare the action plan, then require your explicit approval before real deploy work."}
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
