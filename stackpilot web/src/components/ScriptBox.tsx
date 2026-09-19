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
    <div className="w-full max-w-3xl mx-auto mt-8 flex flex-col items-center gap-4">
      {/* Platform Options Dock - Positioned right above the command bar (No shadows, No scrollbar) */}
      <div className="relative group max-w-full px-2">
        <div className="relative inline-flex items-center gap-1 sm:gap-1.5 px-3 py-1.5 rounded-full border border-zinc-800/90 bg-zinc-950/90 backdrop-blur-2xl text-xs font-mono select-none overflow-x-auto no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden max-w-full">
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
                  className={`px-3 sm:px-3.5 py-1 sm:py-1.5 rounded-full transition-all duration-200 cursor-pointer whitespace-nowrap text-xs font-medium shrink-0 ${
                    isActive
                      ? 'bg-zinc-100 text-zinc-950 font-bold'
                      : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/80 active:scale-95'
                  }`}
                  title={`Switch to ${script.label}`}
                >
                  {script.label}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Sleek single-line command bar: just the command and the copy button beside it (No shadows, No scrollbar) */}
      <div className="w-full flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5 sm:py-3 rounded-full border border-zinc-800/90 bg-zinc-950/90 backdrop-blur-2xl transition-all group hover:border-zinc-700">
        {/* Command text with completely hidden scrollbar */}
        <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden text-left font-mono text-xs sm:text-sm text-zinc-200 py-0.5">
          <span className="text-zinc-500 font-bold select-none shrink-0">$</span>
          <code className="whitespace-nowrap font-mono selection:bg-zinc-800 selection:text-white">
            {activeScript.command}
          </code>
        </div>

        {/* Copy Button right beside the command (No shadows) */}
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-semibold font-sans shrink-0 transition-all active:scale-95 cursor-pointer"
          title="Copy command to clipboard"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span className="text-emerald-700 font-bold">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5 text-zinc-700 shrink-0" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default ScriptBox;
