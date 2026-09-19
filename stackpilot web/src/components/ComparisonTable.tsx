import React from 'react';
import { Check, X, Sparkles, Shield, Zap } from 'lucide-react';
import { SpotlightCard } from './reactbits/SpotlightCard';

export const ComparisonTable: React.FC = () => {
  const features = [
    {
      name: 'Zero-Script Autonomous QA',
      desc: 'AI automatically discovers forms, tabs, and routes without writing Playwright/Cypress scripts.',
      sp: true,
      cypress: false,
      coolify: false,
    },
    {
      name: '60 FPS Live WebCodecs Screencast',
      desc: 'True hardware-accelerated video streaming with sub-25ms latency & 0ms keyframe cache.',
      sp: true,
      cypress: false,
      coolify: false,
    },
    {
      name: 'Self-Healing Build Engine',
      desc: 'AI agent diagnoses compiler errors, fixes Dockerfile syntax, and re-tests automatically.',
      sp: true,
      cypress: false,
      coolify: false,
    },
    {
      name: '1-Line Universal Script Installer',
      desc: 'Deploy on any VPS, macOS, or Windows with single-command auto-hardware discovery.',
      sp: true,
      cypress: false,
      coolify: true,
    },
    {
      name: 'Strict Domain Boundary Fence',
      desc: 'Autonomous agent is strictly fenced within the target application; never wanders to 3rd party links.',
      sp: true,
      cypress: false,
      coolify: false,
    },
    {
      name: 'Native MCP Server for IDEs',
      desc: 'Trigger tests, inspect logs, and debug deployments directly from Claude Code or Cursor.',
      sp: true,
      cypress: false,
      coolify: false,
    },
    {
      name: '100% Self-Hosted & Air-Gapped Ready',
      desc: 'Your code, database, and telemetry never leave your personal infrastructure.',
      sp: true,
      cypress: true,
      coolify: true,
    },
  ];

  return (
    <section className="py-24 relative z-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 text-xs font-mono font-medium mb-4">
            <Zap className="w-3.5 h-3.5" />
            <span>Competitive Matrix</span>
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            How StackPilot Compares
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-600 dark:text-slate-300">
            Why modern engineering teams choose StackPilot over brittle manual testing suites and complex deployment tools.
          </p>
        </div>

        {/* Comparison Table */}
        <SpotlightCard className="overflow-hidden border border-slate-300 dark:border-slate-800">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-100/50 dark:bg-slate-900/50">
                  <th className="p-5 text-sm font-bold text-slate-900 dark:text-white">Capability</th>
                  <th className="p-5 text-sm font-bold text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border-x border-cyan-500/20 text-center">
                    <span className="flex items-center justify-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-cyan-500" />
                      StackPilot v2.0
                    </span>
                  </th>
                  <th className="p-5 text-sm font-semibold text-slate-600 dark:text-slate-400 text-center">
                    Playwright / Cypress
                  </th>
                  <th className="p-5 text-sm font-semibold text-slate-600 dark:text-slate-400 text-center">
                    Traditional PaaS
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/80 dark:divide-slate-800/80 text-sm">
                {features.map((f, i) => (
                  <tr key={i} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors">
                    <td className="p-5">
                      <div className="font-semibold text-slate-900 dark:text-white">{f.name}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{f.desc}</div>
                    </td>
                    <td className="p-5 text-center bg-cyan-500/5 border-x border-cyan-500/20">
                      {f.sp ? (
                        <div className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 font-bold">
                          <Check className="w-4 h-4" />
                        </div>
                      ) : (
                        <X className="w-4 h-4 text-slate-400 mx-auto" />
                      )}
                    </td>
                    <td className="p-5 text-center">
                      {f.cypress ? (
                        <Check className="w-4 h-4 text-emerald-500 mx-auto" />
                      ) : (
                        <X className="w-4 h-4 text-slate-400 dark:text-slate-600 mx-auto" />
                      )}
                    </td>
                    <td className="p-5 text-center">
                      {f.coolify ? (
                        <Check className="w-4 h-4 text-emerald-500 mx-auto" />
                      ) : (
                        <X className="w-4 h-4 text-slate-400 dark:text-slate-600 mx-auto" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SpotlightCard>
      </div>
    </section>
  );
};
