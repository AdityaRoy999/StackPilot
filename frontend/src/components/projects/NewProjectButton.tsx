"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Info, Plus, Loader2 } from "@/lib/platform-icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// The source browsers, image catalog, and terminal are loaded when creating a
// project, rather than adding them to every dashboard navigation.
const ProjectDialog = dynamic(() => import("@/components/CreateProjectDialog").then(module => module.CreateProjectDialog), {
  loading: () => null,
  ssr: false,
});
const ProjectGuide = dynamic(() => import("./ProjectSetupGuide").then(module => module.ProjectSetupGuide), {
  loading: () => null,
  ssr: false,
});

export function NewProjectButton() {
  const [open, setOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  return <>
    <div className="flex shrink-0 items-center gap-2">
      <Button className="h-11 gap-2 px-3 sm:h-9" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>{open ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}New project</Button>
      <Tooltip>
        <TooltipTrigger render={<Button type="button" variant="outline" size="icon" className="size-11 text-muted-foreground sm:size-9" aria-label="Project creation guide" aria-haspopup="dialog" aria-expanded={guideOpen} onClick={() => setGuideOpen(true)} />}>
          <Info className="size-4" />
        </TooltipTrigger>
        <TooltipContent>Project creation guide</TooltipContent>
      </Tooltip>
    </div>
    {open && <ProjectDialog initiallyOpen onDismiss={() => setOpen(false)} />}
    {guideOpen && <ProjectGuide open={guideOpen} onOpenChange={setGuideOpen} />}
  </>;
}
