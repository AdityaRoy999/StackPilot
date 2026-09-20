import React from 'react';

interface FooterProps {
  onNavigateDocs?: () => void;
  onNavigateContact?: () => void;
}

export const Footer: React.FC<FooterProps> = ({ onNavigateDocs, onNavigateContact }) => {
  return (
    <footer className="relative w-full pt-20 pb-10 overflow-hidden z-20 flex flex-col items-center border-t border-zinc-900/60 mt-20">
      {/* Top Navigation Row */}
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-8 mb-10 flex flex-wrap items-center justify-between gap-4 text-xs">
        {/* Left: Operational Status */}
        <div className="flex items-center gap-2 text-zinc-400">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-zinc-300 font-medium">All systems operational</span>
        </div>

        {/* Right: Quick Links */}
        <div className="flex flex-wrap items-center gap-5 sm:gap-7 text-zinc-400">
          <a
            href="/docs"
            onClick={(e) => {
              e.preventDefault();
              onNavigateDocs?.();
            }}
            className="hover:text-white transition-colors cursor-pointer select-none"
          >
            Documentation
          </a>
          <a
            href="/contact"
            onClick={(e) => {
              e.preventDefault();
              onNavigateContact?.();
            }}
            className="hover:text-white transition-colors cursor-pointer select-none"
          >
            Contact
          </a>
          <a
            href="https://github.com/AdityaRoy999/StackPilot"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white transition-colors"
          >
            GitHub
          </a>
          <a
            href="https://github.com/AdityaRoy999/StackPilot/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white transition-colors"
          >
            Releases
          </a>
        </div>
      </div>

      {/* Giant Antigravity-Style Display Wordmark */}
      <div className="w-full overflow-hidden flex items-center justify-center my-4 sm:my-8 select-none pointer-events-none px-2 sm:px-6">
        <h2 className="font-headline text-[13vw] sm:text-[14.5vw] font-bold tracking-tighter leading-none text-center text-zinc-100 whitespace-nowrap drop-shadow-2xl">
          StackPilot
        </h2>
      </div>

      {/* Bottom Metadata & Legal Row */}
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-8 pt-8 border-t border-zinc-900/80 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-500">
        <div className="flex items-center gap-2.5 text-zinc-400">
          <span className="font-bold text-zinc-200">StackPilot</span>
          <span>•</span>
          <span>Autonomous AI QA &amp; Delivery Engine</span>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-zinc-500 text-[11px]">
          <span>© 2026 StackPilot</span>
          <span>•</span>
          <span>Open Source (Apache-2.0)</span>
          <span>•</span>
          <span>Built for the Agentic Era</span>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
