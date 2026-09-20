import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check } from 'lucide-react';
import confetti from 'canvas-confetti';
import { SCRIPTS, ScriptTab } from '../config/scripts';
import { useScript } from '../context/ScriptContext';
import { highlightCode } from '../utils/syntaxHighlight';

export const ScriptBox: React.FC = () => {
  const { activeTab, setActiveTab, activeScript } = useScript();
  const [copied, setCopied] = useState(false);
  const [hoveredTab, setHoveredTab] = useState<ScriptTab | null>(null);

  const highlightedCommand = useMemo(() => {
    return highlightCode(activeScript.command, 'bash');
  }, [activeScript.command]);

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
      {/* Unified Bento Grid Card */}
      <div className="w-full rounded-2xl sm:rounded-3xl border border-zinc-800/80 bg-zinc-950/90 backdrop-blur-2xl p-2 sm:p-2.5 flex flex-col gap-2 transition-all shadow-2xl">
        {/* Top Bento Row: Platform Options switcher with smooth pill physics */}
        <div
          onMouseLeave={() => setHoveredTab(null)}
          className="flex items-center gap-1 sm:gap-1.5 p-1 rounded-xl sm:rounded-2xl bg-[#121214]/90 border border-zinc-800/60 overflow-x-auto no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden text-xs select-none relative"
        >
          {SCRIPTS.map((script, idx) => {
            const isActive = script.id === activeTab;

            return (
              <React.Fragment key={script.id}>
                {idx > 0 && (
                  <span
                    className="h-3 w-[1px] bg-zinc-800/60 select-none shrink-0 pointer-events-none mx-0.5"
                    aria-hidden="true"
                  />
                )}
                <button
                  type="button"
                  onClick={() => setActiveTab(script.id)}
                  onMouseEnter={() => setHoveredTab(script.id)}
                  className={`relative px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 border-0 bg-transparent ${
                    isActive
                      ? 'text-zinc-950 font-semibold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                  title={`Switch to ${script.label}`}
                >
                  {/* Smooth hover pill */}
                  {hoveredTab === script.id && !isActive && (
                    <motion.div
                      layoutId="scriptTabHoverPill"
                      className="absolute inset-0 bg-[#26262a] rounded-lg"
                      transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                    />
                  )}

                  {/* Smooth sliding active tab pill */}
                  {isActive && (
                    <motion.div
                      layoutId="activeTabSelection"
                      className="absolute inset-0 bg-zinc-100 rounded-lg shadow-sm"
                      transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                    />
                  )}
                  <span className="relative z-10">{script.label}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Bottom Bento Row: Command well with traffic lights, syntax highlighting and animated copy button */}
        <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl sm:rounded-2xl bg-[#121214]/95 border border-zinc-800/60 transition-all relative">
          {/* Left: Terminal traffic lights + Command text */}
          <div className="flex items-center gap-3 min-w-0 flex-1 overflow-x-auto no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden py-0.5 pr-2">
            {/* Mac traffic lights */}
            <div className="flex items-center gap-1.5 shrink-0 select-none opacity-85">
              <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#27c93f]" />
            </div>

            <span className="text-emerald-400 font-mono font-bold select-none shrink-0 text-xs sm:text-sm">$</span>

            {/* Crisp syntax-highlighted command */}
            <span
              className="font-mono text-xs sm:text-sm text-zinc-200 whitespace-nowrap selection:bg-zinc-800 selection:text-white"
              dangerouslySetInnerHTML={{ __html: highlightedCommand }}
            />
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
                  <Check className="w-3.5 h-3.5" />
                </motion.div>
              ) : (
                <motion.div
                  key="copy"
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.4, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <Copy className="w-3.5 h-3.5" />
                </motion.div>
              )}
            </AnimatePresence>
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScriptBox;
