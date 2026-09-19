import React from 'react';
import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { Footer } from './components/Footer';
import GradualBlur from './components/reactbits/GradualBlur';

export const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col selection:bg-zinc-800 selection:text-zinc-100 antialiased font-sans relative">
      {/* Top Gradual Blur behind header */}
      <GradualBlur
        target="page"
        position="top"
        height="6rem"
        strength={2.5}
        divCount={6}
        curve="bezier"
        exponential={true}
        opacity={1}
        zIndex={40}
      />

      <Navbar />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 flex flex-col justify-center relative z-10">
        <Hero />
      </main>

      <Footer />

      {/* Bottom Gradual Blur at viewport base */}
      <GradualBlur
        target="page"
        position="bottom"
        height="5rem"
        strength={2}
        divCount={5}
        curve="bezier"
        exponential={true}
        opacity={1}
        zIndex={40}
      />
    </div>
  );
};

export default App;
