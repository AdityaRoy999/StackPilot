import React from 'react';

interface MarqueeProps {
  children: React.ReactNode;
  direction?: 'left' | 'right';
  speed?: number;
  pauseOnHover?: boolean;
  className?: string;
}

export const Marquee: React.FC<MarqueeProps> = ({
  children,
  speed = 30,
  pauseOnHover = true,
  className = '',
}) => {
  return (
    <div
      className={`relative w-full overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_10%,black_90%,transparent)] ${className}`}
    >
      <div
        className={`flex w-max min-w-full gap-8 py-4 animate-marquee ${
          pauseOnHover ? 'hover:[animation-play-state:paused]' : ''
        }`}
        style={{
          animationDuration: `${speed}s`,
        }}
      >
        <div className="flex shrink-0 items-center justify-around gap-8">
          {children}
        </div>
        <div className="flex shrink-0 items-center justify-around gap-8" aria-hidden="true">
          {children}
        </div>
      </div>
    </div>
  );
};
