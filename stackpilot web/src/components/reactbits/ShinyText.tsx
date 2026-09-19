import React from 'react';

interface ShinyTextProps {
  text: string;
  disabled?: boolean;
  speed?: number;
  className?: string;
}

export const ShinyText: React.FC<ShinyTextProps> = ({
  text,
  disabled = false,
  speed = 4,
  className = '',
}) => {
  return (
    <span
      className={`inline-block relative overflow-hidden bg-clip-text text-transparent ${
        disabled
          ? 'text-slate-900 dark:text-slate-100'
          : 'bg-gradient-to-r from-slate-400 via-white to-slate-400 dark:from-slate-500 dark:via-cyan-100 dark:to-slate-500 bg-[length:200%_100%] animate-shimmer'
      } ${className}`}
      style={{
        animationDuration: `${speed}s`,
      }}
    >
      {text}
    </span>
  );
};
