import React from 'react';
import { BlurText } from './reactbits/BlurText';
import { ScriptBox } from './ScriptBox';

export const Hero: React.FC = () => {
  return (
    <section className="pt-28 pb-16 sm:pt-36 sm:pb-24 text-center relative z-10">
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

      {/* Clean Single-line Bento Command Box with Copy Button */}
      <div id="install" className="scroll-mt-24">
        <ScriptBox />
      </div>
    </section>
  );
};

export default Hero;
