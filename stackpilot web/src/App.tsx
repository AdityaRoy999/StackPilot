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
      <AnimatePresence mode="wait">
        <motion.div
          key={route}
          initial={{ opacity: 0, filter: 'blur(16px)', y: 4 }}
          animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
          exit={{ opacity: 0, filter: 'blur(16px)', y: -4 }}
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
            <div className="min-h-screen bg-black text-zinc-100 flex flex-col selection:bg-zinc-800 selection:text-zinc-100 antialiased font-sans relative overflow-x-clip">
              {/* Rich Vibrant Bluish & Indigo Atmospheric Ambient Gradients — Hardware accelerated compositor layers */}
              <div
                className="fixed -bottom-24 -left-28 w-[720px] h-[720px] bg-gradient-to-tr from-blue-600/35 via-indigo-600/22 to-transparent blur-[130px] pointer-events-none z-0 rounded-full select-none will-change-transform transform-gpu"
                style={{ transform: 'translate3d(0, 0, 0)' }}
                aria-hidden="true"
              />
              <div
                className="fixed top-1/4 -right-28 w-[560px] h-[560px] bg-gradient-to-bl from-indigo-600/20 via-sky-600/15 to-transparent blur-[140px] pointer-events-none z-0 rounded-full select-none will-change-transform transform-gpu"
                style={{ transform: 'translate3d(0, 0, 0)' }}
                aria-hidden="true"
              />

              {/* Full-screen Global React Bits Lightfall Background */}
              <div className="fixed inset-0 w-full h-full pointer-events-none z-0 overflow-hidden select-none">
                <Lightfall
                  colors={['#A6C8FF', '#5227FF', '#FF9FFC']}
                  backgroundColor="#000000"
                  speed={0.8}
                  streakCount={8}
                  streakWidth={1.2}
                  streakLength={1.2}
                  glow={1}
                  density={1}
                  twinkle={0.8}
                  zoom={1.8}
                  backgroundGlow={0.4}
                  opacity={0.7}
                  mouseInteraction={true}
                  mouseStrength={0.8}
                  mouseRadius={0.5}
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
    </FontProvider>
  );
};

export default App;
