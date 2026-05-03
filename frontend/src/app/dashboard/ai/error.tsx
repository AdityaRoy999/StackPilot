"use client";

import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function AiAgentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[32rem] items-center justify-center rounded-xl border border-border bg-card p-6 text-card-foreground">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-background">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <h2 className="text-xl font-semibold">AI Agent could not load</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {error.message || "The playground hit a client-side error. Reload the page or go back to the dashboard."}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button type="button" variant="outline" onClick={() => history.back()}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button type="button" onClick={reset}>
            <RotateCcw className="h-4 w-4" />
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
}
