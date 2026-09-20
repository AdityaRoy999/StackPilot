import React from 'react';

interface FooterProps {
  onNavigateDocs?: () => void;
}

export const Footer: React.FC<FooterProps> = ({ onNavigateDocs }) => {
  return (
    <footer className="relative w-full py-12 flex flex-col items-center justify-center overflow-hidden z-20 text-xs font-mono">
      <div className="flex items-center gap-3 text-xs text-zinc-400 mb-2">
        <span className="font-semibold text-zinc-300">StackPilot</span>
        <span className="text-zinc-700">•</span>
        <button
          type="button"
          onClick={onNavigateDocs}
          className="text-zinc-400 hover:text-emerald-400 transition-colors cursor-pointer bg-transparent border-0 p-0 font-mono text-xs"
        >
          Documentation
        </button>
        <span className="text-zinc-700">•</span>
        <a
          href="https://github.com/AdityaRoy999/StackPilot"
          target="_blank"
          rel="noopener noreferrer"
          className="text-zinc-400 hover:text-white transition-colors"
        >
          GitHub
        </a>
      </div>

      <div className="mt-1 text-[11px] text-zinc-600 text-center tracking-wide">
        Autonomous AI QA &amp; Delivery Engine — Built for the Agentic Era
      </div>
    </footer>
  );
};

export default Footer;
