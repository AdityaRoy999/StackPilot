import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BlurText } from './reactbits/BlurText';
import { ScriptBox } from './ScriptBox';

interface MorphWord {
  text: string;
  stops: string[];
  glow: string;
}

const MORPH_WORDS: MorphWord[] = [
  {
    text: 'Deployment',
    stops: ['#34d399', '#2dd4bf', '#22d3ee'],
    glow: 'rgba(52, 211, 153, 0.28)',
  },
  {
    text: 'Testing',
    stops: ['#67e8f9', '#38bdf8', '#818cf8'],
    glow: 'rgba(56, 189, 248, 0.28)',
  },
];

// Helper to interpolate between hex colors for multi-stop letter gradients
function interpolateColor(color1: string, color2: string, factor: number): string {
  const c1 = parseInt(color1.replace('#', ''), 16);
  const c2 = parseInt(color2.replace('#', ''), 16);

  const r1 = (c1 >> 16) & 255;
  const g1 = (c1 >> 8) & 255;
  const b1 = c1 & 255;

  const r2 = (c2 >> 16) & 255;
  const g2 = (c2 >> 8) & 255;
  const b2 = c2 & 255;

  const r = Math.round(r1 + factor * (r2 - r1));
  const g = Math.round(g1 + factor * (g2 - g1));
  const b = Math.round(b1 + factor * (b2 - b1));

  return `rgb(${r}, ${g}, ${b})`;
}

function getGradientLetterColors(stops: string[], count: number): string[] {
  if (count <= 1) return [stops[0]];
  const colors: string[] = [];
  const segments = stops.length - 1;

  for (let i = 0; i < count; i++) {
    const globalT = i / (count - 1);
    const segment = Math.min(Math.floor(globalT * segments), segments - 1);
    const segmentT = (globalT - segment / segments) * segments;
    colors.push(interpolateColor(stops[segment], stops[segment + 1], segmentT));
  }
  return colors;
}

export const Hero: React.FC = () => {
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % MORPH_WORDS.length);
    }, 3200);
    return () => clearInterval(timer);
  }, []);

  const currentWord = MORPH_WORDS[wordIndex];
  const letterColors = getGradientLetterColors(currentWord.stops, currentWord.text.length);

  return (
    <section className="pt-28 pb-16 sm:pt-36 sm:pb-24 text-center relative z-10">
      {/* Main Title with BlurText animation & Caveat Brush font on the morphing word */}
      <div className="w-full max-w-5xl mx-auto mb-6 flex flex-col items-center justify-center select-none">
        <h1 className="text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight text-zinc-50 leading-[1.14] text-center">
          <BlurText
            text="Autonomous AI"
            as="span"
            delay={25}
            animateBy="letters"
            direction="top"
            stepDuration={0.25}
            className="justify-center text-center text-zinc-50 font-bold block"
          />
          <motion.span
            layout
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="inline-flex items-center justify-center gap-2.5 sm:gap-4 mt-1 sm:mt-2"
          >
            <span className="relative inline-flex items-center justify-center">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={currentWord.text}
                  exit={{
                    opacity: 0,
                    y: 16,
                    filter: 'blur(8px)',
                    transition: { duration: 0.22, ease: 'easeIn' }
                  }}
                  className="inline-flex items-center font-caveat font-normal text-[1.14em] sm:text-[1.18em] tracking-wide"
                  style={{
                    filter: `drop-shadow(0 0 24px ${currentWord.glow})`,
                  }}
                >
                  {currentWord.text.split('').map((char, idx) => (
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
                        delay: idx * 0.03,
                        ease: [0.22, 1, 0.36, 1],
                      }}
                      style={{
                        color: letterColors[idx],
                        display: 'inline-block',
                        willChange: 'transform, filter, opacity',
                      }}
                    >
                      {char}
                    </motion.span>
                  ))}
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
