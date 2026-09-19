import React from 'react';
import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { Footer } from './components/Footer';
import { SmoothScroll } from './components/SmoothScroll';
import { WebThreads } from './components/reactbits/WebThreads';

export const App: React.FC = () => {
  return (
    <SmoothScroll>
      <div className="min-h-screen bg-black text-zinc-100 flex flex-col selection:bg-zinc-800 selection:text-zinc-100 antialiased font-sans relative overflow-x-hidden">
        {/* Full-screen Global WebThreads Background - Subtle & Low Visibility */}
        <div className="fixed inset-0 w-full h-full pointer-events-none z-0 overflow-hidden select-none opacity-20">
          <WebThreads
            color1="#000000"
            color2="#18181b"
            color3="#a1a1aa"
            speed={0.14}
            threadCount={5}
            frequency={4.0}
            spread={0.2}
            taper={1.0}
            position={0.5}
            fanMode="center"
            glow={0.01}
            falloff={0.7}
            thickness={1.0}
            brightness={0.3}
            opacity={0.4}
            mirror={true}
            shimmer={false}
            grain={true}
            grainIntensity={0.03}
            mouseInteraction={true}
            mouseStrength={0.25}
          />
        </div>

        <Navbar />

        <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 flex flex-col justify-center relative z-10">
          <Hero />
        </main>

        <Footer />
      </div>
    </SmoothScroll>
  );
};

export default App;
