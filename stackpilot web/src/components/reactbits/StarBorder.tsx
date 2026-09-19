import React from 'react';

interface StarBorderProps extends React.HTMLAttributes<HTMLElement> {
  as?: React.ElementType;
  className?: string;
  color?: string;
  speed?: string;
  href?: string;
  children: React.ReactNode;
}

export const StarBorder: React.FC<StarBorderProps> = ({
  as: Component = 'button',
  className = '',
  color = '#06b6d4',
  speed = '4s',
  children,
  ...props
}) => {
  return (
    <Component
      className={`relative inline-block py-[1px] px-[1px] overflow-hidden rounded-xl group transition-transform duration-300 hover:scale-[1.02] active:scale-[0.98] ${className}`}
      {...props}
    >
      {/* Rotating gradient background */}
      <div
        className="absolute w-[300%] h-[300%] -top-[100%] -left-[100%] rounded-full opacity-70 group-hover:opacity-100 transition-opacity duration-500 animate-spin-slow"
        style={{
          background: `conic-gradient(from 0deg, transparent 0 340deg, ${color} 360deg)`,
          animationDuration: speed,
        }}
      />

      {/* Inner button surface */}
      <div className="relative z-10 rounded-[11px] bg-slate-900/90 dark:bg-black/90 text-white px-6 py-3 font-medium transition-colors group-hover:bg-slate-900/80 dark:group-hover:bg-black/80 flex items-center justify-center gap-2">
        {children}
      </div>
    </Component>
  );
};
