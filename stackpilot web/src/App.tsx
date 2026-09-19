import React from 'react';
import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { TechMarquee } from './components/TechMarquee';
import { ScriptCopyHub } from './components/ScriptCopyHub';
import { LiveCockpitShowcase } from './components/LiveCockpitShowcase';
import { BentoFeatures } from './components/BentoFeatures';
import { ArchitectureDiagram } from './components/ArchitectureDiagram';
import { ComparisonTable } from './components/ComparisonTable';
import { FAQ } from './components/FAQ';
import { Footer } from './components/Footer';
import { Dock } from './components/reactbits/Dock';
import { 
  Terminal, 
  Video, 
  Sparkles, 
  Layers, 
  HelpCircle, 
  Play 
} from 'lucide-react';

export const App: React.FC = () => {
  const dockItems = [
    {
      id: 'script',
      label: 'Script Hub',
      icon: <Terminal className="w-5 h-5" />,
      href: '#install-scripts',
      onClick: () => {
        document.getElementById('install-scripts')?.scrollIntoView({ behavior: 'smooth' });
      },
    },
    {
      id: 'demo',
      label: '60 FPS Live Demo',
      icon: <Video className="w-5 h-5" />,
      href: '#live-cockpit',
      onClick: () => {
        document.getElementById('live-cockpit')?.scrollIntoView({ behavior: 'smooth' });
      },
    },
    {
      id: 'features',
      label: 'Features',
      icon: <Sparkles className="w-5 h-5" />,
      href: '#features',
      onClick: () => {
        document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' });
      },
    },
    {
      id: 'arch',
      label: 'Architecture',
      icon: <Layers className="w-5 h-5" />,
      href: '#architecture',
      onClick: () => {
        document.getElementById('architecture')?.scrollIntoView({ behavior: 'smooth' });
      },
    },
    {
      id: 'faq',
      label: 'FAQ',
      icon: <HelpCircle className="w-5 h-5" />,
      href: '#faq',
      onClick: () => {
        document.getElementById('faq')?.scrollIntoView({ behavior: 'smooth' });
      },
    },
    {
      id: 'cockpit',
      label: 'Launch Cockpit',
      icon: <Play className="w-5 h-5 text-cyan-400 fill-current" />,
      href: 'http://localhost:3000',
      onClick: () => {
        window.open('http://localhost:3000', '_blank');
      },
    },
  ];

  return (
    <div className="min-h-screen bg-[#fafafa] dark:bg-[#06080d] text-slate-900 dark:text-slate-100 transition-colors duration-300 relative overflow-x-hidden selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* Top Navbar */}
      <Navbar />

      {/* Main Content Sections */}
      <main>
        <Hero />
        <TechMarquee />
        <ScriptCopyHub />
        <LiveCockpitShowcase />
        <BentoFeatures />
        <ArchitectureDiagram />
        <ComparisonTable />
        <FAQ />
      </main>

      {/* Footer */}
      <Footer />

      {/* Floating ReactBits Dock at bottom */}
      <div className="hidden sm:block">
        <Dock items={dockItems} />
      </div>
    </div>
  );
};
export default App;
