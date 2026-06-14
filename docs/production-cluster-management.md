# Production Cluster Management

StackPilot can see Docker and Kubernetes resources that already exist on the backend host through the Host Infrastructure Monitor. Discovery is read-only by default. Existing containers, images, pods, deployments, services, and nodes should not become controllable until a user explicitly claims them.

## Current Capability

- Inventory Docker containers and images visible to the StackPilot backend container.
- Inventory Kubernetes nodes, pods, deployments, and services from the backend's active `kubectl` context.
- Inventory Kubernetes namespaces and events, plus richer node capacity, pod restart/readiness, service port, and deployment generation details.
- Open read-only Kubernetes details for namespaces, nodes, pods, deployments, and services, including a summary, directly related events, and live `kubectl get ... -o yaml` output.
- Mark resources as `StackPilot`, `External`, `Observed`, or `Claimed`.
- Claim and release observed Docker/Kubernetes resources through the infrastructure registry.
- Control claimed Kubernetes resources without importing them into projects: deployment rollout status/history/undo, pause/resume rollout, set image, pod delete, node describe, node cordon, node uncordon, and node drain are handled as direct cluster actions.
- Preview destructive or scheduling-affecting Kubernetes actions with dry-run output before applying them.
- Inspect claimed resources, read claimed runtime logs, start/stop claimed Docker containers, restart claimed Docker containers or Kubernetes deployments, and scale claimed Kubernetes deployments.
- Keep pre-existing workloads visible without mutating them.
- Bootstrap a k3s control plane from a saved SSH, Tailscale SSH, or Headscale SSH connection.
- Store the k3s join token encrypted and join additional saved servers as worker nodes.
- Inspect registered clusters from the control plane and view joined server/agent nodes in **Logs & Monitoring -> Cluster Builder**.

## Claim Workflow

Observed resources are read-only. To make a pre-existing resource eligible for future lifecycle controls:

1. Open **Logs & Monitoring**.
2. Find the resource in **Host Infrastructure Monitor**.
3. Click **Claim**.
4. StackPilot stores the provider, resource type, namespace, name, external id, current status, and a metadata snapshot.
5. Inspect, logs, restart, scale, rollout, set image, pod delete, node controls, or import-to-project controls must check this claim before executing.

Releasing a claim removes StackPilot's active ownership state. It does not delete the container, image, pod, service, deployment, or node.

## Ownership Model

- **Observed**: visible in inventory, read-only.
- **Claimed**: user explicitly marked the external resource as safe for StackPilot to reason about and prepare controls for.
- **Managed**: resource was created by StackPilot or imported into a project/environment with lifecycle metadata.
- **Released**: previous claim is retained for audit history, but active control is disabled.

## Multi-Node Production Cluster Model

For Raspberry Pi worker nodes plus cloud VPS nodes, StackPilot should manage a real Kubernetes cluster rather than isolated remote Docker hosts. The recommended architecture is one or more control-plane nodes, multiple workers, a private mesh network using Tailscale or Headscale, scoped Kubernetes RBAC, and scheduling policies that prefer edge nodes but can fall back to cloud nodes.

## Scenario Fit

The existing-cluster scenario now fits the control-plane side: if StackPilot is installed after a Docker host or Kubernetes cluster already exists, it can discover those resources, show details and YAML, let an operator claim a resource, and then run safe direct controls against the live cluster without importing the resource into a project. This keeps external workloads from filling StackPilot project storage while still allowing intentional operations.

For the Raspberry Pi plus cloud VPS failover scenario, StackPilot can now create the base cluster shape by initializing a k3s control plane on a saved server and joining additional saved servers as worker nodes. After bootstrap, the infrastructure monitor can see nodes, workloads, pods, services, namespaces, and events; claim nodes or workloads; preview node scheduling actions; cordon or uncordon nodes; drain nodes; inspect workloads; change deployment images; scale deployments; and inspect logs. The remaining gap is policy orchestration: StackPilot does not yet generate affinity/failover policies, install every production add-on, or reconcile a desired cluster topology continuously.

## Feature Roadmap

- **Slice 1: Inventory**: implemented Docker and Kubernetes discovery.
- **Slice 2: Claims**: implemented explicit claim/release state.
- **Slice 3: Safe Controls**: implemented Inspect, Logs, Restart, Docker Start/Stop, Kubernetes Deployment Scale, deployment rollout status/history/undo, pause/resume, set image, pod delete, node describe, node cordon/uncordon/drain, and dry-run previews for claimed resources. Import remains separate and explicit.
- **Slice 4: Cluster Explorer**: implemented namespace-aware tabs for workloads, pods, services, nodes, namespaces, events, and read-only resource details/YAML.
- **Slice 5: Import Into Project**: convert a claimed resource into a StackPilot project/environment.
- **Slice 6: Cluster Provisioning**: implemented k3s control-plane bootstrap, encrypted join-token storage, worker joins, cluster inventory, and cluster status checks over SSH plus Headscale/Tailscale.
- **Slice 7: Placement Policies**: define labels, taints, tolerations, affinity, priority classes, and failover rules so edge nodes can be preferred and cloud nodes can absorb workloads when edge nodes fail.
- **Slice 8: Add-on Management**: install and reconcile CNI, metrics-server, ingress controller, cert-manager, storage classes, GitHub runner or CI integrations, and observability agents.

## Security Requirements

- Never mutate external resources unless they are claimed or managed.
- Use scoped Kubernetes RBAC, not cluster-admin by default.
- Keep SSH and kubeconfig secrets encrypted.
- Log every control-plane action.
- Separate observation permissions from mutation permissions.
- Support dry-run previews before destructive Kubernetes changes.

## Testing Matrix

- Docker unavailable: endpoint should return `docker.available=false`.
- Kubernetes unavailable: endpoint should return `kubernetes.available=false`.
- Existing external containers: visible as `External` and claimable.
- Existing StackPilot containers: visible as `StackPilot`.
- Existing Kubernetes system deployments: visible as external/observed.
- Cluster explorer: namespaces, events, node capacity, pod restart counts, and service ports should render from the inventory API.
- Kubernetes YAML details: an authenticated user can read YAML for a namespace and a service without claiming the resource.
- Kubernetes direct control: unclaimed rollout/set-image/pod-delete/node-control requests must fail with 403; claimed deployment rollout status/history and node describe should return kubectl output; mutating rollout, image, pod-delete, and node-control requests require confirmation unless `dry_run=true`.
- Claim resource: inventory returns `claimed_by_StackPilot=true`.
- Release resource: inventory returns `claimed_by_StackPilot=false`.
- Multiple users: claims are isolated per user.
- Future destructive action: must fail if resource is not claimed or managed.
- Inspect action: must fail until the resource is claimed, then return Docker or Kubernetes runtime JSON.
- Logs action: must fail until the resource is claimed, then return Docker container logs or Kubernetes pod/deployment logs.
- Restart action: must fail until the resource is claimed and `confirm=true`, then restart Docker containers or Kubernetes deployments only.
- Docker state action: must fail until the container is claimed and `confirm=true`, then allow start/stop only for Docker containers.
- Scale action: must fail until the deployment is claimed and `confirm=true`, then allow Kubernetes deployment replicas between 0 and 50.
- Node action: must fail until the node is claimed; describe is read-only, cordon/uncordon/drain require `confirm=true`, and dry-run previews must not mutate node scheduling state.
