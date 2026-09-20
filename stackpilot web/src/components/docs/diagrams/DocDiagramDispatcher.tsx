import React from 'react';
import { JobQueueSequenceDiagram } from './JobQueueSequenceDiagram';
import { AiSwarmFlowDiagram } from './AiSwarmFlowDiagram';
import { ReplayBufferFlowDiagram } from './ReplayBufferFlowDiagram';
import { K3sProvisionSequenceDiagram } from './K3sProvisionSequenceDiagram';
import { GithubCiSequenceDiagram } from './GithubCiSequenceDiagram';
import { ObservabilityFlowDiagram } from './ObservabilityFlowDiagram';
import { OverviewArchitectureDiagram } from './OverviewArchitectureDiagram';
import { ScreencastPipelineDiagram } from './ScreencastPipelineDiagram';
import { Terminal, Activity } from 'lucide-react';

export interface DocDiagramDispatcherProps {
  docId?: string;
  diagramName?: string;
  code?: string;
}

export const DocDiagramDispatcher: React.FC<DocDiagramDispatcherProps> = ({
  docId,
  diagramName,
  code = ''
}) => {
  // 1. Direct name match if specified
  const name = diagramName?.toLowerCase() || '';
  if (name.includes('job') || name.includes('queue') || name.includes('architecture')) {
    return <JobQueueSequenceDiagram />;
  }
  if (name.includes('ai') || name.includes('swarm') || name.includes('agent')) {
    return <AiSwarmFlowDiagram />;
  }
  if (name.includes('replay') || name.includes('buffer')) {
    return <ReplayBufferFlowDiagram />;
  }
  if (name.includes('k3s') || name.includes('kubernetes')) {
    return <K3sProvisionSequenceDiagram />;
  }
  if (name.includes('cicd') || name.includes('github') || name.includes('webhook')) {
    return <GithubCiSequenceDiagram />;
  }
  if (name.includes('observability') || name.includes('telemetry') || name.includes('metrics')) {
    return <ObservabilityFlowDiagram />;
  }
  if (name.includes('overview') || name.includes('system')) {
    return <OverviewArchitectureDiagram />;
  }
  if (name.includes('screencast') || name.includes('video')) {
    return <ScreencastPipelineDiagram />;
  }

  // 2. Code-based heuristic detection
  if (code.includes('JobQueueWorker') || code.includes('BRPOP') || code.includes('deployment_job') || code.includes('BuildResult')) {
    return <JobQueueSequenceDiagram />;
  }
  if (code.includes('SupervisorAgent') || code.includes('ArchitectAgent') || code.includes('CoderAgent') || code.includes('VerifierAgent')) {
    return <AiSwarmFlowDiagram />;
  }
  if (code.includes('recordedFramesRef') || code.includes('700') || code.includes('Buffer Length') || code.includes('Evict Oldest')) {
    return <ReplayBufferFlowDiagram />;
  }
  if (code.includes('k3s') || code.includes('k8s_provision') || code.includes('6443/tcp') || code.includes('KubeConfig')) {
    return <K3sProvisionSequenceDiagram />;
  }
  if (code.includes('HMAC-SHA256') || code.includes('check_run') || code.includes('blocked_ci') || code.includes('X-Hub-Signature')) {
    return <GithubCiSequenceDiagram />;
  }
  if (code.includes('cAdvisor') || code.includes('Promtail') || code.includes('Prometheus') || code.includes('Grafana Loki')) {
    return <ObservabilityFlowDiagram />;
  }
  if (code.includes('x11grab') || code.includes('WebCodecs') || code.includes('streamer.py')) {
    return <ScreencastPipelineDiagram />;
  }
  if (code.includes('Clients & Ingress') || code.includes('ControlPlane') || code.includes('AIService') || code.includes('Drogon Backend Engine')) {
    return <OverviewArchitectureDiagram />;
  }

  // 3. Fallback to docId matching
  switch (docId) {
    case 'overview':
      return <OverviewArchitectureDiagram />;
    case 'architecture':
      return <JobQueueSequenceDiagram />;
    case 'ai-agent':
      return <AiSwarmFlowDiagram />;
    case 'screencast':
      return <ScreencastPipelineDiagram />;
    case 'replay':
      return <ReplayBufferFlowDiagram />;
    case 'kubernetes':
      return <K3sProvisionSequenceDiagram />;
    case 'cicd':
      return <GithubCiSequenceDiagram />;
    case 'observability':
      return <ObservabilityFlowDiagram />;
    default:
      // Fallback clean bento placeholder if unspecified
      return (
        <div className="my-8 rounded-2xl border border-zinc-800/90 bg-[#18181b]/90 p-5 sm:p-6 shadow-xl space-y-4">
          <div className="flex items-center gap-2 pb-2">
            <span className="p-1.5 rounded-lg bg-zinc-800 text-white">
              <Terminal className="w-4 h-4 text-white" />
            </span>
            <div>
              <h3 className="text-base font-bold text-white tracking-tight">System Architecture Diagram</h3>
              <p className="text-xs text-zinc-400">Interactive visual workflow for {docId || 'StackPilot'}</p>
            </div>
          </div>
          <div className="p-4 rounded-xl bg-zinc-950/80 border-0 flex items-center justify-center text-xs font-mono text-zinc-400">
            <Activity className="w-4 h-4 text-white mr-2" />
            <span>Interactive diagram rendering active</span>
          </div>
        </div>
      );
  }
};

export default DocDiagramDispatcher;
export {
  JobQueueSequenceDiagram,
  AiSwarmFlowDiagram,
  ReplayBufferFlowDiagram,
  K3sProvisionSequenceDiagram,
  GithubCiSequenceDiagram,
  ObservabilityFlowDiagram,
  OverviewArchitectureDiagram,
  ScreencastPipelineDiagram
};
