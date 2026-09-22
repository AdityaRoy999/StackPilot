import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  UserMultiple02Icon,
  BookOpen01Icon,
  Mail01Icon,
  GithubIcon,
  StarIcon
} from '@hugeicons/core-free-icons';
import { useFont } from '../context/FontContext';

interface NavbarProps {
  onNavigateDocs?: () => void;
  onNavigateHome?: () => void;
  onNavigateContact?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ onNavigateDocs, onNavigateHome, onNavigateContact }) => {
  const [stars, setStars] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const cached = localStorage.getItem('sp_github_stars');
      if (cached) {
        const num = parseInt(cached, 10);
        if (!isNaN(num) && num > 0) return num;
      }
    }
    return 4; // Verified baseline for AdityaRoy999/StackPilot
  });
  const [visitors, setVisitors] = useState<number>(1482);
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);
  const { fontMode, toggleFontMode } = useFont();

  useEffect(() => {
    // 1. Fetch live GitHub stars from repo with multiple fallback strategies
    const fetchLiveStars = async () => {
      // Strategy A: Local dev / Vercel serverless proxy endpoint
      try {
        const res = await fetch('/api/stars');
        if (res.ok) {
          const data = await res.json();
          if (typeof data.stars === 'number' && data.stars > 0) {
            setStars(data.stars);
            localStorage.setItem('sp_github_stars', data.stars.toString());
            return;
          }
        }
      } catch {
        // Continue to remote fallbacks
      }

      // Strategy B: Ungh.cc unauthenticated edge-cached GitHub proxy (bypasses GitHub rate limits)
      try {
        const unghRes = await fetch('https://ungh.cc/repos/AdityaRoy999/StackPilot');
        if (unghRes.ok) {
          const unghData = await unghRes.json();
          if (typeof unghData?.repo?.stars === 'number') {
            setStars(unghData.repo.stars);
            localStorage.setItem('sp_github_stars', unghData.repo.stars.toString());
            return;
          }
        }
      } catch {
        // Continue to official GitHub API
      }

      // Strategy C: Direct GitHub REST API
      try {
        const ghRes = await fetch('https://api.github.com/repos/AdityaRoy999/StackPilot', {
          headers: { Accept: 'application/vnd.github.v3+json' },
        });
        if (ghRes.ok) {
          const ghData = await ghRes.json();
          if (typeof ghData.stargazers_count === 'number') {
            setStars(ghData.stargazers_count);
            localStorage.setItem('sp_github_stars', ghData.stargazers_count.toString());
            return;
          }
        }
      } catch {
        // Fall back to existing cached state
      }
    };

    fetchLiveStars();

    // 2. Track unique visitors persistently
    const KEY_VISITOR = 'sp_unique_visitor_recorded';
    const KEY_COUNT = 'sp_unique_visitor_count';
    const initialBaseline = 1482;

    let currentCount = parseInt(localStorage.getItem(KEY_COUNT) || '0', 10);
    if (!currentCount || currentCount < initialBaseline) {
      currentCount = initialBaseline;
    }

    const hasVisited = localStorage.getItem(KEY_VISITOR);
    if (!hasVisited) {
      const newCount = currentCount + 1;
      localStorage.setItem(KEY_VISITOR, 'true');
      localStorage.setItem(KEY_COUNT, newCount.toString());
      setVisitors(newCount);
    } else {
      setVisitors(currentCount);
    }
  }, []);

  return (
    <header className="fixed top-5 left-0 right-0 z-50 px-4 sm:px-8 flex items-center justify-between pointer-events-none">
      {/* Left side: Expandable Terminal Button (reveals 'StackPilot' on hover) */}
      <div className="pointer-events-auto">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onNavigateHome?.();
          }}
          className="group inline-flex items-center h-10 px-3.5 rounded-full border-0 bg-[#1c1c1e] backdrop-blur-xl hover:bg-[#262629] transition-all duration-300 ease-out cursor-pointer select-none"
          title="StackPilot Home"
        >
          {/* Terminal prompt icon */}
          <div className="font-mono font-bold text-xs text-white group-hover:text-white transition-colors flex items-center justify-center shrink-0">
            &gt;_
          </div>

          {/* Smoothly expanding brand container */}
          <div className="max-w-0 opacity-0 group-hover:max-w-[160px] group-hover:opacity-100 overflow-hidden transition-all duration-300 ease-out flex items-center whitespace-nowrap">
            <span className="ml-2.5 font-semibold text-xs sm:text-sm tracking-tight text-zinc-100">
              StackPilot
            </span>
          </div>
        </a>
      </div>

      {/* Right side: Unified Capsule Pill with Animated Sliding Hover Tab Physics */}
      <div className="pointer-events-auto">
        <div
          onMouseLeave={() => setHoveredTab(null)}
          className="inline-flex items-center h-10 p-1 rounded-full bg-[#1c1c1e] border border-zinc-800/80 shadow-lg text-xs text-zinc-300 backdrop-blur-xl relative"
        >
          {/* Visitors: between '(' and '|' -> left fully rounded, right square rounded */}
          <div
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-l-full rounded-r-md text-zinc-300 select-none"
            title="Unique site visitors"
          >
            <HugeiconsIcon icon={UserMultiple02Icon} size={15} strokeWidth={1.8} className="text-white shrink-0" />
            <span className="tabular-nums">
              {visitors.toLocaleString()} <span className="hidden xs:inline">visitors</span>
            </span>
          </div>

          {/* Vertical Divider */}
          <span className="h-3.5 w-[1px] bg-zinc-800 shrink-0 select-none mx-0.5" />

          {/* Docs: between '|' and '|' -> square rounded tab with sliding hover animation */}
          <a
            href="/docs"
            onClick={(e) => {
              e.preventDefault();
              onNavigateDocs?.();
            }}
            onMouseEnter={() => setHoveredTab('docs')}
            className="relative inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-transparent text-zinc-400 hover:text-white transition-colors cursor-pointer select-none"
            title="StackPilot Documentation"
          >
            {hoveredTab === 'docs' && (
              <motion.div
                layoutId="navbarHoverPill"
                className="absolute inset-0 bg-[#26262a] rounded-md"
                transition={{ type: 'spring', stiffness: 450, damping: 35 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              <HugeiconsIcon icon={BookOpen01Icon} size={15} strokeWidth={1.8} className="text-white shrink-0" />
              <span>Docs</span>
            </span>
          </a>

          {/* Vertical Divider */}
          <span className="h-3.5 w-[1px] bg-zinc-800 shrink-0 select-none mx-0.5" />

          {/* Contact: between '|' and '|' -> square rounded tab with sliding hover animation */}
          <a
            href="/contact"
            onClick={(e) => {
              e.preventDefault();
              onNavigateContact?.();
            }}
            onMouseEnter={() => setHoveredTab('contact')}
            className="relative inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-transparent text-zinc-400 hover:text-white transition-colors cursor-pointer select-none"
            title="Contact StackPilot Team"
          >
            {hoveredTab === 'contact' && (
              <motion.div
                layoutId="navbarHoverPill"
                className="absolute inset-0 bg-[#26262a] rounded-md"
                transition={{ type: 'spring', stiffness: 450, damping: 35 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              <HugeiconsIcon icon={Mail01Icon} size={15} strokeWidth={1.8} className="text-white shrink-0" />
              <span>Contact</span>
            </span>
          </a>

          {/* Vertical Divider */}
          <span className="h-3.5 w-[1px] bg-zinc-800 shrink-0 select-none mx-0.5" />

          {/* Font Switcher Tab: between '|' and '|' -> lets visitor choose between normal and stylish font */}
          <button
            type="button"
            onClick={toggleFontMode}
            onMouseEnter={() => setHoveredTab('font')}
            className="relative inline-flex items-center gap-1.5 h-8 px-2.5 sm:px-3 rounded-md bg-transparent text-zinc-400 hover:text-white transition-colors cursor-pointer select-none border-0"
            title={fontMode === 'stylish' ? 'Switch to Normal font' : 'Switch to Handwriting / Stylish font'}
          >
            {hoveredTab === 'font' && (
              <motion.div
                layoutId="navbarHoverPill"
                className="absolute inset-0 bg-[#26262a] rounded-md"
                transition={{ type: 'spring', stiffness: 450, damping: 35 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              {fontMode === 'stylish' ? (
                <>
                  <span className="text-xs text-white">✍️</span>
                  <span className="hidden sm:inline text-[11px] text-zinc-300">Stylish</span>
                </>
              ) : (
                <>
                  <span className="text-[11px] font-bold text-white">Aa</span>
                  <span className="hidden sm:inline text-[11px] text-zinc-300">Normal</span>
                </>
              )}
            </span>
          </button>

          {/* Vertical Divider */}
          <span className="h-3.5 w-[1px] bg-zinc-800 shrink-0 select-none mx-0.5" />

          {/* GitHub: between '|' and ')' -> left square rounded, right fully rounded with sliding hover animation */}
          <a
            href="https://github.com/AdityaRoy999/StackPilot"
            target="_blank"
            rel="noopener noreferrer"
            onMouseEnter={() => setHoveredTab('github')}
            className="relative inline-flex items-center gap-2 h-8 px-3 rounded-l-md rounded-r-full bg-transparent text-zinc-400 hover:text-white transition-colors cursor-pointer select-none group"
            title="View StackPilot on GitHub"
          >
            {hoveredTab === 'github' && (
              <motion.div
                layoutId="navbarHoverPill"
                className="absolute inset-0 bg-[#26262a] rounded-l-md rounded-r-full"
                transition={{ type: 'spring', stiffness: 450, damping: 35 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-2">
              <HugeiconsIcon icon={GithubIcon} size={15} strokeWidth={1.8} className="text-white shrink-0" />
              <span className="hidden sm:inline">GitHub</span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#28282c] text-[10px] text-zinc-300 border border-zinc-700/50">
                <HugeiconsIcon icon={StarIcon} size={13} strokeWidth={1.8} className="text-white shrink-0" />
                <span>{stars}</span>
              </span>
            </span>
          </a>
        </div>
      </div>
    </header>
  );
};

export default Navbar;
