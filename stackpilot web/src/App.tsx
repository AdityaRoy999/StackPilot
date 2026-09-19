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
        {/* Full-screen Global WebThreads Background Across the Entire Page */}
        <div className="fixed inset-0 w-full h-full pointer-events-none z-0 overflow-hidden select-none opacity-45">
          <WebThreads
            color1="#000000"
            color2="#27272a"
            color3="#FFFFFF"
            speed={0.18}
            threadCount={6}
            frequency={4.5}
            spread={0.2}
            taper={1.0}
            position={0.5}
            fanMode="center"
            glow={0.02}
            falloff={0.6}
            thickness={1.1}
            brightness={0.6}
            opacity={0.8}
            mirror={true}
            shimmer={false}
            grain={true}
            grainIntensity={0.05}
            mouseInteraction={true}
            mouseStrength={0.3}
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
