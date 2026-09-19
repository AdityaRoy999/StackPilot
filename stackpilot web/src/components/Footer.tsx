import React from 'react';
import { GithubIcon } from './icons/GithubIcon';
import { Terminal } from 'lucide-react';

export const Footer: React.FC = () => {
  return (
    <footer className="border-t border-zinc-850 py-10 text-xs text-zinc-500">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-zinc-400" />
          <span className="font-medium text-zinc-400">StackPilot</span>
          <span>— Open-source autonomous AI QA & delivery engine.</span>
        </div>

        <div className="flex items-center gap-6 text-zinc-400 font-mono">
          <a
            href="https://github.com/AdityaRoy999/StackPilot"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-200 transition-colors flex items-center gap-1.5"
          >
            <GithubIcon className="w-3 h-3" />
            <span>GitHub</span>
          </a>
          <a
            href="http://localhost:3000"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-200 transition-colors"
          >
            Cockpit
          </a>
          <span>Apache-2.0</span>
        </div>
      </div>
    </footer>
  );
};
