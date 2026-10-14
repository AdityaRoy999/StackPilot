"use client";

import dynamic from "next/dynamic";
import { useState, type ComponentProps } from "react";
import type { EditProjectDialog as ProjectEditor } from "@/components/EditProjectDialog";
import { Settings2 } from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { Button } from "@/components/ui/button";

const EditProjectDialog = dynamic(() => import("@/components/EditProjectDialog").then(module => module.EditProjectDialog), { ssr: false });

export function ProjectEditButton({ project }: Pick<ComponentProps<typeof ProjectEditor>, "project">) {
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" aria-label="Edit project" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setActivated(true); setOpen(true); }}>
      <AppIcon name="settings2" fallback={Settings2} className="h-4 w-4" />
    </Button>
    {activated && <EditProjectDialog project={project} open={open} onOpenChange={setOpen} hideTrigger />}
  </>;
}
