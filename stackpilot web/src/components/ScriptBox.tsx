import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { useScript } from '../context/ScriptContext';

export const ScriptBox: React.FC = () => {
  const { activeScript } = useScript();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(activeScript.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full max-w-3xl mx-auto mt-8">
      {/* Sleek single-line command bar: just the command and the copy button beside it */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5 sm:py-3 rounded-full border border-zinc-800/90 bg-zinc-950/90 backdrop-blur-2xl shadow-2xl shadow-black/90 ring-1 ring-white/5 transition-all group hover:border-zinc-700">
        {/* Command text */}
        <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar text-left font-mono text-xs sm:text-sm text-zinc-200 py-0.5">
          <span className="text-zinc-500 font-bold select-none shrink-0">$</span>
          <code className="whitespace-nowrap font-mono selection:bg-zinc-800 selection:text-white">
            {activeScript.command}
          </code>
        </div>

        {/* Copy Button right beside the command */}
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-semibold font-sans shrink-0 transition-all shadow-sm active:scale-95 cursor-pointer"
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
