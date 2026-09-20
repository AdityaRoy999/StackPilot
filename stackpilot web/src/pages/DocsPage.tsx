import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Download04Icon,
  Rocket01Icon,
  Settings02Icon,
  Layers01Icon,
  ComputerTerminal01Icon,
  CpuIcon,
  GitBranchIcon,
  DashboardBrowsingIcon,
  HelpCircleIcon
} from '@hugeicons/core-free-icons';
import { Copy, Check, ArrowLeft, ExternalLink, Search, Terminal, Shield, Zap, RefreshCw, Cpu, Layers, BookOpen, Box, Globe, Server, CheckCircle2 } from 'lucide-react';
import { BranchedMenu, BranchedMenuItem } from '../components/reactbits/BranchedMenu';
import { GithubIcon } from '../components/icons/GithubIcon';
import { StarIcon } from '../components/icons/StarIcon';
import { MailIcon } from '../components/icons/MailIcon';
import { SearchModal } from '../components/SearchModal';
import { SystemTopologyDiagram } from '../components/SystemTopologyDiagram';
import { InstallationScriptViewer } from '../components/InstallationScriptViewer';
import { useFont } from '../context/FontContext';
import { DOCS_CONTENT } from '../data/docsContent';
import { DocMarkdownViewer } from '../components/docs/DocMarkdownViewer';

interface DocsPageProps {
  onNavigateHome: () => void;
  onNavigateContact?: () => void;
}

const DOCS_MENU_ITEMS: BranchedMenuItem[] = [
  {
    label: 'Getting Started',
    children: [
      { value: 'overview', label: 'Platform Overview', icon: Rocket01Icon },
      { value: 'quickstart', label: '60-Second Quickstart', icon: ComputerTerminal01Icon },
      { value: 'install', label: 'Installation Scripts', icon: Download04Icon },
      { value: 'architecture', label: 'System Architecture', icon: Layers01Icon },
      { value: 'templates', label: 'Application Templates', icon: Settings02Icon }
    ]
  },
  {
    label: 'AI & Autonomous QA',
    children: [
      { value: 'ai-agent', label: 'AI Operations Agent', icon: CpuIcon },
      { value: 'screencast', label: '60 FPS Screencast', icon: DashboardBrowsingIcon },
      { value: 'sandboxing', label: 'Chromium Sandboxing', icon: GitBranchIcon },
      { value: 'replay', label: 'Time-Travel Replay', icon: HelpCircleIcon }
    ]
  },
  {
    label: 'Deployment & Runtimes',
    children: [
      { value: 'docker', label: 'Docker Compose', icon: Settings02Icon },
      { value: 'kubernetes', label: 'Kubernetes Clusters', icon: Layers01Icon },
      { value: 'mcp', label: 'MCP for IDE Agents', icon: ComputerTerminal01Icon },
      { value: 'cicd', label: 'CI/CD & GitHub App', icon: GitBranchIcon }
    ]
  },
  {
    label: 'Configuration & Operations',
    children: [
      { value: 'env', label: 'Environment Variables', icon: Settings02Icon },
      { value: 'observability', label: 'Observability & Metrics', icon: DashboardBrowsingIcon },
      { value: 'troubleshooting', label: 'Troubleshooting Guide', icon: HelpCircleIcon }
    ]
  }
];

const SECTION_ICONS: Record<string, any> = {
  overview: Rocket01Icon,
  quickstart: ComputerTerminal01Icon,
  install: Download04Icon,
  architecture: Layers01Icon,
  templates: Settings02Icon,
  'ai-agent': CpuIcon,
  screencast: DashboardBrowsingIcon,
  sandboxing: GitBranchIcon,
  replay: HelpCircleIcon,
  docker: Settings02Icon,
  kubernetes: Layers01Icon,
  mcp: ComputerTerminal01Icon,
  cicd: GitBranchIcon,
  env: Settings02Icon,
  observability: DashboardBrowsingIcon,
  troubleshooting: HelpCircleIcon,
};

export const DocsPage: React.FC<DocsPageProps> = ({ onNavigateHome, onNavigateContact }) => {
  const [activeDoc, setActiveDoc] = useState<string>('overview');
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);
  const { fontMode, toggleFontMode } = useFont();

  const copyCode = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSnippet(id);
    setTimeout(() => setCopiedSnippet(null), 2000);
  };

  // Keyboard shortcut: ⌘K or Ctrl+K opens search popup
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Scroll to top of content on section change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setMobileMenuOpen(false);
  }, [activeDoc]);

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col selection:bg-zinc-800 selection:text-zinc-100 font-sans antialiased">
      {/* Search Modal (Command Palette) */}
      <SearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onSelectDoc={(id) => setActiveDoc(id)}
      />

      {/* Top Header - Completely transparent, natural flow, no full-width overlay band */}
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-2 flex items-center justify-between gap-4">
        {/* Left: Brand & Back */}
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="inline-flex items-center h-10 p-1 rounded-full bg-[#18181b] border border-zinc-800/90 shadow-lg text-xs font-mono text-zinc-300">
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                onNavigateHome();
              }}
              className="inline-flex items-center gap-2 h-8 px-3.5 rounded-full bg-transparent hover:bg-[#242428] text-zinc-300 hover:text-white transition-all cursor-pointer select-none border-0"
              title="Return to StackPilot Home"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Home</span>
            </a>
          </div>

          <div className="h-4 w-[1px] bg-zinc-800 select-none hidden sm:block" />

          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onNavigateHome();
            }}
            className="flex items-center gap-2 text-sm font-semibold tracking-tight text-white hover:text-zinc-300 transition-colors cursor-pointer select-none"
          >
            <span className="font-mono text-white font-bold">&gt;_</span>
            <span>StackPilot Docs</span>
          </a>
        </div>

        {/* Right: Capsule Bar with Sliding Tab Physics and Font Switcher */}
        <div className="flex items-center">
          <div
            onMouseLeave={() => setHoveredTab(null)}
            className="inline-flex items-center h-10 p-1 rounded-full bg-[#18181b] border border-zinc-800/90 shadow-lg text-xs text-zinc-300 relative"
          >
            {/* Interactive Search Button: between '(' and '|' -> left fully rounded, right square rounded */}
            <button
              type="button"
              onClick={() => setIsSearchOpen(true)}
              onMouseEnter={() => setHoveredTab('search')}
              className="relative inline-flex items-center gap-2.5 h-8 px-3 sm:px-3.5 rounded-l-full rounded-r-md bg-transparent text-zinc-300 hover:text-white transition-colors cursor-pointer select-none border-0 group"
              title="Search documentation (⌘K)"
            >
              {hoveredTab === 'search' && (
                <motion.div
                  layoutId="docsHoverPill"
                  className="absolute inset-0 bg-[#26262a] rounded-l-full rounded-r-md"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Search className="w-3.5 h-3.5 text-white shrink-0 transition-colors" />
                <span className="hidden sm:inline">Search docs...</span>
                <kbd className="hidden md:inline-block px-1.5 py-0.5 text-[10px] font-mono text-zinc-400 group-hover:text-zinc-200 bg-[#161618] rounded border border-zinc-700/60">
                  ⌘K
                </kbd>
              </span>
            </button>

            {/* Mobile Menu Toggle (lg:hidden): between '|' and '|' -> square rounded tab */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              onMouseEnter={() => setHoveredTab('menu')}
              className="lg:hidden relative inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md bg-transparent text-zinc-300 hover:text-white border-0 cursor-pointer mx-0.5"
            >
              {hoveredTab === 'menu' && (
                <motion.div
                  layoutId="docsHoverPill"
                  className="absolute inset-0 bg-[#26262a] rounded-md"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <span className="relative z-10">{mobileMenuOpen ? 'Close' : 'Topics'}</span>
            </button>

            {/* Vertical Divider */}
            <span className="h-3.5 w-[1px] bg-zinc-800/90 shrink-0 mx-1 select-none" />

            {/* Contact: between '|' and '|' -> square rounded tab */}
            <a
              href="/contact"
              onClick={(e) => {
                e.preventDefault();
                onNavigateContact?.();
              }}
              onMouseEnter={() => setHoveredTab('contact')}
              className="relative inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-transparent text-zinc-300 hover:text-white transition-colors cursor-pointer select-none border-0"
              title="Contact StackPilot Team"
            >
              {hoveredTab === 'contact' && (
                <motion.div
                  layoutId="docsHoverPill"
                  className="absolute inset-0 bg-[#26262a] rounded-md"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <MailIcon className="w-3.5 h-3.5 text-white shrink-0" />
                <span className="hidden sm:inline">Contact</span>
              </span>
            </a>

            {/* Vertical Divider */}
            <span className="h-3.5 w-[1px] bg-zinc-800/90 shrink-0 mx-1 select-none" />

            {/* Font Switcher Tab: between '|' and '|' -> square rounded tab */}
            <button
              type="button"
              onClick={toggleFontMode}
              onMouseEnter={() => setHoveredTab('font')}
              className="relative inline-flex items-center gap-1.5 h-8 px-2.5 sm:px-3 rounded-md bg-transparent text-zinc-400 hover:text-white transition-colors cursor-pointer select-none border-0"
              title={fontMode === 'stylish' ? 'Switch to Normal font' : 'Switch to Handwriting / Stylish font'}
            >
              {hoveredTab === 'font' && (
                <motion.div
                  layoutId="docsHoverPill"
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
            <span className="h-3.5 w-[1px] bg-zinc-800/90 shrink-0 mx-1 select-none" />

            {/* GitHub Repo: between '|' and ')' -> left square rounded, right fully rounded */}
            <a
              href="https://github.com/AdityaRoy999/StackPilot"
              target="_blank"
              rel="noopener noreferrer"
              onMouseEnter={() => setHoveredTab('repo')}
              className="relative inline-flex items-center gap-2.5 h-8 px-3 sm:px-3.5 rounded-l-md rounded-r-full bg-transparent text-zinc-300 hover:text-white transition-colors cursor-pointer select-none border-0 group"
              title="View StackPilot on GitHub"
            >
              {hoveredTab === 'repo' && (
                <motion.div
                  layoutId="docsHoverPill"
                  className="absolute inset-0 bg-[#26262a] rounded-l-md rounded-r-full"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-2">
                <GithubIcon className="w-3.5 h-3.5 text-white shrink-0 transition-colors" />
                <span className="hidden sm:inline">Repo</span>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#161618] text-[10px] text-zinc-300 border border-zinc-700/50">
                  <StarIcon className="w-2.5 h-2.5 text-white shrink-0" />
                  <span>Star</span>
                </span>
              </span>
            </a>
          </div>
        </div>
      </div>

      {/* Main Container with Sidebar + Content */}
      <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 flex gap-8">
        {/* Left Sidebar: Greyish Bento Card containing the Tree */}
        <aside
          className={`lg:w-72 shrink-0 transition-all duration-300 z-30 ${
            mobileMenuOpen
              ? 'fixed inset-x-4 top-20 bottom-4 bg-[#18181b] border border-zinc-800 rounded-3xl p-5 overflow-y-auto no-scrollbar block shadow-2xl z-50'
              : 'hidden lg:block'
          }`}
        >
          {/* Distinct Greyish Card - Clean without any scrollbar */}
          <div
            className="sticky top-6 rounded-2xl sm:rounded-3xl border border-zinc-800/90 bg-[#18181b]/95 p-4 sm:p-5 flex flex-col gap-3 shadow-xl transition-all"
          >
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80">
              <span className="text-[11px] font-mono uppercase tracking-widest text-zinc-400 font-semibold">
                Documentation
              </span>
              <span className="px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 text-[10px] font-mono font-medium border border-zinc-700/60">
                v1.0.0
              </span>
            </div>

            {/* React Bits BranchedMenu Tree with WHITE selection and NO green left marker */}
            <div className="py-1 overflow-x-hidden">
              <BranchedMenu
                items={DOCS_MENU_ITEMS}
                defaultOpen={[0, 1, 2, 3]}
                defaultActive={activeDoc}
                onSelect={(val) => {
                  setActiveDoc(val);
                  setMobileMenuOpen(false);
                }}
                color="#a1a1aa"
                accentColor="#ffffff"
                lineColor="#3f3f46"
                width={255}
                rowHeight={34}
                indent={32}
                fontSize={13}
                showMarker={false}
                showTrunkLine={false}
              />
            </div>
          </div>
        </aside>

        {/* Right Content View */}
        <main className="flex-1 min-w-0 max-w-3xl pb-24">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeDoc}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="space-y-10"
            >
              {/* Top Section Breadcrumb & Actions Bar */}
              <div className="flex items-center justify-between gap-4 pb-3 border-b border-zinc-800/80">
                <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
                  <HugeiconsIcon icon={SECTION_ICONS[activeDoc] || Rocket01Icon} size={16} className="text-white shrink-0" />
                  <span className="uppercase tracking-wider text-zinc-300 font-semibold">{DOCS_CONTENT[activeDoc]?.category || 'DOCUMENTATION'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => copyCode(DOCS_CONTENT[activeDoc]?.content || '', 'copy-page')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#18181b] hover:bg-[#242428] border border-zinc-800 text-xs font-mono text-zinc-300 hover:text-white transition-all cursor-pointer select-none"
                    title="Copy full page markdown"
                  >
                    {copiedSnippet === 'copy-page' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400 text-[11px] font-medium">Copied Markdown!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-white" />
                        <span className="text-[11px]">Copy Markdown</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Special View for Installation Hub */}
              {activeDoc === 'install' && (
                <div className="space-y-10">
                  <InstallationScriptViewer />
                  <div className="pt-8 border-t border-zinc-800/80">
                    <DocMarkdownViewer content={DOCS_CONTENT['install']?.content || ''} docId="install" />
                  </div>
                </div>
              )}

              {/* Special View for Overview: System Topology Diagram */}
              {activeDoc === 'overview' && (
                <div className="space-y-10">
                  <DocMarkdownViewer content={DOCS_CONTENT['overview']?.content || ''} docId="overview" />
                  <div className="pt-8 border-t border-zinc-800/80 space-y-4">
                    <div className="mb-2">
                      <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2.5">
                        <span className="w-1.5 h-5 rounded-full bg-white inline-block shrink-0" />
                        <span>Interactive Subsystem Topology &amp; Communications</span>
                      </h2>
                      <p className="mt-2 text-sm text-zinc-400">
                        Interactive inspection cards showing live communication protocols, ports, and connection lines between all control plane microservices:
                      </p>
                    </div>
                    <SystemTopologyDiagram />
                  </div>
                </div>
              )}

              {/* All Other 14 Documentation Pages: Render Complete Exhaustive Guide */}
              {activeDoc !== 'install' && activeDoc !== 'overview' && (
                <article className="space-y-6">
                  <DocMarkdownViewer content={DOCS_CONTENT[activeDoc]?.content || ''} docId={activeDoc} />
                </article>
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
};

export default DocsPage;
