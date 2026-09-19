import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

type Tab = 'bash' | 'powershell' | 'docker' | 'core' | 'cli';

interface ScriptOption {
  id: Tab;
  label: string;
  command: string;
}

const SCRIPTS: ScriptOption[] = [
  {
    id: 'bash',
    label: 'curl (Linux / macOS)',
    command: 'curl -fsSL https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.sh | bash',
  },
  {
    id: 'powershell',
    label: 'PowerShell (Windows)',
    command: 'irm https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.ps1 | iex',
  },
  {
    id: 'docker',
    label: 'Docker Compose',
    command: 'git clone https://github.com/AdityaRoy999/StackPilot.git && cd StackPilot && docker compose up -d',
  },
  {
    id: 'core',
    label: 'Core QA (1.5GB RAM)',
    command: 'curl -fsSL https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.sh | bash -s -- --profile core',
  },
  {
    id: 'cli',
    label: 'StackPilot CLI',
    command: 'git clone https://github.com/AdityaRoy999/StackPilot.git && cd StackPilot/stackpilot-cli && pip install -e . && stackpilot doctor',
  },
];

export const ScriptBox: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('bash');
  const [copied, setCopied] = useState(false);

  const activeScript = SCRIPTS.find((s) => s.id === activeTab) || SCRIPTS[0];

  const handleCopy = () => {
    navigator.clipboard.writeText(activeScript.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full max-w-3xl mx-auto mt-10">
      {/* Separate, Big, Rounded Tab Buttons */}
      <div className="flex flex-wrap items-center justify-center gap-2.5 mb-5">
        {SCRIPTS.map((script) => (
          <button
            key={script.id}
            onClick={() => setActiveTab(script.id)}
            className={`px-4 py-2 rounded-full text-xs sm:text-sm font-mono transition-all duration-200 ${
              activeTab === script.id
                ? 'bg-zinc-100 text-zinc-950 font-semibold shadow-md shadow-white/10 scale-105'
                : 'border border-zinc-800 bg-zinc-900/70 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 hover:bg-zinc-800/80'
            }`}
          >
            {script.label}
          </button>
        ))}
      </div>

      {/* Terminal Code Snippet - Pure & Minimal without any extra sentences */}
      <div className="relative rounded-2xl border border-zinc-800/90 bg-zinc-950/90 p-5 font-mono text-xs sm:text-sm text-left shadow-2xl backdrop-blur-xl">
        {/* Window Dots & Copy Button */}
        <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b border-zinc-900">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-zinc-800 inline-block" />
            <span className="w-3 h-3 rounded-full bg-zinc-800 inline-block" />
            <span className="w-3 h-3 rounded-full bg-zinc-800 inline-block" />
          </div>

          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 text-xs font-mono transition-all active:scale-95 shadow-sm"
            title="Copy command to clipboard"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400 font-semibold">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5 text-zinc-400" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>

        {/* Code Content */}
        <div className="overflow-x-auto whitespace-pre select-all text-zinc-100 py-1 font-mono tracking-tight leading-relaxed scrollbar-thin">
          <span className="text-zinc-500 select-none mr-2">$</span>
          {activeScript.command}
        </div>
      </div>

      {/* Metadata */}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-4 text-xs text-zinc-500 font-mono">
        <span>✓ 100% Self-Hosted</span>
        <span>•</span>
        <span>✓ No Cloud Telemetry</span>
        <span>•</span>
        <span>✓ Apache 2.0 License</span>
      </div>
    </div>
  );
};
