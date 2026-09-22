import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface PreloaderProps {
  onComplete?: () => void;
}

export const Preloader: React.FC<PreloaderProps> = ({ onComplete }) => {
  const [progress, setProgress] = useState(0);
  const [isExiting, setIsExiting] = useState(false);
  const [isDone, setIsDone] = useState(false);

  useEffect(() => {
    let current = 0;
    const start = performance.now();
    const duration = 1100; // Fast, snappy ~1.1s total boot time

    const frame = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / duration);
      // Easing curve: quick start, gentle deceleration near 100
      const eased = 1 - Math.pow(1 - t, 2.5);
      current = Math.min(100, Math.floor(eased * 100));
      setProgress(current);

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        setProgress(100);
        // Start the dramatic blue transition effect
        setTimeout(() => {
          setIsExiting(true);
          // Wait for blue sweep animation to finish then unmount
          setTimeout(() => {
            setIsDone(true);
            onComplete?.();
          }, 650);
        }, 120);
      }
    };

    const animId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animId);
  }, [onComplete]);

  if (isDone) return null;

  return (
    <div className="fixed inset-0 z-[99999] pointer-events-none select-none overflow-hidden">
      {/* 1. Base Monochrome Preloader Layer (No Colors) */}
      <motion.div
        initial={{ opacity: 1 }}
        animate={{ opacity: isExiting ? 0 : 1 }}
        transition={{ duration: 0.5, ease: 'easeInOut' }}
        className="absolute inset-0 bg-black flex flex-col items-center justify-center pointer-events-auto"
      >
        <div className="w-full max-w-xs px-6 flex flex-col items-center text-center">
          {/* Minimal Brand Monospace Mark */}
          <div className="flex items-center gap-2 mb-8">
            <span className="font-mono text-white text-sm font-bold tracking-tight">&gt;_</span>
            <span className="font-mono text-white text-xs font-semibold tracking-[0.25em] uppercase">
              StackPilot
            </span>
          </div>

          {/* Minimal Razor Progress Line */}
          <div className="w-full h-[1.5px] bg-zinc-850 rounded-full overflow-hidden mb-5">
            <motion.div
              className="h-full bg-white rounded-full transition-all duration-75 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Numeric Counter */}
          <div className="flex items-center justify-between w-full font-mono text-[11px] text-zinc-500 tracking-wider">
            <span className="uppercase text-[10px] tracking-widest text-zinc-600">Booting</span>
            <span className="text-zinc-200 tabular-nums font-semibold">
              {progress.toString().padStart(2, '0')}%
            </span>
          </div>
        </div>
      </motion.div>

      {/* 2. Futuristic Electric Blue Transition Sweep Effect */}
      <AnimatePresence>
        {isExiting && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{
              opacity: [0, 0.95, 0],
              scale: [0.8, 1.8, 2.6],
              filter: ['blur(0px)', 'blur(30px)', 'blur(60px)'],
            }}
            transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
          >
            {/* Multi-layered radiant electric blue and sky bloom wave */}
            <div className="w-[120vw] h-[120vh] rounded-full bg-[radial-gradient(circle_at_center,_rgba(56,189,248,0.75)_0%,_rgba(37,99,235,0.6)_35%,_rgba(79,70,229,0.35)_55%,_transparent_75%)]" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Subtle Blue Flash Horizon Line */}
      {isExiting && (
        <motion.div
          initial={{ opacity: 1, scaleX: 0 }}
          animate={{ opacity: [1, 0.8, 0], scaleX: [0, 1.5, 2] }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[2px] bg-gradient-to-r from-transparent via-sky-400 to-transparent shadow-[0_0_25px_4px_rgba(56,189,248,0.8)] pointer-events-none"
        />
      )}
    </div>
  );
};
