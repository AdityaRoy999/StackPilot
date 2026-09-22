import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ScriptBox } from './ScriptBox';

const MORPH_WORDS = ['Deployment', 'Testing'];
const LINE_1_TEXT = 'Autonomous AI';
const PLATFORM_TEXT = 'Platform';

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

  // Calculate delays for the initial landing animation cascade across the full headline
  const line1Chars = LINE_1_TEXT.split('');
  const platformChars = PLATFORM_TEXT.split('');

  return (
    <section className="pt-28 pb-16 sm:pt-36 sm:pb-24 text-center relative z-10">
      {/* Main Title - Unified font-headline across the entire headline with full cascading landing animation */}
      <div className="w-full max-w-5xl mx-auto mb-3 flex flex-col items-center justify-center select-none">
        <h1 className="font-headline text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-zinc-50 leading-[1.04] text-center">
          {/* First Line: Autonomous AI - Full landing animation */}
          <span className="justify-center text-center text-zinc-50 font-bold block">
            {line1Chars.map((char, idx) => (
              <motion.span
                key={idx}
                initial={{ filter: 'blur(10px)', opacity: 0, y: -45 }}
                animate={{
                  filter: ['blur(10px)', 'blur(4px)', 'blur(0px)'],
                  opacity: [0, 0.5, 1],
                  y: [-45, 5, 0],
                }}
                transition={{
                  duration: 0.38,
                  times: [0, 0.55, 1],
                  delay: idx * 0.025,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="inline-block"
              >
                {char === ' ' ? '\u00A0' : char}
              </motion.span>
            ))}
          </span>

          {/* Second Line: [Deployment/Testing] Platform */}
          <motion.span
            layout
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="inline-flex items-center justify-center gap-1 sm:gap-1.5 mt-0"
          >
            {/* Morphing Word without colored gradients - Pure crisp white matching the headline */}
            <span className="relative inline-flex items-center justify-center">
              <AnimatePresence mode="wait">
                <motion.span
                  key={currentWord}
                  exit={{
                    opacity: 0,
                    y: 16,
                    filter: 'blur(8px)',
                    transition: { duration: 0.2, ease: 'easeIn' },
                  }}
                  className="inline-flex items-center font-bold tracking-normal text-zinc-50"
                >
                  {currentWord.split('').map((char, idx) => (
                    <motion.span
                      key={idx}
                      initial={{ filter: 'blur(10px)', opacity: 0, y: hasLanded ? -24 : -45 }}
                      animate={{
                        filter: ['blur(10px)', 'blur(4px)', 'blur(0px)'],
                        opacity: [0, 0.5, 1],
                        y: hasLanded ? [-24, 3, 0] : [-45, 5, 0],
                      }}
                      transition={{
                        duration: hasLanded ? 0.32 : 0.38,
                        times: [0, 0.55, 1],
                        // If landing, stagger after line 1; during subsequent morphs, stagger from 0
                        delay: hasLanded ? idx * 0.025 : (line1Chars.length + idx) * 0.025,
                        ease: [0.22, 1, 0.36, 1],
                      }}
                      className="inline-block font-bold"
                    >
                      {char}
                    </motion.span>
                  ))}
                </motion.span>
              </AnimatePresence>
            </span>

            {/* Platform - Participates in initial landing animation then remains stable */}
            <span className="text-zinc-50 font-bold ml-0.5 inline-flex items-center">
              {platformChars.map((char, idx) => (
                <motion.span
                  key={idx}
                  initial={{ filter: 'blur(10px)', opacity: 0, y: -45 }}
                  animate={{
                    filter: ['blur(10px)', 'blur(4px)', 'blur(0px)'],
                    opacity: [0, 0.5, 1],
                    y: [-45, 5, 0],
                  }}
                  transition={{
                    duration: 0.38,
                    times: [0, 0.55, 1],
                    delay: (line1Chars.length + currentWord.length + idx) * 0.025,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className="inline-block font-bold"
                >
                  {char}
                </motion.span>
              ))}
            </span>
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
