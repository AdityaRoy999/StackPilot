import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { Footer } from './components/Footer';
import { ScriptProvider } from './context/ScriptContext';
import { FontProvider } from './context/FontContext';
import { DeferredSection } from './components/DeferredSection';

const DocsPage = lazy(() => import('./pages/DocsPage').then(module => ({ default: module.DocsPage })));
const ContactPage = lazy(() => import('./pages/ContactPage').then(module => ({ default: module.ContactPage })));
const BentoFeatures = lazy(() => import('./components/BentoFeatures').then(module => ({ default: module.BentoFeatures })));
const OpenSourceBento = lazy(() => import('./components/OpenSourceBento').then(module => ({ default: module.OpenSourceBento })));
const InstallSetup = lazy(() => import('./components/InstallSetup'));
type RouteState = 'home' | 'docs' | 'contact';

const readRoute = (): RouteState => {
  const path = window.location.pathname.toLowerCase();
  return path === '/docs' ? 'docs' : path === '/contact' ? 'contact' : 'home';
};

export const App: React.FC = () => {
  const [route, setRoute] = useState<RouteState>(readRoute);
  useEffect(() => {
    const onLocation = () => { setRoute(readRoute()); window.scrollTo(0, 0); };
    window.addEventListener('popstate', onLocation);
    return () => window.removeEventListener('popstate', onLocation);
  }, []);
  const navigate = (target: RouteState) => {
    const path = target === 'home' ? '/' : `/${target}`;
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setRoute(target);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  return (
    <FontProvider><ScriptProvider>
      <Suspense fallback={<div role="status" className="min-h-screen p-8 text-zinc-400">Loading page…</div>}>
        {route === 'docs' ? <DocsPage onNavigateHome={() => navigate('home')} onNavigateContact={() => navigate('contact')} />
          : route === 'contact' ? <ContactPage onNavigateHome={() => navigate('home')} onNavigateDocs={() => navigate('docs')} />
          : <div className="min-h-screen text-zinc-100 relative">
            <div aria-hidden="true" className="fixed inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at 10% 80%, #17255455, transparent 65%), radial-gradient(ellipse at 90% 20%, #312e8140, transparent 60%)' }} />
            <Navbar onNavigateDocs={() => navigate('docs')} onNavigateHome={() => navigate('home')} onNavigateContact={() => navigate('contact')} />
            <main className="max-w-[1380px] w-full mx-auto px-4 sm:px-6 lg:px-8 relative">
              <Hero />
              <DeferredSection minHeight={320}><InstallSetup /></DeferredSection>
              <DeferredSection minHeight={600}><BentoFeatures /></DeferredSection>
            </main>
            <DeferredSection minHeight={660}><OpenSourceBento /></DeferredSection>
            <Footer onNavigateDocs={() => navigate('docs')} onNavigateContact={() => navigate('contact')} />
          </div>}
      </Suspense>
    </ScriptProvider></FontProvider>
  );
};
export default App;
