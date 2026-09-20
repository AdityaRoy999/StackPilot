import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Download04Icon,
  Rocket01Icon,
  Settings02Icon,
  Layers01Icon,
  ComputerTerminal01Icon,
  CpuIcon,
  GitBranchIcon,
  DashboardBrowsingIcon,
  HelpCircleIcon
} from '@hugeicons/core-free-icons';
import { Copy, Check, ArrowLeft, ExternalLink, Search, Terminal, Shield, Zap, RefreshCw, Cpu, Layers, BookOpen, Box, Globe, Server, CheckCircle2 } from 'lucide-react';
import { BranchedMenu, BranchedMenuItem } from '../components/reactbits/BranchedMenu';
import { GithubIcon } from '../components/icons/GithubIcon';
import { StarIcon } from '../components/icons/StarIcon';
import { SearchModal } from '../components/SearchModal';

interface DocsPageProps {
  onNavigateHome: () => void;
}

const DOCS_MENU_ITEMS: BranchedMenuItem[] = [
  {
    label: 'Getting Started',
    children: [
      { value: 'overview', label: 'Platform Overview', icon: Rocket01Icon },
      { value: 'quickstart', label: '60-Second Quickstart', icon: ComputerTerminal01Icon },
      { value: 'install', label: 'Installation Scripts', icon: Download04Icon },
      { value: 'architecture', label: 'System Architecture', icon: Layers01Icon },
      { value: 'templates', label: 'Application Templates', icon: Settings02Icon }
    ]
  },
  {
    label: 'AI & Autonomous QA',
    children: [
      { value: 'ai-agent', label: 'AI Operations Agent', icon: CpuIcon },
      { value: 'screencast', label: '60 FPS Screencast', icon: DashboardBrowsingIcon },
      { value: 'sandboxing', label: 'Chromium Sandboxing', icon: GitBranchIcon },
      { value: 'replay', label: 'Time-Travel Replay', icon: HelpCircleIcon }
    ]
  },
  {
    label: 'Deployment & Runtimes',
    children: [
      { value: 'docker', label: 'Docker Compose', icon: Settings02Icon },
      { value: 'kubernetes', label: 'Kubernetes Clusters', icon: Layers01Icon },
      { value: 'mcp', label: 'MCP for IDE Agents', icon: ComputerTerminal01Icon },
      { value: 'cicd', label: 'CI/CD & GitHub App', icon: GitBranchIcon }
    ]
  },
  {
    label: 'Configuration & Operations',
    children: [
      { value: 'env', label: 'Environment Variables', icon: Settings02Icon },
      { value: 'observability', label: 'Observability & Metrics', icon: DashboardBrowsingIcon },
      { value: 'troubleshooting', label: 'Troubleshooting Guide', icon: HelpCircleIcon }
    ]
  }
];

export const DocsPage: React.FC<DocsPageProps> = ({ onNavigateHome }) => {
  const [activeDoc, setActiveDoc] = useState<string>('overview');
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const copyCode = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSnippet(id);
    setTimeout(() => setCopiedSnippet(null), 2000);
  };

  // Keyboard shortcut: ⌘K or Ctrl+K opens search popup
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Scroll to top of content on section change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setMobileMenuOpen(false);
  }, [activeDoc]);

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col selection:bg-zinc-800 selection:text-zinc-100 font-sans antialiased">
      {/* Search Modal (Command Palette) */}
      <SearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onSelectDoc={(id) => setActiveDoc(id)}
      />

      {/* Top Header - Completely transparent, natural flow, no full-width overlay band */}
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-2 flex items-center justify-between gap-4">
        {/* Left: Brand & Back */}
        <div className="flex items-center gap-3 sm:gap-4">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onNavigateHome();
            }}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#1c1c1e] hover:bg-[#28282c] text-zinc-300 hover:text-white text-xs font-mono transition-all duration-200 cursor-pointer select-none border-0"
            title="Return to StackPilot Home"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Home</span>
          </a>

          <div className="h-4 w-[1px] bg-zinc-800 select-none hidden sm:block" />

          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onNavigateHome();
            }}
            className="flex items-center gap-2 text-sm font-semibold tracking-tight text-white hover:text-zinc-300 transition-colors cursor-pointer select-none"
          >
            <span className="font-mono text-zinc-400 font-bold">&gt;_</span>
            <span>StackPilot Docs</span>
          </a>
        </div>

        {/* Right: Capsule Bar with Distinct Pill Selections (Search | Repo ★) */}
        <div className="flex items-center">
          <div className="inline-flex items-center h-10 p-1 rounded-full bg-[#18181b] border border-zinc-800/90 shadow-lg text-xs font-mono text-zinc-300">
            {/* Interactive Search Button: between '(' and '|' -> left fully rounded, right square rounded */}
            <button
              type="button"
              onClick={() => setIsSearchOpen(true)}
              className="inline-flex items-center gap-2.5 h-8 px-3 sm:px-3.5 rounded-l-full rounded-r-md bg-transparent hover:bg-[#242428] text-zinc-300 hover:text-white transition-all cursor-pointer select-none border-0 group"
              title="Search documentation (⌘K)"
            >
              <Search className="w-3.5 h-3.5 text-zinc-400 group-hover:text-white transition-colors" />
              <span className="hidden sm:inline">Search docs...</span>
              <kbd className="hidden md:inline-block px-1.5 py-0.5 text-[10px] font-mono text-zinc-400 group-hover:text-zinc-200 bg-[#161618] rounded border border-zinc-700/60">
                ⌘K
              </kbd>
            </button>

            {/* Mobile Menu Toggle (lg:hidden): between '|' and '|' -> square rounded tab */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md bg-transparent hover:bg-[#242428] text-zinc-300 hover:text-white border-0 cursor-pointer mx-0.5"
            >
              <span>{mobileMenuOpen ? 'Close' : 'Topics'}</span>
            </button>

            {/* Vertical Divider */}
            <span className="h-3.5 w-[1px] bg-zinc-800/90 shrink-0 mx-1 select-none" />

            {/* GitHub Repo: between '|' and ')' -> left square rounded, right fully rounded */}
            <a
              href="https://github.com/AdityaRoy999/StackPilot"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2.5 h-8 px-3 sm:px-3.5 rounded-l-md rounded-r-full bg-transparent hover:bg-[#242428] text-zinc-300 hover:text-white transition-all cursor-pointer select-none border-0 group"
              title="View StackPilot on GitHub"
            >
              <GithubIcon className="w-3.5 h-3.5 text-zinc-300 group-hover:text-white shrink-0 transition-colors" />
              <span className="hidden sm:inline">Repo</span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#161618] text-[10px] text-zinc-300 border border-zinc-700/50">
                <StarIcon className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                <span>Star</span>
              </span>
            </a>
          </div>
        </div>
      </div>

      {/* Main Container with Sidebar + Content */}
      <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 flex gap-8">
        {/* Left Sidebar: Greyish Bento Card containing the Tree */}
        <aside
          className={`lg:w-72 shrink-0 transition-all duration-300 z-30 ${
            mobileMenuOpen
              ? 'fixed inset-x-4 top-20 bottom-4 bg-[#18181b] border border-zinc-800 rounded-3xl p-5 overflow-y-auto no-scrollbar block shadow-2xl z-50'
              : 'hidden lg:block'
          }`}
        >
          {/* Distinct Greyish Card - Clean without any scrollbar */}
          <div
            className="sticky top-6 rounded-2xl sm:rounded-3xl border border-zinc-800/90 bg-[#18181b]/95 p-4 sm:p-5 flex flex-col gap-3 shadow-xl transition-all"
          >
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80">
              <span className="text-[11px] font-mono uppercase tracking-widest text-zinc-400 font-semibold">
                Documentation
              </span>
              <span className="px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 text-[10px] font-mono font-medium border border-zinc-700/60">
                v1.0.0
              </span>
            </div>

            {/* React Bits BranchedMenu Tree with WHITE selection and NO green left marker */}
            <div className="py-1 overflow-x-hidden">
              <BranchedMenu
                items={DOCS_MENU_ITEMS}
                defaultOpen={[0, 1, 2, 3]}
                defaultActive={activeDoc}
                onSelect={(val) => {
                  setActiveDoc(val);
                  setMobileMenuOpen(false);
                }}
                color="#a1a1aa"
                accentColor="#ffffff"
                lineColor="#3f3f46"
                width={255}
                rowHeight={34}
                indent={32}
                fontSize={13}
                showMarker={false}
                showTrunkLine={false}
              />
            </div>
          </div>
        </aside>

        {/* Right Content View */}
        <main className="flex-1 min-w-0 max-w-3xl pb-24">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeDoc}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="space-y-10"
            >
              {/* SECTION: Overview */}
              {activeDoc === 'overview' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={Rocket01Icon} size={16} />
                      <span>GETTING STARTED / OVERVIEW</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      StackPilot Platform Overview
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      StackPilot is a self-hosted application delivery cockpit and autonomous QA platform. It turns GitHub repositories, SSH/VPS folders, local codebases, and application templates into running Docker Compose or Kubernetes deployments with an integrated AI agent, live 60 FPS browser cockpit, and full-stack observability.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 flex flex-col gap-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                        <Server className="w-4 h-4 text-zinc-300" />
                        <span>Self-Hosted Control Plane</span>
                      </div>
                      <p className="text-xs text-zinc-400 leading-relaxed">
                        C++ Drogon backend, PostgreSQL with pgvector, and Redis orchestration keep all application secrets and code on your own infrastructure.
                      </p>
                    </div>

                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 flex flex-col gap-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                        <Zap className="w-4 h-4 text-amber-400" />
                        <span>Autonomous AI QA &amp; Screencast</span>
                      </div>
                      <p className="text-xs text-zinc-400 leading-relaxed">
                        Hardware-accelerated Chromium sandbox streams 60 FPS interactive feeds over binary WebSockets with self-healing element discovery.
                      </p>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-zinc-800 bg-[#18181b]/90 p-5 space-y-3">
                    <h3 className="text-sm font-semibold text-zinc-200 font-mono flex items-center gap-2">
                      <Layers className="w-4 h-4 text-zinc-300" />
                      <span>End-to-End System Topology</span>
                    </h3>
                    <div className="p-4 rounded-xl bg-black font-mono text-xs text-zinc-300 leading-relaxed overflow-x-auto border border-zinc-800">
                      <pre>{`[ Operator / IDE Agent ]  --->  [ Caddy Reverse Proxy (:80/:443) ]
                                            |
              +-----------------------------+-----------------------------+
              |                                                           |
      [ Next.js Dashboard ]                                   [ C++ Drogon API (:8090) ]
        (Port :3000)                                                      |
                                            +-----------------------------+-----------------------------+
                                            |                             |                             |
                                  [ PostgreSQL + pgvector ]           [ Redis ]            [ Python AI Service (:8010) ]
                                    (Database & Memory)             (Job Queues)             (Model Gateway & CDP QA)
                                                                          |                             |
                                                             [ Docker Compose / K8s ]        [ Sandboxed Chromium ]`}</pre>
                    </div>
                  </div>
                </article>
              )}

              {/* SECTION: Quickstart */}
              {activeDoc === 'quickstart' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={ComputerTerminal01Icon} size={16} />
                      <span>GETTING STARTED / QUICK START</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      60-Second Quick Start
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed">
                      Deploy the complete StackPilot platform locally or on a remote server with Docker Compose.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-2">
                      <span className="text-xs font-mono text-zinc-300 font-bold">1. Clone &amp; prepare environment</span>
                      <div className="p-3 rounded-xl bg-black font-mono text-xs text-zinc-200 border border-zinc-800 flex items-center justify-between">
                        <code>git clone https://github.com/AdityaRoy999/StackPilot.git &amp;&amp; cd StackPilot</code>
                        <button
                          onClick={() => copyCode('git clone https://github.com/AdityaRoy999/StackPilot.git && cd StackPilot', 'qs-1')}
                          className="text-zinc-400 hover:text-white cursor-pointer bg-transparent border-0"
                        >
                          {copiedSnippet === 'qs-1' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>

                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-2">
                      <span className="text-xs font-mono text-zinc-300 font-bold">2. Generate local secrets</span>
                      <div className="p-3 rounded-xl bg-black font-mono text-xs text-zinc-200 border border-zinc-800 flex items-center justify-between">
                        <code>cp production.env.template .env</code>
                        <button
                          onClick={() => copyCode('cp production.env.template .env', 'qs-2')}
                          className="text-zinc-400 hover:text-white cursor-pointer bg-transparent border-0"
                        >
                          {copiedSnippet === 'qs-2' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>

                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-2">
                      <span className="text-xs font-mono text-zinc-300 font-bold">3. Start the entire container stack</span>
                      <div className="p-3 rounded-xl bg-black font-mono text-xs text-zinc-200 border border-zinc-800 flex items-center justify-between">
                        <code>docker compose up -d --build</code>
                        <button
                          onClick={() => copyCode('docker compose up -d --build', 'qs-3')}
                          className="text-zinc-400 hover:text-white cursor-pointer bg-transparent border-0"
                        >
                          {copiedSnippet === 'qs-3' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Endpoints Table */}
                  <div className="rounded-2xl border border-zinc-800 bg-[#18181b]/90 p-5 space-y-3 font-mono text-xs">
                    <h3 className="font-semibold text-zinc-200 text-sm font-sans">Core Service Endpoints</h3>
                    <div className="divide-y divide-zinc-800 text-zinc-300">
                      <div className="py-2.5 flex items-center justify-between">
                        <span>StackPilot Dashboard</span>
                        <a href="http://localhost:3000" target="_blank" rel="noopener noreferrer" className="text-zinc-200 hover:underline">http://localhost:3000</a>
                      </div>
                      <div className="py-2.5 flex items-center justify-between">
                        <span>C++ Backend REST API</span>
                        <code className="text-zinc-300">http://localhost:8090/api/v1</code>
                      </div>
                      <div className="py-2.5 flex items-center justify-between">
                        <span>AI Service &amp; Model Gateway</span>
                        <code className="text-zinc-300">http://localhost:8010</code>
                      </div>
                      <div className="py-2.5 flex items-center justify-between">
                        <span>Grafana Observability</span>
                        <code className="text-zinc-300">http://localhost:3001</code>
                      </div>
                    </div>
                  </div>
                </article>
              )}

              {/* SECTION: Installation */}
              {activeDoc === 'install' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={Download04Icon} size={16} />
                      <span>GETTING STARTED / INSTALLATION</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Automated Installation Scripts
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed">
                      Deploy the complete StackPilot platform on Linux VPS, macOS, or Windows with a single command.
                    </p>
                  </div>

                  {/* Linux / macOS Snippet */}
                  <div className="space-y-2">
                    <span className="text-xs font-mono text-zinc-400 font-semibold">Linux VPS &amp; macOS (Bash / Zsh)</span>
                    <div className="relative group rounded-2xl border border-zinc-800 bg-[#18181b] p-4 font-mono text-xs text-zinc-200 flex items-center justify-between gap-4">
                      <code className="text-zinc-200 break-all">
                        curl -fsSL https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.sh | bash
                      </code>
                      <button
                        onClick={() => copyCode('curl -fsSL https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.sh | bash', 'inst-sh')}
                        className="w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center shrink-0 border-0 cursor-pointer transition-colors"
                        title="Copy command"
                      >
                        {copiedSnippet === 'inst-sh' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  {/* Windows PowerShell Snippet */}
                  <div className="space-y-2">
                    <span className="text-xs font-mono text-zinc-400 font-semibold">Windows (PowerShell)</span>
                    <div className="relative group rounded-2xl border border-zinc-800 bg-[#18181b] p-4 font-mono text-xs text-zinc-200 flex items-center justify-between gap-4">
                      <code className="text-zinc-200 break-all">
                        iwr -useb https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.ps1 | iex
                      </code>
                      <button
                        onClick={() => copyCode('iwr -useb https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.ps1 | iex', 'inst-ps1')}
                        className="w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center shrink-0 border-0 cursor-pointer transition-colors"
                        title="Copy command"
                      >
                        {copiedSnippet === 'inst-ps1' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-2 font-sans text-xs text-zinc-400">
                    <h4 className="font-semibold text-zinc-200">Prerequisites Checked by Script:</h4>
                    <ul className="list-disc list-inside space-y-1">
                      <li>Docker Engine 24.0+ and Docker Compose v2</li>
                      <li>Inbound open ports: 3000 (UI), 8090 (Backend), 8010 (AI Service)</li>
                      <li>At least 2 vCPUs and 2GB RAM (1.5GB baseline with low-memory configuration)</li>
                    </ul>
                  </div>
                </article>
              )}

              {/* SECTION: Architecture */}
              {activeDoc === 'architecture' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={Layers01Icon} size={16} />
                      <span>GETTING STARTED / ARCHITECTURE</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Deep-Dive: Subsystems &amp; Data Flow
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      StackPilot's architecture balances ultra-fast C++ asynchronous request handling with a flexible Python AI gateway and React/Next.js dashboard.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-1.5">
                      <span className="font-mono text-zinc-100 font-semibold text-sm">1. C++ Drogon Core Engine</span>
                      <p className="text-xs text-zinc-400 leading-relaxed font-sans">
                        Event-driven non-blocking HTTP/WebSocket server written in modern C++20. Handles authentication, RBAC, deployment state machines, project CRUD, and direct Docker socket orchestration with zero runtime garbage collection pauses.
                      </p>
                    </div>

                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-1.5">
                      <span className="font-mono text-zinc-100 font-semibold text-sm">2. Python AI Service &amp; Model Gateway</span>
                      <p className="text-xs text-zinc-400 leading-relaxed font-sans">
                        FastAPI service that interfaces with LLM providers (NVIDIA NIM, OpenAI, Anthropic, or local vLLM). Houses the APV (Accessibility, Proximity, Vision) engine and the autonomous browser crawler driver.
                      </p>
                    </div>

                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-1.5">
                      <span className="font-mono text-zinc-100 font-semibold text-sm">3. PostgreSQL with pgvector &amp; Redis</span>
                      <p className="text-xs text-zinc-400 leading-relaxed font-sans">
                        PostgreSQL stores users, credentials, build logs, and high-dimensional vector embeddings for AI memory. Redis manages ephemeral job queues and coordinates WebSocket pub/sub broadcasting.
                      </p>
                    </div>
                  </div>
                </article>
              )}

              {/* SECTION: Templates */}
              {activeDoc === 'templates' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={Settings02Icon} size={16} />
                      <span>GETTING STARTED / APPLICATION TEMPLATES</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Built-in Application Templates
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      Deploy standard databases, object storage, caches, and message brokers with zero configuration files required.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    {[
                      { name: 'PostgreSQL 16', desc: 'Relational database with persistent volume and pgvector extension pre-installed.' },
                      { name: 'MySQL 8 / MariaDB', desc: 'High-performance SQL engines with configurable root passwords and charsets.' },
                      { name: 'Redis Stack', desc: 'In-memory data store with RedisInsight management UI included.' },
                      { name: 'MinIO S3 Storage', desc: 'S3-compatible object storage with web management console and bucket policies.' },
                      { name: 'Grafana & Prometheus', desc: 'Complete observability suite with automated dashboard provisioning.' },
                      { name: 'NATS Messaging', desc: 'Ultra-lightweight cloud-native message broker with JetStream persistence.' }
                    ].map(app => (
                      <div key={app.name} className="p-3.5 rounded-2xl border border-zinc-800 bg-[#18181b]/80 flex flex-col gap-1">
                        <span className="font-semibold text-zinc-100 font-mono">{app.name}</span>
                        <span className="text-zinc-400 leading-relaxed">{app.desc}</span>
                      </div>
                    ))}
                  </div>
                </article>
              )}

              {/* SECTION: AI Operations Agent */}
              {activeDoc === 'ai-agent' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={CpuIcon} size={16} />
                      <span>AI &amp; AUTONOMOUS QA / AI AGENT</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      StackPilot AI Operations Agent
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      An intelligent agent operating directly on the deployment control plane. The agent diagnoses failing containers, inspects crash dumps, auto-generates compose configurations, and executes root cause repairs.
                    </p>
                  </div>

                  <div className="rounded-2xl border border-zinc-800 bg-[#18181b]/90 p-5 space-y-3 font-mono text-xs">
                    <span className="text-zinc-400 font-sans font-semibold">Example Natural Language Commands:</span>
                    <div className="p-3 rounded-xl bg-black border border-zinc-800 text-zinc-200 space-y-2">
                      <div className="text-zinc-400">&gt; "Deploy a clustered Redis instance with 2 replicas and password authentication"</div>
                      <div className="text-zinc-400">&gt; "Inspect deployment #84 and explain why the container exited with code 137"</div>
                      <div className="text-zinc-400">&gt; "Diagnose high memory usage on the frontend service and optimize Node flags"</div>
                    </div>
                  </div>
                </article>
              )}

              {/* SECTION: Screencasting */}
              {activeDoc === 'screencast' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={DashboardBrowsingIcon} size={16} />
                      <span>AI &amp; AUTONOMOUS QA / SCREENCAST</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      60 FPS Low-Latency Screencast
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      Real-time interactive canvas streaming directly from Chromium DevTools Protocol (CDP) WebSocket feeds. Unlike WebRTC, it requires zero STUN/TURN servers or open UDP ports.
                    </p>
                  </div>

                  <div className="p-5 rounded-2xl border border-zinc-800 bg-[#18181b]/90 space-y-3 font-mono text-xs">
                    <span className="text-zinc-400 font-sans font-semibold">CDP Screencast Configuration</span>
                    <div className="p-4 rounded-xl bg-black border border-zinc-800 text-zinc-300">
                      <pre>{`await cdp.send("Page.startScreencast", {
  format: "jpeg",
  quality: 80,
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1
});`}</pre>
                    </div>
                    <p className="text-xs text-zinc-400 font-sans">
                      Frames are decoded via <code className="text-zinc-200">createImageBitmap</code> in a dedicated Web Worker, blitting directly to an offscreen canvas with under 50ms glass-to-glass latency.
                    </p>
                  </div>
                </article>
              )}

              {/* SECTION: Sandboxing */}
              {activeDoc === 'sandboxing' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={GitBranchIcon} size={16} />
                      <span>AI &amp; AUTONOMOUS QA / SANDBOXING</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Chromium Kernel Sandboxing
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      Untrusted web applications executed by the autonomous agent run inside locked-down, rootless containers equipped with custom seccomp filters and isolated cgroups.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-1">
                      <span className="font-semibold text-zinc-200 font-mono">Rootless Execution</span>
                      <p className="text-zinc-400">Runs as unprivileged user (UID 1000) with no access to host filesystem.</p>
                    </div>
                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-1">
                      <span className="font-semibold text-zinc-200 font-mono">Memory Reclamation</span>
                      <p className="text-zinc-400">Kills browser processes and cleans IPC shared memory segments after each mission.</p>
                    </div>
                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-1">
                      <span className="font-semibold text-zinc-200 font-mono">Seccomp Filters</span>
                      <p className="text-zinc-400">Restricts dangerous kernel syscalls preventing sandbox breakout exploits.</p>
                    </div>
                  </div>
                </article>
              )}

              {/* SECTION: Replay */}
              {activeDoc === 'replay' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={HelpCircleIcon} size={16} />
                      <span>AI &amp; AUTONOMOUS QA / REPLAY</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Time-Travel Session Replay
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      Every test mission captures an indexed timeline of frames, synthetic mouse movements, keystrokes, and DOM snapshots. Developers can scrub back and forward to pinpoint the exact millisecond a failure occurred.
                    </p>
                  </div>

                  <div className="p-5 rounded-2xl border border-zinc-800 bg-[#18181b]/90 space-y-3 font-sans text-xs text-zinc-300">
                    <h3 className="font-semibold text-zinc-200 text-sm">Key Capabilities</h3>
                    <ul className="list-disc list-inside space-y-1.5 text-zinc-400">
                      <li>Scrubber slider with real-time frame seeking and playback speeds from 0.5x to 4x.</li>
                      <li>Interactive cursor ripples and element highlight overlays tied to agent thought logs.</li>
                      <li>Export recordings as portable JSON session files or MP4 video recordings.</li>
                    </ul>
                  </div>
                </article>
              )}

              {/* SECTION: Docker */}
              {activeDoc === 'docker' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={Settings02Icon} size={16} />
                      <span>DEPLOYMENT / DOCKER COMPOSE</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Docker Build &amp; Runtime Management
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      StackPilot communicates directly with the Docker Engine daemon (via local Unix socket or remote TCP/TLS) to orchestrate multi-container application stacks.
                    </p>
                  </div>

                  <div className="relative group rounded-2xl border border-zinc-800 bg-[#18181b] p-4 font-mono text-xs text-zinc-200">
                    <button
                      onClick={() => copyCode('docker compose -f docker-compose.prod.yml up -d --build', 'dc-prod')}
                      className="absolute top-4 right-4 w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center border-0 cursor-pointer transition-colors"
                      title="Copy command"
                    >
                      {copiedSnippet === 'dc-prod' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    <code className="text-zinc-200">docker compose -f docker-compose.prod.yml up -d --build</code>
                  </div>
                </article>
              )}

              {/* SECTION: Kubernetes */}
              {activeDoc === 'kubernetes' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={Layers01Icon} size={16} />
                      <span>DEPLOYMENT / KUBERNETES</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Kubernetes Cluster Integration
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      Deploy projects to local Kubernetes instances (k3s, Minikube, kind) or production cloud providers (AWS EKS, Google GKE, Azure AKS). StackPilot translates project specifications into native Deployments, Services, and Ingress resources.
                    </p>
                  </div>

                  <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-2 font-sans text-xs text-zinc-300">
                    <h4 className="font-semibold text-zinc-200">Features:</h4>
                    <ul className="list-disc list-inside space-y-1 text-zinc-400">
                      <li>Automatic namespace isolation per project environment.</li>
                      <li>ConfigMap and Secret injection with AES-256 encryption.</li>
                      <li>Rolling updates with automated health check probes.</li>
                    </ul>
                  </div>
                </article>
              )}

              {/* SECTION: MCP for IDE Agents */}
              {activeDoc === 'mcp' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={ComputerTerminal01Icon} size={16} />
                      <span>DEPLOYMENT / MCP SERVER</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Model Context Protocol (MCP) Server
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      Connect your AI coding assistants (Claude Code, Cursor, Codex, VS Code) directly to StackPilot. Agents can deploy code, check logs, inspect containers, and trigger test missions without leaving the editor.
                    </p>
                  </div>

                  <div className="p-5 rounded-2xl border border-zinc-800 bg-[#18181b]/90 space-y-3 font-mono text-xs">
                    <span className="text-zinc-400 font-sans font-semibold">Claude Code / Cursor Configuration (`mcpServers`):</span>
                    <div className="p-4 rounded-xl bg-black border border-zinc-800 text-zinc-300">
                      <pre>{`{
  "mcpServers": {
    "stackpilot": {
      "command": "node",
      "args": ["/path/to/StackPilot/mcp-server/dist/index.js"],
      "env": {
        "STACKPILOT_API_URL": "http://localhost:8090/api/v1",
        "STACKPILOT_API_TOKEN": "your-api-token"
      }
    }
  }
}`}</pre>
                    </div>
                  </div>
                </article>
              )}

              {/* SECTION: CI/CD & GitHub App */}
              {activeDoc === 'cicd' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={GitBranchIcon} size={16} />
                      <span>DEPLOYMENT / CI/CD PIPELINES</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      CI/CD &amp; GitHub App Automation
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      StackPilot integrates with GitHub Webhooks and GitHub Apps. Push events trigger automatic container rebuilding, ephemeral preview environments for Pull Requests, and commit status updates.
                    </p>
                  </div>

                  <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-2 font-sans text-xs text-zinc-300">
                    <h4 className="font-semibold text-zinc-200">Continuous Delivery Workflow:</h4>
                    <ol className="list-decimal list-inside space-y-1 text-zinc-400">
                      <li>Developer pushes code to branch or opens Pull Request.</li>
                      <li>GitHub sends signed webhook to StackPilot C++ API (`/api/v1/webhooks/github`).</li>
                      <li>Build worker compiles container image with layer caching.</li>
                      <li>AI QA agent executes autonomous regression test against preview URL.</li>
                      <li>Status badge and preview link posted back to GitHub PR.</li>
                    </ol>
                  </div>
                </article>
              )}

              {/* SECTION: Environment Variables */}
              {activeDoc === 'env' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={Settings02Icon} size={16} />
                      <span>CONFIGURATION / ENVIRONMENT VARIABLES</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Platform Environment Variables
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      Complete reference of core configuration options set in your `.env` file.
                    </p>
                  </div>

                  <div className="rounded-2xl border border-zinc-800 bg-[#18181b]/90 p-5 space-y-3 font-mono text-xs">
                    <div className="divide-y divide-zinc-800 text-zinc-300">
                      <div className="py-2 flex items-center justify-between">
                        <div>
                          <code className="text-white font-semibold">STACKPILOT_DOMAIN</code>
                          <div className="text-[11px] text-zinc-500 font-sans">Primary platform hostname</div>
                        </div>
                        <code className="text-zinc-400">localhost</code>
                      </div>
                      <div className="py-2 flex items-center justify-between">
                        <div>
                          <code className="text-white font-semibold">DB_USER / DB_PASSWORD</code>
                          <div className="text-[11px] text-zinc-500 font-sans">PostgreSQL credentials</div>
                        </div>
                        <code className="text-zinc-400">stackpilot_admin</code>
                      </div>
                      <div className="py-2 flex items-center justify-between">
                        <div>
                          <code className="text-white font-semibold">JWT_SECRET</code>
                          <div className="text-[11px] text-zinc-500 font-sans">Secret key for session tokens (48+ chars)</div>
                        </div>
                        <code className="text-zinc-400">aes-256-gcm</code>
                      </div>
                      <div className="py-2 flex items-center justify-between">
                        <div>
                          <code className="text-white font-semibold">TOKEN_ENCRYPTION_KEY</code>
                          <div className="text-[11px] text-zinc-500 font-sans">Encryption for stored project credentials</div>
                        </div>
                        <code className="text-zinc-400">32 bytes hex</code>
                      </div>
                      <div className="py-2 flex items-center justify-between">
                        <div>
                          <code className="text-white font-semibold">AI_SERVICE_PORT</code>
                          <div className="text-[11px] text-zinc-500 font-sans">Internal AI gateway port</div>
                        </div>
                        <code className="text-zinc-400">8010</code>
                      </div>
                    </div>
                  </div>
                </article>
              )}

              {/* SECTION: Observability */}
              {activeDoc === 'observability' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={DashboardBrowsingIcon} size={16} />
                      <span>CONFIGURATION / OBSERVABILITY</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Observability: Prometheus, Grafana &amp; Loki
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      StackPilot includes a full telemetry pipeline out of the box. Metrics and logs from deployed containers and system services are aggregated without external SaaS dependencies.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-sans">
                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-1">
                      <span className="font-semibold text-zinc-100 font-mono">cAdvisor &amp; Prometheus</span>
                      <p className="text-zinc-400">Continuous tracking of CPU, RAM, disk I/O, and network packet rates per container.</p>
                    </div>
                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-1">
                      <span className="font-semibold text-zinc-100 font-mono">Promtail &amp; Loki</span>
                      <p className="text-zinc-400">High-throughput log scraper streaming container stdout/stderr to indexed Loki storage.</p>
                    </div>
                  </div>
                </article>
              )}

              {/* SECTION: Troubleshooting */}
              {activeDoc === 'troubleshooting' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2">
                      <HugeiconsIcon icon={HelpCircleIcon} size={16} />
                      <span>CONFIGURATION / TROUBLESHOOTING</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Troubleshooting Guide
                    </h1>
                    <p className="mt-3 text-base text-zinc-300 leading-relaxed font-sans">
                      Solutions for common setup, network, and runtime issues.
                    </p>
                  </div>

                  <div className="space-y-3 text-xs font-sans">
                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-1">
                      <span className="font-semibold text-zinc-200 font-mono">Port Already in Use (3000, 8090, 8010)</span>
                      <p className="text-zinc-400">Run <code className="text-zinc-300 font-mono">docker compose ps</code> to check existing containers. Adjust the port mapping in `.env` if local host services conflict.</p>
                    </div>

                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-1">
                      <span className="font-semibold text-zinc-200 font-mono">Database Migration Retry</span>
                      <p className="text-zinc-400">If PostgreSQL is slow to initialize on cold start, the backend will automatically retry with exponential backoff (up to 30 seconds).</p>
                    </div>

                    <div className="p-4 rounded-2xl border border-zinc-800 bg-[#18181b]/80 space-y-1">
                      <span className="font-semibold text-zinc-200 font-mono">Docker Socket Permission Denied</span>
                      <p className="text-zinc-400">Ensure the user running StackPilot belongs to the <code className="text-zinc-300 font-mono">docker</code> group: <code className="text-zinc-300 font-mono">sudo usermod -aG docker $USER</code>.</p>
                    </div>
                  </div>
                </article>
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
};

export default DocsPage;
