import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle2,
  ArrowLeft,
  Copy,
  Check,
  Sparkles,
  HelpCircle,
  ExternalLink,
  BookOpen
} from 'lucide-react';
import { GithubIcon } from '../components/icons/GithubIcon';
import { StarIcon } from '../components/icons/StarIcon';
import { MailIcon } from '../components/icons/MailIcon';
import { SendIcon } from '../components/icons/SendIcon';

interface ContactPageProps {
  onNavigateHome: () => void;
  onNavigateDocs: () => void;
}

const INQUIRY_TYPES = [
  'General Inquiry',
  'Deployment Assistance',
  'Autonomous AI QA',
  'Enterprise Cluster',
  'Bug Report / Feedback'
];

export const ContactPage: React.FC<ContactPageProps> = ({ onNavigateHome, onNavigateDocs }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [inquiryType, setInquiryType] = useState('Deployment Assistance');
  const [repoUrl, setRepoUrl] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) return;

    setIsSubmitting(true);
    // Simulate instantaneous smooth dispatch
    setTimeout(() => {
      setIsSubmitting(false);
      setIsSubmitted(true);
    }, 800);
  };

  const copyEmail = () => {
    navigator.clipboard.writeText('contact@stackpilot.dev');
    setCopiedEmail(true);
    setTimeout(() => setCopiedEmail(false), 2000);
  };

  const resetForm = () => {
    setName('');
    setEmail('');
    setInquiryType('Deployment Assistance');
    setRepoUrl('');
    setMessage('');
    setIsSubmitted(false);
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col selection:bg-zinc-800 selection:text-zinc-100 font-sans antialiased">
      {/* Top Header - Unified Capsule Design */}
      <header className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-4 flex items-center justify-between gap-4">
        {/* Left: Home Navigation */}
        <div className="flex items-center gap-3 sm:gap-4">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onNavigateHome();
            }}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#1c1c1e] hover:bg-[#28282c] text-zinc-300 hover:text-white text-xs font-mono transition-all cursor-pointer select-none border border-zinc-800/80"
            title="Return to StackPilot Home"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Home</span>
          </a>

          <div className="h-4 w-[1px] bg-zinc-800 select-none hidden sm:block" />

          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onNavigateHome();
            }}
            className="flex items-center gap-2 text-sm font-semibold tracking-tight text-white hover:text-zinc-300 transition-colors cursor-pointer select-none"
          >
            <span className="font-mono text-zinc-400 font-bold">&gt;_</span>
            <span>StackPilot</span>
          </a>
        </div>

        {/* Right: Unified Navigation Capsule */}
        <div className="inline-flex items-center h-10 p-1 rounded-full bg-[#18181b] border border-zinc-800/90 shadow-lg text-xs font-mono text-zinc-300">
          <a
            href="/docs"
            onClick={(e) => {
              e.preventDefault();
              onNavigateDocs();
            }}
            className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-l-full rounded-r-md bg-transparent hover:bg-[#242428] text-zinc-300 hover:text-white transition-all cursor-pointer select-none border-0"
            title="StackPilot Documentation"
          >
            <BookOpen className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>Docs</span>
          </a>

          <span className="h-3.5 w-[1px] bg-zinc-800/90 shrink-0 mx-1 select-none" />

          <a
            href="https://github.com/AdityaRoy999/StackPilot"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 h-8 px-3.5 rounded-l-md rounded-r-full bg-transparent hover:bg-[#242428] text-zinc-300 hover:text-white transition-all cursor-pointer select-none border-0 group"
            title="View StackPilot on GitHub"
          >
            <GithubIcon className="w-3.5 h-3.5 text-zinc-300 group-hover:text-white shrink-0 transition-colors" />
            <span className="hidden sm:inline">Repo</span>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#161618] text-[10px] text-zinc-300 border border-zinc-700/50">
              <StarIcon className="w-2.5 h-2.5 text-amber-400 shrink-0" />
              <span>Star</span>
            </span>
          </a>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-16">
        {/* Section Header */}
        <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-400 mb-4">
            <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
            <span>CONTACT &amp; OPERATOR SUPPORT</span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-white mb-4">
            Talk with the StackPilot Team
          </h1>
          <p className="text-sm sm:text-base text-zinc-400 leading-relaxed font-sans">
            Need help deploying on your VPS or Kubernetes cluster? Want custom AI QA integrations or enterprise self-hosting support? Send us a note.
          </p>
        </div>

        {/* Bento Grid: Contact Channels + Form */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left Column: Direct Communication Channels (5 cols) */}
          <div className="lg:col-span-5 space-y-4">
            {/* Direct Email Card */}
            <div className="p-5 rounded-2xl sm:rounded-3xl border border-zinc-800/90 bg-[#18181b]/95 flex flex-col gap-3 shadow-xl">
              <div className="flex items-center justify-between">
                <div className="w-9 h-9 rounded-xl bg-zinc-850 flex items-center justify-center text-emerald-400 border border-zinc-800">
                  <MailIcon className="w-4 h-4" />
                </div>
                <button
                  type="button"
                  onClick={copyEmail}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white text-[11px] font-mono border border-zinc-800 transition-colors cursor-pointer"
                >
                  {copiedEmail ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedEmail ? 'Copied' : 'Copy Email'}</span>
                </button>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">Direct Email</h3>
                <p className="text-xs text-zinc-400 mt-0.5">contact@stackpilot.dev</p>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed font-sans border-t border-zinc-800/60 pt-3">
                For architectural questions, security disclosures, or direct operator inquiries. Typical turnaround under 24 hours.
              </p>
            </div>

            {/* GitHub Issues & Discussions Card */}
            <div className="p-5 rounded-2xl sm:rounded-3xl border border-zinc-800/90 bg-[#18181b]/95 flex flex-col gap-3 shadow-xl">
              <div className="w-9 h-9 rounded-xl bg-zinc-850 flex items-center justify-center text-white border border-zinc-800">
                <GithubIcon className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">Open Source Community</h3>
                <p className="text-xs text-zinc-400 mt-0.5">github.com/AdityaRoy999/StackPilot</p>
              </div>
              <div className="flex items-center gap-2 pt-1 font-mono text-xs">
                <a
                  href="https://github.com/AdityaRoy999/StackPilot/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 transition-colors"
                >
                  <span>Open Issue</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
                <a
                  href="https://github.com/AdityaRoy999/StackPilot/discussions"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 transition-colors"
                >
                  <span>Discussions</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>

            {/* Quick Self-Hosting Tip Card */}
            <div className="p-5 rounded-2xl sm:rounded-3xl border border-zinc-800/90 bg-[#18181b]/95 flex flex-col gap-2 shadow-xl">
              <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                <HelpCircle className="w-4 h-4 text-cyan-400" />
                <span>Need immediate installation?</span>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed font-sans">
                You can deploy the complete platform on Linux, macOS, or Windows with our automated one-line curl command in under 60 seconds.
              </p>
              <button
                type="button"
                onClick={onNavigateDocs}
                className="mt-1 text-xs font-mono text-emerald-400 hover:text-emerald-300 text-left transition-colors cursor-pointer bg-transparent border-0 p-0"
              >
                &rarr; View Installation Guide
              </button>
            </div>
          </div>

          {/* Right Column: Contact Form (7 cols) */}
          <div className="lg:col-span-7">
            <div className="rounded-2xl sm:rounded-3xl border border-zinc-800/90 bg-[#18181b]/95 p-6 sm:p-8 shadow-2xl transition-all">
              <AnimatePresence mode="wait">
                {isSubmitted ? (
                  <motion.div
                    key="success"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 450, damping: 30 }}
                    className="py-12 px-4 text-center space-y-4"
                  >
                    <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto">
                      <CheckCircle2 className="w-7 h-7" />
                    </div>
                    <h3 className="text-xl sm:text-2xl font-bold text-white">Message Dispatched</h3>
                    <p className="text-xs sm:text-sm text-zinc-400 max-w-md mx-auto leading-relaxed">
                      Thank you for contacting us, <span className="text-zinc-200 font-semibold">{name}</span>! We have received your inquiry regarding <span className="text-emerald-400 font-mono">{inquiryType}</span> and will respond to <span className="text-zinc-200 font-mono">{email}</span> within 24 hours.
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
                      <h2 className="text-lg sm:text-xl font-bold text-white">Send a Message</h2>
                      <p className="text-xs text-zinc-400 mt-1">
                        Fill out the details below and our team will get back to you promptly.
                      </p>
                    </div>

                    {/* Inquiry Type Segmented Selection */}
                    <div>
                      <label className="block text-xs font-mono text-zinc-400 mb-2 font-medium">
                        INQUIRY TOPIC
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        {INQUIRY_TYPES.map((type) => {
                          const isSelected = inquiryType === type;
                          return (
                            <button
                              key={type}
                              type="button"
                              onClick={() => setInquiryType(type)}
                              className={`px-3 py-1.5 rounded-full text-xs font-mono transition-all cursor-pointer border ${
                                isSelected
                                  ? 'bg-zinc-100 text-zinc-950 font-semibold border-white'
                                  : 'bg-[#141416] text-zinc-400 border-zinc-800 hover:border-zinc-700 hover:text-zinc-200'
                              }`}
                            >
                              {type}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Name & Email Row */}
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

                    {/* Repository / Project URL (Optional) */}
                    <div>
                      <label className="block text-xs font-mono text-zinc-400 mb-1.5 font-medium">
                        PROJECT / REPOSITORY URL <span className="text-zinc-600 font-normal">(OPTIONAL)</span>
                      </label>
                      <input
                        type="url"
                        value={repoUrl}
                        onChange={(e) => setRepoUrl(e.target.value)}
                        placeholder="https://github.com/your-org/your-app"
                        className="w-full h-10 px-3.5 rounded-xl bg-black border border-zinc-800 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors font-sans"
                      />
                    </div>

                    {/* Message Textarea */}
                    <div>
                      <label className="block text-xs font-mono text-zinc-400 mb-1.5 font-medium">
                        MESSAGE *
                      </label>
                      <textarea
                        required
                        rows={4}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="Tell us about your application stack, infrastructure needs, or questions..."
                        className="w-full p-3.5 rounded-xl bg-black border border-zinc-800 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors font-sans resize-none leading-relaxed"
                      />
                    </div>

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
                          <SendIcon className="w-3.5 h-3.5" />
                          <span>Send Message</span>
                        </>
                      )}
                    </button>
                  </motion.form>
                )}
              </AnimatePresence>
            </div>
          </div>
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
