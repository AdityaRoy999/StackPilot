import React from 'react';
import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { Footer } from './components/Footer';
import { SmoothScroll } from './components/SmoothScroll';

export const App: React.FC = () => {
  return (
    <SmoothScroll>
      <div className="min-h-screen bg-black text-zinc-100 flex flex-col selection:bg-zinc-800 selection:text-zinc-100 antialiased font-sans">
        <Navbar />

        <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 flex flex-col justify-center">
          <Hero />
        </main>

        <Footer />
      </div>
    </SmoothScroll>
  );
};

export default App;
