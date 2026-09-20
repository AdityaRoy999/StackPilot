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
        className="absolute bottom-16 left-1/2 -translate-x-1/2 w-[80vw] max-w-5xl h-48 bg-gradient-to-t from-zinc-700/20 via-zinc-800/8 to-transparent blur-3xl pointer-events-none -z-10 rounded-full"
        aria-hidden="true"
      />

      {/* Giant Very Stylish Display Wordmark: Hollow Letters Filled from Below Fading Upwards */}
      <div className="w-full overflow-hidden flex items-center justify-center my-6 sm:my-10 px-3 sm:px-6 relative">
        <div className="relative inline-block select-none pointer-events-none">
          {/* Base Layer: Crisp Hollow Outline */}
          <h2
            className="font-headline text-[13.5vw] sm:text-[15.5vw] md:text-[16.5vw] font-black tracking-[-0.045em] leading-[0.85] text-center whitespace-nowrap select-none"
            style={{
              WebkitTextStroke: '1.2px rgba(255, 255, 255, 0.4)',
              color: 'transparent',
              textShadow: '0 0 30px rgba(255, 255, 255, 0.08)',
            }}
          >
            StackPilot
          </h2>

          {/* Foreground Layer: Filled from below, smoothly fading to transparent upwards */}
          <h2
            className="font-headline text-[13.5vw] sm:text-[15.5vw] md:text-[16.5vw] font-black tracking-[-0.045em] leading-[0.85] text-center whitespace-nowrap absolute inset-0 select-none text-transparent bg-clip-text"
            style={{
              backgroundImage:
                'linear-gradient(to top, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 0.8) 22%, rgba(255, 255, 255, 0.3) 50%, rgba(255, 255, 255, 0.05) 72%, transparent 85%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            StackPilot
          </h2>

          {/* Subtle bottom horizon shimmer under the filled letters */}
          <div
            className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-4/5 max-w-2xl h-[1px] bg-gradient-to-r from-transparent via-white/30 to-transparent blur-[0.5px]"
            aria-hidden="true"
          />
        </div>
      </div>

      {/* Clean Bottom Navigation & Metadata Bar */}
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
