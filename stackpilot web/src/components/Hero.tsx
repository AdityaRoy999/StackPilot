import React from 'react';
import { StrokeText } from './reactbits/StrokeText';
import { ScriptBox } from './ScriptBox';
import { ArrowRight } from 'lucide-react';
import { GithubIcon } from './icons/GithubIcon';

export const Hero: React.FC = () => {
  return (
    <section className="pt-20 pb-16 sm:pt-28 sm:pb-20 text-center">
      {/* Main Title using React Bits StrokeText */}
      <div className="w-full max-w-4xl mx-auto space-y-1 mb-4">
        <StrokeText
          text="Autonomous AI QA &"
          strokeColor="#71717A"
          fillColor="#FFFFFF"
          strokeWidth={1.5}
          drawDuration={1.4}
          fillDelay={0.15}
          stagger={0.04}
          ease="power2.out"
          trigger="mount"
          fillMode="wipe"
          fontSize={82}
          fontWeight={800}
          letterSpacing={-2}
        />
        <StrokeText
          text="Delivery Cockpit"
          strokeColor="#71717A"
          fillColor="#FFFFFF"
          strokeWidth={1.5}
          drawDuration={1.4}
          fillDelay={0.28}
          stagger={0.04}
          ease="power2.out"
          trigger="mount"
          fillMode="wipe"
          fontSize={82}
          fontWeight={800}
          letterSpacing={-2}
        />
      </div>

      {/* Subtitle */}
      <p className="mt-4 text-base sm:text-lg text-zinc-400 max-w-2xl mx-auto leading-relaxed font-normal">
        Deploy any repository in seconds. An autonomous AI agent audits your
        application, conducts 60 FPS real-time browser test journeys, and
        self-heals broken deployments.
      </p>

      {/* Script Copy Box */}
      <ScriptBox />

      {/* Action Buttons */}
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
