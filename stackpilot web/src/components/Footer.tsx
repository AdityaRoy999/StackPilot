import React from 'react';

export const Footer: React.FC = () => {
  return (
    <footer className="relative w-full py-12 flex flex-col items-center justify-center overflow-hidden z-20 text-xs font-mono">
      <div className="text-zinc-400 font-medium tracking-tight text-sm">
        StackPilot
      </div>

      <div className="mt-2 text-[11px] text-zinc-600 text-center tracking-wide">
        Autonomous AI QA &amp; Delivery Engine — Built for the Agentic Era
      </div>
    </footer>
  );
};

export default Footer;
