import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ScriptBox } from './ScriptBox';

const MORPH_WORDS = ['Deployment', 'Testing'];

export const Hero: React.FC = () => {
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    // Continuous word morph interval
    const morphTimer = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % MORPH_WORDS.length);
    }, 3200);

    return () => {
      clearInterval(morphTimer);
    };
  }, []);

  const currentWord = MORPH_WORDS[wordIndex];

  return (
    <section className="pt-28 pb-16 sm:pt-36 sm:pb-24 text-center relative z-10">
      {/* Main Title - Static header text with animation strictly on the morphing word */}
      <div className="w-full max-w-5xl mx-auto mb-3 flex flex-col items-center justify-center select-none">
        <h1 className="font-headline text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-zinc-50 leading-[1.04] text-center">
          {/* First Line: Autonomous AI - Completely static */}
          <span className="justify-center text-center text-zinc-50 font-bold block">
            Autonomous AI
          </span>

          {/* Second Line: [Deployment/Testing] Platform */}
          <span className="inline-flex items-center justify-center gap-2 sm:gap-2.5 mt-0.5">
            {/* Morphing Word - Only dynamic element with smooth blur transition */}
            <span className="relative inline-flex items-center justify-center">
              <AnimatePresence mode="wait">
                <motion.span
                  key={currentWord}
                  initial={{ opacity: 0, y: -16, filter: 'blur(8px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={{
                    opacity: 0,
                    y: 16,
                    filter: 'blur(8px)',
                    transition: { duration: 0.2, ease: 'easeIn' },
                  }}
                  transition={{
                    duration: 0.35,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className="inline-flex items-center font-bold tracking-normal text-zinc-50 will-change-transform transform-gpu"
                >
                  {currentWord}
                </motion.span>
              </AnimatePresence>
            </span>

            {/* Platform - Completely static */}
            <span className="text-zinc-50 font-bold ml-0.5 inline-flex items-center">
              Platform
            </span>
          </span>
        </h1>
      </div>

      {/* Subtitle - Inherits body font automatically (Fuzzy Bubbles in stylish mode, modern sans in normal mode) */}
      <p className="mt-3 text-base sm:text-lg md:text-xl text-zinc-300 max-w-3xl mx-auto leading-relaxed font-normal">
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
