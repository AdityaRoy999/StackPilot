import React from 'react';

interface AuroraBackgroundProps {
  children?: React.ReactNode;
  className?: string;
}

export const AuroraBackground: React.FC<AuroraBackgroundProps> = ({
  children,
  className = '',
}) => {
  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* Aurora Ambient Glow Lights */}
      <div className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 w-[1000px] h-[600px] opacity-30 dark:opacity-40 blur-[120px] rounded-full bg-gradient-to-tr from-cyan-500 via-indigo-500 to-purple-600 animate-pulse-slow" />
      <div className="pointer-events-none absolute top-20 -left-40 w-[600px] h-[500px] opacity-20 dark:opacity-30 blur-[140px] rounded-full bg-gradient-to-r from-teal-400 to-emerald-500" />
      <div className="pointer-events-none absolute top-40 -right-40 w-[600px] h-[500px] opacity-20 dark:opacity-30 blur-[140px] rounded-full bg-gradient-to-l from-violet-600 to-fuchsia-500" />

      {/* Grid Overlay Mask */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03] dark:opacity-[0.05]"
        style={{
          backgroundImage: `linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)`,
          backgroundSize: '40px 40px',
          maskImage: 'radial-gradient(ellipse 60% 50% at 50% 0%, #000 70%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(ellipse 60% 50% at 50% 0%, #000 70%, transparent 100%)',
        }}
      />

      <div className="relative z-10">{children}</div>
    </div>
  );
};
