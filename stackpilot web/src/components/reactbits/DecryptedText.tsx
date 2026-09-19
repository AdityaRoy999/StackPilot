import React, { useEffect, useState, useRef } from 'react';

interface DecryptedTextProps {
  text: string;
  speed?: number;
  maxIterations?: number;
  sequential?: boolean;
  revealDirection?: 'start' | 'end' | 'center';
  useOriginalCharsOnly?: boolean;
  characters?: string;
  className?: string;
  parentClassName?: string;
  encryptedClassName?: string;
  animateOn?: 'view' | 'hover';
}

const DEFAULT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';

export const DecryptedText: React.FC<DecryptedTextProps> = ({
  text,
  speed = 40,
  maxIterations = 10,
  sequential = true,
  characters = DEFAULT_CHARS,
  className = '',
  parentClassName = '',
  encryptedClassName = 'text-cyan-500/70 dark:text-cyan-400/80 font-mono',
  animateOn = 'view',
}) => {
  const [displayText, setDisplayText] = useState(text);
  const [isHovering, setIsHovering] = useState(false);
  const [isDecrypted, setIsDecrypted] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const hasAnimatedRef = useRef(false);

  const startDecrypt = () => {
    let iteration = 0;
    const length = text.length;

    const interval = setInterval(() => {
      setDisplayText(() => {
        return text
          .split('')
          .map((char, index) => {
            if (char === ' ') return ' ';
            if (sequential) {
              const charProgress = (iteration / maxIterations) * length;
              if (index < charProgress) {
                return text[index];
              }
            } else {
              if (iteration >= maxIterations) {
                return text[index];
              }
            }
            return characters[Math.floor(Math.random() * characters.length)];
          })
          .join('');
      });

      iteration += 1;
      if (iteration > maxIterations + (sequential ? length : 0)) {
        clearInterval(interval);
        setDisplayText(text);
        setIsDecrypted(true);
      }
    }, speed);
  };

  useEffect(() => {
    if (animateOn === 'view') {
      const observer = new IntersectionObserver(
        entries => {
          entries.forEach(entry => {
            if (entry.isIntersecting && !hasAnimatedRef.current) {
              hasAnimatedRef.current = true;
              startDecrypt();
            }
          });
        },
        { threshold: 0.1 }
      );

      if (containerRef.current) {
        observer.observe(containerRef.current);
      }
      return () => observer.disconnect();
    }
  }, [text, animateOn]);

  const handleMouseEnter = () => {
    if (animateOn === 'hover') {
      setIsHovering(true);
      setIsDecrypted(false);
      startDecrypt();
    }
  };

  const handleMouseLeave = () => {
    if (animateOn === 'hover') {
      setIsHovering(false);
    }
  };

  return (
    <span
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`inline-block whitespace-pre-wrap cursor-default ${parentClassName}`}
    >
      <span className={isDecrypted ? className : encryptedClassName}>
        {displayText}
      </span>
    </span>
  );
};
