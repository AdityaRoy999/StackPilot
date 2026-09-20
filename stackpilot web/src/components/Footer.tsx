import React from 'react';

interface FooterProps {
  onNavigateDocs?: () => void;
  onNavigateContact?: () => void;
}

export const Footer: React.FC<FooterProps> = ({ onNavigateDocs, onNavigateContact }) => {
  return (
    <footer className="relative w-full pt-16 pb-8 overflow-hidden z-20 flex flex-col items-center mt-24 select-none">
      {/* Subtle ambient light glow behind the giant wordmark */}
      <div
        className="absolute bottom-16 left-1/2 -translate-x-1/2 w-[75vw] max-w-4xl h-44 bg-gradient-to-t from-zinc-700/15 via-zinc-800/5 to-transparent blur-3xl pointer-events-none -z-10 rounded-full"
        aria-hidden="true"
      />

      {/* Giant Very Stylish Display Wordmark */}
      <div className="w-full overflow-hidden flex items-center justify-center my-6 sm:my-10 px-3 sm:px-6 relative">
        <h2 className="font-headline text-[13.5vw] sm:text-[15.5vw] md:text-[16.5vw] font-black tracking-[-0.045em] leading-[0.85] text-center whitespace-nowrap text-transparent bg-clip-text bg-gradient-to-b from-white via-zinc-100 to-zinc-500/40 drop-shadow-[0_10px_35px_rgba(255,255,255,0.06)] hover:brightness-110 transition-all duration-500">
          StackPilot
        </h2>
      </div>

      {/* Clean Bottom Navigation & Metadata Bar (Divider + Links & Brand on Bottom) */}
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-8 pt-6 border-t border-zinc-850/80 border-zinc-800/70 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-400">
        {/* Left: Brand & Engine tagline */}
        <div className="flex items-center gap-2 text-zinc-400 text-xs">
          <span className="font-bold text-zinc-200">StackPilot</span>
          <span className="text-zinc-600">•</span>
          <span className="text-zinc-400">Autonomous AI QA &amp; Delivery Engine</span>
        </div>

        {/* Right: Quick Links moved to bottom row + copyright */}
        <div className="flex flex-wrap items-center justify-center sm:justify-end gap-4 sm:gap-6 text-xs text-zinc-400">
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
          <span className="text-zinc-700 hidden sm:inline">•</span>
          <span className="text-zinc-500 text-[11px]">© 2026 StackPilot</span>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
