import React, { useState } from 'react';
import {
  Globe,
  Cpu,
  Layers,
  Bot,
  Video,
  Server,
  Activity,
  ArrowRight,
  Database,
  Lock,
  Box,
  Terminal,
  Search,
  BarChart3,
  Radio,
  Zap,
  CheckCircle2,
  Sparkles
} from 'lucide-react';

interface SubsystemCluster {
  id: string;
  name: string;
  badge: string;
  color: string;
  description: string;
  services: {
    id: string;
    name: string;
    port: string;
    tech: string;
    ram: string;
    description: string;
  }[];
}

const CLUSTERS: SubsystemCluster[] = [
  {
    id: 'clients',
    name: 'Clients & Ingress',
    badge: 'EDGE PERIMETER',
    color: 'zinc',
    description: 'Entry points, developer interfaces, MCP tooling, and automated TLS termination.',
    services: [
      { id: 'caddy', name: 'Caddy 2.8 Reverse Proxy', port: '80 / 443', tech: 'Auto TLS / ACME', ram: '~28 MB', description: 'Terminates HTTPS, auto-renews Let\'s Encrypt certificates, reverse-proxies REST & WebSockets.' },
      { id: 'ui', name: 'Next.js 16 Web Dashboard', port: '3000', tech: 'React 19, Tailwind, Canvas', ram: '~45 MB', description: 'Real-time dashboard, terminal multiplexer, visual canvas, and deployment controls.' },
      { id: 'mcp', name: 'IDE Agents via MCP', port: 'Stdio / SSE', tech: 'Model Context Protocol', ram: 'Embedded', description: 'Connects Claude Code, Cursor, and Windsurf directly to StackPilot tools.' },
      { id: 'gh', name: 'GitHub Webhook Gateway', port: '443 / Hook', tech: 'HMAC-SHA256 Gating', ram: 'Stateless', description: 'Ingests push events and check_run completions for automatic deployments.' }
    ]
  },
  {
    id: 'control',
    name: 'Control Plane & Orchestration',
    badge: 'CORE ENGINE',
    color: 'zinc',
    description: 'Ultra-low-latency compiled C++17 core running high-concurrency event loops.',
    services: [
      { id: 'drogon', name: 'C++ Drogon Engine', port: '8090', tech: 'C++17 Non-blocking epoll', ram: '< 30 MB', description: 'Compiled microsecond REST API, WebSocket dispatcher, and PTY terminal multiplexer.' },
      { id: 'workers', name: 'Drogon Worker Pool', port: 'Threads', tech: 'std::thread (2-4 cores)', ram: '~12 MB', description: 'Asynchronous task workers polling Redis for build and deployment execution.' },
      { id: 'postgres', name: 'PostgreSQL 16 + pgvector', port: '5432', tech: 'libpqxx + IVFFlat index', ram: '~65 MB', description: 'System of record with 56 migrations, RBAC, and semantic vector memory.' },
      { id: 'redis', name: 'Redis 7 FIFO Queue', port: '6379', tech: 'AOF Persistence', ram: '~15 MB', description: 'Durable deployment queue buffer (stackpilot:jobs:deployment) preventing task loss.' }
    ]
  },
  {
    id: 'ai',
    name: 'AI & Visual Operations Engine',
    badge: 'AUTONOMOUS SRE',
    color: 'zinc',
    description: 'LangGraph swarm orchestrating autonomous diagnostics and AST code repair.',
    services: [
      { id: 'fastapi', name: 'FastAPI AI Service', port: '8010', tech: 'Python 3.11, Uvicorn', ram: '~140 MB', description: 'Houses the 27 tool schemas and LangGraph state machines for autonomous healing.' },
      { id: 'swarm', name: 'Multi-Agent Swarm', port: 'Internal', tech: 'Supervisor/Coder/Verifier', ram: 'Shared', description: 'Hierarchical team diagnosing build errors and applying surgical patches.' },
      { id: 'searxng', name: 'SearXNG Private Search', port: '8088', tech: 'Metasearch Engine', ram: '~70 MB', description: 'Local private web search engine for error solutions without tracking.' },
      { id: 'llm', name: 'NVIDIA NIM / LLM API', port: 'HTTPS', tech: 'Llama 3.1 / DeepSeek', ram: 'Cloud/Local', description: 'Accelerated enterprise inference backends for reasoning and vision.' }
    ]
  },
  {
    id: 'sandbox',
    name: 'Visual Browser Sandbox',
    badge: 'REAL-TIME QA',
    color: 'zinc',
    description: 'Rootless Chromium container with 60 FPS low-latency video streaming.',
    services: [
      { id: 'chromium', name: 'Alpine Chromium', port: '9223', tech: 'CDP Protocol', ram: '~180 MB', description: 'Sandboxed browser instance for autonomous page inspection and element clicking.' },
      { id: 'xvfb', name: 'Xvfb Virtual Display', port: ':99', tech: 'Virtual X11 Server', ram: '~35 MB', description: '1280x720 24-bit virtual screen buffer capturing browser rendering.' },
      { id: 'streamer', name: 'H.264 TCP Streamer', port: '8099', tech: 'FFmpeg x11grab + WebCodecs', ram: '~40 MB', description: 'Encodes screen frames to Annex-B H.264 NALUs and streams directly to canvas.' }
    ]
  },
  {
    id: 'compute',
    name: 'Target Compute Runtimes',
    badge: 'HYBRID FABRIC',
    color: 'zinc',
    description: 'Flexible execution targets supporting single Docker hosts to Kubernetes clusters.',
    services: [
      { id: 'docker', name: 'Local Docker Engine', port: 'sock', tech: '/var/run/docker.sock', ram: 'Host Daemon', description: 'Direct container execution via native BuildKit and rootless compose profiles.' },
      { id: 'ssh', name: 'Remote VPS via SSH', port: '22', tech: 'libssh2 / Tailscale Mesh', ram: 'External', description: 'Deploys to remote servers over encrypted tunnels without agent daemons.' },
      { id: 'k8s', name: 'Kubernetes / k3s', port: '6443', tech: 'ComposeKubernetesPlanner', ram: 'External', description: 'Automated 1-click k3s cluster provisioning with PVCs, Services, and Ingress.' }
    ]
  },
  {
    id: 'observability',
    name: 'Observability Stack',
    badge: 'METRICS & LOGS',
    color: 'zinc',
    description: 'Unified time-series metrics, cgroup v2 container telemetry, and log stores.',
    services: [
      { id: 'prom', name: 'Prometheus TSDB', port: '9090', tech: '15s Scrape Interval', ram: '~95 MB', description: 'Gathers Drogon throughput, system memory, and container stats.' },
      { id: 'cadvisor', name: 'cAdvisor Engine', port: '8081', tech: 'cgroup v2 Exporter', ram: '~45 MB', description: 'Inspects CPU throttling, working set memory, and container network I/O.' },
      { id: 'loki', name: 'Grafana Loki Store', port: '3100', tech: 'LogQL Ingestion', ram: '~80 MB', description: 'Label-indexed structured log store aggregating stdout/stderr from containers.' },
      { id: 'grafana', name: 'Grafana Dashboards', port: '3001', tech: 'Pre-baked Dashboards', ram: '~60 MB', description: 'Unified visualization panels for host telemetry and deployment audit.' }
    ]
  }
];

export const OverviewArchitectureDiagram: React.FC = () => {
  const [selectedCluster, setSelectedCluster] = useState<string>('all');
  const [inspectService, setInspectService] = useState(CLUSTERS[1].services[0]); // default to Drogon

  const visibleClusters = selectedCluster === 'all'
    ? CLUSTERS
    : CLUSTERS.filter((c) => c.id === selectedCluster);

  return (
    <div className="my-8 rounded-2xl border border-zinc-800/90 bg-[#18181b]/90 p-5 sm:p-6 shadow-xl space-y-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-zinc-800 text-white">
              <Layers className="w-4 h-4 text-white" />
            </span>
            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
              StackPilot High-Level System Architecture
            </h3>
          </div>
          <p className="text-xs text-zinc-400">
            Multi-engine control plane connecting compiled C++ core, AI multi-agent swarm, visual sandbox, and hybrid compute runtimes.
          </p>
        </div>

        {/* Status badges */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300">
            <Cpu className="w-3 h-3 text-white" />
            <span>&lt; 30MB C++ Core</span>
          </span>
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300">
            <Sparkles className="w-3 h-3 text-white" />
            <span>Multi-Agent Swarm</span>
          </span>
        </div>
      </div>

      {/* Domain Navigation Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl bg-black/60 border border-zinc-800 text-xs font-mono">
        <button
          type="button"
          onClick={() => setSelectedCluster('all')}
          className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer border-0 ${
            selectedCluster === 'all'
              ? 'bg-zinc-700 text-white font-semibold'
              : 'text-zinc-400 hover:text-white bg-transparent'
          }`}
        >
          All 6 Subsystems
        </button>
        {CLUSTERS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setSelectedCluster(c.id)}
            className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer border-0 ${
              selectedCluster === c.id
                ? 'bg-zinc-700 text-white font-semibold'
                : 'text-zinc-400 hover:text-white bg-transparent'
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>

      {/* 6 Subsystem Bento Clusters Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {visibleClusters.map((cluster) => (
          <div
            key={cluster.id}
            className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800/80 space-y-3 flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between pb-1">
                <h4 className="text-xs font-bold text-white tracking-tight">
                  {cluster.name}
                </h4>
                <span className="text-[9px] font-mono uppercase px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700/60">
                  {cluster.badge}
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 mt-1.5 mb-3 leading-relaxed">
                {cluster.description}
              </p>

              {/* Service Rows - Clean flat rows without nested border cards */}
              <div className="space-y-1">
                {cluster.services.map((svc) => {
                  const isSelected = inspectService?.id === svc.id;
                  return (
                    <div
                      key={svc.id}
                      onClick={() => setInspectService(svc)}
                      className={`px-3 py-2 rounded-lg transition-all cursor-pointer flex items-center justify-between gap-2 ${
                        isSelected
                          ? 'bg-zinc-800 text-white shadow-sm ring-1 ring-zinc-600/50'
                          : 'hover:bg-zinc-800/50 text-zinc-300'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className={`text-xs font-semibold truncate ${isSelected ? 'text-white' : 'text-zinc-200'}`}>
                          {svc.name}
                        </div>
                        <div className="text-[10px] font-mono text-zinc-400 truncate">
                          {svc.tech}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                          isSelected ? 'bg-zinc-700 text-white' : 'bg-zinc-800/80 text-zinc-400'
                        }`}>
                          {svc.port}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="pt-2 flex items-center justify-between text-[10px] font-mono text-zinc-500 border-t border-zinc-800/40 mt-2">
              <span>{cluster.services.length} Microservices</span>
              <span>Click to inspect &rarr;</span>
            </div>
          </div>
        ))}
      </div>

      {/* Selected Microservice Inspection Drawer */}
      {inspectService && (
        <div className="p-4 sm:p-5 rounded-xl bg-black/70 border border-zinc-800 space-y-3">
          <div className="flex items-start justify-between gap-4 pb-2 border-b border-zinc-800/60">
            <div className="flex items-center gap-2">
              <span className="p-1 rounded bg-zinc-800 text-white">
                <Server className="w-4 h-4 text-white" />
              </span>
              <div>
                <h4 className="text-sm font-semibold text-white">
                  {inspectService.name}
                </h4>
                <p className="text-[11px] font-mono text-zinc-400">
                  Technology: <span className="text-white">{inspectService.tech}</span>
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-zinc-400 bg-zinc-900 px-2 py-1 rounded border border-zinc-800">
                Port: <span className="text-white font-bold">{inspectService.port}</span>
              </span>
              <span className="text-[11px] font-mono text-zinc-400 bg-zinc-900 px-2 py-1 rounded border border-zinc-800">
                Memory: <span className="text-emerald-400 font-bold">{inspectService.ram}</span>
              </span>
            </div>
          </div>

          <p className="text-xs text-zinc-300 leading-relaxed">
            {inspectService.description}
          </p>
        </div>
      )}

      {/* Architectural Flow Highlights - Direct Flat Grid without nested border container */}
      <div className="space-y-2.5">
        <div className="text-[11px] font-mono uppercase text-zinc-400 flex items-center gap-1.5 font-semibold">
          <Zap className="w-3.5 h-3.5 text-white" />
          <span>Core End-to-End Control Plane Pathways</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs text-zinc-300 font-mono">
          <div className="p-3 rounded-xl bg-zinc-900/80 border border-zinc-800/80 space-y-1 hover:border-zinc-700 transition-colors">
            <div className="text-white font-bold text-[11px]">1. Ingress &rarr; Control Plane</div>
            <p className="text-[10px] text-zinc-400">Client/Webhook &rarr; Caddy 2.8 &rarr; Drogon API (:8090) &rarr; PostgreSQL 16</p>
          </div>
          <div className="p-3 rounded-xl bg-zinc-900/80 border border-zinc-800/80 space-y-1 hover:border-zinc-700 transition-colors">
            <div className="text-white font-bold text-[11px]">2. Queue &rarr; Deployment</div>
            <p className="text-[10px] text-zinc-400">Drogon &rarr; Redis 7 FIFO &rarr; JobQueueWorker &rarr; Docker / k3s</p>
          </div>
          <div className="p-3 rounded-xl bg-zinc-900/80 border border-zinc-800/80 space-y-1 hover:border-zinc-700 transition-colors">
            <div className="text-white font-bold text-[11px]">3. AI &rarr; Visual Sandbox</div>
            <p className="text-[10px] text-zinc-400">FastAPI Swarm (:8010) &rarr; Chromium CDP &rarr; H.264 Streamer (:8099) &rarr; Canvas</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OverviewArchitectureDiagram;
