import React from 'react';
import { AuroraBackground } from './reactbits/AuroraBackground';
import { DecryptedText } from './reactbits/DecryptedText';
import { ShinyText } from './reactbits/ShinyText';
import { StarBorder } from './reactbits/StarBorder';
import { 
  ArrowRight, 
  Terminal, 
  Sparkles, 
  ShieldCheck, 
  Zap, 
  Video, 
  Box, 
  Code2 
} from 'lucide-react';

export const Hero: React.FC = () => {
  return (
    <AuroraBackground className="pt-32 pb-20 md:pt-40 md:pb-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10">
        {/* Release Pill Badge */}
        <div className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 dark:bg-cyan-950/30 backdrop-blur-md mb-8 animate-fade-in">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
          </span>
          <span className="text-xs font-mono font-medium text-cyan-700 dark:text-cyan-300 tracking-wide">
            StackPilot v2.0 • Ultra-Smooth 60 FPS Autonomous QA & Self-Healing Cockpit
          </span>
          <ArrowRight className="w-3.5 h-3.5 text-cyan-500" />
        </div>

        {/* Main Grand Headline with ReactBits DecryptedText */}
        <h1 className="text-4xl sm:text-6xl md:text-7xl font-extrabold tracking-tight text-slate-900 dark:text-white max-w-5xl mx-auto leading-[1.15]">
          <span>Autonomous AI QA &</span>{' '}
          <br className="hidden sm:inline" />
          <span className="text-gradient-cyan">
            <DecryptedText
              text="Self-Healing Delivery"
              speed={45}
              maxIterations={12}
              characters="ABCDEF0123456789!@#$%^&*"
              className="text-gradient-cyan"
            />
          </span>{' '}
          <span>Cockpit</span>
        </h1>

        {/* Sub-headline */}
        <p className="mt-6 text-lg sm:text-xl text-slate-600 dark:text-slate-300 max-w-3xl mx-auto font-normal leading-relaxed">
          Deploy any web app from GitHub or VPS in seconds. An autonomous AI agent
          crawls, audits, and stress-tests every UI control with{' '}
          <ShinyText text="60 FPS real-time WebCodecs video streaming" className="font-semibold text-slate-900 dark:text-cyan-200" />
          , self-heals broken builds, and runs anywhere via a single script command.
        </p>

        {/* CTAs */}
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
          <StarBorder
            as="a"
            href="#install-scripts"
            color="#06b6d4"
            speed="4s"
            className="w-full sm:w-auto"
          >
            <Terminal className="w-4 h-4 text-cyan-400" />
            <span className="text-sm font-semibold tracking-wide">Copy Quick Install Script</span>
            <ArrowRight className="w-4 h-4 text-cyan-400 group-hover:translate-x-1 transition-transform" />
          </StarBorder>

          <a
            href="#live-cockpit"
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl border border-slate-300 dark:border-slate-800 bg-white/80 dark:bg-slate-900/60 backdrop-blur-md text-slate-800 dark:text-slate-200 hover:text-cyan-600 dark:hover:text-cyan-400 hover:border-cyan-500/50 text-sm font-medium transition-all shadow-sm"
          >
            <Video className="w-4 h-4 text-cyan-500" />
            <span>Interactive 60 FPS Demo</span>
          </a>
        </div>

        {/* Feature Micro-Badges */}
        <div className="mt-14 pt-8 border-t border-slate-200/60 dark:border-slate-800/60 grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mx-auto">
          <div className="flex items-center justify-center gap-2.5 text-xs text-slate-600 dark:text-slate-400 font-mono">
            <Zap className="w-4 h-4 text-amber-500" />
            <span>60 FPS WebCodecs Stream</span>
          </div>
          <div className="flex items-center justify-center gap-2.5 text-xs text-slate-600 dark:text-slate-400 font-mono">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
            <span>Domain-Fenced Autonomous QA</span>
          </div>
          <div className="flex items-center justify-center gap-2.5 text-xs text-slate-600 dark:text-slate-400 font-mono">
            <Code2 className="w-4 h-4 text-cyan-500" />
            <span>C++ Drogon Core Engine</span>
          </div>
          <div className="flex items-center justify-center gap-2.5 text-xs text-slate-600 dark:text-slate-400 font-mono">
            <Box className="w-4 h-4 text-purple-500" />
            <span>Docker & K8s Deployments</span>
          </div>
        </div>
      </div>
    </AuroraBackground>
  );
};
