export type ScriptTab = 'bash' | 'powershell' | 'docker' | 'core' | 'cli';

export interface ScriptOption {
  id: ScriptTab;
  label: string;
  command: string;
}

export const SCRIPTS: ScriptOption[] = [
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
