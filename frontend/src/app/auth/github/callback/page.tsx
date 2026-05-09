"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

function backendGitHubCallbackUrl(code: string, state: string) {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8090/api/v1";
  const base = apiBase.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  const params = new URLSearchParams({ code, state });
  return `${base}/api/v1/auth/github/callback?${params.toString()}`;
}

export default function GitHubCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const status = searchParams.get("status") || "";
    const mode = searchParams.get("mode") || "signin";
    const message = searchParams.get("message") || "";
    const code = searchParams.get("code") || "";
    const state = searchParams.get("state") || "";

    if (code && state) {
      window.location.replace(backendGitHubCallbackUrl(code, state));
      return;
    }

    if (status === "connected") {
      toast.success(message || "GitHub connected successfully");
      router.replace("/dashboard/settings");
      return;
    }

    if (status === "success") {
      toast.success(message || "Signed in with GitHub");
      router.replace("/dashboard");
      return;
    }

    toast.error(message || "GitHub authentication failed");
    router.replace(mode === "connect" ? "/dashboard/settings" : "/auth/login");
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-card px-8 py-10 text-center shadow-sm">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">Finishing GitHub sign-in</h1>
          <p className="text-sm text-muted-foreground">We&apos;re closing the loop and taking you back in.</p>
        </div>
      </div>
    </div>
  );
}
