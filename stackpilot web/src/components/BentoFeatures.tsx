import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { MorphSlider, type MorphItem } from './reactbits/MorphSlider';

interface FeatureItem {
  id: string;
  tagline: string;
  title: string;
  description: string;
  video: string;
}

const FEATURES: FeatureItem[] = [
  {
    id: 'deployments',
    tagline: 'ZERO-CONFIG DEPLOYMENTS',
    title: 'From Git Push to Live Ingress in 10 Seconds',
    description:
      'Connect your repository or codebase. StackPilot auto-detects frameworks, creates isolated micro-sandboxes, and provisions public HTTPS edge ingress in seconds.',
    video: '/features/project-deployment.mp4',
  },
  {
    id: 'clusters',
    tagline: 'MULTI-CLOUD CLUSTERS',
    title: 'Turn Bare-Metal or VPS into Production Clusters',
    description:
      'Turn bare-metal or VPS instances into production Kubernetes and Docker clusters across Hetzner, AWS, or custom nodes with automated SSH distribution and mesh networking.',
    video: '/features/one-click-cluster-builder.mp4',
  },
  {
    id: 'observability',
    tagline: 'REAL-TIME OBSERVABILITY',
    title: 'Microsecond Telemetry & Unified Streaming Logs',
    description:
      'Inspect real-time per-container CPU, RAM, and network telemetry with live streaming logs and instant search to catch resource bottlenecks before users experience downtime.',
    video: '/features/monitoring-infrastructure.mp4',
  },
  {
    id: 'ai-qa',
    tagline: 'AUTONOMOUS AI QA AGENT',
    title: 'The Vision AI Agent That Explores, Tests, and Heals',
    description:
      'Our vision-guided AI agent explores your live app like a real human—navigating full user flows, filling and submitting complex forms, crawling subpage hierarchies, and running self-healing diagnostic repairs on broken paths.',
    video: '/features/ai-agent-testing.mp4',
  },
];

const MORPH_ITEMS: MorphItem[] = FEATURES.map((f) => ({
  video: f.video,
  caption: f.title,
}));

// Cascading blur animation matching the headline word-changing transition in Hero
const CascadingText: React.FC<{
  text: string;
  className?: string;
  delayOffset?: number;
  wordMode?: boolean;
}> = ({ text, className = '', delayOffset = 0, wordMode = false }) => {
  const items = wordMode ? text.split(' ') : text.split('');

  return (
    <span className={`inline-block ${className}`}>
      {items.map((item, idx) => (
        <motion.span
          key={idx}
          initial={{ filter: 'blur(10px)', opacity: 0, y: -20 }}
          animate={{
            filter: ['blur(10px)', 'blur(4px)', 'blur(0px)'],
            opacity: [0, 0.5, 1],
            y: [-20, 3, 0],
          }}
          exit={{
            opacity: 0,
            y: 12,
            filter: 'blur(8px)',
            transition: { duration: 0.16, ease: 'easeIn' },
          }}
          transition={{
            duration: 0.32,
            times: [0, 0.55, 1],
            delay: delayOffset + idx * (wordMode ? 0.03 : 0.015),
            ease: [0.22, 1, 0.36, 1],
          }}
          className="inline-block"
        >
          {item === ' ' ? '\u00A0' : item}
          {wordMode && idx < items.length - 1 && '\u00A0'}
        </motion.span>
      ))}
    </span>
  );
};

export const BentoFeatures: React.FC = () => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isEnlarged, setIsEnlarged] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const activeIndexRef = useRef(0);

  // Scroll-based index change using vanilla scroll progress (no GSAP pin — avoids Lenis conflicts)
  useEffect(() => {
    if (!containerRef.current) return;

    const handleScroll = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const totalHeight = el.offsetHeight - window.innerHeight;
      if (totalHeight <= 0) return;
      const scrolled = -rect.top;
      const progress = Math.max(0, Math.min(0.9999, scrolled / totalHeight));
      const newIndex = Math.min(
        FEATURES.length - 1,
        Math.floor(progress * FEATURES.length)
      );
      if (newIndex !== activeIndexRef.current) {
        activeIndexRef.current = newIndex;
        setActiveIndex(newIndex);
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  // Escape key closes enlarged video lightbox
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsEnlarged(false);
      }
    };
    if (isEnlarged) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEnlarged]);

  const activeFeature = FEATURES[activeIndex];

  return (
    <div
      ref={containerRef}
      id="features"
      className="relative w-full select-none"
      style={{ minHeight: '250vh' }}
    >
      {/* Sticky Showcase Stage — transparent so Lightfall particles show through */}
      <div
        ref={stageRef}
        className="sticky top-[65px] w-full flex flex-col items-center py-2 sm:py-3 z-10"
      >
        {/* Features Headline & Subtitle */}
        <div className="text-center max-w-3xl mx-auto mb-3 sm:mb-4 px-4">
          <h2 className="font-headline text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight text-white leading-tight">
            Features
          </h2>
          <p className="mt-1.5 text-sm sm:text-base lg:text-lg text-zinc-400 leading-relaxed font-normal max-w-2xl mx-auto">
            From 1-click cloud provisioning to vision-guided autonomous testing,
            StackPilot delivers a complete, resilient delivery cockpit for modern engineering teams.
          </p>
        </div>

        {/* Side-by-Side: Video & Bento Card — viewport-constrained height so both fit fully */}
        <div className="w-full max-w-7xl mx-auto px-2 sm:px-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6 items-stretch" style={{ height: 'calc(100vh - 240px)' }}>
            {/* Left Box: Video Container */}
            <div className="w-full h-full">
              <div
                onClick={() => setIsEnlarged(true)}
                className="relative w-full h-full rounded-2xl sm:rounded-3xl overflow-hidden bg-black shadow-2xl select-none cursor-pointer border border-zinc-800/80 transition-transform duration-300 hover:scale-[1.005] group flex items-center justify-center"
                title="Click to expand video"
              >
                <MorphSlider
                  items={MORPH_ITEMS}
                  currentIndex={activeIndex}
                  onIndexChange={setActiveIndex}
                  transition="melt"
                  intensity={0.55}
                  aberration={0.32}
                  duration={0.85}
                  radius={24}
                  drift={0}
                  showControls={false}
                  showIndicators={false}
                  showCaptions={false}
                  className="w-full h-full"
                />

                {/* Subtle Hover Expand Indicator */}
                <div className="absolute top-3 right-3 z-10 px-2.5 py-1 rounded-full bg-black/70 backdrop-blur-md border border-white/15 text-xs font-mono text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none flex items-center gap-1.5 shadow-xl">
                  <svg className="w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>Expand</span>
                </div>
              </div>
            </div>

            {/* Right Box: Bento Card — Tagline + Title at top, Description in grey nested card */}
            <div className="w-full h-full">
              <div className="w-full h-full rounded-2xl sm:rounded-3xl border border-zinc-800/80 bg-zinc-950/90 backdrop-blur-2xl p-5 sm:p-6 lg:p-7 flex flex-col justify-between gap-4 shadow-2xl select-none">
                {/* Top Section: Title directly at top */}
                <div>
                  <AnimatePresence mode="wait">
                    <div key={`title-${activeIndex}`}>
                      <CascadingText
                        text={activeFeature.title}
                        delayOffset={0.02}
                        wordMode={true}
                        className="text-2xl sm:text-3xl lg:text-[28px] xl:text-[31px] font-bold text-white tracking-tight leading-snug"
                      />
                    </div>
                  </AnimatePresence>
                </div>

                {/* Lower Section: Nested Card containing the Description */}
                <div className="rounded-xl sm:rounded-2xl bg-[#111114] border border-zinc-800/80 p-5 sm:p-6 shadow-lg flex flex-col justify-center flex-1">
                  <AnimatePresence mode="wait">
                    <div key={`desc-${activeIndex}`}>
                      <CascadingText
                        text={activeFeature.description}
                        delayOffset={0.06}
                        wordMode={true}
                        className="text-sm sm:text-base lg:text-[15px] text-zinc-200 leading-relaxed font-normal"
                      />
                    </div>
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {isEnlarged && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                onClick={() => setIsEnlarged(false)}
                className="fixed inset-0 z-[99999] flex items-center justify-center p-4 sm:p-8 bg-black/90 backdrop-blur-3xl cursor-zoom-out"
              >
                <motion.div
                  initial={{ scale: 0.88, opacity: 0, y: 15 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ scale: 0.88, opacity: 0, y: 10 }}
                  transition={{ type: 'spring', damping: 30, stiffness: 350 }}
                  onClick={(e) => e.stopPropagation()}
                  className="relative w-full max-w-5xl aspect-video rounded-3xl overflow-hidden bg-black shadow-[0_0_90px_rgba(0,0,0,0.95)] border border-white/10 cursor-default"
                >
                  {/* Playing video without any controls bar (object-contain ensures zero cropping) */}
                  <video
                    key={activeFeature.video}
                    src={activeFeature.video}
                    autoPlay
                    loop
                    muted
                    playsInline
                    className="w-full h-full object-contain select-none pointer-events-none"
                  />

                  {/* Close Button */}
                  <button
                    type="button"
                    onClick={() => setIsEnlarged(false)}
                    className="absolute top-4 right-4 z-30 p-2.5 rounded-full bg-black/70 hover:bg-black text-zinc-300 hover:text-white backdrop-blur-md border border-white/15 transition-all duration-200 cursor-pointer"
                    title="Close (Esc)"
                    aria-label="Close enlarged video"
                  >
                    <svg
                      className="w-5 h-5 fill-none stroke-current stroke-2"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M18 6L6 18M6 6l12 12"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </div>
  );
};

export default BentoFeatures;
