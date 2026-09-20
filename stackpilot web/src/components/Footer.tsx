import React from 'react';

interface FooterProps {
  onNavigateDocs?: () => void;
  onNavigateContact?: () => void;
}

export const Footer: React.FC<FooterProps> = ({ onNavigateDocs, onNavigateContact }) => {
  return (
    <footer className="relative w-full py-12 flex flex-col items-center justify-center overflow-hidden z-20 text-xs font-mono">
      <div className="flex items-center gap-3 text-xs text-zinc-400 mb-2">
        <span className="font-semibold text-zinc-300">StackPilot</span>
        <span className="text-zinc-700">•</span>
        <a
          href="/docs"
          onClick={(e) => {
            e.preventDefault();
            onNavigateDocs?.();
          }}
          className="text-zinc-400 hover:text-white transition-colors cursor-pointer font-mono text-xs select-none"
        >
          Documentation
        </a>
        <span className="text-zinc-700">•</span>
        <a
          href="/contact"
          onClick={(e) => {
            e.preventDefault();
            onNavigateContact?.();
          }}
          className="text-zinc-400 hover:text-white transition-colors cursor-pointer font-mono text-xs select-none"
        >
          Contact
        </a>
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
