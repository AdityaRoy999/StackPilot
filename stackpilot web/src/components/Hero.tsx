import React from 'react';
import { BlurText } from './reactbits/BlurText';
import { ScriptBox } from './ScriptBox';
import { ArrowRight } from 'lucide-react';
import { GithubIcon } from './icons/GithubIcon';

export const Hero: React.FC = () => {
  return (
    <section className="pt-28 pb-14 sm:pt-36 sm:pb-20 text-center relative z-10">
      {/* Main Title animated with BlurText letter-by-letter */}
      <div className="w-full max-w-5xl mx-auto mb-6 flex justify-center">
        <BlurText
          text="Autonomous AI Deployment & Testing Platform"
          delay={25}
          animateBy="letters"
          direction="top"
          stepDuration={0.25}
          className="text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-zinc-50 leading-[1.12] justify-center text-center flex-wrap"
        />
      </div>

      {/* Subtitle - Rephrased and enhanced value proposition */}
      <p className="mt-4 text-base sm:text-lg md:text-xl text-zinc-400 max-w-3xl mx-auto leading-relaxed font-normal">
        Deploy any web application, repository, or full-stack project 100% free for
        instant autonomous testing. Connect your codebase—our self-healing AI
        platform auto-provisions isolated sandboxes, audits browser workflows at
        60 FPS, and verifies live deployments within minutes.
      </p>

      {/* Clean Single-line Command Box with Copy Button */}
      <div id="install" className="scroll-mt-24">
        <ScriptBox />
      </div>

      {/* Action Buttons: slightly grey in color (#1c1c1e), no thin outline */}
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <a
          href="http://localhost:3000"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2.5 px-8 py-3.5 rounded-full bg-[#1c1c1e] hover:bg-[#262629] text-zinc-100 hover:text-white text-sm sm:text-base font-semibold transition-all hover:scale-105 active:scale-95 cursor-pointer"
        >
          <span>Open Cockpit</span>
          <ArrowRight className="w-4 h-4 text-zinc-400" />
        </a>

        <a
          href="https://github.com/AdityaRoy999/StackPilot"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2.5 px-8 py-3.5 rounded-full bg-[#1c1c1e] hover:bg-[#262629] text-zinc-100 hover:text-white text-sm sm:text-base font-semibold transition-all hover:scale-105 active:scale-95 cursor-pointer"
        >
          <GithubIcon className="w-4 h-4 text-zinc-400" />
          <span>Star on GitHub</span>
        </a>
      </div>
    </section>
  );
};

export default Hero;
