import React from 'react';
import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { Footer } from './components/Footer';
import { SmoothScroll } from './components/SmoothScroll';
import { WebThreads } from './components/reactbits/WebThreads';
import { ScriptProvider } from './context/ScriptContext';

export const App: React.FC = () => {
  return (
    <ScriptProvider>
      <SmoothScroll>
        <div className="min-h-screen bg-black text-zinc-100 flex flex-col selection:bg-zinc-800 selection:text-zinc-100 antialiased font-sans relative overflow-x-hidden">
          {/* Full-screen Global WebThreads Background - Clearly Visible & Atmospheric */}
          <div className="fixed inset-0 w-full h-full pointer-events-none z-0 overflow-hidden select-none opacity-80">
            <WebThreads
              color1="#27272a"
              color2="#71717a"
              color3="#ffffff"
              speed={0.18}
              threadCount={6}
              frequency={4.5}
              spread={0.22}
              taper={1.0}
              position={0.5}
              fanMode="center"
              glow={0.06}
              falloff={0.65}
              thickness={1.4}
              brightness={0.85}
              opacity={0.85}
              mirror={true}
              shimmer={true}
              grain={true}
              grainIntensity={0.03}
              mouseInteraction={true}
              mouseStrength={0.35}
            />
          </div>

          <Navbar />

          <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 flex flex-col justify-center relative z-10">
            <Hero />
          </main>

          <Footer />
        </div>
      </SmoothScroll>
    </ScriptProvider>
  );
};

export default App;
