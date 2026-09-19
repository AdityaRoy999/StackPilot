import React, { useState } from 'react';

interface DockItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  href: string;
  onClick?: () => void;
}

interface DockProps {
  items: DockItem[];
  className?: string;
}

export const Dock: React.FC<DockProps> = ({ items, className = '' }) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  return (
    <nav
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-full border border-slate-200/60 dark:border-slate-800/80 bg-white/80 dark:bg-slate-950/80 backdrop-blur-xl shadow-2xl shadow-slate-900/10 dark:shadow-cyan-950/20 transition-all duration-300 ${className}`}
    >
      {items.map((item, idx) => {
        const isHovered = hoveredIndex === idx;
        const isNeighbor = hoveredIndex !== null && Math.abs(hoveredIndex - idx) === 1;

        let scale = 'scale-100';
        if (isHovered) scale = 'scale-125 -translate-y-2';
        else if (isNeighbor) scale = 'scale-110 -translate-y-1';

        return (
          <a
            key={item.id}
            href={item.href}
            onClick={e => {
              if (item.onClick) {
                e.preventDefault();
                item.onClick();
              }
            }}
            onMouseEnter={() => setHoveredIndex(idx)}
            onMouseLeave={() => setHoveredIndex(null)}
            className={`relative flex items-center justify-center p-3 rounded-full text-slate-600 dark:text-slate-300 hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-all duration-200 ${scale}`}
            title={item.label}
          >
            {item.icon}

            {/* Floating tooltip */}
            {isHovered && (
              <span className="absolute -top-9 px-2.5 py-1 text-[11px] font-medium tracking-wide rounded-md bg-slate-900 text-white dark:bg-white dark:text-slate-900 shadow-md whitespace-nowrap animate-fade-in pointer-events-none">
                {item.label}
              </span>
            )}
          </a>
        );
      })}
    </nav>
  );
};
