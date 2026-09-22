import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { HugeiconsIcon } from '@hugeicons/react';
import { Copy01Icon, Tick01Icon } from '@hugeicons/core-free-icons';
import confetti from 'canvas-confetti';
import { SCRIPTS, ScriptTab } from '../config/scripts';
import { useScript } from '../context/ScriptContext';
import { BlurText } from './reactbits/BlurText';
import { BorderGlow } from './reactbits/BorderGlow';

export const ScriptBox: React.FC = () => {
  const { activeTab, setActiveTab, activeScript } = useScript();
  const [copied, setCopied] = useState(false);
  const [hoveredTab, setHoveredTab] = useState<ScriptTab | null>(null);

  const handleCopy = (e?: React.MouseEvent) => {
    navigator.clipboard.writeText(activeScript.command);
    setCopied(true);

    if (e) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = (rect.left + rect.width / 2) / window.innerWidth;
      const y = (rect.top + rect.height / 2) / window.innerHeight;
      confetti({
        particleCount: 22,
        spread: 40,
        startVelocity: 14,
        origin: { x, y },
        colors: ['#ffffff', '#a1a1aa', '#38bdf8', '#4ade80', '#a855f7'],
        ticks: 45,
      });
    }

    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full max-w-[650px] mx-auto mt-8 flex justify-center px-4 sm:px-0">
      {/* Unified Bento Grid Card with Reactive BorderGlow */}
      <BorderGlow
        edgeSensitivity={28}
        glowColor="165 85 55"
        backgroundColor="#0c0c0e"
        borderRadius={28}
        glowRadius={38}
        glowIntensity={1.1}
        coneSpread={26}
        colors={['#10b981', '#06b6d4', '#6366f1']}
        className="w-full shadow-2xl"
      >
        <div className="w-full p-2 sm:p-2.5 flex flex-col gap-2 transition-all">
          {/* Top Bento Row: Platform Options switcher with signature | ) style and section dividers */}
          <div
            onMouseLeave={() => setHoveredTab(null)}
            className="flex items-center gap-1 sm:gap-1.5 p-1 rounded-full bg-[#121214]/90 border border-zinc-800/60 overflow-x-auto touch-pan-x no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden text-xs select-none relative keep-sans"
          >
          {SCRIPTS.map((script, idx) => {
            const isActive = script.id === activeTab;
            // Segmented corner geometry: ( | on first tab, | | square-rounded in middle, | ) on last tab
            const cornerClass =
              idx === 0
                ? 'rounded-l-full rounded-r-md'
                : idx === SCRIPTS.length - 1
                ? 'rounded-l-md rounded-r-full'
                : 'rounded-md';

            return (
              <React.Fragment key={script.id}>
                {idx > 0 && (
                  <span
                    className="h-3.5 w-[1px] bg-zinc-800 shrink-0 pointer-events-none mx-0.5 select-none"
                    aria-hidden="true"
                  />
                )}
                <button
                  type="button"
                  onClick={() => setActiveTab(script.id)}
                  onMouseEnter={() => setHoveredTab(script.id)}
                  className={`relative px-3.5 py-1.5 ${cornerClass} text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 border-0 bg-transparent ${
                    isActive
                      ? 'text-zinc-950 font-semibold'
                      : 'text-zinc-400 hover:text-zinc-100'
                  }`}
                  title={`Switch to ${script.label}`}
                >
                  {/* Segmented hover pill */}
                  {hoveredTab === script.id && !isActive && (
                    <motion.div
                      layoutId="scriptTabHoverPill"
                      className={`absolute inset-0 bg-[#27272a] ${cornerClass}`}
                      transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                    />
                  )}

                  {/* Segmented active pill */}
                  {isActive && (
                    <motion.div
                      layoutId="activeTabSelection"
                      className={`absolute inset-0 bg-zinc-100 ${cornerClass} shadow-sm`}
                      transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                    />
                  )}
                  <span className="relative z-10">{script.label}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Bottom Bento Row: Command well with terminal prompt, animated BlurText switching and spring copy button */}
        <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl sm:rounded-2xl bg-[#121214]/95 border border-zinc-800/60 transition-all relative keep-mono">
          {/* Command text container with right fading gradient and smooth letter switching animation */}
          <div className="relative flex-1 min-w-0 overflow-hidden keep-mono">
            <div className="flex items-center gap-2.5 overflow-x-auto touch-pan-x no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden text-left font-mono text-xs sm:text-sm text-zinc-200 py-0.5 pr-10 keep-mono">
              <span className="text-emerald-400 font-mono font-bold select-none shrink-0 text-xs sm:text-sm keep-mono">$</span>
              <BlurText
                key={activeScript.id}
                text={activeScript.command}
                delay={10}
                animateBy="letters"
                stepDuration={0.2}
                direction="top"
                as="span"
                className="flex-nowrap font-mono text-xs sm:text-sm text-zinc-200 whitespace-nowrap selection:bg-zinc-800 selection:text-white keep-mono"
              />
            </div>

            {/* Smooth fading gradient towards the copy button */}
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-r from-transparent to-[#121214]" />
          </div>

          {/* Circular Copy Button: smooth emerald transition and checkmark spring pop */}
          <button
            onClick={handleCopy}
            className={`w-8 h-8 rounded-full border-0 flex items-center justify-center shrink-0 transition-all duration-300 active:scale-90 cursor-pointer ${
              copied
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'bg-[#1c1c1e] hover:bg-[#28282c] text-zinc-300 hover:text-white'
            }`}
            title="Copy command to clipboard"
            aria-label="Copy command"
          >
            <AnimatePresence mode="wait" initial={false}>
              {copied ? (
                <motion.div
                  key="check"
                  initial={{ scale: 0.4, opacity: 0, rotate: -20 }}
                  animate={{ scale: 1, opacity: 1, rotate: 0 }}
                  exit={{ scale: 0.4, opacity: 0, rotate: 20 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                >
                  <HugeiconsIcon icon={Tick01Icon} size={15} strokeWidth={2.2} />
                </motion.div>
              ) : (
                <motion.div
                  key="copy"
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.4, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={1.8} />
                </motion.div>
              )}
            </AnimatePresence>
          </button>
        </div>
      </div>
      </BorderGlow>
    </div>
  );
};

export default ScriptBox;
