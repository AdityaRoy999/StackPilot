"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Info } from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { cn } from "@/lib/utils";

function GuideSection({ heading, items }: { heading: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <h3 className="font-medium text-foreground">{heading}</h3>
      <div className="mt-3 space-y-2">
        {items.map((item) => (
          <p key={item} className="text-sm leading-relaxed text-muted-foreground">
            {item}
          </p>
        ))}
      </div>
    </div>
  );
}

const selectedTabClass =
  "h-full rounded-lg px-3 text-sm font-semibold data-[active]:!border-black data-[active]:!bg-black data-[active]:!text-white dark:data-[active]:!border-white dark:data-[active]:!bg-white dark:data-[active]:!text-black";

const segmentedTabsListClass = "grid h-10 w-full rounded-xl border border-border bg-muted/30 p-1";
export function ProjectSetupGuide({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [section, setSection] = useState("github");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent resizeKey={section} className="!flex !w-[min(calc(100vw-2rem),960px)] !max-w-[960px] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-2xl p-0">
        <DialogHeader className="shrink-0 px-5 pt-5 pb-4">
          <DialogTitle className="flex items-center gap-2 pr-8">
            <AppIcon name="info" fallback={Info} className="h-5 w-5 text-primary"  />
            Project Creation Guide
          </DialogTitle>
          <DialogDescription>
            Choose your source, configure the project, review the detected stack, then confirm.
            Creating a project saves its configuration; start a deployment from its overview.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={section} onValueChange={setSection} className="min-h-0 overflow-hidden px-5 pb-4">
          <TabsList className={cn(segmentedTabsListClass, "h-auto grid-cols-2 sm:grid-cols-4")}>
            <TabsTrigger value="github" className={selectedTabClass}>
              GitHub
            </TabsTrigger>
            <TabsTrigger value="ssh" className={selectedTabClass}>
              SSH / VPS
            </TabsTrigger>
            <TabsTrigger value="application" className={selectedTabClass}>
              Apps
            </TabsTrigger>
            <TabsTrigger value="local" className={selectedTabClass}>
              Local
            </TabsTrigger>
          </TabsList>

          <div className="mt-4 max-h-[min(46dvh,460px)] overflow-y-auto overscroll-contain pr-1 scrollbar-thin">
            <TabsContent value="github" className="space-y-3">
              <GuideSection
                heading="GitHub source"
                items={[
                  "Use GitHub OAuth or a PAT to load public and private repositories.",
                  "Pick a repository and confirm the configuration to save the project. Start its first deployment from the project overview.",
                  "If you choose Run on server, select the server and a remote workspace path. The repo is cloned under stackpilot-builds/<deployment-id> inside that path.",
                ]}
              />
              <GuideSection
                heading="After creation"
                items={[
                  "Open Deployments to view logs, metrics, runtime details, or delete the deployment.",
                  "Use the runtime controls later if you want Kubernetes, NodePort, or Ingress instead of plain Docker.",
                ]}
              />
            </TabsContent>

            <TabsContent value="ssh" className="space-y-3">
              <GuideSection
                heading="SSH / VPS source"
                items={[
                  "Use this when the source folder already exists on a saved server or Tailscale machine.",
                  "Browse to the actual project folder, not only the parent folder.",
                  "Run locally copies the remote source to StackPilot and builds on this machine. Run on server builds and runs on that same remote server.",
                ]}
              />
              <GuideSection
                heading="Terminal"
                items={[
                  "The terminal lets you run normal shell commands on the selected connection.",
                  "You can git clone, install missing tools, inspect files, then choose the final project folder.",
                ]}
              />
            </TabsContent>

            <TabsContent value="application" className="space-y-3">
              <GuideSection
                heading="Application source"
                items={[
                  "Use this when you want StackPilot to generate a deployable compose project from a known application image.",
                  "Pick an application, configure ports and credentials, then deploy locally or on a saved server.",
                  "Secrets are stored as project environment variables; the generated source keeps only non-secret metadata.",
                ]}
              />
              <GuideSection
                heading="Catalog scope"
                items={[
                  "The catalog starts with common databases, queues, monitoring tools, storage, and utilities.",
                  "Each template is still a normal Docker image workflow, so more application types can be added without changing the deployment engine.",
                ]}
              />
            </TabsContent>

            <TabsContent value="local" className="space-y-3">
              <GuideSection
                heading="Local source"
                items={[
                  "Use this for folders already available on the host running StackPilot.",
                  "Local projects must live inside the allowed local source roots configured for the backend container.",
                  "Direct arbitrary laptop paths are intentionally blocked; mount or import the project into the allowed root so builds are reproducible and safe.",
                ]}
              />
              <GuideSection
                heading="NodePort vs Ingress"
                items={[
                  "NodePort exposes a Kubernetes app on a high node port, useful for local testing.",
                  "Ingress routes domain-based HTTP traffic through an ingress controller, better for production-style URLs and TLS.",
                ]}
              />
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter className="!mx-0 !mb-0 shrink-0 px-5 py-3">
          <Button type="button" onClick={() => onOpenChange(false)}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
