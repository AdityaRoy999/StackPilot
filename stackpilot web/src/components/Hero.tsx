import React from 'react';
import { ScriptBox } from './ScriptBox';
import { ArrowRight, ExternalLink, ShieldCheck, Zap, Bot } from 'lucide-react';
import { GithubIcon } from './icons/GithubIcon';

export const Hero: React.FC = () => {
  return (
    <section className="pt-20 pb-16 sm:pt-28 sm:pb-20 text-center">
      {/* Release pill */}
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-zinc-800 bg-zinc-900/60 text-xs text-zinc-400 mb-8 font-mono">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        <span>StackPilot v2.0 • Autonomous AI Browser Testing Engine</span>
      </div>

      {/* Main Title */}
      <h1 className="text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-zinc-50 max-w-4xl mx-auto leading-[1.1]">
        Autonomous AI QA &<br />
        Delivery Cockpit
      </h1>

      {/* Subtitle */}
      <p className="mt-6 text-base sm:text-lg text-zinc-400 max-w-2xl mx-auto leading-relaxed font-normal">
        Deploy any repository in seconds. An autonomous AI agent audits your
        application, conducts 60 FPS real-time browser test journeys, and
        self-heals broken deployments.
      </p>

      {/* Script Copy Box */}
      <ScriptBox />

      {/* CTAs */}
      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <a
          href="http://localhost:3000"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-zinc-50 text-zinc-950 hover:bg-zinc-200 text-sm font-medium transition-colors shadow-sm"
        >
          <span>Open Cockpit</span>
          <ArrowRight className="w-4 h-4" />
        </a>

        <a
          href="https://github.com/AdityaRoy999/StackPilot"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 text-zinc-300 hover:text-zinc-100 text-sm font-medium transition-colors"
        >
          <GithubIcon className="w-4 h-4 text-zinc-400" />
          <span>Star on GitHub</span>
        </a>
      </div>
    </section>
  );
};
