import React from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { 
  PackageIcon, 
  CpuIcon, 
  DatabaseIcon, 
  Globe02Icon, 
  Layers01Icon, 
  RadioIcon, 
  ServerStack01Icon, 
  ShieldCheckIcon, 
  ComputerTerminal01Icon, 
  FlashIcon 
} from '@hugeicons/core-free-icons';
import { Marquee } from './reactbits/Marquee';

export const TechMarquee: React.FC = () => {
  const techs = [
    { name: 'Docker Compose v2', icon: <HugeiconsIcon icon={PackageIcon} size={16} className="text-cyan-400" /> },
    { name: 'Chromium Sandbox', icon: <HugeiconsIcon icon={Globe02Icon} size={16} className="text-amber-400" /> },
    { name: 'WebCodecs H.264', icon: <HugeiconsIcon icon={RadioIcon} size={16} className="text-purple-400" /> },
    { name: 'Drogon C++20 Core', icon: <HugeiconsIcon icon={CpuIcon} size={16} className="text-emerald-400" /> },
    { name: 'Next.js 16 Cockpit', icon: <HugeiconsIcon icon={Layers01Icon} size={16} className="text-blue-400" /> },
    { name: 'PostgreSQL + pgvector', icon: <HugeiconsIcon icon={DatabaseIcon} size={16} className="text-indigo-400" /> },
    { name: 'Redis Job Queue', icon: <HugeiconsIcon icon={ServerStack01Icon} size={16} className="text-rose-400" /> },
    { name: 'FastAPI AI Gateway', icon: <HugeiconsIcon icon={FlashIcon} size={16} className="text-teal-400" /> },
    { name: 'Kubernetes Ready', icon: <HugeiconsIcon icon={ShieldCheckIcon} size={16} className="text-cyan-300" /> },
    { name: 'Terminal CLI (`stackpilot`)', icon: <HugeiconsIcon icon={ComputerTerminal01Icon} size={16} className="text-green-400" /> },
  ];

  return (
    <div className="py-10 border-y border-slate-200/80 dark:border-slate-800/80 bg-slate-100/40 dark:bg-black/40 relative z-20 overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 mb-3 text-center">
        <span className="text-xs font-mono font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
          Powered by Industry-Standard High-Performance Technologies
        </span>
      </div>
      <Marquee speed={35}>
        {techs.map((t, idx) => (
          <div
            key={idx}
            className="flex items-center gap-2.5 px-4 py-2 rounded-xl border border-slate-200/80 dark:border-slate-800/80 bg-white/60 dark:bg-slate-900/60 backdrop-blur-md shadow-sm"
          >
            {t.icon}
            <span className="text-xs font-mono font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap">
              {t.name}
            </span>
          </div>
        ))}
      </Marquee>
    </div>
  );
};
