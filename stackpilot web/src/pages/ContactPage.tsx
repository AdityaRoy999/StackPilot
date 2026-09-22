import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  CheckmarkCircle01Icon,
  ArrowLeft01Icon,
  BookOpen01Icon,
  GithubIcon,
  StarIcon,
  SentIcon
} from '@hugeicons/core-free-icons';
import { useFont } from '../context/FontContext';

interface ContactPageProps {
  onNavigateHome: () => void;
  onNavigateDocs: () => void;
}

const INQUIRY_TYPES = ['Back us', 'Problem'];

export const ContactPage: React.FC<ContactPageProps> = ({ onNavigateHome, onNavigateDocs }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [inquiryType, setInquiryType] = useState('Back us');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);
  const { fontMode, toggleFontMode } = useFont();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          inquiryType,
          message: message.trim()
        })
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || 'Failed to dispatch message. Please try again.');
      }

      setIsSubmitted(true);
    } catch (err: any) {
      setErrorMessage(err.message || 'Unable to connect to the email service. Please try again later.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setName('');
    setEmail('');
    setInquiryType('Back us');
    setMessage('');
    setErrorMessage(null);
    setIsSubmitted(false);
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col selection:bg-zinc-800 selection:text-zinc-100 font-sans antialiased">
      {/* Top Header - Unified Capsule Design */}
      <header className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-4 flex items-center justify-between gap-4">
        {/* Left: Home Navigation */}
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
              <HugeiconsIcon icon={ArrowLeft01Icon} size={14} strokeWidth={1.8} className="text-white" />
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
            <span>StackPilot</span>
          </a>
        </div>

        {/* Right: Unified Navigation Capsule with Sliding Tab Physics and Font Switcher */}
        <div
          onMouseLeave={() => setHoveredTab(null)}
          className="inline-flex items-center h-10 p-1 rounded-full bg-[#18181b] border border-zinc-800/90 shadow-lg text-xs text-zinc-300 relative"
        >
          {/* Docs Tab: between '(' and '|' -> left fully rounded, right square rounded */}
          <a
            href="/docs"
            onClick={(e) => {
              e.preventDefault();
              onNavigateDocs();
            }}
            onMouseEnter={() => setHoveredTab('docs')}
            className="relative inline-flex items-center gap-1.5 h-8 px-3.5 rounded-l-full rounded-r-md bg-transparent text-zinc-300 hover:text-white transition-colors cursor-pointer select-none border-0"
            title="StackPilot Documentation"
          >
            {hoveredTab === 'docs' && (
              <motion.div
                layoutId="contactHoverPill"
                className="absolute inset-0 bg-[#26262a] rounded-l-full rounded-r-md"
                transition={{ type: 'spring', stiffness: 450, damping: 35 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              <HugeiconsIcon icon={BookOpen01Icon} size={14} strokeWidth={1.8} className="text-white shrink-0" />
              <span>Docs</span>
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
                layoutId="contactHoverPill"
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

          {/* GitHub: between '|' and ')' -> left square rounded, right fully rounded */}
          <a
            href="https://github.com/AdityaRoy999/StackPilot"
            target="_blank"
            rel="noopener noreferrer"
            onMouseEnter={() => setHoveredTab('repo')}
            className="relative inline-flex items-center gap-2 h-8 px-3.5 rounded-l-md rounded-r-full bg-transparent text-zinc-300 hover:text-white transition-colors cursor-pointer select-none border-0 group"
            title="View StackPilot on GitHub"
          >
            {hoveredTab === 'repo' && (
              <motion.div
                layoutId="contactHoverPill"
                className="absolute inset-0 bg-[#26262a] rounded-l-md rounded-r-full"
                transition={{ type: 'spring', stiffness: 450, damping: 35 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-2">
              <HugeiconsIcon icon={GithubIcon} size={14} strokeWidth={1.8} className="text-white shrink-0 transition-colors" />
              <span className="hidden sm:inline">Repo</span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#161618] text-[10px] text-zinc-300 border border-zinc-700/50">
                <HugeiconsIcon icon={StarIcon} size={12} strokeWidth={1.8} className="text-white shrink-0" />
                <span>Star</span>
              </span>
            </span>
          </a>
        </div>
      </header>

      {/* Main Content Area - Single Clean Centered Card */}
      <main className="flex-1 w-full max-w-xl mx-auto px-4 sm:px-6 py-8 sm:py-16 flex flex-col justify-center">
        <div className="w-full rounded-2xl sm:rounded-3xl border border-zinc-800/90 bg-[#18181b]/95 p-6 sm:p-8 shadow-2xl backdrop-blur-xl">
          <AnimatePresence mode="wait">
            {isSubmitted ? (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ type: 'spring', stiffness: 450, damping: 30 }}
                className="py-10 px-4 text-center space-y-4"
              >
                <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto">
                  <HugeiconsIcon icon={CheckmarkCircle01Icon} size={28} strokeWidth={1.8} />
                </div>
                <h3 className="text-xl sm:text-2xl font-bold text-white">Message Sent</h3>
                <p className="text-xs sm:text-sm text-zinc-400 max-w-sm mx-auto leading-relaxed">
                  Thank you, <span className="text-zinc-200 font-semibold">{name}</span>! We received your note regarding <span className="text-emerald-400 font-mono">{inquiryType}</span> and will reply to <span className="text-zinc-200 font-mono">{email}</span>.
                </p>
                <div className="pt-4">
                  <button
                    type="button"
                    onClick={resetForm}
                    className="px-5 py-2 rounded-full bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-mono text-zinc-300 hover:text-white transition-all cursor-pointer"
                  >
                    Send another message
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.form
                key="form"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onSubmit={handleSubmit}
                className="space-y-5 font-sans"
              >
                <div>
                  <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Contact</h2>
                  <p className="text-xs text-zinc-400 mt-1">
                    Send a note to the StackPilot team.
                  </p>
                </div>

                {/* Inquiry Topic: Backing us up | Problem */}
                <div>
                  <label className="block text-xs font-mono text-zinc-400 mb-2 font-medium">
                    INQUIRY TOPIC
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {INQUIRY_TYPES.map((type) => {
                      const isSelected = inquiryType === type;
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() => setInquiryType(type)}
                          className={`px-4 py-1.5 rounded-full text-xs font-mono transition-all cursor-pointer border ${
                            isSelected
                              ? 'bg-zinc-100 text-zinc-950 font-semibold border-white shadow-sm'
                              : 'bg-[#141416] text-zinc-400 border-zinc-800 hover:border-zinc-700 hover:text-zinc-200'
                          }`}
                        >
                          {type}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Full Name & Work Email */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-mono text-zinc-400 mb-1.5 font-medium">
                      FULL NAME *
                    </label>
                    <input
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Aditya Roy"
                      className="w-full h-10 px-3.5 rounded-xl bg-black border border-zinc-800 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors font-sans"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-mono text-zinc-400 mb-1.5 font-medium">
                      WORK EMAIL *
                    </label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="aditya@example.com"
                      className="w-full h-10 px-3.5 rounded-xl bg-black border border-zinc-800 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors font-sans"
                    />
                  </div>
                </div>

                {/* Message */}
                <div>
                  <label className="block text-xs font-mono text-zinc-400 mb-1.5 font-medium">
                    MESSAGE *
                  </label>
                  <textarea
                    required
                    rows={5}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Write your message here..."
                    className="w-full p-3.5 rounded-xl bg-black border border-zinc-800 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors font-sans resize-none leading-relaxed"
                  />
                </div>

                {/* Error Alert */}
                {errorMessage && (
                  <div className="p-3.5 rounded-xl bg-red-950/40 border border-red-800/60 text-red-300 text-xs flex items-start gap-2.5 leading-relaxed font-sans">
                    <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>{errorMessage}</span>
                  </div>
                )}

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full h-11 rounded-xl bg-zinc-100 hover:bg-white text-zinc-950 font-semibold text-xs font-mono flex items-center justify-center gap-2 transition-all cursor-pointer shadow-lg hover:shadow-zinc-100/10 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed border-0"
                >
                  {isSubmitting ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin" />
                      <span>Dispatching...</span>
                    </>
                  ) : (
                    <>
                      <HugeiconsIcon icon={SentIcon} size={14} strokeWidth={1.8} />
                      <span>Send Message</span>
                    </>
                  )}
                </button>
              </motion.form>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full py-8 text-center text-xs font-mono text-zinc-600 border-t border-zinc-900 mt-12">
        StackPilot · Autonomous AI Deployment &amp; QA Platform · Built for the Agentic Era
      </footer>
    </div>
  );
};

export default ContactPage;
