import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Check } from 'lucide-react';
import confetti from 'canvas-confetti';
import { highlightCode } from '../../utils/syntaxHighlight';

export interface MacTrafficLightsProps {
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  isMinimized?: boolean;
  isMaximized?: boolean;
}

export const MacTrafficLights: React.FC<MacTrafficLightsProps> = ({
  onClose,
  onMinimize,
  onMaximize,
  isMinimized = false,
  isMaximized = false,
}) => {
  return (
    <div className="flex items-center gap-2 group/traffic select-none">
      {/* Red: Close / Cross */}
      <button
        type="button"
        onClick={onClose}
        title="Close / Copy snippet"
        aria-label="Close"
        className="w-3 h-3 rounded-full bg-[#ff5f56] border border-[#e0443e] flex items-center justify-center p-0 transition-transform active:scale-90 cursor-pointer shadow-sm hover:brightness-105"
      >
        <svg
          viewBox="0 0 10 10"
          className="w-1.5 h-1.5 stroke-[#4c0000] opacity-80 group-hover/traffic:opacity-100 transition-opacity stroke-[2.2] fill-none"
        >
          <path d="M2.5 2.5 L7.5 7.5 M7.5 2.5 L2.5 7.5" strokeLinecap="round" />
        </svg>
      </button>

      {/* Yellow: Minimize / Dash */}
      <button
        type="button"
        onClick={onMinimize}
        title={isMinimized ? "Expand snippet" : "Minimize / Collapse"}
        aria-label="Minimize"
        className="w-3 h-3 rounded-full bg-[#ffbd2e] border border-[#dea123] flex items-center justify-center p-0 transition-transform active:scale-90 cursor-pointer shadow-sm hover:brightness-105"
      >
        <svg
          viewBox="0 0 10 10"
          className="w-1.5 h-1.5 stroke-[#5c4400] opacity-80 group-hover/traffic:opacity-100 transition-opacity stroke-[2.2] fill-none"
        >
          <path d="M2 5 L8 5" strokeLinecap="round" />
        </svg>
      </button>

      {/* Green: Expand / Zoom */}
      <button
        type="button"
        onClick={onMaximize}
        title={isMaximized ? "Restore standard height" : "Expand to full height"}
        aria-label="Maximize"
        className="w-3 h-3 rounded-full bg-[#27c93f] border border-[#1aab29] flex items-center justify-center p-0 transition-transform active:scale-90 cursor-pointer shadow-sm hover:brightness-105"
      >
        <svg
          viewBox="0 0 10 10"
          className="w-1.5 h-1.5 fill-[#004d11] opacity-80 group-hover/traffic:opacity-100 transition-opacity"
        >
          <path d="M2.5 7.5 L2.5 4.5 L4.5 4.5 L2.5 6.5 Z M7.5 2.5 L7.5 5.5 L5.5 5.5 L7.5 3.5 Z" />
        </svg>
      </button>
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
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

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
      className={`my-5 rounded-2xl border border-zinc-800 bg-[#141416] overflow-hidden shadow-xl group transition-all duration-300 ${className}`}
    >
      {/* Code Block Header with Mac Traffic Lights */}
      <div className="px-4 py-3 bg-[#18181b] border-b border-zinc-800/80 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Authentic Mac Window Buttons */}
          <MacTrafficLights
            onClose={() => handleCopy()}
            onMinimize={() => setIsMinimized((prev) => !prev)}
            onMaximize={() => {
              if (isMinimized) setIsMinimized(false);
              setIsMaximized((prev) => !prev);
            }}
            isMinimized={isMinimized}
            isMaximized={isMaximized}
          />

          {/* Language Tag */}
          <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-300 font-semibold px-2 py-0.5 rounded bg-zinc-800/60 border border-zinc-700/40">
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
              : 'bg-[#222226] hover:bg-[#2e2e34] text-zinc-300 hover:text-white'
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
                <Check className="w-3.5 h-3.5" />
              </motion.div>
            ) : (
              <motion.div
                key="copy"
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <Copy className="w-3.5 h-3.5" />
              </motion.div>
            )}
          </AnimatePresence>
        </button>
      </div>

      {/* Code Block Content */}
      {isMinimized ? (
        <div
          onClick={() => setIsMinimized(false)}
          className="px-4 py-3 bg-black/90 text-xs font-mono text-zinc-400 flex items-center justify-between cursor-pointer hover:bg-zinc-950 transition-colors"
        >
          <span className="italic">Code snippet collapsed ({code.split('\n').length} lines)</span>
          <span className="text-[11px] text-sky-400 font-semibold">Click to expand &rarr;</span>
        </div>
      ) : (
        <div
          className={`p-4 bg-black overflow-x-auto transition-all ${
            isMaximized ? 'max-h-none' : 'max-h-[560px]'
          }`}
        >
          <pre className="font-mono text-xs leading-relaxed selection:bg-zinc-800 selection:text-white">
            <code
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              className={`language-${lang}`}
            />
          </pre>
        </div>
      )}
    </div>
  );
};

export default CodeBlock;
