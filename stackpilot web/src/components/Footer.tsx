import React from 'react';
import { GithubIcon } from './icons/GithubIcon';

export const Footer: React.FC = () => {
  return (
    <footer className="relative w-full py-12 flex flex-col items-center justify-center overflow-hidden z-20 text-xs text-zinc-500 font-mono">
      <div className="flex items-center gap-4 text-zinc-400">
        <span>StackPilot v2.0</span>
        <span className="h-3 w-[1px] bg-zinc-800" />
        <a
          href="https://github.com/AdityaRoy999/StackPilot"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-zinc-200 transition-colors flex items-center gap-1.5"
        >
          <GithubIcon className="w-3.5 h-3.5 text-zinc-400" />
          <span>GitHub</span>
        </a>
        <span className="h-3 w-[1px] bg-zinc-800" />
        <a
          href="http://localhost:3000"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-zinc-200 transition-colors"
        >
          Cockpit
        </a>
        <span className="h-3 w-[1px] bg-zinc-800" />
        <span>Apache-2.0</span>
      </div>

      <div className="mt-3 text-[11px] text-zinc-600 text-center">
        Autonomous AI QA &amp; Delivery Engine — Built for the Agentic Era
      </div>
    </footer>
  );
};

export default Footer;
