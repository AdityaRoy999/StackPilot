import overview from '../../../README.md?raw';
import quickstart from '../../../docs/quickstart.md?raw';
import configuration from '../../../docs/configuration.md?raw';
import architecture from '../../../docs/architecture.md?raw';
import deployment from '../../../docs/deployment-workflows.md?raw';
import ai from '../../../docs/ai-agent.md?raw';
import streaming from '../../../docs/browser-streaming-validation.md?raw';
import synchronization from '../../../docs/browser-page-synchronization.md?raw';
import docker from '../../../docs/docker.md?raw';
import kubernetes from '../../../docs/production-cluster-management.md?raw';
import mcp from '../../../docs/mcp-ide-agents.md?raw';
import github from '../../../docs/github-app.md?raw';
import monitoring from '../../../observability/README.md?raw';
import troubleshooting from '../../../docs/troubleshooting.md?raw';

export interface DocSection { id: string; title: string; summary: string; category: string; content: string }
const section = (id: string, title: string, content: string, source: string): DocSection => ({
  id, title, summary: title, category: 'STACKPILOT DOCUMENTATION',
  content: content.replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, link: string) => {
    const url = new URL(link, `https://github.com/AdityaRoy999/StackPilot/blob/main/${source}`);
    return `](${url.href})`;
  }),
});
export const DOCS_CONTENT: Record<string, DocSection> = {
  overview: section('overview', 'Platform overview', overview, 'README.md'),
  quickstart: section('quickstart', 'Quickstart', quickstart, 'docs/quickstart.md'),
  install: section('install', 'Installation and configuration', configuration, 'docs/configuration.md'),
  architecture: section('architecture', 'Architecture', architecture, 'docs/architecture.md'),
  templates: section('templates', 'Applications and deployment workflows', deployment, 'docs/deployment-workflows.md'),
  'ai-agent': section('ai-agent', 'AI agent', ai, 'docs/ai-agent.md'),
  screencast: section('screencast', 'Live browser streaming', streaming, 'docs/browser-streaming-validation.md'),
  sandboxing: section('sandboxing', 'Browser sessions and synchronization', synchronization, 'docs/browser-page-synchronization.md'),
  replay: section('replay', 'Browser verification and streaming', streaming, 'docs/browser-streaming-validation.md'),
  docker: section('docker', 'Docker', docker, 'docs/docker.md'),
  kubernetes: section('kubernetes', 'Kubernetes', kubernetes, 'docs/production-cluster-management.md'),
  mcp: section('mcp', 'MCP integration', mcp, 'docs/mcp-ide-agents.md'),
  cicd: section('cicd', 'GitHub integration', github, 'docs/github-app.md'),
  env: section('env', 'Configuration', configuration, 'docs/configuration.md'),
  observability: section('observability', 'Observability', monitoring, 'observability/README.md'),
  troubleshooting: section('troubleshooting', 'Troubleshooting', troubleshooting, 'docs/troubleshooting.md'),
};
