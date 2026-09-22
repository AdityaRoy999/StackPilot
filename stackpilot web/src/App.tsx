import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { BentoFeatures } from './components/BentoFeatures';
import { OpenSourceBento } from './components/OpenSourceBento';
import { Footer } from './components/Footer';
import { SmoothScroll } from './components/SmoothScroll';
import { Lightfall } from './components/reactbits/Lightfall';
import { Preloader } from './components/Preloader';
import { ScriptProvider } from './context/ScriptContext';
import { FontProvider } from './context/FontContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { DocsPage } from './pages/DocsPage';
import { ContactPage } from './pages/ContactPage';

type RouteState = 'home' | 'docs' | 'contact';

const getInitialRoute = (): RouteState => {
  if (typeof window === 'undefined') return 'home';
  const path = window.location.pathname.toLowerCase();
  const hash = window.location.hash.toLowerCase();
  if (path.includes('contact') || hash.includes('contact')) return 'contact';
  if (path.includes('docs') || hash.includes('docs')) return 'docs';
  return 'home';
};

const AppContent: React.FC = () => {
  const [route, setRoute] = useState<RouteState>(() => getInitialRoute());
  const { theme } = useTheme();
  const isLight = theme === 'light';

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
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <>
      {/* 1. Minimal Monochrome Preloader with Electric Blue Transition Effect */}
      <Preloader />

      {/* 2. Full-Website Blur Route Transitions */}
      <AnimatePresence mode="wait">
        <motion.div
          key={route}
          initial={{ opacity: 0, filter: 'blur(16px)', y: 6 }}
          animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
          exit={{ opacity: 0, filter: 'blur(16px)', y: -6 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="w-full flex-1 flex flex-col will-change-transform transform-gpu"
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
                <div className={`min-h-screen ${isLight ? 'bg-white text-zinc-900 selection:bg-zinc-200 selection:text-zinc-900' : 'bg-black text-zinc-100 selection:bg-zinc-800 selection:text-zinc-100'} flex flex-col antialiased font-sans relative overflow-x-clip transition-colors duration-300`}>
                  {/* Atmospheric Ambient Gradients — Hardware accelerated compositor layers */}
                  <div
                    className={`fixed -bottom-24 -left-28 w-[720px] h-[720px] ${isLight ? 'bg-gradient-to-tr from-blue-400/20 via-sky-300/15 to-transparent blur-[140px]' : 'bg-gradient-to-tr from-blue-600/35 via-indigo-600/22 to-transparent blur-[130px]'} pointer-events-none z-0 rounded-full select-none will-change-transform transform-gpu`}
                    style={{ transform: 'translate3d(0, 0, 0)' }}
                    aria-hidden="true"
                  />
                  <div
                    className={`fixed top-1/4 -right-28 w-[560px] h-[560px] ${isLight ? 'bg-gradient-to-bl from-indigo-400/15 via-blue-300/10 to-transparent blur-[150px]' : 'bg-gradient-to-bl from-indigo-600/20 via-sky-600/15 to-transparent blur-[140px]'} pointer-events-none z-0 rounded-full select-none will-change-transform transform-gpu`}
                    style={{ transform: 'translate3d(0, 0, 0)' }}
                    aria-hidden="true"
                  />

                  {/* Full-screen Global React Bits Lightfall Background — Adapts gracefully to light/dark */}
                  <div className="fixed inset-0 w-full h-full pointer-events-none z-0 overflow-hidden select-none">
                    <Lightfall
                      colors={
                        isLight
                          ? ['#2563eb', '#1d4ed8', '#0284c7', '#3b82f6', '#4f46e5']
                          : ['#60a5fa', '#3b82f6', '#4f46e5', '#818cf8', '#93c5fd', '#38bdf8']
                      }
                      backgroundColor={isLight ? '#ffffff' : '#000000'}
                      speed={0.42}
                      streakCount={5}
                      streakWidth={0.9}
                      streakLength={1.1}
                      glow={isLight ? 0.45 : 0.8}
                      density={0.32}
                      twinkle={0.5}
                      zoom={1.5}
                      backgroundGlow={isLight ? 0.1 : 0.25}
                      opacity={isLight ? 0.45 : 0.65}
                      dpr={1.0}
                      mouseInteraction={false}
                    />
                  </div>

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
    </>
  );
};

export const App: React.FC = () => {
  return (
    <ThemeProvider>
      <FontProvider>
        <AppContent />
      </FontProvider>
    </ThemeProvider>
  );
};

export default App;
