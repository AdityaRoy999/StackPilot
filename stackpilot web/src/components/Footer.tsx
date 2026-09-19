import React, { useState } from 'react';
import { Cpu, Terminal, Copy, Check, Heart, ExternalLink } from 'lucide-react';
import { GithubIcon } from './icons/GithubIcon';

export const Footer: React.FC = () => {
  const [copied, setCopied] = useState(false);
  const quickCmd = 'curl -fsSL https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.sh | bash';

  const handleCopy = () => {
    navigator.clipboard.writeText(quickCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <footer className="relative z-20 border-t border-slate-200/80 dark:border-slate-800/80 bg-white dark:bg-[#03060a] pt-16 pb-24">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Quick Copy Banner at top of footer */}
        <div className="mb-14 p-6 rounded-2xl border border-cyan-500/30 bg-gradient-to-r from-cyan-500/10 via-indigo-500/10 to-purple-500/10 backdrop-blur-xl flex flex-col md:flex-row items-center justify-between gap-6 shadow-xl shadow-cyan-950/10">
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Terminal className="w-5 h-5 text-cyan-500" />
              <span>Ready to launch StackPilot?</span>
            </h3>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 mt-1">
              Paste this into any terminal to start the autonomous QA cockpit.
            </p>
          </div>

          <div className="flex items-center gap-2 w-full md:w-auto">
            <div className="flex-1 md:w-96 px-3.5 py-2.5 rounded-xl bg-slate-950 text-cyan-300 font-mono text-xs truncate border border-slate-800 select-all">
              {quickCmd}
            </div>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs font-mono transition-all shrink-0 active:scale-95 shadow-md shadow-cyan-500/20"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span>{copied ? 'Copied!' : 'Copy'}</span>
            </button>
          </div>
        </div>

        {/* Main Footer Links & Branding */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-10 pb-12 border-b border-slate-200/80 dark:border-slate-800/80">
          <div className="space-y-4 md:col-span-1">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-tr from-cyan-500 to-indigo-600 p-[1px]">
                <div className="w-full h-full bg-slate-950 rounded-[7px] flex items-center justify-center">
                  <Cpu className="w-4 h-4 text-cyan-400" />
                </div>
              </div>
              <span className="text-base font-bold text-slate-900 dark:text-white">StackPilot</span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Open-source, self-hosted autonomous AI QA & application delivery cockpit. Deploy anywhere, test everything.
            </p>
          </div>

          <div>
            <h4 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-900 dark:text-white mb-4">
              Product & QA
            </h4>
            <ul className="space-y-2 text-xs text-slate-600 dark:text-slate-400 font-medium">
              <li><a href="#install-scripts" className="hover:text-cyan-500 transition-colors">Universal Script Hub</a></li>
              <li><a href="#live-cockpit" className="hover:text-cyan-500 transition-colors">60 FPS Live Screencast</a></li>
              <li><a href="#features" className="hover:text-cyan-500 transition-colors">Autonomous APV Engine</a></li>
              <li><a href="#architecture" className="hover:text-cyan-500 transition-colors">Drogon C++ Architecture</a></li>
            </ul>
          </div>

          <div>
            <h4 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-900 dark:text-white mb-4">
              Integrations
            </h4>
            <ul className="space-y-2 text-xs text-slate-600 dark:text-slate-400 font-medium">
              <li><a href="#install-scripts" className="hover:text-cyan-500 transition-colors">GitHub Actions Workflow</a></li>
              <li><a href="#install-scripts" className="hover:text-cyan-500 transition-colors">Model Context Protocol (MCP)</a></li>
              <li><a href="#install-scripts" className="hover:text-cyan-500 transition-colors">Claude Code & Cursor Setup</a></li>
              <li><a href="#install-scripts" className="hover:text-cyan-500 transition-colors">Kubernetes Provisioner</a></li>
            </ul>
          </div>

          <div>
            <h4 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-900 dark:text-white mb-4">
              Community
            </h4>
            <ul className="space-y-2 text-xs text-slate-600 dark:text-slate-400 font-medium">
              <li>
                <a
                  href="https://github.com/AdityaRoy999/StackPilot"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 hover:text-cyan-500 transition-colors"
                >
                  <GithubIcon className="w-3.5 h-3.5" />
                  <span>GitHub Repository</span>
                  <ExternalLink className="w-3 h-3 text-slate-400" />
                </a>
              </li>
              <li><a href="https://github.com/AdityaRoy999/StackPilot/issues" target="_blank" rel="noopener noreferrer" className="hover:text-cyan-500 transition-colors">Issue Tracker</a></li>
              <li><a href="https://github.com/AdityaRoy999/StackPilot/releases" target="_blank" rel="noopener noreferrer" className="hover:text-cyan-500 transition-colors">Changelog & Releases</a></li>
            </ul>
          </div>
        </div>

        {/* Bottom copyright */}
        <div className="pt-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-500 font-mono">
          <div>
            © {new Date().getFullYear()} StackPilot. Open source under Apache 2.0 / MIT.
          </div>
          <div className="flex items-center gap-1">
            <span>Crafted for high-performance engineering teams</span>
          </div>
        </div>
      </div>
    </footer>
  );
};
