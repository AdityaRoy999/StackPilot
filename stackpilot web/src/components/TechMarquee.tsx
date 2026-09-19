import React from 'react';
import { Marquee } from './reactbits/Marquee';
import { 
  Box, 
  Cpu, 
  Database, 
  Globe, 
  Layers, 
  Radio, 
  Server, 
  ShieldCheck, 
  Terminal, 
  Zap 
} from 'lucide-react';

export const TechMarquee: React.FC = () => {
  const techs = [
    { name: 'Docker Compose v2', icon: <Box className="w-4 h-4 text-cyan-400" /> },
    { name: 'Chromium Sandbox', icon: <Globe className="w-4 h-4 text-amber-400" /> },
    { name: 'WebCodecs H.264', icon: <Radio className="w-4 h-4 text-purple-400" /> },
    { name: 'Drogon C++20 Core', icon: <Cpu className="w-4 h-4 text-emerald-400" /> },
    { name: 'Next.js 16 Cockpit', icon: <Layers className="w-4 h-4 text-blue-400" /> },
    { name: 'PostgreSQL + pgvector', icon: <Database className="w-4 h-4 text-indigo-400" /> },
    { name: 'Redis Job Queue', icon: <Server className="w-4 h-4 text-rose-400" /> },
    { name: 'FastAPI AI Gateway', icon: <Zap className="w-4 h-4 text-teal-400" /> },
    { name: 'Kubernetes Ready', icon: <ShieldCheck className="w-4 h-4 text-cyan-300" /> },
    { name: 'Terminal CLI (`stackpilot`)', icon: <Terminal className="w-4 h-4 text-green-400" /> },
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
