import type { ReactNode } from "react";
import { ChevronDown } from "@/lib/platform-icons";
import { cn } from "@/lib/utils";

/** Secondary information stays available without competing with the main task. */
export function DisclosureSection({ title, description, children, defaultOpen = false, className }: {
  title: string;
  description?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details open={defaultOpen} className={cn("group/disclosure min-w-0 rounded-xl border border-border bg-card", className)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block">{title}</span>
          {description && <span className="mt-1 block text-xs font-normal text-muted-foreground">{description}</span>}
        </span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 transition-transform duration-150 group-open/disclosure:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="min-w-0 border-t border-border p-4">{children}</div>
    </details>
  );
}
