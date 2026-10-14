export type StackRole = "frontend" | "backend" | "database" | "cache" | "queue" | "runtime" | "infrastructure" | "storage" | "monitoring" | "application";
export interface StackComponent {
  id: string;
  name: string;
  role: StackRole;
  kind: "framework" | "client" | "service" | "runtime" | "configuration";
  evidence: string[];
}
export interface ProjectStack {
  status: "detected" | "unknown" | "unavailable";
  components: StackComponent[];
  manifests: string[];
  files_scanned: number;
  truncated: boolean;
  message: string;
  method: "manifests" | "application";
  inspected_at?: number;
  revision?: string;
}
export interface ProjectStackDetails {
  workspace?: string;
  source_server?: string;
  runtime_server?: string;
  source_type?: string;
  repo_url?: string;
  source_path?: string;
  preset?: string;
  image?: string;
  port?: string;
  host_port?: string;
  container_port?: string;
  execution_mode?: string;
  remote_runtime_type?: string;
  remote_k8s_exposure?: string;
  runtime_scheme?: string;
  created_at?: string;
  updated_at?: string;
  variables?: number;
  application_fields?: { label: string; value: string }[];
  environments?: ProjectEnvironmentSummary[];
}
export interface ProjectEnvironmentSummary {
  name: string;
  branch: string;
  auto_deploy: boolean;
  require_ci: boolean;
  cleanup_previous_on_success?: boolean;
  variables?: number;
}
export interface ProjectStackResponse { stack: ProjectStack; details?: ProjectStackDetails }
export interface StackSource {
  source_type: string;
  repo_url?: string;
  source_path?: string;
  ssh_connection_id?: string;
  github_pat?: string;
  branch?: string;
  application_template_id?: string;
  application_config?: { image?: string };
}
export const stackRoleLabels: Record<StackRole, string> = {
  frontend: "Frontend", backend: "Backend", database: "Database", cache: "Cache", queue: "Queue",
  runtime: "Runtime", infrastructure: "Infrastructure", storage: "Storage", monitoring: "Monitoring", application: "Application",
};
export function stackComponentLabel(component: StackComponent) {
  return `${component.name} · ${stackRoleLabels[component.role] || component.role}${component.kind === "client" ? " client" : ""}`;
}
export function stackIconComponents(stack?: ProjectStack) {
  if (!stack) return [];
  // A declared service and its client share one icon; both evidence entries
  // remain available in the details modal.
  const components = new Map<string, StackComponent>();
  const rank: StackRole[] = ["frontend", "backend", "database", "cache", "queue", "storage", "application", "runtime", "infrastructure", "monitoring"];
  for (const item of stack.components) {
    if (!components.has(item.id) || item.kind === "service") components.set(item.id, item);
  }
  return [...components.values()].sort((a, b) => rank.indexOf(a.role) - rank.indexOf(b.role));
}
export function environmentBranchLabel(branch: string) {
  return branch === "HEAD" ? "Repository default" : branch === "application" ? "Application image" : branch;
}
