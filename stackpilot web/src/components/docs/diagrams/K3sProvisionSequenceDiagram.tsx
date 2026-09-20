import React, { useState } from 'react';
import {
  Server,
  Terminal,
  Shield,
  Layers,
  CheckCircle2,
  Lock,
  ArrowRight,
  Cpu,
  Globe,
  Radio,
  Code2,
  Zap
} from 'lucide-react';

interface ProvisionStep {
  id: number;
  from: string;
  to: string;
  action: string;
  detail: string;
  commandSnippet?: string;
  ports?: string[];
  latency: string;
}

const PARTICIPANTS = [
  { id: 'admin', name: 'Operator', role: 'Dashboard Admin', icon: Terminal, port: 'Browser HTTPS' },
  { id: 'sp', name: 'StackPilot SshService', role: 'Drogon C++ libssh2', icon: Lock, port: 'Port 8090' },
  { id: 'host', name: 'Remote VPS Host', role: 'Target Linux Node', icon: Server, port: 'Port 22 SSH' },
  { id: 'k3s', name: 'k3s Engine', role: 'Kubernetes Control Plane', icon: Layers, port: 'Port 6443' }
];

const STEPS: ProvisionStep[] = [
  {
    id: 1,
    from: 'Operator',
    to: 'StackPilot SshService',
    action: 'Click "Provision Kubernetes"',
    detail: 'Operator initiates cluster creation from web dashboard, providing target SSH host credentials or selecting an existing saved connection.',
    commandSnippet: 'POST /api/v1/clusters/provision\n{\n  "ssh_connection_id": "ssh_98df12",\n  "cluster_name": "production-k3s-eu",\n  "install_mode": "cluster-init"\n}',
    latency: '< 10ms'
  },
  {
    id: 2,
    from: 'StackPilot SshService',
    to: 'Remote VPS Host',
    action: 'Execute k8s_provision_script via SSH',
    detail: 'Establishes secure libssh2 session over port 22, uploads and executes the idempotent POSIX bootstrap script with sudo privileges.',
    commandSnippet: 'ssh -i /app/keys/id_ed25519 root@vps.example.com "bash -s" < scripts/k3s_bootstrap.sh',
    latency: '80ms'
  },
  {
    id: 3,
    from: 'Remote VPS Host',
    to: 'Remote VPS Host',
    action: 'Detect Distro (Ubuntu, RHEL, Fedora, Alpine)',
    detail: 'Parses /etc/os-release to determine package manager (apt-get, yum, dnf, apk) and init system for dependency resolution.',
    commandSnippet: '. /etc/os-release\ncase "$ID" in\n  ubuntu|debian) PKG_MGR="apt-get" ;;\n  rhel|centos|fedora) PKG_MGR="dnf" ;;\n  alpine) PKG_MGR="apk" ;;\nesac',
    latency: '150ms'
  },
  {
    id: 4,
    from: 'Remote VPS Host',
    to: 'Remote VPS Host',
    action: 'Open Firewalls (6443/tcp, 10250/tcp, 8472/udp)',
    detail: 'Applies UFW or firewalld rules for required Kubernetes control plane ports, Kubelet metrics, and Flannel VXLAN overlay.',
    commandSnippet: 'ufw allow 6443/tcp comment "k3s API Server"\nufw allow 10250/tcp comment "Kubelet API"\nufw allow 8472/udp comment "Flannel VXLAN overlay"',
    ports: ['6443/tcp (API)', '10250/tcp (Kubelet)', '8472/udp (Flannel)'],
    latency: '400ms'
  },
  {
    id: 5,
    from: 'Remote VPS Host',
    to: 'Remote VPS Host',
    action: 'Install Distro Dependencies (container-selinux)',
    detail: 'Installs container-selinux policies, iptables legacy compatibility if needed, and checks kernel cgroups v2 configuration.',
    commandSnippet: 'dnf install -y container-selinux || true\nsysctl -w net.bridge.bridge-nf-call-iptables=1',
    latency: '3.2s'
  },
  {
    id: 6,
    from: 'Remote VPS Host',
    to: 'k3s Engine',
    action: 'curl -sfL https://get.k3s.io | sh (cluster-init)',
    detail: 'Downloads and executes official k3s binary installer with embedded SQLite or etcd HA engine and disable-traefik option (StackPilot uses Caddy).',
    commandSnippet: 'curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --cluster-init --disable traefik --disable servicelb" sh -',
    latency: '14.5s'
  },
  {
    id: 7,
    from: 'k3s Engine',
    to: 'Remote VPS Host',
    action: 'Control Plane Ready (etcd & CoreDNS online)',
    detail: 'systemd service k3s starts up, generates cluster certificates, validates node readiness, and exposes /etc/rancher/k3s/k3s.yaml.',
    commandSnippet: 'systemctl is-active --quiet k3s\nk3s kubectl wait --for=condition=Ready node --all --timeout=60s',
    latency: '4.8s'
  },
  {
    id: 8,
    from: 'Remote VPS Host',
    to: 'StackPilot SshService',
    action: 'Encrypted KubeConfig & Node Status',
    detail: 'SshService reads /etc/rancher/k3s/k3s.yaml, replaces 127.0.0.1 with public VPS IP, encrypts it using AES-256-GCM, and stores in PostgreSQL.',
    commandSnippet: 'TokenCrypto::encryptKubeconfig(rawYaml, masterKey);\nINSERT INTO clusters (id, name, encrypted_kubeconfig, state) VALUES (...);',
    latency: '350ms'
  },
  {
    id: 9,
    from: 'StackPilot SshService',
    to: 'Operator',
    action: 'Cluster Registered as "Ready"',
    detail: 'Dashboard updates via WebSocket: cluster state moves from "PROVISIONING" to "READY". Deployments can now be scheduled directly.',
    commandSnippet: 'WebSocket message: {"event":"cluster:ready","cluster_id":"cls_7a81bf"}',
    latency: '< 10ms'
  }
];

export const K3sProvisionSequenceDiagram: React.FC = () => {
  const [selectedStep, setSelectedStep] = useState<ProvisionStep>(STEPS[3]); // default to firewall step

  return (
    <div className="my-8 rounded-2xl border border-zinc-800/90 bg-[#18181b]/90 p-5 sm:p-6 shadow-xl space-y-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-zinc-800 text-white">
              <Layers className="w-4 h-4 text-white" />
            </span>
            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
              Automated k3s Cluster Provisioning Flow
            </h3>
          </div>
          <p className="text-xs text-zinc-400">
            One-click remote SSH provisioning with multi-distro adaptation and AES-256 encrypted kubeconfig.
          </p>
        </div>

        {/* Status badges */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300">
            <Shield className="w-3 h-3 text-white" />
            <span>AES-256 Kubeconfig</span>
          </span>
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300">
            <Radio className="w-3 h-3 text-white" />
            <span>Zero Ingress Bloat</span>
          </span>
        </div>
      </div>

      {/* Required Firewall Holes Badges - Direct Flat Cards without nested border container */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-mono uppercase text-zinc-400 flex items-center gap-1.5 font-semibold">
            <Lock className="w-3.5 h-3.5 text-white" />
            <span>Automated Firewall Holes Provisioned by StackPilot</span>
          </span>
          <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded-full">
            Auto-configured
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <div className="p-3 rounded-xl bg-zinc-900/80 border-0 text-xs space-y-1 hover:bg-zinc-800/80 transition-colors">
            <div className="font-mono font-bold text-white flex items-center justify-between">
              <span>Port 6443/tcp</span>
              <span className="text-[10px] text-zinc-400 font-normal">TCP</span>
            </div>
            <p className="text-[11px] text-zinc-400">Kubernetes API Server communication and kubectl proxy.</p>
          </div>
          <div className="p-3 rounded-xl bg-zinc-900/80 border-0 text-xs space-y-1 hover:bg-zinc-800/80 transition-colors">
            <div className="font-mono font-bold text-white flex items-center justify-between">
              <span>Port 10250/tcp</span>
              <span className="text-[10px] text-zinc-400 font-normal">TCP</span>
            </div>
            <p className="text-[11px] text-zinc-400">Kubelet API for pod metrics, logs, and exec telemetry.</p>
          </div>
          <div className="p-3 rounded-xl bg-zinc-900/80 border-0 text-xs space-y-1 hover:bg-zinc-800/80 transition-colors">
            <div className="font-mono font-bold text-white flex items-center justify-between">
              <span>Port 8472/udp</span>
              <span className="text-[10px] text-zinc-400 font-normal">UDP</span>
            </div>
            <p className="text-[11px] text-zinc-400">Flannel VXLAN encapsulation for cross-node pod routing.</p>
          </div>
        </div>
      </div>

      {/* Participants Lane */}
      <div className="space-y-2">
        <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
          Architecture Participants
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {PARTICIPANTS.map((p) => {
            const Icon = p.icon;
            return (
              <div
                key={p.id}
                className="p-3 rounded-xl bg-zinc-900/80 border-0 flex flex-col gap-1.5 transition-all hover:bg-zinc-800/80"
              >
                <div className="flex items-center justify-between">
                  <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center">
                    <Icon className="w-3.5 h-3.5 text-white" />
                  </div>
                  <span className="text-[10px] font-mono text-zinc-400">
                    {p.port}
                  </span>
                </div>
                <div>
                  <div className="text-xs font-semibold text-white truncate">{p.name}</div>
                  <div className="text-[10px] text-zinc-400 truncate">{p.role}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Sequence Timeline */}
      <div className="space-y-2">
        <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">
          Provisioning Execution Steps (Click step to inspect bash &amp; API calls)
        </div>

        <div className="space-y-2">
          {STEPS.map((step) => {
            const isSelected = selectedStep.id === step.id;
            return (
              <div
                key={step.id}
                onClick={() => setSelectedStep(step)}
                className={`p-3.5 rounded-xl border-0 transition-all cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                  isSelected
                    ? 'bg-zinc-800 text-white shadow-md'
                    : 'bg-zinc-900/60 hover:bg-zinc-800/50'
                }`}
              >
                <div className="flex items-start sm:items-center gap-3">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-mono font-bold shrink-0 ${
                      isSelected ? 'bg-white text-black' : 'bg-zinc-800 text-white'
                    }`}
                  >
                    {step.id}
                  </div>

                  <div className="space-y-0.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-white font-mono">
                        {step.action}
                      </span>
                      {step.ports && (
                        <div className="flex items-center gap-1">
                          {step.ports.map((pt, i) => (
                            <span key={i} className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border-0">
                              {pt}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                      <span className="text-zinc-300 font-medium">{step.from}</span>
                      <ArrowRight className="w-3 h-3 text-white shrink-0 inline" />
                      <span className="text-zinc-300 font-medium">{step.to}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono text-zinc-400 bg-zinc-800/80 px-2 py-0.5 rounded border-0">
                    <Zap className="w-2.5 h-2.5 text-white" />
                    {step.latency}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected Step Drawer */}
      <div className="p-4 sm:p-5 rounded-xl bg-black/60 border-0 space-y-3">
        <div className="flex items-start justify-between gap-4 pb-2">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded bg-zinc-800 text-white">
              <Code2 className="w-4 h-4 text-white" />
            </span>
            <div>
              <h4 className="text-sm font-semibold text-white">
                Step {selectedStep.id}: {selectedStep.action}
              </h4>
              <p className="text-[11px] font-mono text-zinc-400">
                {selectedStep.from} &rarr; {selectedStep.to}
              </p>
            </div>
          </div>
          <span className="text-[11px] font-mono text-zinc-400 bg-zinc-900 px-2 py-1 rounded border-0">
            Duration: <span className="text-white font-bold">{selectedStep.latency}</span>
          </span>
        </div>

        <p className="text-xs text-zinc-300 leading-relaxed">
          {selectedStep.detail}
        </p>

        {selectedStep.commandSnippet && (
          <div className="pt-1">
            <div className="text-[10px] font-mono uppercase text-zinc-500 mb-1.5">
              Script Execution / Command Payload
            </div>
            <pre className="font-mono text-xs text-zinc-200 leading-relaxed selection:bg-zinc-800 p-3 rounded-lg bg-zinc-950/80 border-0 overflow-x-auto">
              <code>{selectedStep.commandSnippet}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};

export default K3sProvisionSequenceDiagram;
