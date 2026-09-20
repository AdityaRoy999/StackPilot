import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, ArrowRight } from 'lucide-react';

export interface SearchDocItem {
  id: string;
  category: string;
  title: string;
  description: string;
  keywords: string[];
}

export const SEARCHABLE_DOCS: SearchDocItem[] = [
  {
    id: 'overview',
    category: 'Getting Started',
    title: 'StackPilot Architecture & Platform Vision',
    description: 'Self-hosted application delivery cockpit, C++ Drogon API, Python AI service, and Next.js control plane.',
    keywords: ['architecture', 'overview', 'control plane', 'cockpit', 'drogon', 'vision', 'stack']
  },
  {
    id: 'quickstart',
    category: 'Getting Started',
    title: '60-Second Quick Start & Local Run',
    description: 'Clone the repo, set environment secrets, and launch full multi-container stack with Docker Compose.',
    keywords: ['quickstart', 'run', 'docker compose', 'clone', 'start', 'install', 'setup']
  },
  {
    id: 'install',
    category: 'Getting Started',
    title: 'One-Liner Installation Script',
    description: 'Automated bash and powershell install scripts for Linux VPS, macOS, and Windows workstations.',
    keywords: ['install', 'curl', 'powershell', 'bash', 'script', 'one liner', 'download']
  },
  {
    id: 'architecture',
    category: 'Getting Started',
    title: 'Deep-Dive: Subsystems & Data Flow',
    description: 'Internal topologies connecting PostgreSQL with pgvector, Redis event bus, Drogon workers, and Caddy.',
    keywords: ['topology', 'data flow', 'redis', 'postgres', 'pgvector', 'caddy', 'subsystems']
  },
  {
    id: 'templates',
    category: 'Getting Started',
    title: 'Built-in Application Templates',
    description: 'Deploy PostgreSQL, MySQL, Redis, MinIO S3, Grafana, and NATS without writing Dockerfiles.',
    keywords: ['templates', 'apps', 'postgres', 'mysql', 'redis', 'minio', 's3', 'grafana', 'nats']
  },
  {
    id: 'ai-agent',
    category: 'AI & Autonomous QA',
    title: 'StackPilot AI Operations Agent',
    description: 'Natural language deployment orchestration, failed build diagnostics, and automated root cause analysis.',
    keywords: ['ai', 'agent', 'diagnostics', 'prompts', 'llm', 'gpt-4o', 'claude', 'nvidia nim']
  },
  {
    id: 'screencast',
    category: 'AI & Autonomous QA',
    title: 'Real-Time 60 FPS Screencasting',
    description: 'CDP Page.startScreencast over binary WebSockets with adaptive backpressure and zero WebRTC latency.',
    keywords: ['screencast', '60fps', 'stream', 'canvas', 'cdp', 'websocket', 'sub-50ms', 'latency']
  },
  {
    id: 'sandboxing',
    category: 'AI & Autonomous QA',
    title: 'Chromium Kernel Sandboxing',
    description: 'Rootless container isolation, custom seccomp profiles, and automatic memory cleanup between sessions.',
    keywords: ['sandbox', 'security', 'chromium', 'isolation', 'seccomp', 'memory', 'container']
  },
  {
    id: 'replay',
    category: 'AI & Autonomous QA',
    title: 'Time-Travel Session Replay',
    description: 'Frame-accurate scrubbable playback buffer with speed scaling (0.5x - 4x) and click ripple inspection.',
    keywords: ['replay', 'time travel', 'scrubber', 'timeline', 'playback', 'audit', 'frames']
  },
  {
    id: 'docker',
    category: 'Deployment & Runtimes',
    title: 'Docker Build & Runtime Management',
    description: 'Production container builds, volume persistence, bridge networking, and local/remote daemon targets.',
    keywords: ['docker', 'compose', 'production', 'builds', 'daemon', 'volumes', 'networks']
  },
  {
    id: 'kubernetes',
    category: 'Deployment & Runtimes',
    title: 'Kubernetes Cluster Integration',
    description: 'Deploy workloads to local k3s/Minikube or remote cloud clusters (EKS, GKE, AKS) with automated manifests.',
    keywords: ['kubernetes', 'k8s', 'manifests', 'cluster', 'eks', 'gke', 'helm', 'ingress']
  },
  {
    id: 'mcp',
    category: 'Deployment & Runtimes',
    title: 'Model Context Protocol (MCP) Server',
    description: 'Connect IDE agents like Claude Code, Cursor, and VS Code directly to StackPilot operations.',
    keywords: ['mcp', 'claude code', 'cursor', 'ide', 'model context protocol', 'tools', 'codex']
  },
  {
    id: 'cicd',
    category: 'Deployment & Runtimes',
    title: 'GitHub App & CI/CD Pipelines',
    description: 'Automated webhook triggers on push and pull requests with preview environments and commit status checks.',
    keywords: ['ci/cd', 'github', 'webhooks', 'actions', 'git', 'pr preview', 'automation']
  },
  {
    id: 'env',
    category: 'Configuration & Reference',
    title: 'Environment Variables Reference',
    description: 'Complete specification of all platform configurations, database credentials, and security secrets.',
    keywords: ['env', 'variables', 'configuration', 'jwt', 'secrets', 'ports', 'database']
  },
  {
    id: 'observability',
    category: 'Configuration & Reference',
    title: 'Observability: Prometheus, Grafana & Loki',
    description: 'Built-in container metrics with cAdvisor, centralized log indexing via Loki, and pre-built Grafana boards.',
    keywords: ['metrics', 'prometheus', 'grafana', 'loki', 'logs', 'promtail', 'monitoring']
  },
  {
    id: 'troubleshooting',
    category: 'Configuration & Reference',
    title: 'Troubleshooting & Common Fixes',
    description: 'Solutions for port conflicts, database migration issues, Docker socket permissions, and SSL renewal.',
    keywords: ['troubleshooting', 'errors', 'debug', 'fixes', 'ports', 'crash', 'logs']
  }
];

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectDoc: (id: string) => void;
}

export const SearchModal: React.FC<SearchModalProps> = ({ isOpen, onClose, onSelectDoc }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input on open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Filter items
  const filtered = SEARCHABLE_DOCS.filter(item => {
    if (!query.trim()) return true;
    const q = query.toLowerCase().trim();
    return (
      item.title.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q) ||
      item.keywords.some(k => k.toLowerCase().includes(q))
    );
  });

  // Handle keyboard navigation inside popup
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (filtered.length > 0 ? (prev + 1) % filtered.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (filtered.length > 0 ? (prev - 1 + filtered.length) % filtered.length : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          onSelectDoc(filtered[selectedIndex].id);
          onClose();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, filtered, selectedIndex, onClose, onSelectDoc]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-start justify-center pt-16 sm:pt-24 px-4">
          {/* Smooth Dark Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm cursor-pointer"
          />

          {/* Modal Container */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -10 }}
            transition={{ type: 'spring', stiffness: 450, damping: 30 }}
            className="relative w-full max-w-xl rounded-2xl sm:rounded-3xl border border-zinc-800 bg-[#161619] shadow-2xl overflow-hidden flex flex-col z-10 font-sans"
          >
            {/* Search Input Bar */}
            <div className="flex items-center gap-3 px-4 sm:px-5 py-3.5 border-b border-zinc-800/80 bg-[#1a1a1e]">
              <Search className="w-4 h-4 text-zinc-400 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => {
                  setQuery(e.target.value);
                  setSelectedIndex(0);
                }}
                placeholder="Search docs, topics, guides, commands..."
                className="flex-1 bg-transparent border-0 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none font-sans"
              />
              <div className="flex items-center gap-1.5">
                <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] font-mono text-zinc-400 border border-zinc-700/60">
                  ESC
                </kbd>
                <button
                  onClick={onClose}
                  className="w-6 h-6 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors border-0 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Results List */}
            <div className="max-h-[380px] overflow-y-auto p-2 space-y-1 no-scrollbar">
              {filtered.length > 0 ? (
                filtered.map((item, idx) => {
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onSelectDoc(item.id);
                        onClose();
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`w-full text-left p-3 rounded-xl transition-all flex items-start justify-between gap-3 cursor-pointer border-0 ${
                        isSelected
                          ? 'bg-[#222226] text-white'
                          : 'bg-transparent text-zinc-300 hover:bg-[#1a1a1e]'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                            {item.category}
                          </span>
                          <span className={`text-xs font-semibold truncate ${isSelected ? 'text-white' : 'text-zinc-200'}`}>
                            {item.title}
                          </span>
                        </div>
                        <p className="text-[11px] text-zinc-400 line-clamp-1 leading-relaxed font-sans">
                          {item.description}
                        </p>
                      </div>

                      {isSelected && (
                        <div className="flex items-center gap-1 text-[10px] font-mono text-zinc-400 shrink-0 mt-1">
                          <ArrowRight className="w-3.5 h-3.5 text-white" />
                        </div>
                      )}
                    </button>
                  );
                })
              ) : (
                <div className="py-12 px-4 text-center">
                  <p className="text-xs text-zinc-400">No documentation found matching "{query}"</p>
                  <p className="text-[11px] text-zinc-500 mt-1 font-mono">Try searching for Docker, Replay, Architecture, or CLI</p>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-4 py-2.5 bg-[#141416] border-t border-zinc-800/80 flex items-center justify-between text-[11px] font-mono text-zinc-500">
              <div className="flex items-center gap-3">
                <span><kbd className="text-zinc-400 font-sans">↑↓</kbd> to navigate</span>
                <span><kbd className="text-zinc-400 font-sans">↵</kbd> to select</span>
              </div>
              <div className="text-[10px]">
                {filtered.length} {filtered.length === 1 ? 'result' : 'results'}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default SearchModal;
