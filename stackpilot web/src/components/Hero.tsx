import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ScriptBox } from './ScriptBox';

const MORPH_WORDS = [
  { text: 'Deployment', gradient: 'from-emerald-400 via-teal-300 to-cyan-400' },
  { text: 'Testing', gradient: 'from-cyan-300 via-sky-300 to-indigo-400' },
];

export const Hero: React.FC = () => {
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % MORPH_WORDS.length);
    }, 3200);
    return () => clearInterval(timer);
  }, []);

  const currentWord = MORPH_WORDS[wordIndex];

  return (
    <section className="pt-28 pb-16 sm:pt-36 sm:pb-24 text-center relative z-10">
      {/* Main Title with Smooth Morph Transition between 'Deployment' and 'Testing' */}
      <div className="w-full max-w-5xl mx-auto mb-6 flex flex-col items-center justify-center select-none">
        <h1 className="text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-zinc-50 leading-[1.14] text-center">
          <span className="block">Autonomous AI</span>
          <motion.span
            layout
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="inline-flex items-center justify-center gap-2.5 sm:gap-3.5 mt-1 sm:mt-2"
          >
            <span className="relative inline-flex items-center justify-center">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={currentWord.text}
                  initial={{ opacity: 0, y: 14, filter: 'blur(8px)', scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)', scale: 1 }}
                  exit={{ opacity: 0, y: -14, filter: 'blur(8px)', scale: 0.96 }}
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className={`bg-gradient-to-r ${currentWord.gradient} bg-clip-text text-transparent inline-block`}
                >
                  {currentWord.text}
                </motion.span>
              </AnimatePresence>
            </span>
            <span className="text-zinc-50">Platform</span>
          </motion.span>
        </h1>
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
