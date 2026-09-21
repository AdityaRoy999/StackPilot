import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { HugeiconsIcon } from '@hugeicons/react';
import { Copy01Icon, Tick01Icon } from '@hugeicons/core-free-icons';
import confetti from 'canvas-confetti';
import { highlightCode } from '../../utils/syntaxHighlight';

export interface MacTrafficLightsProps {
  className?: string;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
}

export const MacTrafficLights: React.FC<MacTrafficLightsProps> = ({
  className = '',
  onClose
}) => {
  return (
    <div className={`flex items-center gap-2 select-none ${className}`} aria-hidden="true">
      {/* Red */}
      <div
        onClick={onClose}
        className={`w-3 h-3 rounded-full bg-[#ff5f56] border border-[#e0443e]/60 shadow-sm ${onClose ? 'cursor-pointer hover:opacity-80' : ''}`}
      />
      {/* Yellow */}
      <div className="w-3 h-3 rounded-full bg-[#ffbd2e] border border-[#dea123]/60 shadow-sm" />
      {/* Green */}
      <div className="w-3 h-3 rounded-full bg-[#27c93f] border border-[#1aab29]/60 shadow-sm" />
    </div>
  );
};

export interface CodeBlockProps {
  code: string;
  lang: string;
  id?: string;
  onCopySuccess?: (id: string) => void;
  className?: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  lang,
  id,
  onCopySuccess,
  className = '',
}) => {
  const [copied, setCopied] = useState(false);

  // Compute syntax-highlighted HTML string
  const highlightedHtml = useMemo(() => {
    return highlightCode(code, lang);
  }, [code, lang]);

  const handleCopy = (e?: React.MouseEvent) => {
    navigator.clipboard.writeText(code);
    setCopied(true);

    if (e) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = (rect.left + rect.width / 2) / window.innerWidth;
      const y = (rect.top + rect.height / 2) / window.innerHeight;
      confetti({
        particleCount: 24,
        spread: 45,
        startVelocity: 16,
        origin: { x, y },
        colors: ['#ffffff', '#a1a1aa', '#38bdf8', '#4ade80'],
        ticks: 50,
      });
    }

    if (id && onCopySuccess) {
      onCopySuccess(id);
    }

    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  return (
    <div
      className={`my-5 rounded-2xl border-0 bg-[#121214] overflow-hidden shadow-2xl group transition-all duration-300 ${className}`}
    >
      {/* Code Block Header with Mac Traffic Lights */}
      <div className="px-4 py-3 bg-[#121214] flex items-center justify-between border-0">
        <div className="flex items-center gap-3">
          {/* Authentic Mac Window Buttons (static, non-collapsing) */}
          <MacTrafficLights />

          {/* Language Tag */}
          <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-semibold px-2 py-0.5 rounded-md bg-[#1c1c20] border-0">
            {lang || 'text'}
          </span>
        </div>

        {/* Circular Copy Button with Spring-pop & Emerald transition matching Hero ScriptBox */}
        <button
          type="button"
          onClick={handleCopy}
          className={`w-7 h-7 sm:w-8 sm:h-8 rounded-full border-0 flex items-center justify-center shrink-0 transition-all duration-300 active:scale-90 cursor-pointer ${
            copied
              ? 'bg-emerald-500/20 text-emerald-400'
              : 'bg-[#1c1c20] hover:bg-[#28282c] text-zinc-300 hover:text-white'
          }`}
          title="Copy code snippet to clipboard"
          aria-label="Copy code snippet"
        >
          <AnimatePresence mode="wait" initial={false}>
            {copied ? (
              <motion.div
                key="check"
                initial={{ scale: 0.4, opacity: 0, rotate: -20 }}
                animate={{ scale: 1, opacity: 1, rotate: 0 }}
                exit={{ scale: 0.4, opacity: 0, rotate: 20 }}
                transition={{ type: 'spring', stiffness: 500, damping: 25 }}
              >
                <HugeiconsIcon icon={Tick01Icon} size={15} strokeWidth={2.2} />
              </motion.div>
            ) : (
              <motion.div
                key="copy"
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={1.8} />
              </motion.div>
            )}
          </AnimatePresence>
        </button>
      </div>

      {/* Code Block Content - Full and clean presentation */}
      <div className="overflow-hidden bg-[#121214]">
        <div className="p-4 bg-[#121214] overflow-x-auto">
          <pre className="font-mono text-xs leading-relaxed selection:bg-zinc-700 selection:text-white">
            <code
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              className={`language-${lang}`}
            />
          </pre>
        </div>
      </div>
    </div>
  );
};

export default CodeBlock;
