import React from 'react';
import { CircularGallery } from './reactbits/CircularGallery';

const OPEN_SOURCE_TOOLS = [
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/docker/docker-original.svg',
    text: 'Docker',
    role: 'Container Sandboxing',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/kubernetes/kubernetes-plain.svg',
    text: 'Kubernetes',
    role: 'Cluster Orchestration',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/fastapi/fastapi-original.svg',
    text: 'FastAPI',
    role: 'Async API Framework',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/python/python-original.svg',
    text: 'Python',
    role: 'Core Engine & Logic',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/playwright/playwright-original.svg',
    text: 'Playwright',
    role: 'Browser Vision QA',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/chrome/chrome-original.svg',
    text: 'Chromium',
    role: 'Headless DOM Engine',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/prometheus/prometheus-original.svg',
    text: 'Prometheus',
    role: 'Real-Time Telemetry',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/grafana/grafana-original.svg',
    text: 'Grafana',
    role: 'Live Dashboards',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/postgresql/postgresql-original.svg',
    text: 'PostgreSQL',
    role: 'Relational Database',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/redis/redis-original.svg',
    text: 'Redis',
    role: 'In-Memory Cache',
  },
  {
    image: 'https://cdn.simpleicons.org/wireguard/white',
    text: 'WireGuard',
    role: 'Mesh Networking',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/react/react-original.svg',
    text: 'React',
    role: 'Reactive UI Cockpit',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/typescript/typescript-original.svg',
    text: 'TypeScript',
    role: 'Strict Type System',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/tailwindcss/tailwindcss-original.svg',
    text: 'Tailwind CSS',
    role: 'Modern Utility Styling',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/linux/linux-original.svg',
    text: 'Linux',
    role: 'Kernel & eBPF Probes',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/terraform/terraform-original.svg',
    text: 'Terraform',
    role: 'Infrastructure-as-Code',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/nginx/nginx-original.svg',
    text: 'NGINX',
    role: 'Reverse Proxy & Ingress',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/go/go-original.svg',
    text: 'Golang',
    role: 'Subagent Workers',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/pytorch/pytorch-original.svg',
    text: 'PyTorch',
    role: 'Vision AI & ML Models',
  },
  {
    image: 'https://cdn.jsdelivr.net/gh/devicons/devicon/icons/git/git-original.svg',
    text: 'Git',
    role: 'Version Control & GitOps',
  },
];

export const OpenSourceBento: React.FC = () => {
  return (
    <section id="open-source" className="relative w-full pt-16 pb-24 select-none">
      {/* Clean Headline — no chip, no paragraphs */}
      <div className="text-center max-w-4xl mx-auto mb-10 sm:mb-12 px-4">
        <h2 className="font-headline text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight text-white leading-tight">
          Built with Open Source.{' '}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-indigo-300 to-sky-400">
            For Open Source.
          </span>
        </h2>
      </div>

      {/* 3D WebGL Circular Gallery directly on the ambient background across 100% full width */}
      <div className="w-full h-[600px] sm:h-[660px] relative overflow-hidden">
        <CircularGallery
          items={OPEN_SOURCE_TOOLS}
          bend={3}
          textColor="#ffffff"
          borderRadius={0.06}
          scrollSpeed={2.2}
          scrollEase={0.04}
        />
      </div>

      {/* Curved Interactive Navigation Hint matching 3D cylinder arc */}
      <div className="mt-2 flex items-center justify-center pointer-events-none select-none px-4">
        <svg
          viewBox="0 0 540 64"
          className="w-full max-w-[480px] h-12 overflow-visible"
          aria-label="Drag or scroll to rotate tools"
        >
          <defs>
            <path
              id="tools-curve-path"
              d="M 30,52 Q 270,14 510,52"
              fill="none"
            />
          </defs>
          <text
            className="fill-zinc-400/90 text-[12px] sm:text-[13px] tracking-[0.2em] uppercase keep-mono select-none"
            style={{
              fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              letterSpacing: '0.2em',
              fontWeight: 500,
            }}
          >
            <textPath href="#tools-curve-path" startOffset="50%" textAnchor="middle">
              ← Drag or scroll to rotate tools →
            </textPath>
          </text>
        </svg>
      </div>
    </section>
  );
};

export default OpenSourceBento;
