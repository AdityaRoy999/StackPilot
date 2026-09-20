import React, { useState } from 'react';
import { motion } from 'framer-motion';
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
        {/* Top Bento Row: Platform Options switcher with smooth sliding tab animation */}
        <div className="flex items-center gap-1 sm:gap-1.5 px-2 py-1 overflow-x-auto no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden text-xs font-mono select-none">
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

        {/* Bottom Bento Row: Command well with grayed out background and circular copy button */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 sm:px-4 sm:py-2.5 rounded-xl sm:rounded-2xl bg-[#18181b]/80 border-0 transition-all group">
          {/* Command text with headline-style BlurText transition when switching tabs */}
          <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden text-left font-mono text-xs sm:text-sm text-zinc-200 py-0.5">
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

          {/* Circular Copy Button with only copy icon */}
          <button
            onClick={handleCopy}
            className="w-8 h-8 rounded-full border-0 bg-[#1c1c1e] hover:bg-[#28282c] text-zinc-300 hover:text-white flex items-center justify-center shrink-0 transition-all active:scale-90 cursor-pointer"
            title="Copy command to clipboard"
            aria-label="Copy command"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5 text-zinc-300" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScriptBox;
