import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { Footer } from './components/Footer';
import { SmoothScroll } from './components/SmoothScroll';
import { WebThreads } from './components/reactbits/WebThreads';
import { ScriptProvider } from './context/ScriptContext';
import { DocsPage } from './pages/DocsPage';

const checkIsDocs = () => {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.toLowerCase();
  const hash = window.location.hash.toLowerCase();
  return path.includes('docs') || hash.includes('docs');
};

export const App: React.FC = () => {
  const [route, setRoute] = useState<'home' | 'docs'>(() => (checkIsDocs() ? 'docs' : 'home'));

  useEffect(() => {
    const handleLocationChange = () => {
      setRoute(checkIsDocs() ? 'docs' : 'home');
    };

    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('hashchange', handleLocationChange);
    return () => {
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('hashchange', handleLocationChange);
    };
  }, []);

  const navigateTo = (target: 'home' | 'docs') => {
    const targetPath = target === 'docs' ? '/docs' : '/';
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }
    setRoute(target);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (route === 'docs') {
    return <DocsPage onNavigateHome={() => navigateTo('home')} />;
  }

  return (
    <ScriptProvider>
      <SmoothScroll>
        <div className="min-h-screen bg-black text-zinc-100 flex flex-col selection:bg-zinc-800 selection:text-zinc-100 antialiased font-sans relative overflow-x-hidden">
          {/* Full-screen Global WebThreads Background - Very low brightness, subtle ambient dark texture */}
          <div className="fixed inset-0 w-full h-full pointer-events-none z-0 overflow-hidden select-none opacity-20">
            <WebThreads
              color1="#000000"
              color2="#18181b"
              color3="#3f3f46"
              speed={0.12}
              threadCount={5}
              frequency={3.8}
              spread={0.2}
              taper={1.0}
              position={0.5}
              fanMode="center"
              glow={0.005}
              falloff={0.75}
              thickness={0.85}
              brightness={0.2}
              opacity={0.3}
              mirror={true}
              shimmer={false}
              grain={true}
              grainIntensity={0.02}
              mouseInteraction={true}
              mouseStrength={0.18}
            />
          </div>

          <Navbar onNavigateDocs={() => navigateTo('docs')} onNavigateHome={() => navigateTo('home')} />

          <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 flex flex-col justify-center relative z-10">
            <Hero />
          </main>

          <Footer onNavigateDocs={() => navigateTo('docs')} />
        </div>
      </SmoothScroll>
    </ScriptProvider>
  );
};

export default App;
