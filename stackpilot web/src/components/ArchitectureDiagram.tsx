import React, { useState } from 'react';
import { 
  Layers, 
  Cpu, 
  Database, 
  Terminal, 
  Monitor, 
  Workflow, 
  ShieldCheck, 
  BarChart, 
  Radio, 
  Server 
} from 'lucide-react';
import { SpotlightCard } from './reactbits/SpotlightCard';

export const ArchitectureDiagram: React.FC = () => {
  const [activeLayer, setActiveLayer] = useState<'all' | 'qa' | 'backend' | 'observability'>('all');

  const layers = [
    {
      id: 'ui',
      category: 'qa',
      title: 'Developer Interface & Control Plane',
      badge: 'Tier 1',
      desc: 'Next.js 16 Dashboard on Port 3000, Python Terminal CLI (`stackpilot`), and Model Context Protocol (MCP) server for Claude Code & Cursor.',
      icon: <Monitor className="w-5 h-5 text-cyan-400" />,
    },
    {
      id: 'sandbox',
      category: 'qa',
      title: 'Browser Sandbox & 60 FPS Screencaster',
      badge: 'Tier 2 (QA)',
      desc: 'Alpine Chromium running in virtual Xvfb display, streaming hardware-accelerated H.264 NALUs on port 8099 with zero Base64 overhead.',
      icon: <Radio className="w-5 h-5 text-purple-400" />,
    },
    {
      id: 'drogon',
      category: 'backend',
      title: 'Drogon C++20 Core Backend Engine',
      badge: 'Tier 3 (Core)',
      desc: 'Ultra-fast asynchronous HTTP/WebSocket server managing projects, build tasks, git webhooks, and container orchestration.',
      icon: <Cpu className="w-5 h-5 text-emerald-400" />,
    },
    {
      id: 'data',
      category: 'backend',
      title: 'PostgreSQL + pgvector & Redis Queue',
      badge: 'Tier 4 (Data)',
      desc: 'Stores Site Knowledge Graphs (SKG), user auth, test session logs, and vector embeddings for semantic page archetyping.',
      icon: <Database className="w-5 h-5 text-amber-400" />,
    },
    {
      id: 'observability',
      category: 'observability',
      title: 'Enterprise Observability Stack',
      badge: 'Tier 5 (Metrics)',
      desc: 'Prometheus metrics collector, Grafana analytics dashboards, Loki log indexing, and cAdvisor container telemetry.',
      icon: <BarChart className="w-5 h-5 text-rose-400" />,
    },
  ];

  const filteredLayers = activeLayer === 'all' ? layers : layers.filter(l => l.category === activeLayer);

  return (
    <section id="architecture" className="py-24 relative z-20 bg-slate-100/30 dark:bg-black/30 border-y border-slate-200/80 dark:border-slate-800/80 scroll-mt-24">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 text-xs font-mono font-medium mb-4">
            <Layers className="w-3.5 h-3.5" />
            <span>Under the Hood</span>
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            Production-Grade, Modular Stack
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-600 dark:text-slate-300">
            A self-hosted control plane engineered to run seamlessly on a small 1.5GB VPS or scale across multi-node Kubernetes clusters.
          </p>

          {/* Layer Filter Pills */}
          <div className="mt-8 inline-flex items-center p-1 rounded-xl bg-slate-200/60 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 text-xs font-mono">
            <button
              onClick={() => setActiveLayer('all')}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                activeLayer === 'all'
                  ? 'bg-white dark:bg-slate-800 text-cyan-600 dark:text-cyan-400 font-bold shadow-sm'
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              All Layers
            </button>
            <button
              onClick={() => setActiveLayer('qa')}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                activeLayer === 'qa'
                  ? 'bg-white dark:bg-slate-800 text-cyan-600 dark:text-cyan-400 font-bold shadow-sm'
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              Autonomous QA & Streaming
            </button>
            <button
              onClick={() => setActiveLayer('backend')}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                activeLayer === 'backend'
                  ? 'bg-white dark:bg-slate-800 text-cyan-600 dark:text-cyan-400 font-bold shadow-sm'
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              C++ Drogon & Storage
            </button>
            <button
              onClick={() => setActiveLayer('observability')}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                activeLayer === 'observability'
                  ? 'bg-white dark:bg-slate-800 text-cyan-600 dark:text-cyan-400 font-bold shadow-sm'
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              Observability
            </button>
          </div>
        </div>

        {/* Architecture Stack Cards */}
        <div className="max-w-4xl mx-auto space-y-4">
          {filteredLayers.map((item, idx) => (
            <SpotlightCard
              key={item.id}
              className="p-6 transition-all duration-300"
              spotlightColor="rgba(6, 182, 212, 0.15)"
            >
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-start sm:items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center shrink-0">
                    {item.icon}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-base font-bold text-slate-900 dark:text-white">
                        {item.title}
                      </h4>
                      <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-[10px] font-mono text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                        {item.badge}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
                      {item.desc}
                    </p>
                  </div>
                </div>
              </div>
            </SpotlightCard>
          ))}
        </div>
      </div>
    </section>
  );
};
