import React, { useState } from 'react';
import { Copy, Check, Terminal } from 'lucide-react';
import { InfoIcon } from './icons/InfoIcon';

type Tab = 'bash' | 'powershell' | 'docker' | 'core' | 'cli';

interface ScriptOption {
  id: Tab;
  label: string;
  command: string;
  description: string;
}

const SCRIPTS: ScriptOption[] = [
  {
    id: 'bash',
    label: 'curl (Linux / macOS)',
    command: 'curl -fsSL https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.sh | bash',
    description: 'Automated installer: audits hardware, installs Docker if needed, and launches all StackPilot services.',
  },
  {
    id: 'powershell',
    label: 'PowerShell (Windows)',
    command: 'irm https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.ps1 | iex',
    description: 'Automated Windows one-liner: verifies Docker Desktop / WSL2, clones repository, and launches containers.',
  },
  {
    id: 'docker',
    label: 'Docker Compose',
    command: 'git clone https://github.com/AdityaRoy999/StackPilot.git && cd StackPilot && docker compose up -d',
    description: 'Full stack deployment: runs Frontend (Port 3000), Drogon C++ Engine, AI Service, and Sandbox.',
  },
  {
    id: 'core',
    label: 'Core QA (1.5GB RAM)',
    command: 'curl -fsSL https://raw.githubusercontent.com/AdityaRoy999/StackPilot/main/scripts/install.sh | bash -s -- --profile core',
    description: 'Lightweight profile for low-spec VPS: runs AI Testing Engine + Chromium Sandbox + Cockpit UI (~1.5GB RAM).',
  },
  {
    id: 'cli',
    label: 'StackPilot CLI',
    command: 'git clone https://github.com/AdityaRoy999/StackPilot.git && cd StackPilot/stackpilot-cli && pip install -e . && stackpilot doctor',
    description: 'Installs terminal command-line tool (`stackpilot`) for headless test runs and system diagnostics.',
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
    <div className="w-full max-w-2xl mx-auto mt-8">
      {/* Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex flex-wrap items-center p-1 rounded-lg border border-zinc-800/80 bg-zinc-900/60 text-xs font-mono">
          {SCRIPTS.map((script) => (
            <button
              key={script.id}
              onClick={() => setActiveTab(script.id)}
              className={`px-3 py-1 rounded-md transition-all ${
                activeTab === script.id
                  ? 'bg-zinc-800 text-zinc-100 font-medium shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {script.label}
            </button>
          ))}
        </div>

        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 text-xs font-mono transition-colors"
          title="Copy command to clipboard"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5 text-zinc-400" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Terminal Code Snippet */}
      <div className="relative rounded-xl border border-zinc-800/90 bg-zinc-950 p-4 sm:p-5 font-mono text-xs sm:text-sm text-left shadow-2xl">
        <div className="flex items-center justify-between gap-2 mb-3 pb-2.5 border-b border-zinc-900 text-zinc-500 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-800 inline-block" />
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-800 inline-block" />
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-800 inline-block" />
            <span className="ml-2 text-zinc-500 flex items-center gap-1">
              <Terminal className="w-3 h-3 text-zinc-600" />
              terminal
            </span>
          </div>
          <span className="text-[10px] text-zinc-500 font-sans hidden sm:inline">
            Click copy or select all
          </span>
        </div>

        <div className="overflow-x-auto whitespace-pre select-all text-zinc-200 py-1 scrollbar-thin">
          <span className="text-zinc-500 select-none mr-2">$</span>
          {activeScript.command}
        </div>

        {/* Command explanation */}
        <div className="mt-3 pt-2.5 border-t border-zinc-900/80 flex items-start gap-1.5 text-[11px] text-zinc-400 font-sans">
          <InfoIcon className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-0.5" />
          <span>{activeScript.description}</span>
        </div>
      </div>

      {/* Metadata */}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-4 text-[11px] text-zinc-500 font-mono">
        <span>✓ 100% Self-Hosted</span>
        <span>•</span>
        <span>✓ No Cloud Telemetry</span>
        <span>•</span>
        <span>✓ Apache 2.0 License</span>
      </div>
    </div>
  );
};
