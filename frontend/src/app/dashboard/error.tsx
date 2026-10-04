"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Copy, RotateCcw } from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";

import { Button } from "@/components/ui/button";

// Segment-level boundary for every dashboard route that doesn't define its own.
// Without this, a render-time throw takes out the whole route with no diagnostics.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Keep the full error (with stack) in the console even though the UI
    // only shows the message — this is what makes the failure diagnosable.
    console.error("[dashboard] route error", error);
  }, [error]);

  const details = [error.name, error.message, error.digest && `digest: ${error.digest}`, error.stack]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-xl border border-border bg-card p-6 text-card-foreground">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10">
            <AppIcon name="alert-triangle" fallback={AlertTriangle} className="h-5 w-5 text-destructive"  />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">This page hit an error</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The rest of the dashboard is still working. The details below identify the failure.
            </p>

            <pre className="mt-4 max-h-64 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed">
              {details || "No error details were provided."}
            </pre>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" onClick={() => reset()}>
                <AppIcon name="rotate-ccw" fallback={RotateCcw} className="h-4 w-4"  />
                Try again
              </Button>
              <Button type="button" variant="outline" onClick={() => history.back()}>
                <AppIcon name="arrow-left" fallback={ArrowLeft} className="h-4 w-4"  />
                Back
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(details);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                <AppIcon name="copy" fallback={Copy} className="h-4 w-4"  />
                {copied ? "Copied" : "Copy details"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
