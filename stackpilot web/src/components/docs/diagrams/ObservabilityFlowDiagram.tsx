import React, { useState } from 'react';
import {
  Activity,
  Server,
  Layers,
  Code,
  Search,
  Database,
  ArrowRight,
  Code2,
  Radio,
  Cpu,
  BarChart3
} from 'lucide-react';

interface TelemetryNode {
  id: string;
  name: string;
  category: 'targets' | 'scrapers' | 'storage';
  port: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  configOrMetrics: string[];
  protocol: string;
}

const NODES: TelemetryNode[] = [
  // Targets
  {
    id: 'backend',
    name: 'StackPilot Backend',
    category: 'targets',
    port: ':8090/metrics',
    icon: Server,
    description: 'C++ Drogon core exposes native Prometheus metrics on active WebSocket connections, thread pool saturation, and DB latency.',
    configOrMetrics: ['stackpilot_http_requests_total', 'stackpilot_ws_active_connections', 'stackpilot_db_pool_wait_seconds'],
    protocol: 'HTTP Scrape'
  },
  {
    id: 'containers',
    name: 'Application Containers',
    category: 'targets',
    port: 'cgroup v2',
    icon: Cpu,
    description: 'Docker containers running user applications. Resource stats are read directly from Linux kernel cgroups v2 without agent overhead.',
    configOrMetrics: ['/sys/fs/cgroup/cpu.stat', '/sys/fs/cgroup/memory.current', 'memory.high throttle counters'],
    protocol: 'Kernel cgroups'
  },
  {
    id: 'logs',
    name: 'Docker Container Logs',
    category: 'targets',
    port: '/var/log/pods',
    icon: Code,
    description: 'Standard container stdout and stderr emitted in JSON format and rotated by Docker daemon with strict 100MB file limits.',
    configOrMetrics: ['/var/lib/docker/containers/*/*.log', 'Log-driver: json-file', 'Max-size: 50m, Max-file: 3'],
    protocol: 'FIFO Tail'
  },

  // Scrapers
  {
    id: 'prometheus',
    name: 'Prometheus TSDB',
    category: 'scrapers',
    port: ':9090',
    icon: Activity,
    description: 'High-performance time-series database scraping metrics at 15-second intervals with 15-day local retention.',
    configOrMetrics: ['scrape_interval: 15s', 'evaluation_interval: 15s', 'tsdb retention: 15d'],
    protocol: 'PromQL'
  },
  {
    id: 'cadvisor',
    name: 'cAdvisor Engine',
    category: 'scrapers',
    port: ':8081',
    icon: Layers,
    description: 'Google cAdvisor daemon running as rootless container, measuring real-time CPU percentages, RSS memory, and network I/O per container.',
    configOrMetrics: ['container_cpu_usage_seconds_total', 'container_memory_working_set_bytes', 'container_network_receive_bytes_total'],
    protocol: 'cgroup Exporter'
  },
  {
    id: 'promtail',
    name: 'Promtail Log Scraper',
    category: 'scrapers',
    port: ':9080',
    icon: Radio,
    description: 'Lightweight log forwarder that discovers active Docker containers, attaches project_id labels, and streams to Loki.',
    configOrMetrics: ['clients: [{url: "http://loki:3100/loki/api/v1/push"}]', 'pipeline_stages: [docker: {}]'],
    protocol: 'Push API'
  },

  // Storage
  {
    id: 'loki',
    name: 'Grafana Loki',
    category: 'storage',
    port: ':3100',
    icon: Database,
    description: 'Horizontal, multi-tenant log aggregation system indexing only labels (project_id, deployment_id) for minimal memory footprint.',
    configOrMetrics: ['auth_enabled: false', 'schema_config: v11', 'storage: filesystem'],
    protocol: 'LogQL'
  },
  {
    id: 'grafana',
    name: 'Grafana Dashboards',
    category: 'storage',
    port: ':3001',
    icon: BarChart3,
    description: 'Single pane of glass visualizing unified CPU/memory utilization, container restart rates, and real-time streaming logs.',
    configOrMetrics: ['Provisioned Data Sources: Prometheus, Loki', 'Auto-provisioned Dashboards: System Overview, Host Health'],
    protocol: 'Web UI / API'
  }
];

export const ObservabilityFlowDiagram: React.FC = () => {
  const [selectedNode, setSelectedNode] = useState<TelemetryNode>(NODES[3]); // default to Prometheus

  const targets = NODES.filter((n) => n.category === 'targets');
  const scrapers = NODES.filter((n) => n.category === 'scrapers');
  const storage = NODES.filter((n) => n.category === 'storage');

  return (
    <div className="my-8 rounded-2xl border border-zinc-800/90 bg-[#18181b]/90 p-5 sm:p-6 shadow-xl space-y-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-zinc-800 text-white">
              <Activity className="w-4 h-4 text-white" />
            </span>
            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
              Real-Time Telemetry &amp; Observability Pipeline
            </h3>
          </div>
          <p className="text-xs text-zinc-400">
            End-to-end metrics, cgroup v2 container telemetry, and structured log streaming to Loki and Grafana.
          </p>
        </div>

        {/* Status badges */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300">
            <Activity className="w-3 h-3 text-white" />
            <span>15s Scrape Cadence</span>
          </span>
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300">
            <Radio className="w-3 h-3 text-white" />
            <span>PromQL &amp; LogQL</span>
          </span>
        </div>
      </div>

      {/* 3-Column Pipeline Architecture - Clean flat layout without nested card boxes */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Column 1: Monitored Targets */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between pb-1 px-1">
            <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
              <span>1. Monitored Targets</span>
            </span>
            <span className="text-[10px] font-mono text-zinc-500">Sources</span>
          </div>

          <div className="space-y-2.5">
            {targets.map((node) => {
              const Icon = node.icon;
              const isSelected = selectedNode.id === node.id;
              return (
                <div
                  key={node.id}
                  onClick={() => setSelectedNode(node)}
                  className={`p-3.5 rounded-xl border-0 transition-all cursor-pointer flex flex-col gap-1.5 ${
                    isSelected
                      ? 'bg-zinc-800 text-white shadow-md'
                      : 'bg-zinc-900/70 hover:bg-zinc-800/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded bg-zinc-800 flex items-center justify-center">
                        <Icon className="w-3.5 h-3.5 text-white" />
                      </div>
                      <span className="text-xs font-bold text-white">{node.name}</span>
                    </div>
                    <span className="text-[10px] font-mono text-zinc-400 bg-zinc-800/70 px-1.5 py-0.5 rounded">
                      {node.port}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 pt-1">
                    <span>{node.protocol}</span>
                    <ArrowRight className="w-3 h-3 text-white" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Column 2: Collectors & Agents */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between pb-1 px-1">
            <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
              <span>2. Collectors &amp; Agents</span>
            </span>
            <span className="text-[10px] font-mono text-zinc-500">Scrapers</span>
          </div>

          <div className="space-y-2.5">
            {scrapers.map((node) => {
              const Icon = node.icon;
              const isSelected = selectedNode.id === node.id;
              return (
                <div
                  key={node.id}
                  onClick={() => setSelectedNode(node)}
                  className={`p-3.5 rounded-xl border-0 transition-all cursor-pointer flex flex-col gap-1.5 ${
                    isSelected
                      ? 'bg-zinc-800 text-white shadow-md'
                      : 'bg-zinc-900/70 hover:bg-zinc-800/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded bg-zinc-800 flex items-center justify-center">
                        <Icon className="w-3.5 h-3.5 text-white" />
                      </div>
                      <span className="text-xs font-bold text-white">{node.name}</span>
                    </div>
                    <span className="text-[10px] font-mono text-zinc-400 bg-zinc-800/70 px-1.5 py-0.5 rounded">
                      {node.port}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 pt-1">
                    <span>{node.protocol}</span>
                    <ArrowRight className="w-3 h-3 text-white" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Column 3: Storage & Visualization */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between pb-1 px-1">
            <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span>3. Storage &amp; Visualization</span>
            </span>
            <span className="text-[10px] font-mono text-zinc-500">Query &amp; Dashboards</span>
          </div>

          <div className="space-y-2.5">
            {storage.map((node) => {
              const Icon = node.icon;
              const isSelected = selectedNode.id === node.id;
              return (
                <div
                  key={node.id}
                  onClick={() => setSelectedNode(node)}
                  className={`p-3.5 rounded-xl border-0 transition-all cursor-pointer flex flex-col gap-1.5 ${
                    isSelected
                      ? 'bg-zinc-800 text-white shadow-md'
                      : 'bg-zinc-900/70 hover:bg-zinc-800/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded bg-zinc-800 flex items-center justify-center">
                        <Icon className="w-3.5 h-3.5 text-white" />
                      </div>
                      <span className="text-xs font-bold text-white">{node.name}</span>
                    </div>
                    <span className="text-[10px] font-mono text-zinc-400 bg-zinc-800/70 px-1.5 py-0.5 rounded">
                      {node.port}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 pt-1">
                    <span>{node.protocol}</span>
                    <ArrowRight className="w-3 h-3 text-white" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Selected Node Details Drawer */}
      <div className="p-4 sm:p-5 rounded-xl bg-black/60 border-0 space-y-3">
        <div className="flex items-start justify-between gap-4 pb-2">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded bg-zinc-800 text-white">
              <selectedNode.icon className="w-4 h-4 text-white" />
            </span>
            <div>
              <h4 className="text-sm font-semibold text-white">
                {selectedNode.name}
              </h4>
              <p className="text-[11px] font-mono text-zinc-400">
                Port / Interface: <span className="text-white">{selectedNode.port}</span> &bull; Protocol: <span className="text-white">{selectedNode.protocol}</span>
              </p>
            </div>
          </div>
          <span className="text-[11px] font-mono text-zinc-400 bg-zinc-900 px-2 py-1 rounded border-0">
            Category: <span className="text-white font-bold uppercase">{selectedNode.category}</span>
          </span>
        </div>

        <p className="text-xs text-zinc-300 leading-relaxed">
          {selectedNode.description}
        </p>

        <div className="space-y-1.5 pt-1">
          <div className="text-[10px] font-mono uppercase text-zinc-500">
            Exported Metrics / Configuration Directives
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {selectedNode.configOrMetrics.map((item, idx) => (
              <div
                key={idx}
                className="px-3 py-2 rounded-lg bg-zinc-950/80 border-l-2 border-zinc-700 text-[11px] font-mono text-zinc-300 flex items-start gap-2"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white shrink-0 mt-1.5" />
                <span className="truncate">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ObservabilityFlowDiagram;
