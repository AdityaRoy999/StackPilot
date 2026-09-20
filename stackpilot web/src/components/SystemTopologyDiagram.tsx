import React, { useState } from 'react';
import { 
  Terminal, 
  Shield, 
  Monitor, 
  Cpu, 
  Database, 
  Layers, 
  Bot, 
  Box, 
  Globe,
  Sparkles
} from 'lucide-react';

interface TopologyNode {
  id: string;
  title: string;
  badge: string;
  subtitle: string;
  icon: React.ReactNode;
  left: number;
  top: number;
  width: number;
  height: number;
  details: string;
}

export const SystemTopologyDiagram: React.FC = () => {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const nodes: TopologyNode[] = [
    // Level 1: Client & Ingress
    {
      id: 'operator',
      title: 'Operator / IDE Agent',
      badge: 'Client / CLI',
      subtitle: 'Developer Terminal & IDE Extension',
      icon: <Terminal className="w-4 h-4 text-white shrink-0" />,
      left: 40,
      top: 30,
      width: 215,
      height: 68,
      details: 'CLI client, Cursor MCP agent, or VSCode extension dispatching test runs and receiving screencasts.',
    },
    {
      id: 'caddy',
      title: 'Caddy Reverse Proxy',
      badge: ':80 / :443',
      subtitle: 'TLS Termination & SSL Gateway',
      icon: <Shield className="w-4 h-4 text-white shrink-0" />,
      left: 350,
      top: 30,
      width: 225,
      height: 68,
      details: 'Automated HTTPS certificate manager and high-throughput reverse proxy routing web & WebSocket traffic.',
    },

    // Level 2: Frontend UI & Core API
    {
      id: 'nextjs',
      title: 'Next.js Dashboard',
      badge: 'Port :3000',
      subtitle: 'Control Plane & Live Canvas',
      icon: <Monitor className="w-4 h-4 text-white shrink-0" />,
      left: 40,
      top: 160,
      width: 230,
      height: 74,
      details: 'React 19 dashboard rendering 60 FPS video canvases, test run logs, and visual regression timelines.',
    },
    {
      id: 'drogon',
      title: 'C++ Drogon API',
      badge: 'Port :8090',
      subtitle: 'Ultra-Low Latency Core Backend',
      icon: <Cpu className="w-4 h-4 text-white shrink-0" />,
      left: 480,
      top: 160,
      width: 240,
      height: 74,
      details: 'Non-blocking C++20 Drogon async engine managing project state, git webhooks, and task dispatching.',
    },

    // Level 3: Database, Message Queue & AI Services
    {
      id: 'postgres',
      title: 'PostgreSQL + pgvector',
      badge: 'Port :5432',
      subtitle: 'Knowledge Graph & Vector Memory',
      icon: <Database className="w-4 h-4 text-white shrink-0" />,
      left: 40,
      top: 300,
      width: 230,
      height: 76,
      details: 'Relational storage for project specs, test suites, execution logs, and pgvector embeddings for element grounding.',
    },
    {
      id: 'redis',
      title: 'Redis',
      badge: 'Port :6379',
      subtitle: 'Job Queues & Realtime Pub/Sub',
      icon: <Layers className="w-4 h-4 text-white shrink-0" />,
      left: 315,
      top: 300,
      width: 220,
      height: 76,
      details: 'High-throughput in-memory message broker coordinating async test worker tasks and websocket heartbeats.',
    },
    {
      id: 'python-ai',
      title: 'Python AI Service',
      badge: 'Port :8010',
      subtitle: 'Model Gateway & CDP Agent',
      icon: <Bot className="w-4 h-4 text-white shrink-0" />,
      left: 575,
      top: 300,
      width: 240,
      height: 76,
      details: 'Autonomous QA agent running LangChain/Anthropic models with automated element detection and visual inspection.',
    },

    // Level 4: Execution & Infrastructure Tier
    {
      id: 'docker',
      title: 'Docker Compose / K8s',
      badge: 'Infra',
      subtitle: 'Container Orchestration Fleet',
      icon: <Box className="w-4 h-4 text-white shrink-0" />,
      left: 315,
      top: 430,
      width: 220,
      height: 72,
      details: 'Containerized daemon managing sandbox lifecycles, memory limits, and automated volume storage.',
    },
    {
      id: 'chromium',
      title: 'Sandboxed Chromium',
      badge: 'Xvfb 60 FPS',
      subtitle: 'Hardware-Accelerated Browser Feed',
      icon: <Globe className="w-4 h-4 text-white shrink-0" />,
      left: 575,
      top: 430,
      width: 240,
      height: 72,
      details: 'Headless Alpine Chromium operating in isolated virtual display, broadcasting sub-50ms CDP screencasts.',
    },
  ];

  return (
    <div className="rounded-2xl border border-zinc-800 bg-[#121214] p-5 sm:p-6 space-y-4 shadow-2xl">
      {/* Header with Title & Metadata */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-zinc-800/80">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-zinc-800/90 border border-zinc-700/60 flex items-center justify-center">
            <Layers className="w-4 h-4 text-white" />
          </div>
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-zinc-100 font-mono tracking-tight">
              End-to-End System Topology
            </h3>
            <p className="text-xs text-zinc-400">
              Interactive Microservices Architecture &amp; Networking Routes
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/60 text-emerald-400 border border-emerald-800/50 text-[11px] font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Operational</span>
          </span>
        </div>
      </div>

      {/* Interactive Topology Canvas with Native Horizontal Scroll on Small Screens */}
      <div className="w-full overflow-x-auto pb-4 pt-2 -mx-2 px-2 select-none">
        <div className="relative w-[850px] h-[525px] bg-[#0c0c0e] rounded-xl border border-zinc-850 border-zinc-800/70 overflow-hidden shadow-inner mx-auto">
          {/* Subtle Background Grid Pattern */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="topo-grid-dots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
                <circle cx="2" cy="2" r="1" fill="#27272a" opacity="0.6" />
              </pattern>

              <marker
                id="topo-arrow"
                markerWidth="8"
                markerHeight="8"
                refX="6"
                refY="4"
                orient="auto"
              >
                <path d="M 0 1.5 L 6 4 L 0 6.5 z" fill="#a1a1aa" />
              </marker>

              <marker
                id="topo-arrow-highlight"
                markerWidth="8"
                markerHeight="8"
                refX="6"
                refY="4"
                orient="auto"
              >
                <path d="M 0 1.5 L 6 4 L 0 6.5 z" fill="#ffffff" />
              </marker>
            </defs>

            <rect width="100%" height="100%" fill="url(#topo-grid-dots)" />

            {/* Connecting Lines with Real SVG Arrows & Junction Dots */}
            
            {/* 1. Operator ---> Caddy */}
            <path
              d="M 255 64 L 344 64"
              stroke="#71717a"
              strokeWidth="1.5"
              markerEnd="url(#topo-arrow)"
            />
            {/* Tag on line */}
            <rect x="272" y="54" width="56" height="18" rx="4" fill="#18181b" stroke="#3f3f46" strokeWidth="1" />
            <text x="300" y="66" fill="#d4d4d8" fontSize="9" fontFamily="monospace" textAnchor="middle">
              HTTPS/WSS
            </text>

            {/* 2. Caddy Down Branch */}
            <path
              d="M 462 98 L 462 130"
              stroke="#71717a"
              strokeWidth="1.5"
            />
            {/* Horizontal Split Line */}
            <path
              d="M 155 130 L 600 130"
              stroke="#71717a"
              strokeWidth="1.5"
            />
            {/* Junction dot on Caddy branch */}
            <circle cx="462" cy="130" r="3.5" fill="#e4e4e7" stroke="#27272a" strokeWidth="1.5" />

            {/* Drop into Next.js Dashboard */}
            <path
              d="M 155 130 L 155 154"
              stroke="#71717a"
              strokeWidth="1.5"
              markerEnd="url(#topo-arrow)"
            />

            {/* Drop into C++ Drogon API */}
            <path
              d="M 600 130 L 600 154"
              stroke="#71717a"
              strokeWidth="1.5"
              markerEnd="url(#topo-arrow)"
            />

            {/* 3. C++ Drogon API Down to Databases & Services */}
            <path
              d="M 600 234 L 600 268"
              stroke="#71717a"
              strokeWidth="1.5"
            />
            {/* Secondary Horizontal Split Bar */}
            <path
              d="M 155 268 L 695 268"
              stroke="#71717a"
              strokeWidth="1.5"
            />
            {/* Junction dot on Drogon branch */}
            <circle cx="600" cy="268" r="3.5" fill="#e4e4e7" stroke="#27272a" strokeWidth="1.5" />

            {/* Drop into PostgreSQL */}
            <path
              d="M 155 268 L 155 294"
              stroke="#71717a"
              strokeWidth="1.5"
              markerEnd="url(#topo-arrow)"
            />

            {/* Drop into Redis */}
            <path
              d="M 425 268 L 425 294"
              stroke="#71717a"
              strokeWidth="1.5"
              markerEnd="url(#topo-arrow)"
            />

            {/* Drop into Python AI Service */}
            <path
              d="M 695 268 L 695 294"
              stroke="#71717a"
              strokeWidth="1.5"
              markerEnd="url(#topo-arrow)"
            />

            {/* 4. Redis down to Docker Compose / K8s */}
            <path
              d="M 425 376 L 425 424"
              stroke="#71717a"
              strokeWidth="1.5"
              markerEnd="url(#topo-arrow)"
            />

            {/* 5. Python AI Service down to Sandboxed Chromium */}
            <path
              d="M 695 376 L 695 424"
              stroke="#71717a"
              strokeWidth="1.5"
              markerEnd="url(#topo-arrow)"
            />
            {/* Tag on Chromium line */}
            <rect x="704" y="394" width="76" height="18" rx="4" fill="#18181b" stroke="#3f3f46" strokeWidth="1" />
            <text x="742" y="406" fill="#d4d4d8" fontSize="9" fontFamily="monospace" textAnchor="middle">
              CDP Screencast
            </text>
          </svg>

          {/* HTML Interactive Bento Cards */}
          {nodes.map((node) => {
            const isSelected = selectedNode === node.id;

            return (
              <div
                key={node.id}
                onClick={() => setSelectedNode(isSelected ? null : node.id)}
                className={`absolute rounded-xl border p-3 cursor-pointer transition-all duration-200 flex flex-col justify-between ${
                  isSelected
                    ? 'bg-[#1e1e24] border-white shadow-[0_0_20px_rgba(255,255,255,0.15)] ring-1 ring-white/50'
                    : 'bg-[#141417]/95 hover:bg-[#1a1a1f] border-zinc-800 hover:border-zinc-600 shadow-md'
                }`}
                style={{
                  left: node.left,
                  top: node.top,
                  width: node.width,
                  height: node.height,
                }}
              >
                {/* Top Row: Icon + Title + Port Badge */}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-6 h-6 rounded-md bg-zinc-800/90 border border-zinc-700/60 flex items-center justify-center shrink-0">
                      {node.icon}
                    </div>
                    <span className="text-xs font-semibold text-zinc-100 truncate">
                      {node.title}
                    </span>
                  </div>

                  <span className="px-1.5 py-0.5 rounded bg-zinc-800/80 text-[10px] text-zinc-300 font-mono border border-zinc-700/50 shrink-0">
                    {node.badge}
                  </span>
                </div>

                {/* Bottom Row: Subtitle & Status Indicator */}
                <div className="flex items-center justify-between gap-2 mt-1">
                  <span className="text-[10px] text-zinc-400 truncate">
                    {node.subtitle}
                  </span>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Interactive Detail Drawer for Selected Card */}
      {selectedNode && (
        <div className="p-3.5 rounded-xl bg-zinc-900/90 border border-zinc-700/80 flex items-start justify-between gap-3 text-xs animate-in fade-in duration-150">
          <div>
            <div className="flex items-center gap-2 font-semibold text-white mb-1">
              <Sparkles className="w-3.5 h-3.5 text-white" />
              <span>{nodes.find((n) => n.id === selectedNode)?.title}</span>
              <span className="font-mono text-zinc-400 text-[11px]">
                ({nodes.find((n) => n.id === selectedNode)?.badge})
              </span>
            </div>
            <p className="text-zinc-300 leading-relaxed text-[11px]">
              {nodes.find((n) => n.id === selectedNode)?.details}
            </p>
          </div>
          <button
            onClick={() => setSelectedNode(null)}
            className="text-zinc-400 hover:text-white text-xs px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 cursor-pointer"
          >
            Close
          </button>
        </div>
      )}

      {/* Legend & Hint */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 text-[11px] text-zinc-400 border-t border-zinc-850 border-zinc-800/60">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-[1.5px] bg-zinc-500 inline-block" />
            <span>TCP / WebSocket Route</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
            <span>Active Microservice</span>
          </span>
        </div>
        <span className="text-zinc-500 font-mono text-[10px]">
          Click any card for service specification
        </span>
      </div>
    </div>
  );
};

export default SystemTopologyDiagram;
