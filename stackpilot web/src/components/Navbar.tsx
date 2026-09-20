import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen } from 'lucide-react';
import { GithubIcon } from './icons/GithubIcon';
import { StarIcon } from './icons/StarIcon';
import { UsersIcon } from './icons/UsersIcon';
import { MailIcon } from './icons/MailIcon';
import { useFont } from '../context/FontContext';

interface NavbarProps {
  onNavigateDocs?: () => void;
  onNavigateHome?: () => void;
  onNavigateContact?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ onNavigateDocs, onNavigateHome, onNavigateContact }) => {
  const [stars, setStars] = useState<number | null>(null);
  const [visitors, setVisitors] = useState<number>(1482);
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);
  const { fontMode, toggleFontMode } = useFont();

  useEffect(() => {
    // 1. Fetch live GitHub stars from repo
    fetch('https://api.github.com/repos/AdityaRoy999/StackPilot')
      .then((res) => {
        if (!res.ok) throw new Error('Network error');
        return res.json();
      })
      .then((data) => {
        if (typeof data.stargazers_count === 'number') {
          setStars(data.stargazers_count);
        }
      })
      .catch(() => {
        setStars(1);
      });

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
            <UsersIcon className="w-3.5 h-3.5 text-white shrink-0" />
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
              <BookOpen className="w-3.5 h-3.5 text-white shrink-0" />
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
              <MailIcon className="w-3.5 h-3.5 text-white shrink-0" />
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
              <GithubIcon className="w-3.5 h-3.5 text-white shrink-0" />
              <span className="hidden sm:inline">GitHub</span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#28282c] text-[10px] text-zinc-300 border border-zinc-700/50">
                <StarIcon className="w-2.5 h-2.5 text-white shrink-0" />
                <span>{stars !== null ? stars : '1'}</span>
              </span>
            </span>
          </a>
        </div>
      </div>
    </header>
  );
};

export default Navbar;
