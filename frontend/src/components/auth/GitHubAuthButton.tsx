"use client";

import { useMutation } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface GitHubAuthButtonProps {
  mode: "signin" | "signup" | "connect";
  enabled: boolean;
  className?: string;
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
      <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.05c-3.34.73-4.04-1.42-4.04-1.42-.55-1.38-1.33-1.75-1.33-1.75-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.22 1.84 1.22 1.08 1.82 2.82 1.3 3.5 1 .11-.76.42-1.3.76-1.6-2.67-.3-5.48-1.32-5.48-5.87 0-1.3.47-2.36 1.23-3.19-.12-.3-.53-1.52.12-3.17 0 0 1-.32 3.3 1.22a11.7 11.7 0 0 1 6 0c2.29-1.54 3.29-1.22 3.29-1.22.66 1.65.25 2.87.13 3.17.77.83 1.23 1.89 1.23 3.19 0 4.56-2.82 5.56-5.5 5.86.44.37.82 1.08.82 2.18v3.24c0 .32.21.69.82.58A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

export function GitHubAuthButton({ mode, enabled, className }: GitHubAuthButtonProps) {
  const startMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post("/auth/github/start", { mode });
      return response.data as { authorization_url: string };
    },
    onSuccess: (data) => {
      window.location.href = data.authorization_url;
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "GitHub sign-in failed"
          : "GitHub sign-in failed";
      toast.error(message);
    },
  });

  if (!enabled) {
    return null;
  }

  const label =
    mode === "connect"
      ? "Connect GitHub"
      : mode === "signup"
        ? "Sign up with GitHub"
        : "Sign in with GitHub";

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => startMutation.mutate()}
      disabled={startMutation.isPending}
      className={cn(
        "relative h-10 justify-center rounded-lg border-border px-4 text-sm font-medium shadow-none",
        "bg-transparent text-foreground hover:bg-muted hover:text-foreground",
        className
      )}
    >
      <span className="pointer-events-none absolute left-4 top-1/2 flex -translate-y-1/2 items-center justify-center text-foreground">
        {startMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <GitHubMark />}
      </span>
      <span className="px-8">{label}</span>
    </Button>
  );
}
