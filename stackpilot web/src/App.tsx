import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { BentoFeatures } from './components/BentoFeatures';
import { OpenSourceBento } from './components/OpenSourceBento';
import { Footer } from './components/Footer';
import { SmoothScroll } from './components/SmoothScroll';
import { Lightfall } from './components/reactbits/Lightfall';
import { ScriptProvider } from './context/ScriptContext';
import { FontProvider } from './context/FontContext';
import { DocsPage } from './pages/DocsPage';
import { ContactPage } from './pages/ContactPage';
import { Preloader } from './components/Preloader';

type RouteState = 'home' | 'docs' | 'contact';

const getInitialRoute = (): RouteState => {
  if (typeof window === 'undefined') return 'home';
  const path = window.location.pathname.toLowerCase();
  const hash = window.location.hash.toLowerCase();
  if (path.includes('contact') || hash.includes('contact')) return 'contact';
  if (path.includes('docs') || hash.includes('docs')) return 'docs';
  return 'home';
};

export const App: React.FC = () => {
  const [route, setRoute] = useState<RouteState>(() => getInitialRoute());

  useEffect(() => {
    const handleLocationChange = () => {
      setRoute(getInitialRoute());
    };

    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('hashchange', handleLocationChange);
    return () => {
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('hashchange', handleLocationChange);
    };
  }, []);

  const navigateTo = (target: RouteState) => {
    let targetPath = '/';
    if (target === 'docs') targetPath = '/docs';
    if (target === 'contact') targetPath = '/contact';
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }
    setRoute(target);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  };

  return (
    <FontProvider>
      <Preloader />

      {/* Global Viewport Background: 100% FIXED to screen, completely decoupled from scroll & Lenis */}
      {route === 'home' && (
        <div
          className="fixed inset-0 pointer-events-none overflow-hidden select-none"
          style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 0 }}
        >
          {/* Ambient Blue Gradients */}
          <div
            className="absolute -bottom-24 -left-28 w-[720px] h-[720px] bg-gradient-to-tr from-blue-600/35 via-indigo-600/22 to-transparent blur-[130px] rounded-full select-none"
            aria-hidden="true"
          />
          <div
            className="absolute top-1/4 -right-28 w-[560px] h-[560px] bg-gradient-to-bl from-indigo-600/20 via-sky-600/15 to-transparent blur-[140px] rounded-full select-none"
            aria-hidden="true"
          />

          {/* Full-screen Global React Bits Lightfall Background */}
          <Lightfall
            colors={['#60a5fa', '#3b82f6', '#4f46e5', '#818cf8', '#93c5fd', '#38bdf8']}
            backgroundColor="#000000"
            speed={0.42}
            streakCount={5}
            streakWidth={0.9}
            streakLength={1.1}
            glow={0.8}
            density={0.35}
            twinkle={0.5}
            zoom={2.5}
            backgroundGlow={0.25}
            opacity={0.65}
            mouseInteraction={false}
          />
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={route}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="w-full flex-1 flex flex-col relative z-10"
        >
          {route === 'docs' && (
            <SmoothScroll>
              <DocsPage
                onNavigateHome={() => navigateTo('home')}
                onNavigateContact={() => navigateTo('contact')}
              />
            </SmoothScroll>
          )}

          {route === 'contact' && (
            <SmoothScroll>
              <ContactPage
                onNavigateHome={() => navigateTo('home')}
                onNavigateDocs={() => navigateTo('docs')}
              />
            </SmoothScroll>
          )}

          {route === 'home' && (
            <ScriptProvider>
              <SmoothScroll>
                <div className="min-h-screen bg-transparent text-zinc-100 flex flex-col selection:bg-zinc-800 selection:text-zinc-100 antialiased font-sans relative">
                  <Navbar
                    onNavigateDocs={() => navigateTo('docs')}
                    onNavigateHome={() => navigateTo('home')}
                    onNavigateContact={() => navigateTo('contact')}
                  />

                  <main className="flex-1 max-w-[1380px] w-full mx-auto px-4 sm:px-6 lg:px-8 flex flex-col relative z-10">
                    <Hero />
                    <BentoFeatures />
                  </main>

                  {/* Full-width 100vw section for CircularGallery */}
                  <div className="w-full relative z-10 overflow-hidden">
                    <OpenSourceBento />
                  </div>

                  <Footer
                    onNavigateDocs={() => navigateTo('docs')}
                    onNavigateContact={() => navigateTo('contact')}
                  />
                </div>
              </SmoothScroll>
            </ScriptProvider>
          )}
        </motion.div>
      </AnimatePresence>
    </FontProvider>
  );
};

export default App;
