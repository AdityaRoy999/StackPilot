import React, { useState, useEffect } from 'react';
import { useTheme } from '../context/ThemeContext';
import { 
  Terminal, 
  Sun, 
  Moon, 
  Cpu, 
  ExternalLink, 
  Layers, 
  ShieldCheck, 
  Play,
  Menu,
  X
} from 'lucide-react';
import { GithubIcon } from './icons/GithubIcon';

export const Navbar: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'py-3 bg-white/80 dark:bg-[#06080d]/80 backdrop-blur-xl border-b border-slate-200/80 dark:border-slate-800/80 shadow-sm dark:shadow-2xl dark:shadow-cyan-950/20'
          : 'py-5 bg-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between">
        {/* Brand Logo */}
        <a href="#" className="flex items-center gap-3 group">
          <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-500 via-indigo-500 to-purple-600 p-[1px] shadow-lg shadow-cyan-500/20 group-hover:shadow-cyan-500/40 transition-all duration-300">
            <div className="w-full h-full bg-slate-950 rounded-[11px] flex items-center justify-center">
              <Cpu className="w-5 h-5 text-cyan-400 group-hover:rotate-12 transition-transform duration-300" />
            </div>
          </div>
          <div className="flex flex-col">
            <span className="text-lg font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-1.5">
              StackPilot
              <span className="px-1.5 py-0.5 text-[10px] font-mono font-medium rounded-full bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20">
                v2.0
              </span>
            </span>
            <span className="text-[11px] text-slate-500 dark:text-slate-400 -mt-1 font-mono">
              Autonomous Delivery & QA
            </span>
          </div>
        </a>

        {/* Desktop Navigation Links */}
        <nav className="hidden md:flex items-center gap-1 px-4 py-1.5 rounded-full border border-slate-200/80 dark:border-slate-800/80 bg-slate-100/50 dark:bg-slate-900/40 backdrop-blur-md text-sm font-medium text-slate-600 dark:text-slate-300">
          <a
            href="#install-scripts"
            className="px-3.5 py-1.5 rounded-full hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-white dark:hover:bg-slate-800/80 transition-all"
          >
            ⚡ Script Hub
          </a>
          <a
            href="#live-cockpit"
            className="px-3.5 py-1.5 rounded-full hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-white dark:hover:bg-slate-800/80 transition-all"
          >
            🎯 Live QA Demo
          </a>
          <a
            href="#features"
            className="px-3.5 py-1.5 rounded-full hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-white dark:hover:bg-slate-800/80 transition-all"
          >
            Features
          </a>
          <a
            href="#architecture"
            className="px-3.5 py-1.5 rounded-full hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-white dark:hover:bg-slate-800/80 transition-all"
          >
            Architecture
          </a>
          <a
            href="#faq"
            className="px-3.5 py-1.5 rounded-full hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-white dark:hover:bg-slate-800/80 transition-all"
          >
            FAQ
          </a>
        </nav>

        {/* Action Controls */}
        <div className="hidden md:flex items-center gap-3">
          {/* GitHub Link */}
          <a
            href="https://github.com/AdityaRoy999/StackPilot"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 text-xs font-mono text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
          >
            <GithubIcon className="w-4 h-4" />
            <span>GitHub</span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          </a>

          {/* Theme Toggle Button */}
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 text-slate-700 dark:text-slate-300 hover:text-cyan-500 dark:hover:text-cyan-400 transition-all"
            aria-label="Toggle dark/light theme"
          >
            {theme === 'dark' ? (
              <Sun className="w-4 h-4 text-amber-400 rotate-0 transition-transform duration-300" />
            ) : (
              <Moon className="w-4 h-4 text-indigo-500 rotate-0 transition-transform duration-300" />
            )}
          </button>

          {/* Launch Dashboard Button */}
          <a
            href="http://localhost:3000"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white text-xs font-semibold shadow-md shadow-cyan-500/20 hover:shadow-cyan-500/30 transition-all active:scale-95"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Launch Cockpit</span>
          </a>
        </div>

        {/* Mobile menu trigger */}
        <div className="flex md:hidden items-center gap-2">
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-indigo-500" />}
          </button>
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden px-4 pt-3 pb-6 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#06080d]/95 backdrop-blur-2xl flex flex-col gap-3">
          <a
            href="#install-scripts"
            onClick={() => setMobileMenuOpen(false)}
            className="px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 font-medium text-sm"
          >
            ⚡ Script Hub
          </a>
          <a
            href="#live-cockpit"
            onClick={() => setMobileMenuOpen(false)}
            className="px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 font-medium text-sm"
          >
            🎯 Live QA Demo
          </a>
          <a
            href="#features"
            onClick={() => setMobileMenuOpen(false)}
            className="px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 font-medium text-sm"
          >
            Features
          </a>
          <a
            href="#architecture"
            onClick={() => setMobileMenuOpen(false)}
            className="px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 font-medium text-sm"
          >
            Architecture
          </a>
          <a
            href="http://localhost:3000"
            className="flex items-center justify-center gap-2 py-2.5 rounded-xl bg-cyan-500 text-white font-semibold text-sm"
          >
            <Play className="w-4 h-4 fill-current" />
            <span>Launch Cockpit (Port 3000)</span>
          </a>
        </div>
      )}
    </header>
  );
};
