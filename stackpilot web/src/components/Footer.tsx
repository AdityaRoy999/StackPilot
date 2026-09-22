import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  BookOpen01Icon,
  Mail01Icon,
  GithubIcon,
  Tag01Icon
} from '@hugeicons/core-free-icons';

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

      {/* Giant Chronicle-Style Wordmark: Clean, Monolithic Typography Fading Smoothly into Background */}
      <div className="w-full overflow-hidden flex items-center justify-center mt-6 sm:mt-10 mb-2 sm:mb-4 px-4 sm:px-8 relative">
        <div className="relative select-none pointer-events-none pb-4">
          <h2
            className="footer-brand-wordmark keep-sans text-[11vw] sm:text-[12.5vw] md:text-[13.5vw] font-black tracking-[-0.02em] sm:tracking-[0.01em] uppercase leading-[1.15] text-center whitespace-nowrap select-none text-transparent bg-clip-text"
            style={{
              fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
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

      {/* Clean Bottom Navigation & Metadata Bar with Floating Capsule Bubble (Without harsh border line) */}
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-8 pt-4 sm:pt-6 flex flex-col md:flex-row items-center justify-between gap-6 text-xs text-zinc-400 keep-sans">
        {/* Left: Brand & Engine tagline */}
        <div className="flex items-center gap-2 text-zinc-400 text-xs keep-sans">
          <span className="font-bold text-zinc-200">StackPilot</span>
          <span className="text-zinc-600">•</span>
          <span className="text-zinc-400">Autonomous AI QA &amp; Delivery Engine</span>
        </div>

        {/* Right: Floating Capsule Bubble with Animated Sliding Hover Tab Physics */}
        <div className="flex items-center justify-center keep-sans">
          <div
            onMouseLeave={() => setHoveredTab(null)}
            className="inline-flex items-center h-10 p-1 rounded-full bg-[#18181b] border border-zinc-800/90 shadow-xl text-xs text-zinc-300 relative select-none keep-sans"
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
                <HugeiconsIcon icon={BookOpen01Icon} size={14} strokeWidth={1.8} className="text-white shrink-0" />
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
                <HugeiconsIcon icon={Mail01Icon} size={14} strokeWidth={1.8} className="text-white shrink-0" />
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
                <HugeiconsIcon icon={GithubIcon} size={14} strokeWidth={1.8} className="text-white shrink-0" />
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
                <HugeiconsIcon icon={Tag01Icon} size={14} strokeWidth={1.8} className="text-white shrink-0" />
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
