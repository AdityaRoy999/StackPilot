import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ScriptBox } from './ScriptBox';

const MORPH_WORDS = ['Deployment', 'Testing'];

export const Hero: React.FC = () => {
  const [wordIndex, setWordIndex] = useState(0);
  const [hasLanded, setHasLanded] = useState(false);

  useEffect(() => {
    // Mark initial landing complete after the cascading landing animation finishes (~1.5s)
    const landingTimer = setTimeout(() => {
      setHasLanded(true);
    }, 1500);

    // Continuous word morph interval
    const morphTimer = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % MORPH_WORDS.length);
    }, 3200);

    return () => {
      clearTimeout(landingTimer);
      clearInterval(morphTimer);
    };
  }, []);

  const currentWord = MORPH_WORDS[wordIndex];

  return (
    <section className="pt-28 pb-10 sm:pt-36 sm:pb-14 text-center relative z-10">
      {/* Main Title - GPU-accelerated word-level cascade for buttery smooth 60 FPS initial render */}
      <div className="w-full max-w-5xl mx-auto mb-3 flex flex-col items-center justify-center select-none">
        <h1 className="font-headline text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-zinc-50 leading-[1.04] text-center">
          {/* First Line: Autonomous AI - Word-level hardware-accelerated cascade */}
          <span className="justify-center text-center text-zinc-50 font-bold flex flex-wrap gap-x-3 sm:gap-x-4">
            <motion.span
              initial={{ opacity: 0, y: -28, filter: 'blur(8px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.45, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
              className="inline-block will-change-transform transform-gpu"
            >
              Autonomous
            </motion.span>
            <motion.span
              initial={{ opacity: 0, y: -28, filter: 'blur(8px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.45, delay: 0.16, ease: [0.22, 1, 0.36, 1] }}
              className="inline-block will-change-transform transform-gpu"
            >
              AI
            </motion.span>
          </span>

          {/* Second Line: [Deployment/Testing] Platform */}
          <motion.span
            layout
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="inline-flex items-center justify-center gap-2 sm:gap-2.5 mt-1"
          >
            {/* Morphing Word without colored gradients - Pure crisp white matching the headline */}
            <span className="relative inline-flex items-center justify-center">
              <AnimatePresence mode="wait">
                <motion.span
                  key={currentWord}
                  initial={{ opacity: 0, y: hasLanded ? -18 : -28, filter: 'blur(8px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={{
                    opacity: 0,
                    y: 16,
                    filter: 'blur(8px)',
                    transition: { duration: 0.22, ease: 'easeIn' },
                  }}
                  transition={{
                    duration: 0.38,
                    delay: hasLanded ? 0 : 0.28,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className="inline-block font-bold tracking-normal text-zinc-50 will-change-transform transform-gpu"
                >
                  {currentWord}
                </motion.span>
              </AnimatePresence>
            </span>

            {/* Platform - Participates in initial landing cascade then remains stable */}
            <motion.span
              initial={{ opacity: 0, y: -28, filter: 'blur(8px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.45, delay: 0.38, ease: [0.22, 1, 0.36, 1] }}
              className="text-zinc-50 font-bold inline-block will-change-transform transform-gpu"
            >
              Platform
            </motion.span>
          </motion.span>
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
