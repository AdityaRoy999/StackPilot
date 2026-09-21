import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Copy01Icon,
  Tick01Icon,
  ComputerTerminal01Icon
} from '@hugeicons/core-free-icons';
import { MacTrafficLights } from './docs/CodeBlock';
import { highlightCode } from '../utils/syntaxHighlight';

export type InstallScriptTab = 
  | 'bash' 
  | 'powershell' 
  | 'docker' 
  | 'core' 
  | 'cli' 
  | 'github-actions' 
  | 'embed'
  | 'drogon'
  | 'uninstall';

interface ScriptMetadata {
  id: InstallScriptTab;
  label: string;
  os: string;
  command: string;
  description: string;
  prerequisites: string[];
  flags: { flag: string; desc: string }[];
  expectedTime: string;
}

const BASE_HOST = 'https://stackpilot.vercel.app';

const getOrigin = (): string => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return BASE_HOST;
};

export const ALL_INSTALL_SCRIPTS: ScriptMetadata[] = [
  {
    id: 'bash',
    label: 'Linux / macOS (Bash)',
    os: 'Ubuntu 20.04+, Debian 11+, RHEL/CentOS 8+, macOS 12+ (Apple Silicon & Intel)',
    command: `curl -fsSL ${BASE_HOST}/install.sh | bash`,
    description: 'Autonomous one-liner installer. Automatically detects distribution, installs Docker Engine & Compose v2 if missing, verifies GPU/AVX2 acceleration, sets up bridge networking, and launches StackPilot.',
    prerequisites: ['curl', 'sudo / root privileges', 'Ports 3000, 8090, 8010 open'],
    flags: [
      { flag: '--profile core', desc: 'Deploy lightweight 1.5GB RAM footprint (FastAPI + Chromium + Next.js)' },
      { flag: '--profile full', desc: 'Deploy entire enterprise suite including C++ Drogon engine' },
      { flag: '--profile monitoring', desc: 'Include Prometheus, Grafana, and Loki observability stack' },
      { flag: '--port 8080', desc: 'Override default UI ingress port' }
    ],
    expectedTime: '~45 seconds',
  },
  {
    id: 'powershell',
    label: 'Windows (PowerShell)',
    os: 'Windows 10/11 Pro, Enterprise, or Server 2022 (WSL2 / Docker Desktop)',
    command: `powershell -ExecutionPolicy Bypass -c "irm ${BASE_HOST}/install.ps1 | iex"`,
    description: 'Native Windows deployment script. Verifies WSL2 virtual machine platform, checks Docker Desktop daemon named pipes, initializes environment secrets, and pulls production images.',
    prerequisites: ['PowerShell 5.1+ or 7+', 'Docker Desktop with WSL2 backend enabled', 'Administrator privileges'],
    flags: [
      { flag: '-Profile Core', desc: 'Launch minimal footprint without heavy observability agents' },
      { flag: '-Profile Full', desc: 'Launch full stack with local pgvector and Drogon core' },
      { flag: '-SkipPrereq', desc: 'Bypass automatic Docker version validation' }
    ],
    expectedTime: '~60 seconds',
  },
  {
    id: 'docker',
    label: 'Docker Compose (Manual)',
    os: 'Any system with Docker 24.0+ and Docker Compose v2.20+',
    command: 'git clone https://github.com/AdityaRoy999/StackPilot.git && cd StackPilot && docker compose up -d',
    description: 'Direct Git clone and Compose orchestration for production servers and infrastructure-as-code pipelines. Full control over volumes, env variables, and network bridges.',
    prerequisites: ['git', 'docker-compose-plugin >= 2.20.0'],
    flags: [
      { flag: 'docker compose up -d', desc: 'Start all core containers in detached background daemon mode' },
      { flag: 'docker compose --profile full up -d', desc: 'Launch full enterprise configuration' },
      { flag: 'docker compose logs -f ai-service', desc: 'Follow live autonomous QA agent logs and CDP events' }
    ],
    expectedTime: '~90 seconds (image pull)',
  },
  {
    id: 'core',
    label: 'Core QA (1.5GB VPS)',
    os: 'Low-resource Virtual Private Servers (DigitalOcean $6/mo, Hetzner CX22, AWS t4g.small)',
    command: `curl -fsSL ${BASE_HOST}/install.sh | bash -s -- --profile core`,
    description: 'Tuned specifically for budget VPS hardware. Replaces heavyweight model gateways with a compact quant-optimized CDP pipeline and disables unused telemetry daemons.',
    prerequisites: ['1.5GB RAM minimum', '1 vCPU', '5GB free disk space'],
    flags: [
      { flag: '--profile core', desc: 'Restricts heap allocations and limits Chromium worker tabs to 2 concurrency' },
      { flag: '--swap 2G', desc: 'Automatically creates 2GB swap space if physical RAM is under 2GB' }
    ],
    expectedTime: '~40 seconds',
  },
  {
    id: 'cli',
    label: 'Python CLI (`stackpilot`)',
    os: 'Python 3.10+ on Linux, macOS, or Windows',
    command: 'git clone https://github.com/AdityaRoy999/StackPilot.git && cd StackPilot/stackpilot-cli && pip install -e . && stackpilot doctor',
    description: 'Developer workstation CLI client. Enables headless test execution from your terminal, automated site crawling, CI verification, and local diagnostic health auditing.',
    prerequisites: ['Python 3.10 or higher', 'pip and venv'],
    flags: [
      { flag: 'stackpilot doctor', desc: 'Verify local CDP connection, Docker daemon status, and API tokens' },
      { flag: 'stackpilot test <url> --depth 3', desc: 'Trigger full autonomous recursive crawl and test on target URL' },
      { flag: 'stackpilot replay <run-id>', desc: 'Launch interactive 60 FPS time-travel session scrubber' }
    ],
    expectedTime: '~20 seconds',
  },
  {
    id: 'github-actions',
    label: 'GitHub Actions CI/CD',
    os: 'GitHub Hosted (ubuntu-latest) or Self-Hosted Actions Runner',
    command: `# .github/workflows/stackpilot-qa.yml
name: StackPilot Autonomous QA
on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  autonomous-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run StackPilot 60 FPS Autonomous QA
        uses: AdityaRoy999/StackPilot-action@v2
        with:
          target-url: "https://staging.myapp.com"
          max-depth: 3
          timeout-seconds: 180
          fail-on-regression: true`,
    description: 'Continuous integration workflow YAML. Dispatches an autonomous AI QA test on every pull request, streams screencast artifacts, and leaves an audit comment with video replay links.',
    prerequisites: ['GitHub Actions enabled repository', 'Publicly accessible or VPN staging URL'],
    flags: [
      { flag: 'max-depth: 3', desc: 'Explore up to 3 levels of subpages and dynamic cards' },
      { flag: 'fail-on-regression: true', desc: 'Exit code 1 if visual, form, or console error detected' }
    ],
    expectedTime: 'Runs in CI job (< 2 min)',
  },
  {
    id: 'embed',
    label: 'In-Page Web Embed',
    os: 'Any web application (Next.js, Vite, React, Vue, HTML5)',
    command: `<!-- StackPilot Autonomous In-Page Audit Trigger -->
<script 
  src="${BASE_HOST}/pilot.js" 
  data-project="sp_live_992" 
  data-stream="60fps" 
  async>
</script>`,
    description: 'Client-side agent beacon. Embeds a lightweight diagnostic trigger script that connects your staging preview directly to your self-hosted StackPilot instance for real-time user session replay.',
    prerequisites: ['Access to target website HTML <head> or <body>'],
    flags: [
      { flag: 'data-project', desc: 'Unique project identifier matching your Drogon core project ID' },
      { flag: 'data-stream="60fps"', desc: 'Enable ultra-smooth binary WebSocket screen capture' }
    ],
    expectedTime: 'Instant (< 10ms CDN load)',
  },
  {
    id: 'drogon',
    label: 'C++ Drogon Core Engine',
    os: 'Linux (GCC 11+ / Clang 13+), CMake 3.20+, Drogon Framework',
    command: 'git clone https://github.com/AdityaRoy999/StackPilot.git && cd StackPilot/backend && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)',
    description: 'Compile the native C++20 Drogon backend engine directly from source without Docker. Ideal for bare-metal servers requiring maximum I/O throughput and sub-millisecond REST latency.',
    prerequisites: ['cmake >= 3.20', 'g++ >= 11 or clang++ >= 13', 'libjsoncpp-dev, uuid-dev, zlib1g-dev, libtrantor-dev'],
    flags: [
      { flag: '-DCMAKE_BUILD_TYPE=Release', desc: 'Compile with -O3 optimization flags and strip debug symbols' },
      { flag: '-j$(nproc)', desc: 'Parallelize compilation across all available CPU cores' }
    ],
    expectedTime: '~2-3 minutes',
  },
  {
    id: 'uninstall',
    label: 'Uninstall & Purge',
    os: 'Linux VPS & macOS',
    command: `curl -fsSL ${BASE_HOST}/uninstall.sh | bash`,
    description: 'Completely stops all StackPilot containers, removes images, purges volume data (optional prompt), clears local network bridges, and resets Docker daemon state cleanly.',
    prerequisites: ['sudo / root privileges'],
    flags: [
      { flag: '--purge-data', desc: 'Delete PostgreSQL database volumes and persistent logs' },
      { flag: '--keep-images', desc: 'Retain downloaded Docker images for quick reinstallation' }
    ],
    expectedTime: '~15 seconds',
  },
];

export const InstallationScriptViewer: React.FC = () => {
  const [activeTab, setActiveTab] = useState<InstallScriptTab>('bash');
  const [copied, setCopied] = useState(false);
  const [hoveredTab, setHoveredTab] = useState<InstallScriptTab | null>(null);
  const [profile, setProfile] = useState<'core' | 'full' | 'monitoring'>('full');

  const selectedScript = ALL_INSTALL_SCRIPTS.find(s => s.id === activeTab) || ALL_INSTALL_SCRIPTS[0];

  // Dynamic command generator based on active tab and profile
  const getComputedCommand = () => {
    const host = getOrigin();
    if (activeTab === 'bash') {
      const profileFlag = profile === 'core' ? ' --profile core' : profile === 'full' ? ' --profile full' : ' --profile monitoring';
      return `curl -fsSL ${host}/install.sh | bash -s --${profileFlag}`;
    }
    if (activeTab === 'powershell') {
      const profileFlag = profile === 'core' ? ' -Profile Core' : profile === 'full' ? ' -Profile Full' : ' -Profile Monitoring';
      return `powershell -ExecutionPolicy Bypass -c "irm ${host}/install.ps1 | iex"${profile === 'full' ? '' : profileFlag}`;
    }
    if (activeTab === 'docker') {
      const profileFlag = profile === 'core' ? ' --profile core' : profile === 'full' ? '' : ' --profile monitoring';
      return `git clone https://github.com/AdityaRoy999/StackPilot.git && cd StackPilot && docker compose${profileFlag} up -d`;
    }
    return selectedScript.command.replace(BASE_HOST, host);
  };

  const currentCommand = getComputedCommand();
  const isMultiLine = currentCommand.includes('\n');

  const getBadgeLabel = () => {
    switch (selectedScript.id) {
      case 'powershell': return 'POWERSHELL';
      case 'docker': return 'DOCKER COMPOSE';
      case 'core': return 'BASH (CORE VPS)';
      case 'cli': return 'PYTHON CLI';
      case 'github-actions': return 'GITHUB ACTIONS (YAML)';
      case 'embed': return 'HTML EMBED';
      case 'drogon': return 'C++ CMAKE';
      case 'uninstall': return 'BASH (PURGE)';
      default: return 'BASH (SHELL)';
    }
  };

  const getSubtitle = () => {
    switch (selectedScript.id) {
      case 'bash':
      case 'powershell':
      case 'core':
        return 'One-Click Installer';
      case 'docker':
        return 'Compose Orchestration';
      case 'cli':
        return 'Workstation CLI Tool';
      case 'github-actions':
        return 'CI/CD Automation Pipeline';
      case 'embed':
        return 'Diagnostic Beacon Script';
      case 'drogon':
        return 'Native C++ Engine Build';
      case 'uninstall':
        return 'System Purge Utility';
      default:
        return 'Production Script';
    }
  };

  const getSyntaxLang = () => {
    if (selectedScript.id === 'powershell') return 'bash';
    if (selectedScript.id === 'docker' || selectedScript.id === 'github-actions') return 'yaml';
    if (selectedScript.id === 'embed') return 'html';
    return 'bash';
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(currentCommand);
    setCopied(true);

    try {
      confetti({
        particleCount: 50,
        spread: 60,
        origin: { y: 0.7 },
        colors: ['#ffffff', '#a1a1aa', '#52525b'],
      });
    } catch (e) {}

    setTimeout(() => setCopied(false), 2400);
  };

  return (
    <div className="space-y-6">
      {/* Top Bento Selection Container with Capsule Navigation */}
      <div className="w-full rounded-2xl sm:rounded-3xl border border-zinc-800 bg-[#161619] shadow-2xl p-4 sm:p-5 flex flex-col gap-4">
        {/* Row 1: Profile Pills & Mode Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-zinc-800/80">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs font-mono font-bold text-zinc-200">
              StackPilot Production Script Engine
            </span>
          </div>

          {(activeTab === 'bash' || activeTab === 'powershell' || activeTab === 'docker') && (
            <div className="flex items-center gap-1 bg-[#1c1c20] p-1 rounded-full text-xs font-mono border border-zinc-800 select-none">
              <span className="px-2 text-[10px] text-zinc-400 font-bold uppercase tracking-wider select-none">Profile:</span>
              {[
                { id: 'core' as const, label: 'Core (1.5GB)', title: 'Low memory (1.5GB): FastAPI + Chromium + Next.js' },
                { id: 'full' as const, label: 'Full Platform', title: 'Full Enterprise: Drogon C++ Engine + Redis + pgvector' },
                { id: 'monitoring' as const, label: '+ Observability', title: 'Full Stack + Prometheus & Grafana Dashboards' },
              ].map((p, idx, arr) => {
                const isActive = profile === p.id;
                const cornerClass =
                  idx === 0
                    ? 'rounded-l-full rounded-r-md'
                    : idx === arr.length - 1
                    ? 'rounded-l-md rounded-r-full'
                    : 'rounded-md';

                return (
                  <React.Fragment key={p.id}>
                    {idx > 0 && (
                      <span
                        className="h-3.5 w-[1px] bg-zinc-800 shrink-0 pointer-events-none mx-0.5 select-none"
                        aria-hidden="true"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => setProfile(p.id)}
                      className={`relative px-2.5 py-1 ${cornerClass} text-xs font-medium transition-colors cursor-pointer border-0 bg-transparent ${
                        isActive
                          ? 'text-zinc-950 font-bold'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                      title={p.title}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="installProfilePill"
                          className={`absolute inset-0 bg-white ${cornerClass} shadow`}
                          transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                        />
                      )}
                      <span className="relative z-10">{p.label}</span>
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>

        {/* Row 2: Sliding Script Tab Navigation Capsule with signature | ) style */}
        <div
          onMouseLeave={() => setHoveredTab(null)}
          className="flex items-center gap-1 overflow-x-auto no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden p-1 rounded-full bg-[#1c1c20] border border-zinc-800/90 text-xs select-none relative"
        >
          {ALL_INSTALL_SCRIPTS.map((script, idx) => {
            const isActive = script.id === activeTab;
            const cornerClass =
              idx === 0
                ? 'rounded-l-full rounded-r-md'
                : idx === ALL_INSTALL_SCRIPTS.length - 1
                ? 'rounded-l-md rounded-r-full'
                : 'rounded-md';

            return (
              <React.Fragment key={script.id}>
                {idx > 0 && (
                  <span
                    className="h-3.5 w-[1px] bg-zinc-800 shrink-0 pointer-events-none mx-0.5 select-none"
                    aria-hidden="true"
                  />
                )}
                <button
                  type="button"
                  onClick={() => setActiveTab(script.id)}
                  onMouseEnter={() => setHoveredTab(script.id)}
                  className={`relative px-3.5 py-1.5 ${cornerClass} text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 border-0 bg-transparent ${
                    isActive
                      ? 'text-zinc-950 font-bold'
                      : 'text-zinc-400 hover:text-zinc-100'
                  }`}
                  title={`Select ${script.label}`}
                >
                  {/* Active sliding pill */}
                  {isActive && (
                    <motion.div
                      layoutId="installScriptTabPill"
                      className={`absolute inset-0 bg-white ${cornerClass} shadow-md`}
                      transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                    />
                  )}

                  {/* Hover pill on inactive tabs */}
                  {hoveredTab === script.id && !isActive && (
                    <motion.div
                      layoutId="installScriptHoverPill"
                      className={`absolute inset-0 bg-[#2b2b30] ${cornerClass}`}
                      transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                    />
                  )}

                  <span className="relative z-10 flex items-center gap-1.5">
                    <span>{script.label}</span>
                  </span>
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Dynamic Animated Content Container for Active Tab */}
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab + (activeTab === 'bash' || activeTab === 'powershell' || activeTab === 'docker' ? `-${profile}` : '')}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="flex flex-col gap-4"
          >
            {/* Row 3: Command Code Display Box with Mac Traffic Lights & Syntax Highlighting */}
            <div className="relative group rounded-2xl border border-zinc-800/90 bg-[#0c0c0e] overflow-hidden shadow-xl">
              <div className="px-4 py-2.5 bg-[#161619] border-b border-zinc-800/70 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <MacTrafficLights onClose={handleCopy} />
                  <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-300 font-semibold px-2 py-0.5 rounded bg-zinc-800/60 border border-zinc-700/40">
                    {getBadgeLabel()}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-mono text-zinc-400 flex items-center gap-1.5">
                    <HugeiconsIcon icon={ComputerTerminal01Icon} size={13} strokeWidth={1.8} className="text-white" />
                    <span>{getSubtitle()}</span>
                  </span>
                  {isMultiLine && (
                    <button
                      type="button"
                      onClick={handleCopy}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono border-0 transition-all cursor-pointer ${
                        copied
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white'
                      }`}
                      title="Copy script to clipboard"
                    >
                      <HugeiconsIcon icon={copied ? Tick01Icon : Copy01Icon} size={13} strokeWidth={2} />
                      <span>{copied ? 'Copied!' : 'Copy'}</span>
                    </button>
                  )}
                </div>
              </div>

              {isMultiLine ? (
                <div className="p-4 sm:p-5 font-mono text-xs overflow-x-auto">
                  <pre className="font-mono text-xs leading-relaxed selection:bg-zinc-800 selection:text-white m-0 p-0 overflow-x-auto">
                    <code
                      dangerouslySetInnerHTML={{
                        __html: highlightCode(currentCommand, getSyntaxLang())
                      }}
                      className="leading-relaxed select-all block whitespace-pre font-mono"
                    />
                  </pre>
                </div>
              ) : (
                <div className="p-4 sm:p-5 font-mono text-xs flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0 flex-1 overflow-x-auto no-scrollbar">
                    <span className="text-emerald-400 select-none font-bold text-sm shrink-0">$</span>
                    <pre className="font-mono text-xs leading-relaxed selection:bg-zinc-800 selection:text-white m-0 p-0 overflow-x-auto">
                      <code
                        dangerouslySetInnerHTML={{
                          __html: highlightCode(currentCommand, getSyntaxLang())
                        }}
                        className="whitespace-nowrap leading-relaxed select-all"
                      />
                    </pre>
                  </div>

                  {/* Circular Copy Button */}
                  <button
                    type="button"
                    onClick={handleCopy}
                    className={`w-8 h-8 rounded-full border-0 flex items-center justify-center shrink-0 transition-all duration-300 active:scale-90 cursor-pointer ${
                      copied
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-[#222226] hover:bg-[#2e2e34] text-zinc-300 hover:text-white'
                    }`}
                    title="Copy command to clipboard"
                    aria-label="Copy command"
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      {copied ? (
                        <motion.div
                          key="check"
                          initial={{ scale: 0.4, opacity: 0, rotate: -20 }}
                          animate={{ scale: 1, opacity: 1, rotate: 0 }}
                          exit={{ scale: 0.4, opacity: 0, rotate: 20 }}
                          transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                        >
                          <HugeiconsIcon icon={Tick01Icon} size={15} strokeWidth={2.2} />
                        </motion.div>
                      ) : (
                        <motion.div
                          key="copy"
                          initial={{ scale: 0.4, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.4, opacity: 0 }}
                          transition={{ duration: 0.15 }}
                        >
                          <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={1.8} />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </button>
                </div>
              )}
            </div>

            {/* Row 4: Script Metadata, OS Targets & Estimated Execution Time */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1 text-xs">
              <div className="p-3 rounded-xl bg-[#1a1a1e] border border-zinc-800/70 space-y-1">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 font-bold">Target Environment</span>
                <p className="text-zinc-300 text-[11px] leading-relaxed">{selectedScript.os}</p>
              </div>

              <div className="p-3 rounded-xl bg-[#1a1a1e] border border-zinc-800/70 space-y-1">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 font-bold">Estimated Time</span>
                <p className="text-zinc-300 text-[11px] font-mono leading-relaxed">{selectedScript.expectedTime}</p>
              </div>

              <div className="p-3 rounded-xl bg-[#1a1a1e] border border-zinc-800/70 space-y-1">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 font-bold">Primary Action</span>
                <p className="text-zinc-300 text-[11px] leading-relaxed line-clamp-2">{selectedScript.description}</p>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Deep-Dive Specifications for All Scripts */}
      <div className="rounded-2xl border border-zinc-800 bg-[#161619] p-5 sm:p-6 space-y-4">
        <h3 className="text-sm sm:text-base font-semibold text-white font-mono flex items-center gap-2">
          <HugeiconsIcon icon={ComputerTerminal01Icon} size={16} strokeWidth={1.8} className="text-white" />
          <span>Script Flags &amp; Parameter Reference</span>
        </h3>

        <div className="space-y-3">
          <p className="text-xs text-zinc-300 leading-relaxed">
            The automated installation scripts accept runtime profile arguments, port overrides, and container configuration parameters directly via standard arguments:
          </p>

          <div className="rounded-xl border border-zinc-800 bg-black/60 overflow-hidden text-xs font-mono">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/60 text-zinc-400 text-[11px]">
                  <th className="p-3 font-semibold">Flag / Parameter</th>
                  <th className="p-3 font-semibold">Description</th>
                  <th className="p-3 font-semibold hidden sm:table-cell">Applies To</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80 text-zinc-300 text-[11px]">
                {selectedScript.flags.map((flag, idx) => (
                  <tr key={idx} className="hover:bg-zinc-800/30 transition-colors">
                    <td className="p-3 text-white font-bold whitespace-nowrap">{flag.flag}</td>
                    <td className="p-3 text-zinc-300">{flag.desc}</td>
                    <td className="p-3 text-zinc-400 hidden sm:table-cell">{selectedScript.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Prerequisites Checklist */}
        <div className="pt-3 border-t border-zinc-800/80 space-y-2">
          <span className="text-xs font-mono font-bold text-zinc-300 uppercase tracking-wider">
            Automated System Health Checks
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            {selectedScript.prerequisites.map((prereq, idx) => (
              <div key={idx} className="flex items-center gap-2 p-2.5 rounded-lg bg-[#1a1a1e] border border-zinc-800 text-zinc-300">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                <span className="font-mono text-[11px]">{prereq}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default InstallationScriptViewer;
