import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface PreloaderProps {
  onComplete?: () => void;
}

export const Preloader: React.FC<PreloaderProps> = ({ onComplete }) => {
  const [showPreloader, setShowPreloader] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const finishedRef = useRef(false);

  const handleFinish = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setShowPreloader(false);
    onComplete?.();
  };

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.playbackRate = 1.0;
      video.play().catch(() => {
        // Fallback if browser requires user gesture
        setTimeout(handleFinish, 1800);
      });
    }

    // Safety fallback: video duration is 3.16s, guarantee transition out by 3.8s
    const timer = setTimeout(handleFinish, 3800);
    return () => clearTimeout(timer);
  }, []);

  return (
    <AnimatePresence>
      {showPreloader && (
        <motion.div
          key="video-preloader"
          initial={{ opacity: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, filter: 'blur(22px)', scale: 1.03 }}
          transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-0 z-[999999] bg-black flex items-center justify-center cursor-pointer select-none overflow-hidden"
          onClick={handleFinish}
          title="Click to skip"
        >
          {/* Centered cropped and speed-optimized video */}
          <div className="relative w-full max-w-[560px] aspect-[3/2] flex items-center justify-center">
            <video
              ref={videoRef}
              src="/preloader/preloader.mp4"
              muted
              autoPlay
              playsInline
              onEnded={handleFinish}
              className="w-full h-full object-contain pointer-events-none"
            />
          </div>

          {/* Minimal subtle skip prompt in bottom right */}
          <div className="absolute bottom-6 right-8 text-[11px] font-mono text-zinc-600 hover:text-zinc-400 transition-colors uppercase tracking-widest pointer-events-none">
            Click to Skip
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default Preloader;
