import React, { useState } from 'react';
import {
  GitBranch,
  Globe,
  Cpu,
  Layers,
  Box,
  ShieldCheck,
  CheckCircle2,
  ArrowRight,
  Code2,
  Lock,
  Zap,
  Activity,
  Sliders
} from 'lucide-react';

interface CiStep {
  id: number;
  from: string;
  to: string;
  action: string;
  detail: string;
  branch: 'both' | 'gated' | 'direct';
  codeSnippet?: string;
  latency: string;
}

const PARTICIPANTS = [
  { id: 'dev', name: 'Developer', role: 'Source Author', icon: Globe, port: 'Git CLI' },
  { id: 'gh', name: 'GitHub Platform', role: 'Git Remote & Actions', icon: GitBranch, port: 'api.github.com' },
  { id: 'sp', name: 'StackPilot WebhookController', role: 'C++ HMAC & Gating', icon: Cpu, port: 'Port 8090' },
  { id: 'redis', name: 'Redis 7 Queue', role: 'FIFO Task Buffer', icon: Layers, port: 'Port 6379' },
  { id: 'worker', name: 'Deployment Worker', role: 'BuildKit & Rolling Deploy', icon: Box, port: 'Worker Thread' }
];

const STEPS: CiStep[] = [
  {
    id: 1,
    from: 'Developer',
    to: 'GitHub Platform',
    action: 'git push origin dev',
    detail: 'Developer commits code changes and pushes branch to GitHub remote repository.',
    branch: 'both',
    codeSnippet: 'git add .\ngit commit -m "feat(api): optimize connection pool"\ngit push origin dev',
    latency: 'Client network'
  },
  {
    id: 2,
    from: 'GitHub Platform',
    to: 'StackPilot WebhookController',
    action: 'POST /api/v1/github/webhooks',
    detail: 'GitHub Webhook delivery payload containing push event, commit SHA, head ref, and X-Hub-Signature-256 header.',
    branch: 'both',
    codeSnippet: 'POST /api/v1/github/webhooks HTTP/1.1\nX-Hub-Signature-256: sha256=a87f2e1...\nX-GitHub-Event: push\nContent-Type: application/json',
    latency: '< 150ms'
  },
  {
    id: 3,
    from: 'StackPilot WebhookController',
    to: 'StackPilot WebhookController',
    action: 'Verify HMAC-SHA256(secret, payload)',
    detail: 'Constant-time verification of HMAC signature against configured webhook secret using OpenSSL EVP to prevent timing attacks.',
    branch: 'both',
    codeSnippet: 'bool isValid = Crypto::verifyHmacSha256(rawBody, secret, signatureHeader);',
    latency: '0.4ms'
  },
  {
    id: 4,
    from: 'StackPilot WebhookController',
    to: 'StackPilot WebhookController',
    action: 'Match repo & branch (\'dev\') to Environment',
    detail: 'Queries PostgreSQL to resolve project environment (e.g. Preview vs Production) linked to branch "dev" and checks require_ci setting.',
    branch: 'both',
    codeSnippet: 'SELECT id, require_ci FROM project_environments WHERE project_id = $1 AND git_branch = \'dev\';',
    latency: '0.8ms'
  },
  {
    id: 5,
    from: 'StackPilot WebhookController',
    to: 'StackPilot WebhookController',
    action: 'CI Gated: Create deployment (status=\'blocked_ci\')',
    detail: 'When require_ci is true, StackPilot records the deployment in pending state, awaiting GitHub Actions check_run success webhook.',
    branch: 'gated',
    codeSnippet: 'INSERT INTO deployments (id, status, commit_sha) VALUES ($1, \'blocked_ci\', $2);',
    latency: '0.7ms'
  },
  {
    id: 6,
    from: 'GitHub Platform',
    to: 'StackPilot WebhookController',
    action: 'check_run (status=\'completed\', conclusion=\'success\')',
    detail: 'GitHub Actions finishes test suite and emits check_run webhook. StackPilot unlocks the deployment for build execution.',
    branch: 'gated',
    codeSnippet: '{\n  "action": "completed",\n  "check_run": {\n    "head_sha": "d8e3b1c",\n    "conclusion": "success"\n  }\n}',
    latency: 'CI Pipeline Duration'
  },
  {
    id: 7,
    from: 'StackPilot WebhookController',
    to: 'Redis 7 Queue',
    action: 'LPUSH stackpilot:jobs:deployment {job_id}',
    detail: 'Pushes the validated deployment job onto the Redis queue buffer for worker pickup.',
    branch: 'both',
    codeSnippet: 'LPUSH stackpilot:jobs:deployment "job_ci_99af24"',
    latency: '0.3ms'
  },
  {
    id: 8,
    from: 'Deployment Worker',
    to: 'Deployment Worker',
    action: 'Build exact commit SHA & promote runtime',
    detail: 'Worker clones the exact SHA, builds Docker container, executes health check, and promotes to live Caddy router.',
    branch: 'both',
    codeSnippet: 'docker build --build-arg COMMIT_SHA=d8e3b1c -t stackpilot/app:d8e3b1c .\n# Zero-downtime container swap',
    latency: 'Build duration'
  }
];

export const GithubCiSequenceDiagram: React.FC = () => {
  const [ciGatedMode, setCiGatedMode] = useState<boolean>(true);
  const [selectedStep, setSelectedStep] = useState<CiStep>(STEPS[2]); // default to HMAC verification

  const activeSteps = STEPS.filter((s) => {
    if (s.branch === 'both') return true;
    if (ciGatedMode) return s.branch === 'gated';
    return s.branch === 'direct';
  });

  return (
    <div className="my-8 rounded-2xl border border-zinc-800/60 bg-[#121214]/95 p-5 sm:p-6 shadow-xl space-y-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-zinc-800 text-white">
              <GitBranch className="w-4 h-4 text-white" />
            </span>
            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
              GitHub App Webhook &amp; CI/CD Gating Pipeline
            </h3>
          </div>
          <p className="text-xs text-zinc-400">
            HMAC-SHA256 signature verification, branch environment routing, and automated GitHub Actions gating.
          </p>
        </div>

        {/* CI Mode Switcher */}
        <div className="flex items-center gap-2 p-1 rounded-full bg-black/60 border border-zinc-800/60 text-[11px] font-mono">
          <button
            type="button"
            onClick={() => setCiGatedMode(true)}
            className={`px-3 py-1 rounded-full transition-all cursor-pointer border-0 ${
              ciGatedMode
                ? 'bg-zinc-700 text-white font-semibold'
                : 'text-zinc-400 hover:text-white bg-transparent'
            }`}
          >
            CI Gating (require_ci=true)
          </button>
          <button
            type="button"
            onClick={() => setCiGatedMode(false)}
            className={`px-3 py-1 rounded-full transition-all cursor-pointer border-0 ${
              !ciGatedMode
                ? 'bg-zinc-700 text-white font-semibold'
                : 'text-zinc-400 hover:text-white bg-transparent'
            }`}
          >
            Direct Push (require_ci=false)
          </button>
        </div>
      </div>

      {/* Participants Lane */}
      <div className="space-y-2">
        <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
          Architecture Participants
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
          {PARTICIPANTS.map((p) => {
            const Icon = p.icon;
            return (
              <div
                key={p.id}
                className="p-3 rounded-xl bg-[#18181c]/80 border-0 flex flex-col gap-1.5 transition-all hover:bg-[#202026]"
              >
                <div className="flex items-center justify-between">
                  <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center">
                    <Icon className="w-3.5 h-3.5 text-white" />
                  </div>
                  <span className="text-[10px] font-mono text-zinc-400">
                    {p.port}
                  </span>
                </div>
                <div>
                  <div className="text-xs font-semibold text-white truncate">{p.name}</div>
                  <div className="text-[10px] text-zinc-400 truncate">{p.role}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Sequence Timeline */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
            Pipeline Progression ({ciGatedMode ? 'Gated by CI Check' : 'Instant Auto-Deploy'})
          </span>
          <span className="text-[10px] font-mono text-zinc-400">
            {activeSteps.length} Steps
          </span>
        </div>

        <div className="space-y-2">
          {activeSteps.map((step) => {
            const isSelected = selectedStep.id === step.id;
            return (
              <div
                key={step.id}
                onClick={() => setSelectedStep(step)}
                className={`p-3.5 rounded-xl border-0 transition-all cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                  isSelected
                    ? 'bg-[#222228] text-white shadow-md'
                    : 'bg-[#18181c]/60 hover:bg-[#202026]/80'
                }`}
              >
                <div className="flex items-start sm:items-center gap-3">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-mono font-bold shrink-0 ${
                      isSelected ? 'bg-white text-black' : 'bg-zinc-800 text-white'
                    }`}
                  >
                    {step.id}
                  </div>

                  <div className="space-y-0.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-white font-mono">
                        {step.action}
                      </span>
                      {step.branch === 'gated' && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300">
                          CI Gated
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                      <span className="text-zinc-300 font-medium">{step.from}</span>
                      <ArrowRight className="w-3 h-3 text-white shrink-0 inline" />
                      <span className="text-zinc-300 font-medium">{step.to}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono text-zinc-500">
                    <Zap className="w-3 h-3 text-zinc-400" />
                    {step.latency}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected Step Drawer */}
      <div className="p-4 sm:p-5 rounded-xl bg-[#0a0a0c] border-0 space-y-3">
        <div className="flex items-start justify-between gap-4 pb-2">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded bg-zinc-800 text-white">
              <Code2 className="w-4 h-4 text-white" />
            </span>
            <div>
              <h4 className="text-sm font-semibold text-white">
                Step {selectedStep.id}: {selectedStep.action}
              </h4>
              <p className="text-[11px] font-mono text-zinc-400">
                {selectedStep.from} &rarr; {selectedStep.to}
              </p>
            </div>
          </div>
          <span className="text-[11px] font-mono text-zinc-400 bg-zinc-900 px-2 py-1 rounded border-0">
            Latency: <span className="text-white font-bold">{selectedStep.latency}</span>
          </span>
        </div>

        <p className="text-xs text-zinc-300 leading-relaxed">
          {selectedStep.detail}
        </p>

        {selectedStep.codeSnippet && (
          <div className="rounded-lg bg-zinc-950/80 border-0 p-3 overflow-x-auto">
            <div className="text-[10px] font-mono uppercase text-zinc-500 mb-1.5">
              Code / Webhook Snippet
            </div>
            <pre className="font-mono text-xs text-zinc-200 leading-relaxed selection:bg-zinc-800">
              <code>{selectedStep.codeSnippet}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};

export default GithubCiSequenceDiagram;
