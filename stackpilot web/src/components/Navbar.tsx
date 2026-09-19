import React, { useState, useEffect } from 'react';
import { GithubIcon } from './icons/GithubIcon';
import { StarIcon } from './icons/StarIcon';
import { UsersIcon } from './icons/UsersIcon';
import { ExternalLink, Terminal } from 'lucide-react';

export const Navbar: React.FC = () => {
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
    <header className="fixed top-4 left-0 right-0 z-50 flex justify-center px-4 sm:px-6 pointer-events-none">
      <div className="w-full max-w-4xl h-12 px-3 sm:px-4 rounded-xl border border-zinc-800/90 bg-zinc-950/85 backdrop-blur-xl flex items-center justify-between shadow-2xl shadow-black/80 pointer-events-auto transition-all">
        {/* Logo */}
        <a href="#" className="flex items-center gap-2.5 group shrink-0">
          <div className="w-6 h-6 rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-100 group-hover:border-zinc-700 transition-colors">
            <Terminal className="w-3 h-3 text-zinc-300" />
          </div>
          <span className="font-semibold text-xs sm:text-sm tracking-tight text-zinc-100">
            StackPilot
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-400 border border-zinc-800">
            v2.0
          </span>
        </a>

        {/* Right actions: Unique Visitors, GitHub Stars, Launch Cockpit */}
        <div className="flex items-center gap-2 sm:gap-2.5">
          {/* Unique Visitors Counter */}
          <div
            className="hidden sm:flex items-center gap-1.5 text-xs text-zinc-400 font-mono px-2.5 py-1 rounded-lg border border-zinc-800/80 bg-zinc-900/60"
            title="Unique site visitors"
          >
            <UsersIcon className="w-3.5 h-3.5 text-emerald-400" />
            <span>{visitors.toLocaleString()} visitors</span>
          </div>

          {/* GitHub Repo Link with Live Star Count */}
          <a
            href="https://github.com/AdityaRoy999/StackPilot"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-zinc-300 hover:text-zinc-100 px-2.5 sm:px-3 py-1 rounded-lg border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 transition-colors"
            title="View StackPilot on GitHub"
          >
            <GithubIcon className="w-3.5 h-3.5 text-zinc-400" />
            <span className="hidden md:inline">GitHub</span>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] font-mono text-zinc-300 border border-zinc-700/60">
              <StarIcon className="w-2.5 h-2.5 text-amber-400" />
              <span>{stars !== null ? stars : '1'}</span>
            </span>
          </a>

          {/* Launch Cockpit Button */}
          <a
            href="http://localhost:3000"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-950 bg-zinc-100 hover:bg-zinc-200 px-3 py-1.5 rounded-lg transition-colors shadow-sm shrink-0"
          >
            <span>Launch Cockpit</span>
            <ExternalLink className="w-3 h-3 text-zinc-600" />
          </a>
        </div>
      </div>
    </header>
  );
};
