import React, { useState } from 'react';
import {
  Globe,
  Cpu,
  Database,
  Layers,
  Play,
  Box,
  CheckCircle2,
  X,
  ArrowRight,
  Code2,
  Terminal,
  Activity,
  Zap
} from 'lucide-react';

interface SequenceStep {
  id: number;
  from: string;
  to: string;
  action: string;
  detail: string;
  type: 'request' | 'db' | 'queue' | 'response' | 'worker' | 'success' | 'failure';
  codeSnippet?: string;
  sourceFile?: string;
  latency?: string;
}

const PARTICIPANTS = [
  { id: 'dev', name: 'Developer / Webhook', role: 'Trigger Source', icon: Globe, port: 'Port 443' },
  { id: 'api', name: 'Drogon Controller', role: 'C++17 Non-blocking API', icon: Cpu, port: 'Port 8090' },
  { id: 'db', name: 'PostgreSQL 16', role: 'Transactional Store', icon: Database, port: 'Port 5432' },
  { id: 'redis', name: 'Redis 7 Queue', role: 'FIFO Task Buffer', icon: Layers, port: 'Port 6379' },
  { id: 'worker', name: 'JobQueueWorker', role: 'Thread Pool Worker', icon: Play, port: 'Internal Thread' },
  { id: 'build', name: 'Docker BuildService', role: 'BuildKit & Container', icon: Box, port: '/var/run/docker.sock' }
];

const STEPS: SequenceStep[] = [
  {
    id: 1,
    from: 'Developer / Webhook',
    to: 'Drogon Controller',
    action: 'POST /projects/{id}/deployments',
    detail: 'Client or GitHub webhook triggers a new build request with commit SHA, environment variables, and branch config.',
    type: 'request',
    codeSnippet: 'POST /api/v1/projects/550e8400-e29b-41d4-a716-446655440000/deployments\nAuthorization: Bearer <JWT_TOKEN>',
    sourceFile: 'src/controllers/DeploymentController.cpp',
    latency: '< 1.2ms'
  },
  {
    id: 2,
    from: 'Drogon Controller',
    to: 'PostgreSQL 16',
    action: 'INSERT deployment & deployment_job',
    detail: 'Transactional state persistence: deployment is recorded as "queued" and deployment_job as "pending" with attempt counter set to 0.',
    type: 'db',
    codeSnippet: 'INSERT INTO deployments (id, project_id, status) VALUES ($1, $2, \'queued\');\nINSERT INTO deployment_jobs (id, deployment_id, status) VALUES ($3, $1, \'pending\');',
    sourceFile: 'src/services/JobQueueService.cpp',
    latency: '0.8ms'
  },
  {
    id: 3,
    from: 'Drogon Controller',
    to: 'Redis 7 Queue',
    action: 'LPUSH stackpilot:jobs:deployment {job_id}',
    detail: 'Atomic push to the FIFO Redis queue buffer. Survives Drogon server reboots without dropping queued jobs.',
    type: 'queue',
    codeSnippet: 'LPUSH stackpilot:jobs:deployment "job_6f9c42a1-b8d9"',
    sourceFile: 'src/services/JobQueueService.cpp',
    latency: '0.3ms'
  },
  {
    id: 4,
    from: 'Drogon Controller',
    to: 'Developer / Webhook',
    action: '201 Created (deployment_id)',
    detail: 'Immediate non-blocking return with unique deployment ID. Client immediately opens WebSocket connection for live log streaming.',
    type: 'response',
    codeSnippet: 'HTTP/1.1 201 Created\nContent-Type: application/json\n\n{\n  "deployment_id": "dep_9b1e072f",\n  "status": "queued",\n  "ws_logs": "/ws/logs/dep_9b1e072f"\n}',
    sourceFile: 'src/controllers/DeploymentController.cpp',
    latency: '< 2ms total'
  },
  {
    id: 5,
    from: 'JobQueueWorker',
    to: 'Redis 7 Queue',
    action: 'BRPOP stackpilot:jobs:deployment (timeout=2s)',
    detail: 'Dedicated C++ worker thread executes blocking pop with 2-second timeout to minimize CPU spinning while ensuring immediate job pickup.',
    type: 'worker',
    codeSnippet: 'BRPOP stackpilot:jobs:deployment 2',
    sourceFile: 'src/services/JobQueueService.cpp',
    latency: 'Event-driven'
  },
  {
    id: 6,
    from: 'JobQueueWorker',
    to: 'PostgreSQL 16',
    action: 'UPDATE deployment_job SET status=\'running\', locked_at=NOW()',
    detail: 'Worker atomically claims ownership and registers a locking timestamp. Heartbeat loop keeps this lock refreshed every 10 seconds.',
    type: 'db',
    codeSnippet: 'UPDATE deployment_jobs\nSET status = \'running\', locked_at = NOW(), worker_id = \'worker-core-02\'\nWHERE id = $1 AND status = \'pending\';',
    sourceFile: 'src/services/JobQueueService.cpp',
    latency: '0.6ms'
  },
  {
    id: 7,
    from: 'JobQueueWorker',
    to: 'Docker BuildService',
    action: 'buildFromRepository(...) / buildFromArtifact(...)',
    detail: 'BuildService clones Git commit or unpacks staged tarball, parses Dockerfile / Compose, and invokes BuildKit engine with real-time log multiplexing.',
    type: 'worker',
    codeSnippet: 'BuildService::buildFromRepository(job.projectId, job.commitSha, logCallback);',
    sourceFile: 'src/services/BuildService.cpp',
    latency: 'Async Streaming'
  },
  {
    id: 8,
    from: 'Docker BuildService',
    to: 'JobQueueWorker',
    action: 'BuildResult (status, runtime_url, container_id)',
    detail: 'Build finishes and returns container metadata, assigned internal port, health check output, and exit status.',
    type: 'success',
    codeSnippet: 'struct BuildResult {\n  bool success = true;\n  std::string containerId = "c89b71a2e4";\n  std::string runtimeUrl = "http://app.internal:8080";\n};',
    sourceFile: 'src/services/BuildService.cpp',
    latency: 'Build duration'
  },
  {
    id: 9,
    from: 'JobQueueWorker',
    to: 'PostgreSQL 16',
    action: 'UPDATE deployment SET status=\'running\' / \'failed\'',
    detail: 'Durable state update. On success: status becomes "running" and runtime_url is saved. On failure: status is "failed", error is logged, and retry counter increments.',
    type: 'success',
    codeSnippet: '-- Success path:\nUPDATE deployments SET status = \'running\', runtime_url = $2 WHERE id = $1;\nUPDATE deployment_jobs SET status = \'completed\' WHERE id = $3;\n\n-- Failure path:\nUPDATE deployments SET status = \'failed\', error_log = $4 WHERE id = $1;\nUPDATE deployment_jobs SET status = \'failed\', attempts = attempts + 1 WHERE id = $3;',
    sourceFile: 'src/services/JobQueueService.cpp',
    latency: '0.9ms'
  }
];

export const JobQueueSequenceDiagram: React.FC = () => {
  const [selectedStep, setSelectedStep] = useState<SequenceStep | null>(STEPS[0]);
  const [filterMode, setFilterMode] = useState<'all' | 'success' | 'failure'>('all');

  const filteredSteps = STEPS.filter((step) => {
    if (filterMode === 'all') return true;
    if (filterMode === 'success') return step.type !== 'failure';
    if (filterMode === 'failure') return step.type === 'failure' || step.id <= 7 || step.id === 9;
    return true;
  });

  return (
    <div className="my-8 rounded-2xl border border-zinc-800/60 bg-[#121214]/95 p-5 sm:p-6 shadow-xl space-y-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-zinc-800 text-white">
              <Zap className="w-4 h-4 text-white" />
            </span>
            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
              Deployment Job Execution Sequence
            </h3>
          </div>
          <p className="text-xs text-zinc-400">
            Drogon non-blocking C++ controller, Redis FIFO queue buffer, and multi-threaded worker lifecycle.
          </p>
        </div>

        {/* Filter pills */}
        <div className="flex items-center gap-1.5 p-1 rounded-full bg-black/60 border border-zinc-800/60 text-[11px] font-mono self-start sm:self-auto">
          <button
            type="button"
            onClick={() => setFilterMode('all')}
            className={`px-3 py-1 rounded-full transition-all cursor-pointer border-0 ${
              filterMode === 'all'
                ? 'bg-zinc-700 text-white font-semibold'
                : 'text-zinc-400 hover:text-white bg-transparent'
            }`}
          >
            All Steps
          </button>
          <button
            type="button"
            onClick={() => setFilterMode('success')}
            className={`px-3 py-1 rounded-full transition-all cursor-pointer border-0 ${
              filterMode === 'success'
                ? 'bg-zinc-700 text-white font-semibold'
                : 'text-zinc-400 hover:text-white bg-transparent'
            }`}
          >
            Success Path
          </button>
          <button
            type="button"
            onClick={() => setFilterMode('failure')}
            className={`px-3 py-1 rounded-full transition-all cursor-pointer border-0 ${
              filterMode === 'failure'
                ? 'bg-zinc-700 text-white font-semibold'
                : 'text-zinc-400 hover:text-white bg-transparent'
            }`}
          >
            Failure / Retry
          </button>
        </div>
      </div>

      {/* Participant Nodes Lane */}
      <div className="space-y-2">
        <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
          Architecture Participants
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          {PARTICIPANTS.map((p) => {
            const Icon = p.icon;
            return (
              <div
                key={p.id}
                className="p-3 rounded-xl bg-[#18181c]/80 border-0 flex flex-col gap-1.5 transition-all hover:bg-[#202026] group"
              >
                <div className="flex items-center justify-between">
                  <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center">
                    <Icon className="w-3.5 h-3.5 text-white" />
                  </div>
                  <span className="text-[10px] font-mono text-zinc-400 group-hover:text-zinc-200">
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

      {/* Interactive Sequence Steps Timeline */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
            Execution Flow (Click any step to inspect code &amp; payload)
          </span>
          <span className="text-[10px] font-mono text-zinc-400">
            {filteredSteps.length} Steps
          </span>
        </div>

        <div className="space-y-2">
          {filteredSteps.map((step) => {
            const isSelected = selectedStep?.id === step.id;
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
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 truncate">
                      <span className="text-zinc-300 font-medium">{step.from}</span>
                      <ArrowRight className="w-3 h-3 text-white shrink-0 inline" />
                      <span className="text-zinc-300 font-medium">{step.to}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                  {step.latency && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-mono text-zinc-500">
                      <Zap className="w-3 h-3 text-zinc-400" />
                      {step.latency}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected Step Inspection Drawer */}
      {selectedStep && (
        <div className="p-4 sm:p-5 rounded-xl bg-[#0a0a0c] border-0 space-y-3">
          <div className="flex items-start justify-between gap-4 pb-2">
            <div className="flex items-center gap-2">
              <span className="p-1 rounded bg-zinc-800 text-white">
                <Code2 className="w-4 h-4 text-white" />
              </span>
              <div>
                <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                  <span>Step {selectedStep.id}: {selectedStep.action}</span>
                </h4>
                <div className="text-[11px] font-mono text-zinc-400">
                  Source: <span className="text-zinc-200">{selectedStep.sourceFile || 'C++ Drogon Engine'}</span>
                </div>
              </div>
            </div>
            {selectedStep.latency && (
              <span className="text-[11px] font-mono text-zinc-400 bg-[#18181c] px-2 py-1 rounded border-0">
                Latency: <span className="text-white font-bold">{selectedStep.latency}</span>
              </span>
            )}
          </div>

          <p className="text-xs text-zinc-300 leading-relaxed">
            {selectedStep.detail}
          </p>

          {selectedStep.codeSnippet && (
            <div className="rounded-lg bg-zinc-950/80 border-0 p-3 overflow-x-auto">
              <div className="text-[10px] font-mono uppercase text-zinc-500 mb-1.5">
                Payload / Execution Snippet
              </div>
              <pre className="font-mono text-xs text-zinc-200 leading-relaxed selection:bg-zinc-800">
                <code>{selectedStep.codeSnippet}</code>
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Outcome Cards (Alt Branching) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
        <div className="p-4 rounded-xl bg-[#18181c]/80 border-0 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400 font-mono">
            <CheckCircle2 className="w-4 h-4 text-white" />
            <span>ALT: BUILD SUCCESSFUL</span>
          </div>
          <p className="text-xs text-zinc-300 leading-relaxed">
            Container successfully built and spun up. Deployment status transitions to <code className="text-white bg-zinc-800 px-1 py-0.5 rounded">running</code>, public runtime URL is published, and Caddy dynamically routes live traffic.
          </p>
        </div>

        <div className="p-4 rounded-xl bg-[#18181c]/80 border-0 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-rose-400 font-mono">
            <X className="w-4 h-4 text-white" />
            <span>ALT: BUILD FAILED / RETRY</span>
          </div>
          <p className="text-xs text-zinc-300 leading-relaxed">
            Failure logged with exit code and stack trace. Attempt count is incremented. If <code className="text-white bg-zinc-800 px-1 py-0.5 rounded">attempts &lt; max</code>, the job re-enters Redis; otherwise the AI SRE agent is dispatched for auto-repair.
          </p>
        </div>
      </div>
    </div>
  );
};

export default JobQueueSequenceDiagram;
