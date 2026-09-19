import React from 'react';
import { GithubIcon } from './icons/GithubIcon';
import { ExternalLink, Terminal } from 'lucide-react';

export const Navbar: React.FC = () => {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-zinc-850 bg-black/80 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
        {/* Logo */}
        <a href="#" className="flex items-center gap-2.5 group">
          <div className="w-7 h-7 rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-100 group-hover:border-zinc-700 transition-colors">
            <Terminal className="w-3.5 h-3.5 text-zinc-300" />
          </div>
          <span className="font-semibold text-sm tracking-tight text-zinc-100">
            StackPilot
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-800">
            v2.0
          </span>
        </a>

        {/* Right actions */}
        <div className="flex items-center gap-2.5">
          <a
            href="https://github.com/AdityaRoy999/StackPilot"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-zinc-300 hover:text-zinc-100 px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 transition-colors"
          >
            <GithubIcon className="w-3.5 h-3.5 text-zinc-400" />
            <span>GitHub</span>
          </a>

          <a
            href="http://localhost:3000"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-950 bg-zinc-100 hover:bg-zinc-200 px-3.5 py-1.5 rounded-md transition-colors"
          >
            <span>Launch Cockpit</span>
            <ExternalLink className="w-3 h-3 text-zinc-600" />
          </a>
        </div>
      </div>
    </header>
  );
};
