import React from 'react';
import { 
  Bot, 
  Video, 
  Wrench, 
  Box, 
  BarChart3, 
  Sparkles, 
  Cpu, 
  ShieldCheck, 
  Zap, 
  Network, 
  Lock 
} from 'lucide-react';
import { SpotlightCard } from './reactbits/SpotlightCard';

export const BentoFeatures: React.FC = () => {
  return (
    <section id="features" className="py-24 relative z-20 scroll-mt-24">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 text-xs font-mono font-medium mb-4">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Next-Generation Architecture</span>
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            Engineered for Extreme Speed,
            <br />
            <span className="text-gradient-cyan">Reliability & Privacy.</span>
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-600 dark:text-slate-300">
            From low-latency Chromium compositing to self-healing C++ build pipelines, every component is built for production resilience.
          </p>
        </div>

        {/* Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Card 1: Autonomous AI QA (Large 2 Cols) */}
          <SpotlightCard
            className="md:col-span-2 p-8 flex flex-col justify-between"
            spotlightColor="rgba(6, 182, 212, 0.2)"
          >
            <div>
              <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-500 mb-6">
                <Bot className="w-6 h-6" />
              </div>
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-cyan-600 dark:text-cyan-400">
                Core Autonomous Intelligence
              </span>
              <h3 className="text-2xl font-bold text-slate-900 dark:text-white mt-2">
                Action Perception Verification (APV) Engine
              </h3>
              <p className="mt-3 text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
                Unlike flaky end-to-end testing scripts, StackPilot uses vision-augmented AI that inspects DOM hierarchies, detects interactive surfaces, completes complex forms, submits them, and verifies DOM settling with microsecond precision.
              </p>
            </div>

            {/* Interactive feature chips */}
            <div className="mt-8 grid grid-cols-2 sm:grid-cols-3 gap-3 pt-6 border-t border-slate-200/80 dark:border-slate-800/80">
              <div className="flex items-center gap-2 text-xs font-mono text-slate-700 dark:text-slate-300">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                <span>Domain-Boundary Fence</span>
              </div>
              <div className="flex items-center gap-2 text-xs font-mono text-slate-700 dark:text-slate-300">
                <Zap className="w-4 h-4 text-amber-500" />
                <span>0ms Synthetic Click</span>
              </div>
              <div className="flex items-center gap-2 text-xs font-mono text-slate-700 dark:text-slate-300">
                <Network className="w-4 h-4 text-cyan-500" />
                <span>Recursive Frontier Crawl</span>
              </div>
            </div>
          </SpotlightCard>

          {/* Card 2: 60 FPS WebCodecs Streaming (1 Col) */}
          <SpotlightCard
            className="p-8 flex flex-col justify-between"
            spotlightColor="rgba(139, 92, 246, 0.2)"
          >
            <div>
              <div className="w-12 h-12 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-500 mb-6">
                <Video className="w-6 h-6" />
              </div>
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-purple-600 dark:text-purple-400">
                Ultra-Low Latency
              </span>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-2">
                60 FPS WebCodecs Video Stream
              </h3>
              <p className="mt-3 text-slate-600 dark:text-slate-300 leading-relaxed text-sm">
                Zero Base64 bloat. Length-prefixed binary H.264 NALUs stream directly over WebSocket into HTML5 Canvas via WebCodecs VideoDecoder with instant IDR keyframe caching.
              </p>
            </div>
            <div className="mt-6 pt-4 border-t border-slate-200/80 dark:border-slate-800/80 flex items-center justify-between text-xs font-mono text-slate-500">
              <span>Latency: &lt; 25ms</span>
              <span className="text-purple-400 font-bold">Hardware Accelerated</span>
            </div>
          </SpotlightCard>

          {/* Card 3: Self-Healing Builds (1 Col) */}
          <SpotlightCard
            className="p-8 flex flex-col justify-between"
            spotlightColor="rgba(16, 185, 129, 0.2)"
          >
            <div>
              <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-500 mb-6">
                <Wrench className="w-6 h-6" />
              </div>
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                Auto-Recovery
              </span>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-2">
                Self-Healing Build Engine
              </h3>
              <p className="mt-3 text-slate-600 dark:text-slate-300 leading-relaxed text-sm">
                When a Dockerfile or deployment fails, the built-in diagnostic agent audits compiler logs, fixes code or dependencies, triggers rebuilds, and verifies recovery.
              </p>
            </div>
            <div className="mt-6 pt-4 border-t border-slate-200/80 dark:border-slate-800/80 text-xs font-mono text-emerald-500 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" />
              <span>Zero-Downtime Rollback</span>
            </div>
          </SpotlightCard>

          {/* Card 4: C++ Drogon Core Engine (1 Col) */}
          <SpotlightCard
            className="p-8 flex flex-col justify-between"
            spotlightColor="rgba(6, 182, 212, 0.2)"
          >
            <div>
              <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-500 mb-6">
                <Cpu className="w-6 h-6" />
              </div>
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-cyan-600 dark:text-cyan-400">
                High Performance Core
              </span>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-2">
                C++ Drogon Async Engine
              </h3>
              <p className="mt-3 text-slate-600 dark:text-slate-300 leading-relaxed text-sm">
                Built on modern C++20 and Drogon framework for rock-solid non-blocking concurrency, zero-overhead process pipelines, and sub-millisecond API response times.
              </p>
            </div>
            <div className="mt-6 pt-4 border-t border-slate-200/80 dark:border-slate-800/80 text-xs font-mono text-cyan-500">
              <span>50,000+ Req/Sec Capacity</span>
            </div>
          </SpotlightCard>

          {/* Card 5: MCP Server for IDE Agents (1 Col) */}
          <SpotlightCard
            className="p-8 flex flex-col justify-between"
            spotlightColor="rgba(245, 158, 11, 0.2)"
          >
            <div>
              <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500 mb-6">
                <Box className="w-6 h-6" />
              </div>
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                IDE Agent Integration
              </span>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-2">
                Built-In MCP Server
              </h3>
              <p className="mt-3 text-slate-600 dark:text-slate-300 leading-relaxed text-sm">
                Connect Claude Code, Cursor, Windsurf, or Codex directly to StackPilot via the Model Context Protocol (MCP) to trigger QA runs directly from your editor.
              </p>
            </div>
            <div className="mt-6 pt-4 border-t border-slate-200/80 dark:border-slate-800/80 text-xs font-mono text-amber-500">
              <span>Claude Code & Cursor Ready</span>
            </div>
          </SpotlightCard>
        </div>
      </div>
    </section>
  );
};
