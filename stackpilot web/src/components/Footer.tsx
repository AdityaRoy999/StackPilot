import React from 'react';
import { SCRIPTS } from '../config/scripts';
import { useScript } from '../context/ScriptContext';

export const Footer: React.FC = () => {
  const { activeTab, setActiveTab } = useScript();

  return (
    <footer className="relative w-full pt-10 pb-16 flex flex-col items-center justify-center overflow-hidden z-20">
      {/* Subtle curved dome / horizon glow inspired by modern dark OS docks */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[720px] max-w-full h-[200px] rounded-[100%] bg-gradient-to-t from-zinc-800/20 via-zinc-900/10 to-transparent blur-3xl pointer-events-none" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[760px] max-w-full h-[140px] rounded-[100%] border-t border-zinc-800/40 pointer-events-none" />

      {/* Big Bubble OS Dock with Platform Options */}
      <div className="relative group max-w-full px-4">
        {/* Subtle radial aura behind the bubble */}
        <div className="absolute -inset-1 rounded-full bg-gradient-to-r from-zinc-700/20 via-zinc-500/15 to-zinc-700/20 blur-lg opacity-40 group-hover:opacity-80 transition-opacity duration-500" />

        {/* The Dock Pill Bubble containing the platform options */}
        <nav
          aria-label="Platform environment selection dock"
          className="relative inline-flex items-center gap-1 sm:gap-2 px-3 py-2 sm:px-4 sm:py-2 rounded-full border border-zinc-800/90 bg-zinc-950/90 backdrop-blur-2xl shadow-2xl shadow-black ring-1 ring-white/5 text-xs font-mono select-none overflow-x-auto no-scrollbar max-w-full"
        >
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
                  className={`px-3.5 py-1.5 rounded-full transition-all duration-200 cursor-pointer whitespace-nowrap text-xs font-medium shrink-0 ${
                    isActive
                      ? 'bg-zinc-100 text-zinc-950 font-bold shadow-md shadow-white/10 scale-100'
                      : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/80 active:scale-95'
                  }`}
                  title={`Switch to ${script.label}`}
                >
                  {script.label}
                </button>
              </React.Fragment>
            );
          })}
        </nav>
      </div>

      {/* Minimal footer metadata */}
      <div className="mt-8 text-[11px] font-mono text-zinc-600 text-center tracking-wide">
        StackPilot v2.0 — Open-source autonomous AI QA &amp; delivery engine. Apache-2.0
      </div>
    </footer>
  );
};

export default Footer;
