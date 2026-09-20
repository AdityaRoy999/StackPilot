import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { BookOpen } from 'lucide-react';
import { MailIcon } from './icons/MailIcon';
import { GithubIcon } from './icons/GithubIcon';

interface FooterProps {
  onNavigateDocs?: () => void;
  onNavigateContact?: () => void;
}

export const Footer: React.FC<FooterProps> = ({ onNavigateDocs, onNavigateContact }) => {
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);

  return (
    <footer className="relative w-full pt-16 pb-8 overflow-hidden z-20 flex flex-col items-center mt-24 select-none">
      {/* Subtle ambient light glow behind the giant wordmark */}
      <div
        className="absolute bottom-16 left-1/2 -translate-x-1/2 w-[80vw] max-w-5xl h-48 bg-gradient-to-t from-zinc-700/20 via-zinc-800/8 to-transparent blur-3xl pointer-events-none -z-10 rounded-full"
        aria-hidden="true"
      />

      {/* Giant Chronicle-Style Wordmark: Clean, Monolithic Typography Fading into Background */}
      <div className="w-full overflow-visible flex items-center justify-center my-6 sm:my-10 px-4 sm:px-8 relative">
        <div className="relative select-none pointer-events-none">
          <h2
            className="font-headline text-[11vw] sm:text-[12.5vw] md:text-[13.5vw] font-black tracking-[-0.02em] sm:tracking-[0.01em] uppercase leading-[1.1] text-center whitespace-nowrap select-none text-transparent bg-clip-text"
            style={{
              backgroundImage:
                'linear-gradient(180deg, rgba(255, 255, 255, 0.88) 0%, rgba(255, 255, 255, 0.55) 28%, rgba(255, 255, 255, 0.18) 65%, rgba(255, 255, 255, 0.03) 88%, transparent 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            StackPilot
          </h2>
        </div>
      </div>

      {/* Clean Bottom Navigation & Metadata Bar with Floating Capsule Bubble */}
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-8 pt-8 border-t border-zinc-800/70 flex flex-col md:flex-row items-center justify-between gap-6 text-xs text-zinc-400">
        {/* Left: Brand & Engine tagline */}
        <div className="flex items-center gap-2 text-zinc-400 text-xs">
          <span className="font-bold text-zinc-200">StackPilot</span>
          <span className="text-zinc-600">•</span>
          <span className="text-zinc-400">Autonomous AI QA &amp; Delivery Engine</span>
        </div>

        {/* Right: Floating Capsule Bubble with Animated Sliding Hover Tab Physics */}
        <div className="flex items-center justify-center">
          <div
            onMouseLeave={() => setHoveredTab(null)}
            className="inline-flex items-center h-10 p-1 rounded-full bg-[#18181b] border border-zinc-800/90 shadow-xl text-xs text-zinc-300 relative select-none"
          >
            {/* Documentation: between '(' and '|' -> left fully rounded, right square rounded */}
            <a
              href="/docs"
              onClick={(e) => {
                e.preventDefault();
                onNavigateDocs?.();
              }}
              onMouseEnter={() => setHoveredTab('docs')}
              className="relative inline-flex items-center gap-1.5 h-8 px-3 sm:px-3.5 rounded-l-full rounded-r-md bg-transparent text-zinc-400 hover:text-white transition-colors cursor-pointer select-none border-0"
              title="StackPilot Documentation"
            >
              {hoveredTab === 'docs' && (
                <motion.div
                  layoutId="footerHoverPill"
                  className="absolute inset-0 bg-[#26262a] rounded-l-full rounded-r-md"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <BookOpen className="w-3.5 h-3.5 text-white shrink-0" />
                <span className="hidden sm:inline">Documentation</span>
                <span className="sm:hidden">Docs</span>
              </span>
            </a>

            {/* Vertical Divider */}
            <span className="h-3.5 w-[1px] bg-zinc-800/90 shrink-0 mx-0.5 select-none" />

            {/* Contact: between '|' and '|' -> square rounded tab */}
            <a
              href="/contact"
              onClick={(e) => {
                e.preventDefault();
                onNavigateContact?.();
              }}
              onMouseEnter={() => setHoveredTab('contact')}
              className="relative inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-transparent text-zinc-400 hover:text-white transition-colors cursor-pointer select-none border-0"
              title="Contact StackPilot Team"
            >
              {hoveredTab === 'contact' && (
                <motion.div
                  layoutId="footerHoverPill"
                  className="absolute inset-0 bg-[#26262a] rounded-md"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <MailIcon className="w-3.5 h-3.5 text-white shrink-0" />
                <span>Contact</span>
              </span>
            </a>

            {/* Vertical Divider */}
            <span className="h-3.5 w-[1px] bg-zinc-800/90 shrink-0 mx-0.5 select-none" />

            {/* GitHub: between '|' and '|' -> square rounded tab */}
            <a
              href="https://github.com/AdityaRoy999/StackPilot"
              target="_blank"
              rel="noopener noreferrer"
              onMouseEnter={() => setHoveredTab('github')}
              className="relative inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-transparent text-zinc-400 hover:text-white transition-colors cursor-pointer select-none border-0"
              title="View StackPilot on GitHub"
            >
              {hoveredTab === 'github' && (
                <motion.div
                  layoutId="footerHoverPill"
                  className="absolute inset-0 bg-[#26262a] rounded-md"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <GithubIcon className="w-3.5 h-3.5 text-white shrink-0" />
                <span>GitHub</span>
              </span>
            </a>

            {/* Vertical Divider */}
            <span className="h-3.5 w-[1px] bg-zinc-800/90 shrink-0 mx-0.5 select-none" />

            {/* Releases: between '|' and '|' -> square rounded tab */}
            <a
              href="https://github.com/AdityaRoy999/StackPilot/releases"
              target="_blank"
              rel="noopener noreferrer"
              onMouseEnter={() => setHoveredTab('releases')}
              className="relative inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-transparent text-zinc-400 hover:text-white transition-colors cursor-pointer select-none border-0"
              title="StackPilot Releases"
            >
              {hoveredTab === 'releases' && (
                <motion.div
                  layoutId="footerHoverPill"
                  className="absolute inset-0 bg-[#26262a] rounded-md"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <svg
                  className="w-3.5 h-3.5 text-white shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
                  <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
                </svg>
                <span>Releases</span>
              </span>
            </a>

            {/* Vertical Divider */}
            <span className="h-3.5 w-[1px] bg-zinc-800/90 shrink-0 mx-0.5 select-none" />

            {/* Copyright badge: between '|' and ')' -> left square rounded, right fully rounded */}
            <span className="inline-flex items-center h-8 px-3 rounded-l-md rounded-r-full text-[11px] text-zinc-400 select-none">
              <span className="hidden sm:inline">© 2026 StackPilot</span>
              <span className="sm:hidden">© 2026</span>
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
