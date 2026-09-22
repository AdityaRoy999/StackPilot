import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { HugeiconsIcon } from '@hugeicons/react';
import { Search01Icon, Cancel01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { AnimatedList } from './reactbits/AnimatedList';

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
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Focus input on open, prevent page scroll, lock body
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      if (listRef.current) listRef.current.scrollTop = 0;
      // Prevent the browser from scrolling the underlying page to the input
      setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 50);
      // Lock body scroll so Lenis/native scroll can't move while modal is open
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
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

  // Reset scroll on filter change
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [query]);

  // Scroll active item into view when navigating via keyboard
  useEffect(() => {
    if (itemRefs.current[selectedIndex]) {
      itemRefs.current[selectedIndex]?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth'
      });
    }
  }, [selectedIndex]);

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
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
          {/* Smooth Dark Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm cursor-pointer"
          />

          {/* Modal Container Centered in the Middle of the Page */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 450, damping: 30 }}
            data-lenis-prevent
            className="relative w-full max-w-xl rounded-2xl sm:rounded-3xl border border-zinc-800 bg-[#161619] shadow-2xl overflow-hidden flex flex-col z-10 my-auto"
          >
            {/* Search Input Bar - Seamless without dividing border line */}
            <div className="flex items-center gap-3 px-4 sm:px-5 py-3.5 bg-[#161619]">
              <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.8} className="text-white shrink-0" />
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
                  className="w-6 h-6 rounded-full flex items-center justify-center text-white hover:bg-zinc-800/80 transition-colors border-0 cursor-pointer"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} className="text-white" />
                </button>
              </div>
            </div>

            {/* Results List - Animated with React Bits AnimatedList (No scrollbars, clean frictionless scrolling) */}
            <div data-lenis-prevent onWheel={(e) => e.stopPropagation()} className="px-2 pb-1 overflow-hidden no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              {filtered.length > 0 ? (
                <AnimatedList<SearchDocItem>
                  items={filtered}
                  initialSelectedIndex={selectedIndex}
                  onItemSelect={(item) => {
                    onSelectDoc(item.id);
                    onClose();
                  }}
                  displayScrollbar={false}
                  showGradients={false}
                  enableArrowNavigation={true}
                  maxHeight="420px"
                  renderItem={(item, _idx, isSelected) => (
                    <div
                      key={item.id}
                      className={`w-full text-left p-3 sm:p-3.5 rounded-xl transition-all flex items-start justify-between gap-3 cursor-pointer border ${
                        isSelected
                          ? 'bg-[#222226] text-white border-zinc-700 shadow-lg'
                          : 'bg-[#18181b]/80 text-zinc-300 hover:bg-[#1f1f23] border-zinc-800/80'
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
                          <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} className="text-white" />
                        </div>
                      )}
                    </div>
                  )}
                />
              ) : (
                <div className="py-12 px-4 text-center">
                  <p className="text-xs text-zinc-400">No documentation found matching "{query}"</p>
                  <p className="text-[11px] text-zinc-500 mt-1 font-mono">Try searching for Docker, Replay, Architecture, or CLI</p>
                </div>
              )}
            </div>

            {/* Modal Footer - Seamless without dividing border line */}
            <div className="px-5 py-3 bg-[#161619] flex items-center justify-between text-[11px] font-mono text-zinc-500">
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
