import React, { useState, useEffect } from 'react';
import confetti from 'canvas-confetti';
import { 
  Terminal, 
  Copy, 
  Check, 
  Play, 
  RefreshCw, 
  Sparkles, 
  Sliders, 
  ShieldCheck, 
  Cpu, 
  Server, 
  Laptop, 
  Code, 
  GitBranch
} from 'lucide-react';
import { SpotlightCard } from './reactbits/SpotlightCard';
import { MacTrafficLights } from './docs/CodeBlock';

type ScriptTab = 'bash' | 'powershell' | 'docker' | 'cli' | 'github-actions' | 'embed';

export const ScriptCopyHub: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ScriptTab>('bash');
  const [profile, setProfile] = useState<'core' | 'full' | 'monitoring'>('core');
  const [copied, setCopied] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simStep, setSimStep] = useState(0);

  // Generate the active command snippet based on tab and profile options
  const getScriptCommand = () => {
    const profileFlag = profile === 'core' ? ' --profile core' : profile === 'full' ? ' --profile full' : ' --profile monitoring';

    switch (activeTab) {
      case 'bash':
        return `curl -fsSL https://stackpilot.vercel.app/install.sh | bash -s --${profileFlag}`;
      case 'powershell':
        return `powershell -ExecutionPolicy Bypass -c "irm https://stackpilot.vercel.app/install.ps1 | iex"`;
      case 'docker':
        return `git clone https://github.com/AdityaRoy999/StackPilot.git && cd StackPilot && docker compose${profileFlag} up -d`;
      case 'cli':
        return `pip install stackpilot-cli && stackpilot test https://your-site.com --depth 3`;
      case 'github-actions':
        return `# .github/workflows/stackpilot-qa.yml
name: StackPilot Autonomous QA
on: [push, pull_request]

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
          timeout-seconds: 180`;
      case 'embed':
        return `<!-- StackPilot Autonomous In-Page Audit Trigger -->
<script 
  src="https://cdn.stackpilot.dev/pilot.js" 
  data-project="sp_live_992" 
  data-stream="60fps" 
  async>
</script>`;
      default:
        return '';
    }
  };

  const currentCommand = getScriptCommand();

  const handleCopy = () => {
    navigator.clipboard.writeText(currentCommand);
    setCopied(true);

    // Trigger celebratory confetti burst
    try {
      confetti({
        particleCount: 50,
        spread: 60,
        origin: { y: 0.7 },
        colors: ['#06b6d4', '#8b5cf6', '#10b981'],
      });
    } catch (e) {}

    setTimeout(() => setCopied(false), 2500);
  };

  const simulationLogs = [
    { text: '[*] Discovering system hardware...', color: 'text-cyan-400' },
    { text: '  • Total RAM: 16.0 GB | CPU Cores: 8 (Sufficient for 60 FPS streaming)', color: 'text-slate-300' },
    { text: '[*] Verifying Docker Engine & Containerd daemon...', color: 'text-cyan-400' },
    { text: '  • Docker Engine 27.2.0 (API v1.47) is Healthy & Connected', color: 'text-emerald-400' },
    { text: `[*] Initializing StackPilot Services with [${profile.toUpperCase()}] profile...`, color: 'text-cyan-400' },
    { text: '  • stackpilot-browser-sandbox (Alpine Chromium + WebCodecs) -> Port 8099, 9222 [STARTED]', color: 'text-slate-300' },
    { text: '  • stackpilot-ai-service (FastAPI + APV Engine + Domain Guard) -> Port 8010 [STARTED]', color: 'text-slate-300' },
    { text: '  • stackpilot-postgres (pgvector + SKG Graph Memory) -> Port 5433 [HEALTHY]', color: 'text-emerald-400' },
    { text: '  • stackpilot-frontend (Next.js Interactive Dashboard) -> Port 3000 [LISTENING]', color: 'text-emerald-400' },
    { text: '🚀 [SUCCESS] StackPilot Cockpit is running live! Open: http://localhost:3000', color: 'text-emerald-300 font-bold' },
  ];

  const handleRunSimulation = () => {
    if (isSimulating) return;
    setIsSimulating(true);
    setSimStep(0);
  };

  useEffect(() => {
    if (!isSimulating) return;

    if (simStep < simulationLogs.length - 1) {
      const timer = setTimeout(() => {
        setSimStep(prev => prev + 1);
      }, 400);
      return () => clearTimeout(timer);
    } else {
      const resetTimer = setTimeout(() => {
        setIsSimulating(false);
      }, 5000);
      return () => clearTimeout(resetTimer);
    }
  }, [isSimulating, simStep]);

  return (
    <section id="install-scripts" className="py-20 relative z-20 scroll-mt-24">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 text-xs font-mono font-medium mb-4">
            <Terminal className="w-3.5 h-3.5" />
            <span>Interactive Script Delivery Hub</span>
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            One Command to Launch.
            <br />
            <span className="text-gradient-cyan">Zero Configuration Headaches.</span>
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-600 dark:text-slate-300">
            Select your platform below, customize runtime profile, and copy the script directly into your terminal or CI/CD pipeline.
          </p>
        </div>

        {/* Main Terminal Card */}
        <SpotlightCard
          className="border border-slate-300/80 dark:border-slate-800/80 shadow-2xl bg-white/80 dark:bg-[#0b0f19]/90"
          spotlightColor="rgba(6, 182, 212, 0.2)"
        >
          {/* Top Window Chrome */}
          <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 border-b border-slate-200/80 dark:border-slate-800/80 bg-slate-100/50 dark:bg-slate-900/50">
            {/* Window Dots */}
            <div className="flex items-center gap-2">
              <MacTrafficLights onClose={handleCopy} />
              <span className="ml-3 text-xs font-mono text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-cyan-500" />
                stackpilot-quickstart.sh
              </span>
            </div>

            {/* Profile Selector Pills */}
            <div className="flex items-center gap-1.5 bg-slate-200/60 dark:bg-slate-800/60 p-1 rounded-xl text-xs font-medium">
              <span className="px-2 text-[11px] text-slate-500 dark:text-slate-400 font-mono">Profile:</span>
              <button
                onClick={() => setProfile('core')}
                className={`px-2.5 py-1 rounded-lg transition-all ${
                  profile === 'core'
                    ? 'bg-white dark:bg-slate-700 text-cyan-600 dark:text-cyan-300 shadow-sm font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
                title="Low-spec (1.5GB RAM): AI QA Engine + Sandbox + Frontend"
              >
                Core QA (1.5GB)
              </button>
              <button
                onClick={() => setProfile('full')}
                className={`px-2.5 py-1 rounded-lg transition-all ${
                  profile === 'full'
                    ? 'bg-white dark:bg-slate-700 text-cyan-600 dark:text-cyan-300 shadow-sm font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
                title="Full Platform: Drogon C++ Backend + Build Engine"
              >
                Full Platform
              </button>
              <button
                onClick={() => setProfile('monitoring')}
                className={`px-2.5 py-1 rounded-lg transition-all ${
                  profile === 'monitoring'
                    ? 'bg-white dark:bg-slate-700 text-cyan-600 dark:text-cyan-300 shadow-sm font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
                title="Full Suite + Prometheus, Grafana & Loki"
              >
                + Observability
              </button>
            </div>
          </div>

          {/* Platform Tab Navigation */}
          <div className="flex overflow-x-auto border-b border-slate-200/80 dark:border-slate-800/80 px-6 bg-slate-50/40 dark:bg-slate-950/40 text-xs font-mono">
            <button
              onClick={() => setActiveTab('bash')}
              className={`flex items-center gap-2 py-3 px-4 border-b-2 font-medium transition-all ${
                activeTab === 'bash'
                  ? 'border-cyan-500 text-cyan-600 dark:text-cyan-400 bg-cyan-500/5'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Laptop className="w-3.5 h-3.5" />
              <span>Linux / macOS (Bash)</span>
            </button>
            <button
              onClick={() => setActiveTab('powershell')}
              className={`flex items-center gap-2 py-3 px-4 border-b-2 font-medium transition-all ${
                activeTab === 'powershell'
                  ? 'border-cyan-500 text-cyan-600 dark:text-cyan-400 bg-cyan-500/5'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Server className="w-3.5 h-3.5" />
              <span>Windows (PowerShell)</span>
            </button>
            <button
              onClick={() => setActiveTab('docker')}
              className={`flex items-center gap-2 py-3 px-4 border-b-2 font-medium transition-all ${
                activeTab === 'docker'
                  ? 'border-cyan-500 text-cyan-600 dark:text-cyan-400 bg-cyan-500/5'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>Docker Compose</span>
            </button>
            <button
              onClick={() => setActiveTab('cli')}
              className={`flex items-center gap-2 py-3 px-4 border-b-2 font-medium transition-all ${
                activeTab === 'cli'
                  ? 'border-cyan-500 text-cyan-600 dark:text-cyan-400 bg-cyan-500/5'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>Python CLI (`stackpilot`)</span>
            </button>
            <button
              onClick={() => setActiveTab('github-actions')}
              className={`flex items-center gap-2 py-3 px-4 border-b-2 font-medium transition-all ${
                activeTab === 'github-actions'
                  ? 'border-cyan-500 text-cyan-600 dark:text-cyan-400 bg-cyan-500/5'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <GitBranch className="w-3.5 h-3.5" />
              <span>GitHub Actions CI</span>
            </button>
            <button
              onClick={() => setActiveTab('embed')}
              className={`flex items-center gap-2 py-3 px-4 border-b-2 font-medium transition-all ${
                activeTab === 'embed'
                  ? 'border-cyan-500 text-cyan-600 dark:text-cyan-400 bg-cyan-500/5'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Code className="w-3.5 h-3.5" />
              <span>Embed QA Webhook</span>
            </button>
          </div>

          {/* Code Display Area */}
          <div className="p-6">
            <div className="relative rounded-xl border border-slate-200/80 dark:border-slate-800/80 bg-slate-950 p-5 font-mono text-sm shadow-inner group">
              {/* Copy and Actions Floating Bar */}
              <div className="absolute top-3 right-3 flex items-center gap-2">
                <button
                  onClick={handleRunSimulation}
                  disabled={isSimulating}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-400 text-xs font-mono transition-colors disabled:opacity-50"
                  title="Simulate script execution animation"
                >
                  <Play className={`w-3.5 h-3.5 ${isSimulating ? 'animate-spin' : ''}`} />
                  <span>{isSimulating ? 'Simulating...' : 'Simulate Run ▶'}</span>
                </button>

                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs font-mono transition-all shadow-md active:scale-95"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Copied! ✓</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Script</span>
                    </>
                  )}
                </button>
              </div>

              {/* Code text */}
              <div className="pr-36 overflow-x-auto text-cyan-300 select-all leading-relaxed whitespace-pre font-mono">
                {currentCommand}
              </div>
            </div>

            {/* Quick Helper Notes */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400 font-mono">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                <span>100% Self-Hosted • No telemetry • Docker & Docker Compose auto-detected</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-slate-400 dark:text-slate-600">|</span>
                <span>Requirements: Docker Desktop or Linux Docker Engine</span>
              </div>
            </div>
          </div>

          {/* Live Simulated Run Terminal Drawer */}
          {isSimulating && (
            <div className="border-t border-slate-200/80 dark:border-slate-800/80 p-6 bg-black/95 font-mono text-xs animate-fade-in">
              <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800 text-slate-400">
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  <span>Live Terminal Simulation output</span>
                </span>
                <span>Step {simStep + 1} of {simulationLogs.length}</span>
              </div>
              <div className="space-y-1.5">
                {simulationLogs.slice(0, simStep + 1).map((log, idx) => (
                  <div key={idx} className={`${log.color} animate-fade-in`}>
                    {log.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </SpotlightCard>
      </div>
    </section>
  );
};
