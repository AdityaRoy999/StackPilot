import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Keep content mounted for closing motion, but out of focus and accessibility. */
export function AnimatedCollapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  return <div aria-hidden={!open} inert={!open} className={cn("grid transition-[grid-template-rows,opacity] duration-250 ease-out motion-reduce:transition-none", className)} style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}><div className="min-h-0 overflow-hidden">{children}</div></div>;
}
