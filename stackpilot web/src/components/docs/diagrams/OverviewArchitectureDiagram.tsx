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
    badge: 'ENTRY POINTS',
    color: 'zinc',
    description: 'Entry points, developer interfaces, IDE tools, and HTTPS connections.',
    services: [
      { id: 'caddy', name: 'Caddy 2.8 Reverse Proxy', port: '80 / 443', tech: 'Auto TLS / HTTPS', ram: '~28 MB', description: 'Handles HTTPS, auto-renews SSL certificates, and routes traffic.' },
      { id: 'ui', name: 'Web Dashboard', port: '3000', tech: 'React, Tailwind, Canvas', ram: '~45 MB', description: 'Real-time dashboard, live terminal, video stream, and deployment controls.' },
      { id: 'mcp', name: 'IDE Agents via MCP', port: 'Stdio / SSE', tech: 'Model Context Protocol', ram: 'Embedded', description: 'Connects AI coding tools like Claude Code and Cursor directly to StackPilot.' },
      { id: 'gh', name: 'GitHub Webhooks', port: '443 / Hook', tech: 'Secure Webhooks', ram: 'Stateless', description: 'Listens for git push events to trigger automatic deployments.' }
    ]
  },
  {
    id: 'control',
    name: 'Control Plane & Orchestration',
    badge: 'MAIN BACKEND',
    color: 'zinc',
    description: 'Lightweight, fast C++ core that handles requests and manages tasks.',
    services: [
      { id: 'drogon', name: 'C++ Drogon Engine', port: '8090', tech: 'Fast C++17 Core', ram: '< 30 MB', description: 'Lightweight REST API, live WebSockets, and terminal management.' },
      { id: 'workers', name: 'Drogon Worker Pool', port: 'Threads', tech: 'Background Threads', ram: '~12 MB', description: 'Background workers that execute builds and deployments.' },
      { id: 'postgres', name: 'PostgreSQL Database', port: '5432', tech: 'Postgres + pgvector', ram: '~65 MB', description: 'Main database for projects, users, permissions, and AI memories.' },
      { id: 'redis', name: 'Redis Queue', port: '6379', tech: 'Fast In-Memory Queue', ram: '~15 MB', description: 'Reliable deployment queue so tasks are never lost.' }
    ]
  },
  {
    id: 'ai',
    name: 'AI Operations & QA',
    badge: 'AI ASSISTANT',
    color: 'zinc',
    description: 'AI team that diagnoses build errors, fixes code, and tests web pages.',
    services: [
      { id: 'fastapi', name: 'FastAPI AI Service', port: '8010', tech: 'Python 3.11', ram: '~140 MB', description: 'Runs the AI agent tools and automated self-healing routines.' },
      { id: 'swarm', name: 'AI Agent Team', port: 'Internal', tech: 'Lead / Coder / Tester', ram: 'Shared', description: 'Team of specialized AI roles that plan, write code, and verify fixes.' },
      { id: 'searxng', name: 'Private Web Search', port: '8088', tech: 'Private Search', ram: '~70 MB', description: 'Local private search for documentation and error solutions.' },
      { id: 'llm', name: 'AI Models (NVIDIA / Gemini)', port: 'HTTPS', tech: 'Llama 3.1 / DeepSeek / Gemini', ram: 'Cloud/Local', description: 'Language models for reasoning, code analysis, and visual testing.' }
    ]
  },
  {
    id: 'sandbox',
    name: 'Browser Sandbox',
    badge: 'BROWSER TESTING',
    color: 'zinc',
    description: 'Isolated browser container that runs tests and streams video in real time.',
    services: [
      { id: 'chromium', name: 'Alpine Chromium', port: '9223', tech: 'Headless Browser', ram: '~180 MB', description: 'Isolated browser for clicking elements, typing, and testing pages.' },
      { id: 'xvfb', name: 'Virtual Display', port: ':99', tech: 'Virtual Screen', ram: '~35 MB', description: 'Virtual screen that lets the browser render without a physical monitor.' },
      { id: 'streamer', name: 'Video Streamer', port: '8099', tech: 'Fast Video Streaming', ram: '~40 MB', description: 'Captures and streams browser video directly to your dashboard.' }
    ]
  },
  {
    id: 'compute',
    name: 'Deployment Targets',
    badge: 'SERVERS & CLOUD',
    color: 'zinc',
    description: 'Deploy to your local machine, remote VPS servers, or Kubernetes clusters.',
    services: [
      { id: 'docker', name: 'Local Docker', port: 'sock', tech: 'Docker Socket', ram: 'Host Daemon', description: 'Runs your apps as standard Docker containers on the host.' },
      { id: 'ssh', name: 'Remote Servers via SSH', port: '22', tech: 'Encrypted SSH', ram: 'External', description: 'Deploys directly to remote VPS servers without installing agents.' },
      { id: 'k8s', name: 'Kubernetes (k3s)', port: '6443', tech: 'Kubernetes Cluster', ram: 'External', description: 'Automatic 1-click lightweight Kubernetes cluster setup.' }
    ]
  },
  {
    id: 'observability',
    name: 'Logs & Metrics',
    badge: 'LOGS & METRICS',
    color: 'zinc',
    description: 'See live system performance, container memory, and application logs.',
    services: [
      { id: 'prom', name: 'Prometheus Metrics', port: '9090', tech: 'Time-Series Metrics', ram: '~95 MB', description: 'Tracks CPU, memory, response times, and system health.' },
      { id: 'cadvisor', name: 'cAdvisor Container Stats', port: '8081', tech: 'Container Telemetry', ram: '~45 MB', description: 'Monitors memory and CPU usage across every running container.' },
      { id: 'loki', name: 'Loki Log Store', port: '3100', tech: 'Fast Log Search', ram: '~80 MB', description: 'Collects and indexes logs from all your containers.' },
      { id: 'grafana', name: 'Grafana Dashboards', port: '3001', tech: 'Visual Dashboards', ram: '~60 MB', description: 'Clean visual charts and graphs for your server performance.' }
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
    <div className="my-8 rounded-2xl border border-zinc-800/60 bg-[#121214]/95 p-5 sm:p-6 shadow-xl space-y-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-zinc-800 text-white">
              <Layers className="w-4 h-4 text-white" />
            </span>
            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
              How StackPilot Works
            </h3>
          </div>
          <p className="text-xs text-zinc-400">
            A simple overview of how StackPilot connects your web dashboard, backend services, AI testing, and servers.
          </p>
        </div>
      </div>

      {/* Domain Navigation Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl bg-black/60 border border-zinc-800/60 text-xs font-mono">
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
            className="p-4 rounded-xl bg-[#18181c]/80 border-0 space-y-3 flex flex-col justify-between"
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

            <div className="pt-2 flex items-center justify-between text-[10px] font-mono text-zinc-500 mt-2">
              <span>{cluster.services.length} Microservices</span>
              <span>Click to inspect &rarr;</span>
            </div>
          </div>
        ))}
      </div>

      {/* Selected Microservice Inspection Drawer */}
      {inspectService && (
        <div className="p-4 sm:p-5 rounded-xl bg-[#0a0a0c] border-0 space-y-3">
          <div className="flex items-start justify-between gap-4 pb-2">
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
              <span className="text-[11px] font-mono text-zinc-400 bg-[#18181c] px-2 py-1 rounded border-0">
                Port: <span className="text-white font-bold">{inspectService.port}</span>
              </span>
              <span className="text-[11px] font-mono text-zinc-400 bg-[#18181c] px-2 py-1 rounded border-0">
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
          <div className="p-3 rounded-xl bg-[#18181c]/80 border-0 space-y-1 hover:bg-[#202026] transition-colors">
            <div className="text-white font-bold text-[11px]">1. Ingress &rarr; Control Plane</div>
            <p className="text-[10px] text-zinc-400">Client/Webhook &rarr; Caddy 2.8 &rarr; Drogon API (:8090) &rarr; PostgreSQL 16</p>
          </div>
          <div className="p-3 rounded-xl bg-[#18181c]/80 border-0 space-y-1 hover:bg-[#202026] transition-colors">
            <div className="text-white font-bold text-[11px]">2. Queue &rarr; Deployment</div>
            <p className="text-[10px] text-zinc-400">Drogon &rarr; Redis 7 FIFO &rarr; JobQueueWorker &rarr; Docker / k3s</p>
          </div>
          <div className="p-3 rounded-xl bg-[#18181c]/80 border-0 space-y-1 hover:bg-[#202026] transition-colors">
            <div className="text-white font-bold text-[11px]">3. AI &rarr; Visual Sandbox</div>
            <p className="text-[10px] text-zinc-400">FastAPI Swarm (:8010) &rarr; Chromium CDP &rarr; H.264 Streamer (:8099) &rarr; Canvas</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OverviewArchitectureDiagram;
