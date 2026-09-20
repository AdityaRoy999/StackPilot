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
import { Copy, Check, ArrowLeft, ExternalLink, Search, Terminal, Shield, Zap, RefreshCw, Cpu, Layers } from 'lucide-react';
import { BranchedMenu, BranchedMenuItem } from '../components/reactbits/BranchedMenu';
import { GithubIcon } from '../components/icons/GithubIcon';
import { StarIcon } from '../components/icons/StarIcon';

interface DocsPageProps {
  onNavigateHome: () => void;
}

const DOCS_MENU_ITEMS: BranchedMenuItem[] = [
  {
    label: 'Getting Started',
    children: [
      { value: 'overview', label: 'Overview', icon: Rocket01Icon },
      { value: 'install', label: 'Installation', icon: Download04Icon },
      { value: 'quickstart', label: 'Quick Start', icon: ComputerTerminal01Icon },
      { value: 'architecture', label: 'Architecture', icon: Layers01Icon }
    ]
  },
  {
    label: 'Core Capabilities',
    children: [
      { value: 'screencast', label: '60 FPS Screencast', icon: DashboardBrowsingIcon },
      { value: 'self-healing', label: 'Self-Healing Engine', icon: CpuIcon },
      { value: 'sandboxing', label: 'Chromium Sandboxing', icon: GitBranchIcon },
      { value: 'replay', label: 'Time-Travel Replay', icon: HelpCircleIcon }
    ]
  },
  {
    label: 'Deployment & Setup',
    children: [
      { value: 'docker', label: 'Docker Compose', icon: Settings02Icon },
      { value: 'cli', label: 'StackPilot CLI', icon: ComputerTerminal01Icon },
      { value: 'cicd', label: 'GitHub Actions & CI/CD', icon: GitBranchIcon }
    ]
  },
  {
    label: 'Configuration & Reference',
    children: [
      { value: 'env', label: 'Environment Variables', icon: Settings02Icon },
      { value: 'protocols', label: 'Protocols & CDP', icon: Layers01Icon }
    ]
  }
];

export const DocsPage: React.FC<DocsPageProps> = ({ onNavigateHome }) => {
  const [activeDoc, setActiveDoc] = useState<string>('overview');
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const copyCode = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSnippet(id);
    setTimeout(() => setCopiedSnippet(null), 2000);
  };

  // Scroll to top of content on section change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setMobileMenuOpen(false);
  }, [activeDoc]);

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col selection:bg-zinc-800 selection:text-zinc-100 font-sans antialiased">
      {/* Top Header */}
      <header className="sticky top-0 z-50 w-full border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          {/* Left: Brand & Back */}
          <div className="flex items-center gap-3 sm:gap-4">
            <button
              onClick={onNavigateHome}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#1c1c1e] hover:bg-[#28282c] text-zinc-300 hover:text-white text-xs font-mono transition-all duration-200 cursor-pointer border-0"
              title="Return to StackPilot Home"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Home</span>
            </button>

            <div className="h-4 w-[1px] bg-zinc-800 select-none hidden sm:block" />

            <button
              onClick={onNavigateHome}
              className="flex items-center gap-2 text-sm font-semibold tracking-tight text-white hover:text-emerald-400 transition-colors cursor-pointer bg-transparent border-0 p-0"
            >
              <span className="font-mono text-emerald-400 font-bold">&gt;_</span>
              <span>StackPilot Docs</span>
            </button>
          </div>

          {/* Center / Right: Quick Search & GitHub */}
          <div className="flex items-center gap-2.5 sm:gap-3">
            <div className="relative hidden md:flex items-center">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 pointer-events-none" />
              <input
                type="text"
                placeholder="Search docs (e.g. Docker, CDP, Replay)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-64 pl-8 pr-3 py-1.5 rounded-full bg-[#141416] border border-zinc-800/80 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition-all font-mono"
              />
            </div>

            {/* Mobile Menu Toggle */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#1c1c1e] text-xs font-mono text-zinc-300 hover:text-white border-0 cursor-pointer"
            >
              <span>{mobileMenuOpen ? 'Close Menu' : 'Browse Topics'}</span>
            </button>

            {/* GitHub Stars */}
            <a
              href="https://github.com/AdityaRoy999/StackPilot"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#1c1c1e] hover:bg-[#262629] text-xs text-zinc-300 hover:text-white transition-all border-0"
            >
              <GithubIcon className="w-3.5 h-3.5 text-white shrink-0" />
              <span className="hidden sm:inline">Repo</span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#28282c] text-[10px] font-mono text-zinc-300">
                <StarIcon className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                <span>Star</span>
              </span>
            </a>
          </div>
        </div>
      </header>

      {/* Main Container with Sidebar + Content */}
      <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 flex gap-8">
        {/* Left Sidebar (Desktop & Mobile Dropdown) */}
        <aside
          className={`lg:w-64 shrink-0 transition-all duration-300 z-30 ${
            mobileMenuOpen
              ? 'fixed inset-x-4 top-20 bottom-4 bg-zinc-950/95 backdrop-blur-2xl border border-zinc-800 rounded-2xl p-6 overflow-y-auto block shadow-2xl'
              : 'hidden lg:block'
          }`}
        >
          <div className="sticky top-24 flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase tracking-widest text-zinc-500 font-semibold">
                Documentation
              </span>
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-[10px] font-mono font-medium">
                v1.0.0
              </span>
            </div>

            {/* React Bits BranchedMenu Component */}
            <div className="py-1">
              <BranchedMenu
                items={DOCS_MENU_ITEMS}
                defaultOpen={[0, 1, 2, 3]}
                defaultActive={activeDoc}
                onSelect={(val) => {
                  setActiveDoc(val);
                  setMobileMenuOpen(false);
                }}
                color="#e4e4e7"
                accentColor="#10b981"
                lineColor="#27272a"
                width={250}
                rowHeight={34}
                indent={32}
                fontSize={13}
              />
            </div>

            {/* Quick Link to Cockpit */}
            <div className="mt-4 p-3.5 rounded-xl border border-zinc-800/80 bg-zinc-950/80 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                <span>Live Browser Cockpit</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed font-sans">
                Access the real-time canvas feed at port <code className="text-zinc-200 font-mono">3000</code>.
              </p>
              <a
                href="http://localhost:3000"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-mono text-emerald-400 hover:text-emerald-300 font-medium"
              >
                <span>Open Cockpit</span>
                <ExternalLink className="w-3 h-3" />
              </a>
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
                    <div className="flex items-center gap-2 text-xs font-mono text-emerald-400 mb-2">
                      <HugeiconsIcon icon={Rocket01Icon} size={16} />
                      <span>GETTING STARTED / OVERVIEW</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      StackPilot Architecture &amp; Vision
                    </h1>
                    <p className="mt-3 text-base text-zinc-400 leading-relaxed font-sans">
                      StackPilot is an autonomous, self-healing AI QA and verification engine that executes real web actions inside an isolated, hardware-accelerated Chromium sandbox while streaming interactive 60 FPS screencasts with sub-50ms latency.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="p-4 rounded-xl border border-zinc-800/80 bg-zinc-900/40 flex flex-col gap-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
                        <Zap className="w-4 h-4 text-amber-400" />
                        <span>Sub-50ms Latency</span>
                      </div>
                      <p className="text-xs text-zinc-400 leading-relaxed">
                        Direct Chromium DevTools Protocol (CDP) WebSocket frame capture without WebRTC handshake overhead or port collisions.
                      </p>
                    </div>

                    <div className="p-4 rounded-xl border border-zinc-800/80 bg-zinc-900/40 flex flex-col gap-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
                        <Shield className="w-4 h-4 text-emerald-400" />
                        <span>Kernel-Level Sandboxing</span>
                      </div>
                      <p className="text-xs text-zinc-400 leading-relaxed">
                        Unprivileged container execution, custom seccomp profiles, and clean memory reclamation on every session termination.
                      </p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-800/80 bg-zinc-950 p-5 space-y-3">
                    <h3 className="text-sm font-semibold text-zinc-200 font-mono flex items-center gap-2">
                      <Layers className="w-4 h-4 text-emerald-400" />
                      <span>High-Level System Topology</span>
                    </h3>
                    <div className="p-4 rounded-lg bg-black font-mono text-xs text-zinc-300 leading-relaxed overflow-x-auto border border-zinc-900">
                      <pre>{`[ Frontend Canvas ] <--- Binary WS Frame Stream (60 FPS) <--- [ FastAPI Core ]
         |                                                           |
         +--- Mouse/Keyboard Events (JSON WS) --------------------+  | CDP Session
                                                                  v  v
                                                       [ Sandboxed Chromium ]`}</pre>
                    </div>
                  </div>
                </article>
              )}

              {/* SECTION: Installation */}
              {activeDoc === 'install' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-emerald-400 mb-2">
                      <HugeiconsIcon icon={Download04Icon} size={16} />
                      <span>GETTING STARTED / INSTALLATION</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      One-Liner Installation
                    </h1>
                    <p className="mt-3 text-base text-zinc-400 leading-relaxed">
                      Deploy the entire autonomous testing suite in less than 30 seconds across Linux, macOS, or Windows with a single command.
                    </p>
                  </div>

                  {/* Linux / macOS Snippet */}
                  <div className="space-y-2">
                    <span className="text-xs font-mono text-zinc-400 font-semibold">Linux &amp; macOS (Bash / Zsh)</span>
                    <div className="relative group rounded-xl border border-zinc-800/80 bg-[#141416] p-4 font-mono text-xs text-zinc-200 flex items-center justify-between gap-4">
                      <code className="text-emerald-400 break-all">
                        curl -fsSL https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.sh | bash
                      </code>
                      <button
                        onClick={() => copyCode('curl -fsSL https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.sh | bash', 'install-sh')}
                        className="w-8 h-8 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center shrink-0 border-0 cursor-pointer transition-colors"
                        title="Copy command"
                      >
                        {copiedSnippet === 'install-sh' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  {/* Windows PowerShell Snippet */}
                  <div className="space-y-2">
                    <span className="text-xs font-mono text-zinc-400 font-semibold">Windows (PowerShell)</span>
                    <div className="relative group rounded-xl border border-zinc-800/80 bg-[#141416] p-4 font-mono text-xs text-zinc-200 flex items-center justify-between gap-4">
                      <code className="text-sky-400 break-all">
                        iwr -useb https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.ps1 | iex
                      </code>
                      <button
                        onClick={() => copyCode('iwr -useb https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.ps1 | iex', 'install-ps1')}
                        className="w-8 h-8 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center shrink-0 border-0 cursor-pointer transition-colors"
                        title="Copy command"
                      >
                        {copiedSnippet === 'install-ps1' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  {/* Requirements note */}
                  <div className="p-4 rounded-xl border border-zinc-800/80 bg-zinc-950/60 space-y-2">
                    <h4 className="text-xs font-mono font-semibold text-zinc-200">System Prerequisites:</h4>
                    <ul className="list-disc list-inside text-xs text-zinc-400 space-y-1 font-sans">
                      <li>Docker Engine 24.0+ &amp; Docker Compose v2</li>
                      <li>Minimum 2 vCPUs and 2GB RAM (1.5GB baseline with low-memory mode)</li>
                      <li>Open inbound ports: <code className="text-zinc-200 font-mono">3000</code> (Cockpit Web) and <code className="text-zinc-200 font-mono">8000</code> (FastAPI Core)</li>
                    </ul>
                  </div>
                </article>
              )}

              {/* SECTION: Quickstart */}
              {activeDoc === 'quickstart' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-emerald-400 mb-2">
                      <HugeiconsIcon icon={ComputerTerminal01Icon} size={16} />
                      <span>GETTING STARTED / QUICK START</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      60-Second Quick Start
                    </h1>
                    <p className="mt-3 text-base text-zinc-400 leading-relaxed">
                      Initialize your first autonomous test run in three simple steps.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div className="p-4 rounded-xl border border-zinc-800/80 bg-zinc-950 space-y-2">
                      <span className="text-xs font-mono text-emerald-400 font-bold">Step 1: Start the services</span>
                      <div className="p-3 rounded-lg bg-black font-mono text-xs text-zinc-200 border border-zinc-900 flex items-center justify-between">
                        <code>docker compose up -d</code>
                        <button
                          onClick={() => copyCode('docker compose up -d', 'step-1')}
                          className="text-zinc-400 hover:text-white cursor-pointer bg-transparent border-0"
                        >
                          {copiedSnippet === 'step-1' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>

                    <div className="p-4 rounded-xl border border-zinc-800/80 bg-zinc-950 space-y-2">
                      <span className="text-xs font-mono text-emerald-400 font-bold">Step 2: Dispatch a test mission</span>
                      <div className="p-3 rounded-lg bg-black font-mono text-xs text-zinc-200 border border-zinc-900 flex items-center justify-between">
                        <code>stackpilot run https://app.yourdomain.com --heal --headless=false</code>
                        <button
                          onClick={() => copyCode('stackpilot run https://app.yourdomain.com --heal --headless=false', 'step-2')}
                          className="text-zinc-400 hover:text-white cursor-pointer bg-transparent border-0"
                        >
                          {copiedSnippet === 'step-2' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>

                    <div className="p-4 rounded-xl border border-zinc-800/80 bg-zinc-950 space-y-2">
                      <span className="text-xs font-mono text-emerald-400 font-bold">Step 3: Monitor in Live Cockpit</span>
                      <p className="text-xs text-zinc-400 leading-relaxed font-sans">
                        Open your browser at <a href="http://localhost:3000" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">http://localhost:3000</a> to observe real-time AI autonomous navigation, element highlighting, and inspect frame-by-frame logs.
                      </p>
                    </div>
                  </div>
                </article>
              )}

              {/* SECTION: Architecture */}
              {activeDoc === 'architecture' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-emerald-400 mb-2">
                      <HugeiconsIcon icon={Layers01Icon} size={16} />
                      <span>ARCHITECTURE / DEEP DIVE</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Internal Engine Architecture
                    </h1>
                    <p className="mt-3 text-base text-zinc-400 leading-relaxed">
                      Discover how StackPilot synchronizes AI agent reasoning, Chrome DevTools Protocol events, and low-latency canvas blitting.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div className="p-5 rounded-xl border border-zinc-800/80 bg-zinc-950 space-y-3">
                      <h3 className="text-sm font-semibold text-zinc-200 font-mono">Core Subsystems</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-zinc-300 font-sans">
                        <div className="p-3 rounded-lg bg-zinc-900/60 border border-zinc-800/60">
                          <span className="font-mono text-emerald-400 font-semibold block mb-1">browser_driver.py</span>
                          Manages raw CDP connection lifecycle, screencasting events, and mouse/keyboard synthetic inputs.
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-900/60 border border-zinc-800/60">
                          <span className="font-mono text-emerald-400 font-semibold block mb-1">InteractiveCanvas</span>
                          Renders incoming JPEG binary frames via <code className="text-zinc-200">createImageBitmap</code> into an offscreen HTML5 canvas with ripple animations.
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-900/60 border border-zinc-800/60">
                          <span className="font-mono text-emerald-400 font-semibold block mb-1">ai-service</span>
                          Multimodal reasoning loop (GPT-4o / Claude 3.5 Sonnet) that reads accessibility trees and generates deterministic actions.
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-900/60 border border-zinc-800/60">
                          <span className="font-mono text-emerald-400 font-semibold block mb-1">ReplayEngine</span>
                          In-memory circular frame buffer with scrubber controls, speed scaling (0.5x - 4x), and step annotations.
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              )}

              {/* SECTION: 60 FPS Screencast */}
              {activeDoc === 'screencast' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-emerald-400 mb-2">
                      <HugeiconsIcon icon={DashboardBrowsingIcon} size={16} />
                      <span>CORE CAPABILITIES / STREAMING</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      60 FPS Low-Latency Screencast
                    </h1>
                    <p className="mt-3 text-base text-zinc-400 leading-relaxed">
                      StackPilot avoids heavyweight WebRTC stacks by utilizing native <code className="text-zinc-200 font-mono">Page.startScreencast</code> over binary WebSockets with adaptive backpressure management.
                    </p>
                  </div>

                  <div className="p-5 rounded-xl border border-zinc-800/80 bg-zinc-950 space-y-3">
                    <h3 className="text-sm font-semibold text-zinc-200 font-mono">Screencast Configuration Parameters</h3>
                    <div className="p-3 rounded-lg bg-black font-mono text-xs text-zinc-300 border border-zinc-900">
                      <pre>{`await cdp.send("Page.startScreencast", {
  format: "jpeg",
  quality: 80,
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1
});`}</pre>
                    </div>
                    <p className="text-xs text-zinc-400 font-sans">
                      Frames are immediately blitted into the client canvas using zero-copy transfers, eliminating browser garbage collector spikes.
                    </p>
                  </div>
                </article>
              )}

              {/* SECTION: Self-Healing */}
              {activeDoc === 'self-healing' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-emerald-400 mb-2">
                      <HugeiconsIcon icon={CpuIcon} size={16} />
                      <span>CORE CAPABILITIES / RESILIENCE</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Self-Healing AI QA Engine
                    </h1>
                    <p className="mt-3 text-base text-zinc-400 leading-relaxed">
                      Traditional Selenium/Cypress tests break whenever CSS selectors or DOM structures change. StackPilot continuously resolves element intent dynamically using semantic trees and vision models.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="p-4 rounded-xl border border-zinc-800/80 bg-zinc-950 space-y-1.5">
                      <span className="text-xs font-mono text-emerald-400 font-semibold">1. Failure Detection</span>
                      <p className="text-xs text-zinc-400">Captures DOM state and visual diff upon element location failure.</p>
                    </div>
                    <div className="p-4 rounded-xl border border-zinc-800/80 bg-zinc-950 space-y-1.5">
                      <span className="text-xs font-mono text-amber-400 font-semibold">2. Semantic Discovery</span>
                      <p className="text-xs text-zinc-400">Maps accessibility labels, ARIA landmarks, and visual proximity.</p>
                    </div>
                    <div className="p-4 rounded-xl border border-zinc-800/80 bg-zinc-950 space-y-1.5">
                      <span className="text-xs font-mono text-sky-400 font-semibold">3. Autonomous Patch</span>
                      <p className="text-xs text-zinc-400">Executes action and writes back updated locator recommendations.</p>
                    </div>
                  </div>
                </article>
              )}

              {/* SECTION: Docker */}
              {activeDoc === 'docker' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-emerald-400 mb-2">
                      <HugeiconsIcon icon={Settings02Icon} size={16} />
                      <span>DEPLOYMENT / DOCKER COMPOSE</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      Docker Compose Stack
                    </h1>
                    <p className="mt-3 text-base text-zinc-400 leading-relaxed">
                      Deploy the production containerized stack with pre-configured network isolation and volume mounts.
                    </p>
                  </div>

                  <div className="relative group rounded-xl border border-zinc-800/80 bg-[#141416] p-4 font-mono text-xs text-zinc-200">
                    <button
                      onClick={() => copyCode('docker compose -f docker-compose.prod.yml up -d', 'docker-cmd')}
                      className="absolute top-4 right-4 w-8 h-8 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center border-0 cursor-pointer transition-colors"
                      title="Copy command"
                    >
                      {copiedSnippet === 'docker-cmd' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    <code className="text-zinc-300">docker compose -f docker-compose.prod.yml up -d</code>
                  </div>
                </article>
              )}

              {/* SECTION: CLI */}
              {activeDoc === 'cli' && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-emerald-400 mb-2">
                      <HugeiconsIcon icon={ComputerTerminal01Icon} size={16} />
                      <span>DEPLOYMENT / CLI TOOL</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
                      StackPilot CLI Command Reference
                    </h1>
                    <p className="mt-3 text-base text-zinc-400 leading-relaxed">
                      The standalone <code className="text-zinc-200 font-mono">stackpilot</code> executable lets developers orchestrate and diagnose runs directly from their local terminal.
                    </p>
                  </div>

                  <div className="space-y-3 font-mono text-xs">
                    <div className="p-3.5 rounded-xl border border-zinc-800/80 bg-zinc-950 flex flex-col gap-1">
                      <div className="flex items-center justify-between text-emerald-400 font-semibold">
                        <span>stackpilot init</span>
                        <span className="text-[10px] text-zinc-500 font-normal">Scaffold configuration</span>
                      </div>
                      <p className="text-zinc-400 font-sans text-xs">Generates <code className="text-zinc-200">stackpilot.config.json</code> in the current project root.</p>
                    </div>

                    <div className="p-3.5 rounded-xl border border-zinc-800/80 bg-zinc-950 flex flex-col gap-1">
                      <div className="flex items-center justify-between text-emerald-400 font-semibold">
                        <span>stackpilot run &lt;target_url&gt;</span>
                        <span className="text-[10px] text-zinc-500 font-normal">Execute test mission</span>
                      </div>
                      <p className="text-zinc-400 font-sans text-xs">Launches autonomous crawler agent against target endpoint.</p>
                    </div>

                    <div className="p-3.5 rounded-xl border border-zinc-800/80 bg-zinc-950 flex flex-col gap-1">
                      <div className="flex items-center justify-between text-emerald-400 font-semibold">
                        <span>stackpilot logs --tail</span>
                        <span className="text-[10px] text-zinc-500 font-normal">Stream live runtime logs</span>
                      </div>
                      <p className="text-zinc-400 font-sans text-xs">Streams real-time structured CDP and LLM thought logs.</p>
                    </div>
                  </div>
                </article>
              )}

              {/* Fallback for other sections */}
              {!['overview', 'install', 'quickstart', 'architecture', 'screencast', 'self-healing', 'docker', 'cli'].includes(activeDoc) && (
                <article className="space-y-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono text-emerald-400 mb-2">
                      <HugeiconsIcon icon={Settings02Icon} size={16} />
                      <span>CONFIGURATION REFERENCE</span>
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white capitalize">
                      {activeDoc.replace('-', ' ')}
                    </h1>
                    <p className="mt-3 text-base text-zinc-400 leading-relaxed font-sans">
                      Complete specification, parameters, and environment overrides for this subsystem.
                    </p>
                  </div>

                  <div className="p-5 rounded-xl border border-zinc-800/80 bg-zinc-950 space-y-3 font-mono text-xs">
                    <div className="flex items-center justify-between border-b border-zinc-800 pb-2 text-zinc-400">
                      <span>VARIABLE</span>
                      <span>DEFAULT</span>
                    </div>
                    <div className="flex items-center justify-between text-zinc-200">
                      <code>STACKPILOT_PORT</code>
                      <code className="text-emerald-400">3000</code>
                    </div>
                    <div className="flex items-center justify-between text-zinc-200">
                      <code>CDP_HEADLESS</code>
                      <code className="text-emerald-400">new</code>
                    </div>
                    <div className="flex items-center justify-between text-zinc-200">
                      <code>STREAM_FPS</code>
                      <code className="text-emerald-400">60</code>
                    </div>
                    <div className="flex items-center justify-between text-zinc-200">
                      <code>AI_MODEL</code>
                      <code className="text-emerald-400">gpt-4o</code>
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
