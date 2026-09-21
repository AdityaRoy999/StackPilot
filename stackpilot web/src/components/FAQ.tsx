import React, { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { HelpCircleIcon, ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { SpotlightCard } from './reactbits/SpotlightCard';

export const FAQ: React.FC = () => {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const faqs = [
    {
      q: 'How does the 1-line script installer work?',
      a: 'The universal install script audits your system RAM and CPU, verifies Docker daemon status, pulls the lightweight pre-built images, configures environment variables, and launches the services in under 60 seconds. You can pass `--profile core` for low-memory VPS instances.',
    },
    {
      q: 'How does StackPilot test websites without writing test scripts?',
      a: 'StackPilot utilizes Action Perception Verification (APV) combined with Vision and DOM grounding. It extracts the interactive accessibility tree, assigns Set-of-Marks numeric badges to interactive controls, analyzes form fields to generate contextually valid payloads, submits them, and verifies that the page transitions correctly.',
    },
    {
      q: 'How does the domain boundary fence prevent the AI from clicking external links?',
      a: 'StackPilot enforces multi-tier origin confinement: DOM extraction flags external links (`is_external: true`), autonomous frontier loops ignore out-of-domain targets, and if any action ever navigates to a third-party website (such as GitHub, Twitter/X, or external documentation), the APV guard immediately snaps back to the target application in 0ms.',
    },
    {
      q: 'Can I run StackPilot on a budget 1.5GB / 2GB RAM VPS?',
      a: 'Yes! By using `--profile core`, StackPilot runs solely the AI QA Service, Browser Sandbox, and Frontend, taking ~1.4GB of RAM. The C++ Drogon backend and Observability suite can be enabled when additional headroom is available.',
    },
    {
      q: 'How do I connect Claude Code or Cursor to StackPilot?',
      a: 'StackPilot includes a native Model Context Protocol (MCP) server running on port 8090. Simply add StackPilot to your `mcpServers` config in Claude or Cursor to trigger autonomous testing runs, view logs, and manage deployments from your editor.',
    },
    {
      q: 'Is my source code and application telemetry private?',
      a: '100%. StackPilot is completely self-hosted. All container builds, database records, browser sandboxes, and screencasts run within your local Docker or Kubernetes cluster without any third-party telemetry.',
    },
  ];

  return (
    <section id="faq" className="py-24 relative z-20 scroll-mt-24">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 text-xs font-mono font-medium mb-4">
            <HugeiconsIcon icon={HelpCircleIcon} size={14} />
            <span>Got Questions?</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            Frequently Asked Questions
          </h2>
        </div>

        {/* Accordion list */}
        <div className="space-y-3">
          {faqs.map((faq, index) => {
            const isOpen = openIndex === index;
            return (
              <SpotlightCard
                key={index}
                className="transition-all duration-200 border border-slate-200/80 dark:border-slate-800/80 cursor-pointer"
                onClick={() => setOpenIndex(isOpen ? null : index)}
              >
                <div className="p-6">
                  <div className="flex items-center justify-between gap-4">
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">
                      {faq.q}
                    </h3>
                    <div
                      className={`w-6 h-6 rounded-full flex items-center justify-center bg-slate-100 dark:bg-slate-800 text-slate-500 transition-transform duration-300 shrink-0 ${
                        isOpen ? 'rotate-180 text-cyan-500' : ''
                      }`}
                    >
                      <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={2} />
                    </div>
                  </div>

                  {isOpen && (
                    <p className="mt-4 text-sm text-slate-600 dark:text-slate-300 leading-relaxed pt-3 border-t border-slate-200/60 dark:border-slate-800/60 animate-fade-in">
                      {faq.a}
                    </p>
                  )}
                </div>
              </SpotlightCard>
            );
          })}
        </div>
      </div>
    </section>
  );
};
