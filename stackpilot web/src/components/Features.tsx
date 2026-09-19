import React from 'react';
import { Video, Bot, ShieldCheck } from 'lucide-react';

const FEATURES = [
  {
    icon: Video,
    title: '60 FPS Live Screencast',
    description:
      'Frame-locked CDP screencasting with sub-50ms latency. Stream and replay Chromium test runs in real time with interactive cursor tracking and frame inspection.',
  },
  {
    icon: Bot,
    title: 'Autonomous Vision QA',
    description:
      'Domain-fenced AI agent explores interactive user journeys, tests complex form submissions, verifies DOM mutations, and generates visual defect reports.',
  },
  {
    icon: ShieldCheck,
    title: 'Self-Healing Deployments',
    description:
      'Automated container lifecycle management for Docker and Kubernetes. Detects failing health checks and initiates instant automated rollback to previous stable state.',
  },
];

export const Features: React.FC = () => {
  return (
    <section className="py-16 sm:py-24 border-t border-zinc-850">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-zinc-100">
            Engineered for Autonomous Reliability
          </h2>
          <p className="mt-2 text-sm text-zinc-400 max-w-xl mx-auto">
            Everything you need to test, monitor, and deploy web applications without manual QA overhead.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {FEATURES.map((feature, idx) => {
            const Icon = feature.icon;
            return (
              <div
                key={idx}
                className="rounded-xl border border-zinc-850 bg-zinc-950/60 p-6 text-left hover:border-zinc-750 transition-colors"
              >
                <div className="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4 text-zinc-200">
                  <Icon className="w-4 h-4 text-zinc-300" />
                </div>
                <h3 className="text-base font-semibold text-zinc-100 mb-2">
                  {feature.title}
                </h3>
                <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed">
                  {feature.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
