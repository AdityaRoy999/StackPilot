import React, { useState, useEffect } from 'react';
import { BookOpen } from 'lucide-react';
import { GithubIcon } from './icons/GithubIcon';
import { StarIcon } from './icons/StarIcon';
import { UsersIcon } from './icons/UsersIcon';

interface NavbarProps {
  onNavigateDocs?: () => void;
  onNavigateHome?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ onNavigateDocs, onNavigateHome }) => {
  const [stars, setStars] = useState<number | null>(null);
  const [visitors, setVisitors] = useState<number>(1482);

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
          <div className="font-mono font-bold text-xs text-zinc-300 group-hover:text-emerald-400 transition-colors flex items-center justify-center shrink-0">
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

      {/* Right side: Floating pill bubbles (Visitors, Docs & GitHub) */}
      <div className="pointer-events-auto flex items-center gap-2 sm:gap-2.5">
        {/* Visitors Bubble */}
        <div
          className="inline-flex items-center gap-1.5 h-10 px-3 sm:px-3.5 rounded-full border-0 bg-[#1c1c1e] backdrop-blur-xl text-xs font-mono text-zinc-300 transition-colors"
          title="Unique site visitors"
        >
          <UsersIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span>{visitors.toLocaleString()} visitors</span>
        </div>

        {/* Docs Button */}
        <a
          href="/docs"
          onClick={(e) => {
            e.preventDefault();
            onNavigateDocs?.();
          }}
          className="inline-flex items-center gap-1.5 h-10 px-3 sm:px-3.5 rounded-full border-0 bg-[#1c1c1e] backdrop-blur-xl text-xs font-mono text-zinc-300 hover:text-white hover:bg-[#262629] transition-all cursor-pointer select-none"
          title="StackPilot Documentation"
        >
          <BookOpen className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span>Docs</span>
        </a>

        {/* GitHub Stars Bubble */}
        <a
          href="https://github.com/AdityaRoy999/StackPilot"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 h-10 px-3 sm:px-3.5 rounded-full border-0 bg-[#1c1c1e] backdrop-blur-xl text-xs text-zinc-300 hover:text-white hover:bg-[#262629] transition-all group"
          title="View StackPilot on GitHub"
        >
          <GithubIcon className="w-3.5 h-3.5 text-white shrink-0" />
          <span className="hidden sm:inline">GitHub</span>
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#28282c] text-[10px] font-mono text-zinc-300 border-0">
            <StarIcon className="w-2.5 h-2.5 text-amber-400 shrink-0" />
            <span>{stars !== null ? stars : '1'}</span>
          </span>
        </a>
      </div>
    </header>
  );
};

export default Navbar;
