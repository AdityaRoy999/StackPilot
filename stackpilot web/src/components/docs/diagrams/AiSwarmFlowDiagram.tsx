import React, { useState } from 'react';
import {
  Bot,
  Workflow,
  Code2,
  ShieldCheck,
  Wrench,
  Eye,
  Terminal,
  ArrowRight,
  RotateCcw,
  Sparkles,
  Layers,
  CheckCircle2,
  ShieldAlert,
  Play,
  Cpu,
  Monitor
} from 'lucide-react';

interface SwarmNode {
  id: string;
  name: string;
  role: string;
  category: 'input' | 'agent' | 'decision' | 'executor' | 'browser';
  icon: React.ComponentType<{ className?: string }>;
  promptDesc: string;
  tools: string[];
  output: string;
  badge: string;
}

const NODES: SwarmNode[] = [
  {
    id: 'user_req',
    name: 'User Prompt / Webhook Trigger',
    role: 'Event Ingestion',
    category: 'input',
    icon: Terminal,
    promptDesc: 'Failing build alert, runtime crash signal, or natural language user instructions (e.g., "Fix broken Next.js route in deployment").',
    tools: ['POST /api/v1/ai/chat', 'Webhook Trigger'],
    output: 'Structured task envelope with project_id and deployment_id',
    badge: 'INGEST'
  },
  {
    id: 'supervisor',
    name: 'SupervisorAgent',
    role: 'Router & Intent Classifier',
    category: 'agent',
    icon: Bot,
    promptDesc: 'Evaluates the user intent and project health. Formulates execution graph and routes to Architect for multi-step diagnosis.',
    tools: ['get_deployment_status', 'get_deployment_logs', 'list_deployments', 'get_session_context'],
    output: 'Execution Plan, routing decision, and priority score',
    badge: 'ROUTER'
  },
  {
    id: 'architect',
    name: 'ArchitectAgent',
    role: 'Blueprint & Strategy Designer',
    category: 'agent',
    icon: Workflow,
    promptDesc: 'Inspects project repository layout, AST dependencies, and configuration files to formulate a non-destructive remediation blueprint.',
    tools: ['workspace_list_files', 'workspace_read_file', 'web_search', 'web_fetch'],
    output: 'ArchitectBlueprint (files to modify, replacement strategy, dependency changes)',
    badge: 'STRATEGY'
  },
  {
    id: 'coder',
    name: 'CoderAgent',
    role: 'Surgical Code Remediation',
    category: 'agent',
    icon: Code2,
    promptDesc: 'Executes surgical find-and-replace edits or writes updated files inside the project workspace without destroying unrelated code.',
    tools: ['workspace_edit_file', 'workspace_write_file', 'terminal_run_command'],
    output: 'Unified diff and workspace file modifications',
    badge: 'PATCH'
  },
  {
    id: 'verifier',
    name: 'VerifierAgent',
    role: 'Syntax Check & Build Test',
    category: 'agent',
    icon: ShieldCheck,
    promptDesc: 'Reviews code patches against syntax standards, lint checks, and triggers preliminary test compilation.',
    tools: ['terminal_run_command', 'workspace_read_file', 'wait_for_deployment'],
    output: 'Verification result (Pass / Fail reasons)',
    badge: 'VERIFY'
  },
  {
    id: 'decision',
    name: 'Verification Decision Gateway',
    role: 'State Machine Branching',
    category: 'decision',
    icon: CheckCircle2,
    promptDesc: 'Determines whether the proposed changes passed all integrity checks. If broken syntax or regressions occur, loops back to Coder.',
    tools: ['LangGraph conditional edges'],
    output: 'Branch: Passed -> Executor | Failed -> Loop back to CoderAgent',
    badge: 'GATE'
  },
  {
    id: 'executor',
    name: 'Workspace Tools & Deployment',
    role: 'Build & Hot-Reload Execution',
    category: 'executor',
    icon: Wrench,
    promptDesc: 'Triggers local container rebuild from modified workspace, registers image, and executes zero-downtime rolling restart.',
    tools: ['workspace_trigger_rebuild', 'repair_deployment', 'scale_deployment'],
    output: 'Active container container_id and healthy HTTP endpoint',
    badge: 'DEPLOY'
  },
  {
    id: 'browser',
    name: 'Visual QA & Browser Validation',
    role: 'Autonomous Visual Testing',
    category: 'browser',
    icon: Eye,
    promptDesc: 'Navigates headless Chromium inside Xvfb sandbox, verifies UI elements, asserts console error absence, and streams 60 FPS video.',
    tools: ['browser_navigate', 'browser_click', 'browser_screenshot', 'browser_extract_state'],
    output: 'Visual assertion pass, screenshot artifacts, and replay buffer',
    badge: 'VISUAL QA'
  }
];

export const AiSwarmFlowDiagram: React.FC = () => {
  const [selectedNode, setSelectedNode] = useState<SwarmNode>(NODES[1]); // default to SupervisorAgent
  const [simulatedLoop, setSimulatedLoop] = useState(false);

  return (
    <div className="my-8 rounded-2xl border border-zinc-800/90 bg-[#18181b]/90 p-5 sm:p-6 shadow-xl space-y-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-zinc-800 text-white">
              <Bot className="w-4 h-4 text-white" />
            </span>
            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
              Multi-Agent Autonomous Swarm Architecture
            </h3>
          </div>
          <p className="text-xs text-zinc-400">
            LangGraph state machine routing, 27 reasoning tools, and self-healing verification loop.
          </p>
        </div>

        {/* Status badges */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300">
            <Sparkles className="w-3 h-3 text-white" />
            <span>LangGraph Swarm</span>
          </span>
          <button
            type="button"
            onClick={() => setSimulatedLoop(!simulatedLoop)}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-mono transition-all cursor-pointer border ${
              simulatedLoop
                ? 'bg-amber-950/70 border-amber-700 text-amber-200'
                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white'
            }`}
          >
            <RotateCcw className="w-3 h-3 text-white" />
            <span>{simulatedLoop ? 'Simulating Error Loop' : 'Simulate Failure Loop'}</span>
          </button>
        </div>
      </div>

      {/* Visual Flow Grid */}
      <div className="space-y-3">
        <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
          Agent State Machine Pipeline (Click node to inspect tools &amp; prompts)
        </div>

        {/* Step-by-Step Flow Nodes */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {NODES.slice(0, 4).map((node, idx) => {
            const Icon = node.icon;
            const isSelected = selectedNode.id === node.id;
            return (
              <div
                key={node.id}
                onClick={() => setSelectedNode(node)}
                className={`p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                  isSelected
                    ? 'bg-zinc-800/90 border-zinc-600 shadow-lg ring-1 ring-zinc-500/20'
                    : 'bg-zinc-900/70 border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center">
                    <Icon className="w-4 h-4 text-white" />
                  </div>
                  <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full bg-zinc-800/90 text-zinc-300 border border-zinc-700/60">
                    Step {idx + 1} &bull; {node.badge}
                  </span>
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white tracking-tight">{node.name}</h4>
                  <p className="text-[11px] text-zinc-400 mt-0.5">{node.role}</p>
                </div>
                <div className="flex items-center justify-between pt-1 text-[10px] font-mono text-zinc-400">
                  <span>{node.tools.length} Tools</span>
                  <ArrowRight className="w-3 h-3 text-white" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Verification and Execution row */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {NODES.slice(4, 8).map((node, idx) => {
            const Icon = node.icon;
            const isSelected = selectedNode.id === node.id;
            const isDecision = node.id === 'decision';
            return (
              <div
                key={node.id}
                onClick={() => setSelectedNode(node)}
                className={`p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                  isSelected
                    ? 'bg-zinc-800/90 border-zinc-600 shadow-lg ring-1 ring-zinc-500/20'
                    : isDecision && simulatedLoop
                    ? 'bg-amber-950/20 border-amber-800/60 hover:bg-amber-950/30'
                    : 'bg-zinc-900/70 border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center">
                    <Icon className="w-4 h-4 text-white" />
                  </div>
                  <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full bg-zinc-800/90 text-zinc-300 border border-zinc-700/60">
                    Step {idx + 5} &bull; {node.badge}
                  </span>
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white tracking-tight">{node.name}</h4>
                  <p className="text-[11px] text-zinc-400 mt-0.5">{node.role}</p>
                </div>
                <div className="flex items-center justify-between pt-1 text-[10px] font-mono text-zinc-400">
                  <span>{node.tools.length} Tools</span>
                  {node.id === 'decision' && simulatedLoop ? (
                    <span className="flex items-center gap-1 text-amber-300">
                      <RotateCcw className="w-3 h-3 text-white" />
                      <span>Looping</span>
                    </span>
                  ) : (
                    <ArrowRight className="w-3 h-3 text-white" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Decision Branching & Feedback Loop Indicator */}
      <div className="p-4 rounded-xl bg-black/60 border border-zinc-800/80 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-mono uppercase text-zinc-400 flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-white" />
            <span>Conditional Branching Decision Logic</span>
          </span>
          <span className="text-[10px] font-mono text-zinc-400">LangGraph State Graph</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Passed branch */}
          <div className="p-3.5 rounded-lg bg-emerald-950/30 border border-emerald-800/40 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-emerald-400 font-mono flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                <span>Branch: PASSED (Syntax OK &amp; Tests Green)</span>
              </span>
              <span className="text-[10px] font-mono text-emerald-300">&rarr; Step 7: Workspace Tools</span>
            </div>
            <p className="text-[11px] text-zinc-300 leading-relaxed">
              Triggers hot container reload and launches Chromium visual QA to confirm page renders without 5xx errors.
            </p>
          </div>

          {/* Failed branch */}
          <div
            className={`p-3.5 rounded-lg border space-y-1.5 transition-all ${
              simulatedLoop
                ? 'bg-amber-950/40 border-amber-600 ring-1 ring-amber-500/30'
                : 'bg-zinc-900/50 border-zinc-800'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-amber-300 font-mono flex items-center gap-1.5">
                <RotateCcw className="w-3.5 h-3.5 text-white" />
                <span>Branch: FAILED (Errors Detected)</span>
              </span>
              <span className="text-[10px] font-mono text-amber-300">&larr; Feedback Loop to Step 4</span>
            </div>
            <p className="text-[11px] text-zinc-300 leading-relaxed">
              Verifier injects error context into state. CoderAgent recalculates AST patch to resolve discrepancies. Max iterations: 3.
            </p>
          </div>
        </div>
      </div>

      {/* Selected Node Details Drawer */}
      <div className="p-4 sm:p-5 rounded-xl bg-black/80 border border-zinc-800 space-y-3">
        <div className="flex items-start justify-between gap-4 pb-2">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded bg-zinc-800 text-white">
              <selectedNode.icon className="w-4 h-4 text-white" />
            </span>
            <div>
              <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                <span>{selectedNode.name}</span>
                <span className="text-[10px] font-mono text-zinc-400 bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800">
                  {selectedNode.role}
                </span>
              </h4>
            </div>
          </div>
          <span className="text-[11px] font-mono text-zinc-400">
            Category: <span className="text-white font-semibold uppercase">{selectedNode.category}</span>
          </span>
        </div>

        <p className="text-xs text-zinc-300 leading-relaxed">
          {selectedNode.promptDesc}
        </p>

        {/* Tools and Output Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
          <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800/80 space-y-1.5">
            <div className="text-[10px] font-mono uppercase text-zinc-500">
              Attached Python Tools
            </div>
            <div className="flex flex-wrap gap-1.5">
              {selectedNode.tools.map((t, i) => (
                <code
                  key={i}
                  className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300"
                >
                  {t}
                </code>
              ))}
            </div>
          </div>

          <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800/80 space-y-1.5">
            <div className="text-[10px] font-mono uppercase text-zinc-500">
              Output Artifact
            </div>
            <p className="text-xs font-mono text-zinc-200">
              {selectedNode.output}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AiSwarmFlowDiagram;
