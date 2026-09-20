import React, { useState, useEffect } from 'react';
import { 
  Play, 
  Pause, 
  RotateCcw, 
  ShieldAlert, 
  CheckCircle2, 
  Activity, 
  Eye, 
  MousePointer, 
  Globe, 
  Maximize2,
  Sparkles,
  Lock
} from 'lucide-react';
import { SpotlightCard } from './reactbits/SpotlightCard';
import { TiltedCard } from './reactbits/TiltedCard';
import { MacTrafficLights } from './docs/CodeBlock';

export const LiveCockpitShowcase: React.FC = () => {
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  const testSteps = [
    {
      action: 'Click: [1] "Products Nav Tab"',
      url: 'https://ecommerce.local/',
      status: 'passed',
      latency: '14ms',
      thought: 'Discovered primary navigation link. Dispatched CDP synthetic pointer & verified route transition to /products.',
      badge: '[1] Nav Link',
      cursorPos: { x: '24%', y: '18%' },
    },
    {
      action: 'Type: "Wireless ANC Headphones" into [2] Search',
      url: 'https://ecommerce.local/products',
      status: 'passed',
      latency: '8ms',
      thought: 'Targeted search input field. Injected test query via Input.insertText with zero latency debounce.',
      badge: '[2] Input Field',
      cursorPos: { x: '52%', y: '26%' },
    },
    {
      action: 'Click: [3] "Add to Cart (Card #1)"',
      url: 'https://ecommerce.local/products?q=headphones',
      status: 'passed',
      latency: '21ms',
      thought: 'Verified product card interactive button. DOM mutated with cart badge update. APV verified state settled.',
      badge: '[3] Card Action',
      cursorPos: { x: '35%', y: '62%' },
    },
    {
      action: 'Fill Form: Name, Email & [4] "Checkout Button"',
      url: 'https://ecommerce.local/checkout',
      status: 'passed',
      latency: '19ms',
      thought: 'Auto-filled test credentials & verified form submission button without triggering external redirect.',
      badge: '[4] Submit Form',
      cursorPos: { x: '68%', y: '74%' },
    },
  ];

  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setCurrentStepIndex(prev => (prev + 1) % testSteps.length);
    }, 2800);
    return () => clearInterval(interval);
  }, [isPlaying]);

  const step = testSteps[currentStepIndex];

  return (
    <section id="live-cockpit" className="py-20 relative z-20 bg-slate-100/40 dark:bg-black/40 border-y border-slate-200/80 dark:border-slate-800/80 scroll-mt-24">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 text-xs font-mono font-medium mb-4">
            <Activity className="w-3.5 h-3.5" />
            <span>Real-Time Autonomous Testing Engine</span>
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            Watch the AI Test Your App at{' '}
            <span className="text-gradient-cyan">60 FPS Fluid Motion</span>
          </h2>
          <p className="mt-4 text-base sm:text-lg text-slate-600 dark:text-slate-300">
            Real-time WebCodecs H.264 screencast directly from an isolated Chromium sandbox. 
            No fake FPS counters, no laggy snapshots — true hardware-accelerated video streaming.
          </p>
        </div>

        {/* Cockpit Simulation Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left / Center: Interactive Browser Canvas Mockup (8 Cols) */}
          <div className="lg:col-span-8">
            <TiltedCard maxTilt={4} scale={1.01} className="shadow-2xl">
              <div className="rounded-2xl border border-slate-300 dark:border-slate-800 bg-slate-950 overflow-hidden">
                {/* Browser Top Chrome */}
                <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-800 text-xs font-mono">
                  {/* Traffic lights & URL bar */}
                  <div className="flex items-center gap-3 flex-1 max-w-lg">
                    <MacTrafficLights />
                    <div className="flex items-center gap-2 px-3 py-1 rounded-md bg-slate-950 border border-slate-800 text-slate-300 flex-1 truncate">
                      <Lock className="w-3 h-3 text-emerald-400 shrink-0" />
                      <span className="truncate">{step.url}</span>
                    </div>
                  </div>

                  {/* 60 FPS Badge & Controls */}
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-500/40 text-emerald-400 font-mono text-[11px] font-bold">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                      <span>60.0 FPS</span>
                    </div>
                    <button
                      onClick={() => setIsPlaying(!isPlaying)}
                      className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
                      title={isPlaying ? 'Pause simulation' : 'Play simulation'}
                    >
                      {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {/* Simulated Web Canvas Viewport */}
                <div className="relative aspect-[16/10] w-full bg-[#0a0e17] overflow-hidden select-none">
                  {/* Website Mockup Content */}
                  <div className="absolute inset-0 p-6 flex flex-col justify-between">
                    {/* Simulated Web Header */}
                    <div className="flex items-center justify-between pb-4 border-b border-slate-800/80">
                      <div className="flex items-center gap-4">
                        <div className="w-7 h-7 rounded-lg bg-indigo-500/30 border border-indigo-400/40 flex items-center justify-center text-xs font-bold text-indigo-300">
                          ACME
                        </div>
                        <div className="relative">
                          <span className="text-xs text-slate-300 font-medium">Products</span>
                          {/* Visual Set-of-Marks Badge [1] */}
                          <span className="absolute -top-2.5 -right-5 px-1 py-0.2 text-[9px] font-mono font-bold rounded bg-rose-500 text-white shadow-sm ring-1 ring-white/30">
                            [1]
                          </span>
                        </div>
                        <span className="text-xs text-slate-500">Pricing</span>
                        <span className="text-xs text-slate-500">Docs</span>
                      </div>
                      <div className="relative">
                        <div className="w-36 h-7 rounded-md bg-slate-900 border border-slate-800 text-[11px] text-slate-400 flex items-center px-2">
                          Search audio...
                        </div>
                        {/* Set-of-Marks [2] */}
                        <span className="absolute -top-2.5 -right-2 px-1 py-0.2 text-[9px] font-mono font-bold rounded bg-amber-500 text-black shadow-sm ring-1 ring-black/30">
                          [2]
                        </span>
                      </div>
                    </div>

                    {/* Simulated Product Card Grid */}
                    <div className="grid grid-cols-2 gap-4 my-auto">
                      <div className="relative p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col justify-between">
                        <div>
                          <span className="text-xs text-indigo-400 font-mono">NEW ARRIVAL</span>
                          <h4 className="text-sm font-semibold text-white mt-1">Noise-Cancelling Headphones Pro</h4>
                          <p className="text-xs text-slate-400 mt-1">$299.00 • In Stock</p>
                        </div>
                        <div className="mt-4 flex items-center justify-between">
                          <div className="relative">
                            <button className="px-3 py-1.5 rounded-lg bg-cyan-500 text-black text-xs font-bold shadow-md shadow-cyan-500/20">
                              Add to Cart
                            </button>
                            {/* Set-of-Marks [3] */}
                            <span className="absolute -top-2 -right-2 px-1 py-0.2 text-[9px] font-mono font-bold rounded bg-cyan-400 text-black shadow-sm ring-1 ring-black/30">
                              [3]
                            </span>
                          </div>
                          <span className="text-[10px] text-slate-500 font-mono">★ 4.9 (1,240)</span>
                        </div>
                      </div>

                      <div className="relative p-4 rounded-xl bg-slate-900/50 border border-slate-800/80 flex flex-col justify-between">
                        <div>
                          <span className="text-xs text-emerald-400 font-mono">FAST SHIPPING</span>
                          <h4 className="text-sm font-semibold text-slate-300 mt-1">Studio Monitor Earbuds</h4>
                          <p className="text-xs text-slate-400 mt-1">$149.00 • In Stock</p>
                        </div>
                        <div className="mt-4 flex items-center justify-between">
                          <button className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-xs font-medium">
                            Add to Cart
                          </button>
                          <span className="text-[10px] text-slate-500 font-mono">★ 4.7 (890)</span>
                        </div>
                      </div>
                    </div>

                    {/* Simulated Footer Action */}
                    <div className="flex items-center justify-between pt-3 border-t border-slate-800/60">
                      <div className="relative">
                        <button className="px-4 py-1.5 rounded-lg bg-emerald-500 text-slate-950 text-xs font-bold">
                          Proceed to Checkout
                        </button>
                        {/* Set-of-Marks [4] */}
                        <span className="absolute -top-2 -right-2 px-1 py-0.2 text-[9px] font-mono font-bold rounded bg-emerald-400 text-black shadow-sm ring-1 ring-black/30">
                          [4]
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-slate-500 font-mono">
                        <span className="flex items-center gap-1 text-emerald-400">
                          <CheckCircle2 className="w-3 h-3" /> Same-Origin Locked
                        </span>
                        <span>External Links Blocked</span>
                      </div>
                    </div>
                  </div>

                  {/* Simulated Autonomous Mouse Cursor */}
                  <div
                    className="absolute z-30 pointer-events-none transition-all duration-700 ease-out flex items-center gap-2"
                    style={{
                      left: step.cursorPos.x,
                      top: step.cursorPos.y,
                    }}
                  >
                    <MousePointer className="w-5 h-5 text-cyan-400 fill-cyan-400/30 drop-shadow-md animate-bounce" />
                    <span className="px-2 py-0.5 rounded-md bg-slate-900/90 border border-cyan-500/40 text-[10px] font-mono font-bold text-cyan-300 backdrop-blur-md shadow-lg">
                      AI Tester
                    </span>
                    {/* Ripple Click Animation */}
                    <span className="absolute -inset-2 rounded-full border-2 border-cyan-400/80 animate-ping" />
                  </div>
                </div>
              </div>
            </TiltedCard>
          </div>

          {/* Right: Live Action Perception Verification Feed (4 Cols) */}
          <div className="lg:col-span-4 space-y-4">
            <SpotlightCard className="p-5 border border-slate-300 dark:border-slate-800">
              <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800 mb-4">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-cyan-500" />
                  <span className="text-xs font-mono font-bold uppercase tracking-wider text-slate-900 dark:text-white">
                    APV Perception Stream
                  </span>
                </div>
                <span className="text-[11px] font-mono text-cyan-600 dark:text-cyan-400 font-semibold">
                  Step {currentStepIndex + 1} of {testSteps.length}
                </span>
              </div>

              {/* Current Action Item */}
              <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 mb-4">
                <div className="text-[11px] font-mono font-medium text-cyan-700 dark:text-cyan-300">
                  CURRENT ACTION
                </div>
                <div className="text-sm font-bold text-slate-900 dark:text-white mt-0.5">
                  {step.action}
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs font-mono text-slate-600 dark:text-slate-400">
                  <span className="px-2 py-0.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-emerald-600 dark:text-emerald-400 font-bold">
                    Passed ✓
                  </span>
                  <span>Latency: {step.latency}</span>
                </div>
              </div>

              {/* AI Agent Thought Trace */}
              <div className="space-y-1.5 font-mono text-xs">
                <div className="text-slate-500 dark:text-slate-400 text-[11px]">AUTONOMOUS REASONING:</div>
                <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 leading-relaxed">
                  {step.thought}
                </div>
              </div>

              {/* Security & Domain Fence Status */}
              <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2 text-xs font-mono">
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Domain Fence:</span>
                  <span className="text-emerald-500 font-semibold flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Strict Same-Origin
                  </span>
                </div>
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>H.264 GOP Queue:</span>
                  <span className="text-cyan-500 font-semibold">0 Drops (IDR Locked)</span>
                </div>
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>DOM Quiescence:</span>
                  <span className="text-slate-900 dark:text-slate-200 font-semibold">Rest Verified (0ms)</span>
                </div>
              </div>
            </SpotlightCard>

            {/* Quick Test Trigger Card */}
            <div className="p-4 rounded-xl border border-slate-300/80 dark:border-slate-800/80 bg-white/70 dark:bg-slate-900/50 backdrop-blur-md">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white mb-2">
                <Sparkles className="w-3.5 h-3.5 text-cyan-500" />
                <span>Test Your Own Web App Live</span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed mb-3">
                Run the quick install script or use the CLI to start testing any local or staging URL immediately.
              </p>
              <a
                href="#install-scripts"
                className="inline-flex items-center justify-center gap-1.5 w-full py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-950 text-xs font-bold hover:bg-slate-800 dark:hover:bg-slate-100 transition-colors"
              >
                <span>Get Started in 1 Line</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
