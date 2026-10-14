import { Button } from "@/components/ui/button";
import { Check } from "@/lib/platform-icons";

export const PROJECT_SETUP_STEPS = ["Source", "Configure", "Review", "Confirm"] as const;

export function ProjectSetupSteps({ step, onChange, disabled }: { step: number; onChange: (step: number) => void; disabled?: boolean }) {
  return <SetupSteps compact labels={PROJECT_SETUP_STEPS} label="Project setup progress" step={step} onChange={onChange} disabled={disabled} />;
}

/** Shared progress rail: upcoming steps are dashed; reached steps are filled. */
export function SetupSteps({ labels, label, step, onChange, disabled, compact = false }: {
  labels: readonly string[]; label: string; step: number;
  onChange: (step: number) => void; disabled?: boolean; compact?: boolean;
}) {
  return <nav aria-label={label} className={compact ? "setup-progress setup-progress-compact border-b border-border py-2 pl-4 pr-12 sm:pl-5" : "setup-progress border-b border-border px-5 py-4 sm:px-6"}>
    <ol className="flex min-w-0">
      {labels.map((name, index) => <li key={name} className="setup-progress-item" data-reached={index <= step} data-connected={index < step}>
        <button type="button" disabled={disabled || index > step} onClick={() => onChange(index)} aria-current={index === step ? "step" : undefined} className="setup-progress-button">
          <span className="setup-progress-circle"><svg className="setup-progress-outline" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 3" strokeLinecap="round" /></svg>{index < step ? <Check aria-label="Completed" className="size-3.5" /> : `0${index + 1}`}</span>
          <span className="setup-progress-label">{name}</span>
        </button>
      </li>)}
    </ol>
  </nav>;
}

export function ProjectSetupReview({ name, source, target, environments, variables, onEdit }: {
  name: string; source: string; target: string;
  environments: { name: string; branch: string; require_ci: boolean; auto_deploy: boolean }[];
  variables: number; onEdit: () => void;
}) {
  return <section className="space-y-5" aria-label="Project configuration review">
    <div><p className="workspace-section-label mb-2">Review configuration</p><h3 className="break-words text-xl font-semibold tracking-tight">{name}</h3><p className="mt-2 text-sm text-muted-foreground">Check your setup and detected stack. Continue to confirmation before creating the project.</p></div>
    <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card text-sm">
      {[{ label: "Source", value: source }, { label: "Runtime", value: target }, { label: "Variables", value: `${variables} configured · values kept private` }].map(row => <div key={row.label} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-4 p-4 sm:grid-cols-[7rem_minmax(0,1fr)]"><dt className="text-muted-foreground">{row.label}</dt><dd className="break-words font-medium [overflow-wrap:anywhere]">{row.value}</dd></div>)}
      <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-4 p-4 sm:grid-cols-[7rem_minmax(0,1fr)]"><dt className="text-muted-foreground">Environments</dt><dd className="space-y-3">{environments.map((env, i) => <div key={i}><p className="font-medium">{env.name} <span className="ml-1 font-mono text-xs text-muted-foreground">{env.branch === "HEAD" ? "Repository default" : env.branch}</span></p><p className="mt-1 text-xs text-muted-foreground">{env.auto_deploy ? "Deploy on push" : "Manual deploy"} · {env.require_ci ? "CI must pass before building" : "GitHub CI gate off"}</p></div>)}</dd></div>
    </dl>
    <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm"><p className="font-medium">Build and verification</p><p className="mt-1 leading-relaxed text-muted-foreground">Stack detection describes the source. Deployment uses its Dockerfile or a supported build and verifies runtime health. Configure tests in stackpilot.json for deeper verification.</p></div>
    <Button type="button" variant="outline" onClick={onEdit}>Edit configuration</Button>
  </section>;
}

export interface ConfirmationRow { label: string; value: string }
export function ProjectSetupConfirmation({ name, rows, environments, variableKeys, onEdit }: {
  name: string; rows: ConfirmationRow[];
  environments: { name: string; branch: string; auto_deploy: boolean; require_ci: boolean; cleanup_previous_on_success: boolean; variableKeys: string[] }[];
  variableKeys: string[]; onEdit: () => void;
}) {
  return <section className="space-y-5" aria-label="Project creation confirmation">
    <div><p className="workspace-section-label mb-2">Confirm project</p><h3 className="break-words text-xl font-semibold tracking-tight">{name}</h3><p className="mt-2 text-sm text-muted-foreground">Create project will save this configuration. You can start a deployment from the project overview.</p></div>
    <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border text-sm">{rows.filter(row => row.value).map(row => <div key={row.label} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 p-4 sm:grid-cols-[9rem_minmax(0,1fr)]"><dt className="text-muted-foreground">{row.label}</dt><dd className="break-words font-medium [overflow-wrap:anywhere]">{row.value}</dd></div>)}</dl>
    <div className="space-y-3"><h4 className="text-sm font-semibold">Environments</h4>{environments.map((env, index) => <article key={index} className="rounded-lg border border-border p-4 text-sm"><div className="flex flex-wrap justify-between gap-2"><p className="font-medium">{env.name.trim().toLowerCase()}</p><span className="font-mono text-xs text-muted-foreground">{env.branch === "HEAD" ? "Repository default" : env.branch}</span></div><p className="mt-2 text-muted-foreground">{env.auto_deploy ? "Deploy on push" : "Manual deployment"} · {env.require_ci ? "CI required" : "CI gate off"}</p><p className="mt-1 text-xs text-muted-foreground">{env.cleanup_previous_on_success ? "Clean up previous release after success" : "Retain previous releases"}</p><p className="mt-2 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{env.variableKeys.length ? `Variables: ${env.variableKeys.join(", ")}` : "No environment-specific variables"}</p></article>)}</div>
    <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm"><h4 className="font-medium">Shared variables</h4><p className="mt-1 break-words text-muted-foreground [overflow-wrap:anywhere]">{variableKeys.length ? variableKeys.join(", ") : "None configured"}</p><p className="mt-2 text-xs text-muted-foreground">Credential and variable values are kept private.</p></div>
    <Button type="button" variant="outline" onClick={onEdit}>Edit configuration</Button>
  </section>;
}
