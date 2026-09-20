import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check } from 'lucide-react';
import { SCRIPTS } from '../config/scripts';
import { useScript } from '../context/ScriptContext';
import { BlurText } from './reactbits/BlurText';

export const ScriptBox: React.FC = () => {
  const { activeTab, setActiveTab, activeScript } = useScript();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(activeScript.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full max-w-3xl mx-auto mt-8">
      {/* Unified Bento Grid Card */}
      <div className="rounded-2xl sm:rounded-3xl border border-zinc-800/80 bg-zinc-950/90 backdrop-blur-2xl p-2 sm:p-2.5 flex flex-col gap-2 transition-all">
        {/* Top Bento Row: Platform Options switcher (left-aligned flush with command well below) */}
        <div className="flex items-center gap-1 sm:gap-1.5 px-0 py-0.5 overflow-x-auto no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden text-xs font-mono select-none">
          {SCRIPTS.map((script) => {
            const isActive = script.id === activeTab;
            return (
              <button
                key={script.id}
                type="button"
                onClick={() => setActiveTab(script.id)}
                className={`relative px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  isActive ? 'text-zinc-950 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
                }`}
                title={`Switch to ${script.label}`}
              >
                {/* Smooth sliding pill animation */}
                {isActive && (
                  <motion.div
                    layoutId="activeTabSelection"
                    className="absolute inset-0 rounded-full bg-zinc-100"
                    transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                  />
                )}
                <span className="relative z-10">{script.label}</span>
              </button>
            );
          })}
        </div>

        {/* Bottom Bento Row: Command well with fading gradient and animated copy button */}
        <div className="flex items-center justify-between gap-3 px-3.5 py-2 sm:px-4 sm:py-2.5 rounded-xl sm:rounded-2xl bg-[#18181b]/80 border-0 transition-all relative">
          {/* Command text container with right fading gradient */}
          <div className="relative flex-1 min-w-0 overflow-hidden">
            <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden text-left font-mono text-xs sm:text-sm text-zinc-200 py-0.5 pr-10">
              <span className="text-zinc-500 font-bold select-none shrink-0">$</span>
              <BlurText
                key={activeScript.id}
                text={activeScript.command}
                delay={10}
                animateBy="letters"
                stepDuration={0.2}
                direction="top"
                className="flex-nowrap font-mono text-xs sm:text-sm text-zinc-200 whitespace-nowrap selection:bg-zinc-800 selection:text-white"
              />
            </div>

            {/* Smooth fading gradient towards the copy button */}
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-r from-transparent to-[#18181b]" />
          </div>

          {/* Circular Copy Button: smooth green transition and checkmark spring pop */}
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
