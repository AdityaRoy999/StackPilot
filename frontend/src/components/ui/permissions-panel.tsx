"use client";

import { Button } from "@/components/ui/button";
import { ShieldCheck } from "@/lib/platform-icons";

export interface MessagePermission {
  id: string;
  toolName?: string;
  title: string;
  description?: string;
  command?: string;
  arguments?: Record<string, unknown>;
  browserStep?: { url: string; label: string; action: string; reason: string; step_index: number };
  status: "pending" | "approved" | "declined";
}

export function PermissionsPanel({ permissions, pendingId, disabled, onApprove, onDecline }: {
  permissions: MessagePermission[];
  pendingId?: string;
  disabled?: boolean;
  onApprove?: () => void;
  onDecline?: () => void;
}) {
  if (!permissions.length) return null;
  return <details open className="my-2 text-xs" data-permissions-section>
    <summary className="w-fit cursor-pointer select-none py-1 text-muted-foreground">Permissions · {permissions.length}</summary>
    <div className="mt-1 space-y-2">
      {permissions.map(permission => {
        const pending=permission.status === "pending" && permission.id === pendingId;
        const label=permission.browserStep?.label || permission.title.replace(/^Permission Needed:\s*/, "").replaceAll("_", " ");
        return <section key={permission.id} aria-label="Action permission" className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium capitalize">{label}</span>
                <span className="text-[11px] text-muted-foreground">{permission.status === "approved" ? "Approved" : permission.status === "declined" ? "Declined" : "Needs approval"}</span>
              </div>
              {permission.browserStep && <p className="mt-1 truncate text-muted-foreground" title={permission.browserStep.url}>{permission.browserStep.url}</p>}
              {permission.command && <code className="mt-1 block whitespace-pre-wrap break-all text-muted-foreground">{permission.command}</code>}
              {(permission.arguments || permission.description) && <details className="mt-1 text-muted-foreground">
                <summary className="w-fit cursor-pointer">Details</summary>
                {permission.description && <p className="mt-2 leading-relaxed">{permission.description}</p>}
                {permission.arguments && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{JSON.stringify(permission.arguments,null,2)}</pre>}
              </details>}
              {pending && <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" className="h-7 px-3 text-xs" disabled={disabled} onClick={onApprove}>Approve & continue</Button>
                <Button size="sm" variant="ghost" className="h-7 px-3 text-xs text-muted-foreground" disabled={disabled} onClick={onDecline}>Decline</Button>
              </div>}
              {permission.status === "pending" && !pending && <p className="mt-1 text-muted-foreground">Request a fresh review to continue this saved step.</p>}
            </div>
          </div>
        </section>;
      })}
    </div>
  </details>;
}
