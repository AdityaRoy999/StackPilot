export type ScriptTab = 'bash' | 'powershell' | 'docker' | 'core' | 'cli';

export interface ScriptOption {
  id: ScriptTab;
  label: string;
  command: string;
}

// Hosted directly on Vercel / domain instead of raw GitHub
const BASE_HOST = 'https://stackpilot.vercel.app';

export const SCRIPTS: ScriptOption[] = [
  {
    id: 'bash',
    label: 'Linux / macOS',
    command: `curl -fsSL ${BASE_HOST}/install.sh | bash`,
  },
  {
    id: 'powershell',
    label: 'Windows',
    command: `irm ${BASE_HOST}/install.ps1 | iex`,
  },
  {
    id: 'docker',
    label: 'Docker Compose',
    command: 'git clone https://github.com/AdityaRoy999/StackPilot.git && cd StackPilot && docker compose up -d',
  },
  {
    id: 'core',
    label: 'Core QA (1.5GB RAM)',
    command: `curl -fsSL ${BASE_HOST}/install.sh | bash -s -- --profile core`,
  },
  {
    id: 'cli',
    label: 'StackPilot CLI',
    command: 'git clone https://github.com/AdityaRoy999/StackPilot.git && cd StackPilot/stackpilot-cli && pip install -e . && stackpilot doctor',
  },
];
