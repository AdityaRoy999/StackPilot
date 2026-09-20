import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { SCRIPTS } from '../config/scripts';
import { useScript } from '../context/ScriptContext';

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
      {/* Unified Bento Grid Card joining platform options & command bar */}
      <div className="rounded-2xl sm:rounded-3xl border border-zinc-800/90 bg-zinc-950/90 backdrop-blur-2xl p-2 sm:p-2.5 flex flex-col gap-2 transition-all">
        {/* Top Bento Row: Platform Options switcher */}
        <div className="flex items-center gap-1 sm:gap-1.5 px-2 py-1 overflow-x-auto no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden text-xs font-mono select-none">
          {SCRIPTS.map((script, idx) => {
            const isActive = script.id === activeTab;
            return (
              <React.Fragment key={script.id}>
                {idx > 0 && (
                  <span className="h-3.5 w-[1px] bg-zinc-800/80 select-none hidden md:inline-block shrink-0" />
                )}
                <button
                  type="button"
                  onClick={() => setActiveTab(script.id)}
                  className={`px-3 sm:px-3.5 py-1.5 rounded-full transition-all duration-200 cursor-pointer whitespace-nowrap text-xs font-medium shrink-0 ${
                    isActive
                      ? 'bg-[#121212] border border-zinc-700 text-white font-bold'
                      : 'text-zinc-400 hover:text-zinc-100 hover:bg-[#121212]/70 active:scale-95'
                  }`}
                  title={`Switch to ${script.label}`}
                >
                  {script.label}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Bottom Bento Row: Command well with copy button */}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5 sm:py-3 rounded-xl sm:rounded-2xl bg-black/70 border border-zinc-850/80 transition-all group hover:border-zinc-700/80">
          {/* Command text */}
          <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden text-left font-mono text-xs sm:text-sm text-zinc-200 py-0.5">
            <span className="text-zinc-500 font-bold select-none shrink-0">$</span>
            <code className="whitespace-nowrap font-mono selection:bg-zinc-800 selection:text-white">
              {activeScript.command}
            </code>
          </div>

          {/* Copy Button styled with #121212 */}
          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[#121212] border border-zinc-800 hover:border-zinc-700 hover:bg-[#1a1a1a] text-zinc-200 hover:text-white text-xs font-semibold font-sans shrink-0 transition-all active:scale-95 cursor-pointer"
            title="Copy command to clipboard"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                <span className="text-emerald-400 font-bold">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScriptBox;
