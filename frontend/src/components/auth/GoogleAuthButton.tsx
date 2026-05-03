"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
            ux_mode?: "popup" | "redirect";
          }) => void;
          prompt: () => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              type?: "standard" | "icon";
              theme?: "outline" | "filled_blue" | "filled_black";
              size?: "large" | "medium" | "small";
              text?: "signin_with" | "signup_with" | "continue_with" | "signin";
              shape?: "rectangular" | "pill" | "circle" | "square";
              logo_alignment?: "left" | "center";
              width?: string;
            }
          ) => void;
        };
      };
    };
  }
}

interface GoogleAuthButtonProps {
  mode: "signin" | "signup";
  clientId: string;
  className?: string;
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
      <path
        fill="#EA4335"
        d="M12 10.2v3.9h5.5c-.2 1.3-1.5 3.9-5.5 3.9-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.7 3.5 14.6 2.6 12 2.6A9.4 9.4 0 0 0 2.6 12 9.4 9.4 0 0 0 12 21.4c5.4 0 9-3.8 9-9.1 0-.6-.1-1.1-.2-1.5H12Z"
      />
      <path
        fill="#34A853"
        d="M3.7 7.5 6.9 9.8A5.9 5.9 0 0 1 12 6c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.7 3.5 14.6 2.6 12 2.6c-3.6 0-6.8 2-8.3 4.9Z"
      />
      <path
        fill="#FBBC05"
        d="M12 21.4c2.5 0 4.6-.8 6.2-2.3l-3-2.5c-.8.6-1.8 1-3.2 1-2.5 0-4.7-1.7-5.5-4l-3.3 2.5A9.4 9.4 0 0 0 12 21.4Z"
      />
      <path
        fill="#4285F4"
        d="M21 12.3c0-.6-.1-1.1-.2-1.5H12v3.9h5.5c-.3 1.3-1.1 2.4-2.2 3.1l3 2.5c1.8-1.7 2.7-4.1 2.7-7Z"
      />
    </svg>
  );
}

export function GoogleAuthButton({ mode, clientId, className }: GoogleAuthButtonProps) {
  const router = useRouter();
  const buttonHostRef = useRef<HTMLDivElement | null>(null);
  const [googleReady, setGoogleReady] = useState(false);
  const [scriptFailed, setScriptFailed] = useState(false);

  const googleAuthMutation = useMutation({
    mutationFn: async (credential: string) => {
      const response = await api.post("/auth/google", { credential });
      return response.data;
    },
    onSuccess: () => {
      toast.success(mode === "signup" ? "Google account connected" : "Signed in with Google");
      router.push("/dashboard");
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Google sign-in failed"
          : "Google sign-in failed";
      toast.error(message);
    },
  });
  const { isPending: googleAuthPending, mutate: authenticateWithGoogle } = googleAuthMutation;

  useEffect(() => {
    if (!clientId) {
      return;
    }

    let cancelled = false;

    const callback = (response: { credential?: string }) => {
      if (!response.credential) {
        toast.error("Google did not return a usable credential");
        return;
      }
      authenticateWithGoogle(response.credential);
    };

    const existing = document.getElementById("google-identity-script") as HTMLScriptElement | null;
    const renderGoogleTrigger = () => {
      if (!window.google?.accounts?.id || !buttonHostRef.current) {
        return;
      }

      buttonHostRef.current.innerHTML = "";
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback,
        ux_mode: "popup",
      });
      window.google.accounts.id.renderButton(buttonHostRef.current, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: mode === "signup" ? "signup_with" : "signin_with",
        shape: "rectangular",
        logo_alignment: "left",
        width: "560",
      });

      if (!cancelled) {
        setGoogleReady(true);
      }
    };

    if (window.google?.accounts?.id) {
      renderGoogleTrigger();
      return () => {
        cancelled = true;
      };
    }

    if (existing) {
      const onLoad = () => {
        renderGoogleTrigger();
      };
      const onError = () => {
        if (!cancelled) {
          setScriptFailed(true);
        }
      };
      existing.addEventListener("load", onLoad, { once: true });
      existing.addEventListener("error", onError, { once: true });
      return () => {
        cancelled = true;
        existing.removeEventListener("load", onLoad);
        existing.removeEventListener("error", onError);
      };
    }

    const script = document.createElement("script");
    script.id = "google-identity-script";
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      renderGoogleTrigger();
    }, { once: true });
    script.addEventListener("error", () => {
      if (!cancelled) {
        setScriptFailed(true);
      }
    }, { once: true });
    document.head.appendChild(script);

    return () => {
      cancelled = true;
    };
  }, [authenticateWithGoogle, clientId, mode]);

  if (!clientId) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        Google sign-in is not configured.
      </div>
    );
  }

  const label = mode === "signup" ? "Sign up with Google" : "Sign in with Google";
  const handleVisibleClick = () => {
    if (scriptFailed) {
      toast.error("Google sign-in could not load. Check your network or Google client configuration.");
      return;
    }

    if (!googleReady) {
      toast.message("Google sign-in is still loading. Try again in a moment.");
    }
  };

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        onClick={handleVisibleClick}
        disabled={googleAuthPending}
        className={cn(
          "relative h-10 w-full justify-center rounded-lg border-border !bg-transparent px-4 text-sm font-medium !text-foreground shadow-none hover:!bg-muted hover:!text-foreground dark:!bg-transparent",
          className
        )}
      >
        <span className="absolute left-4 flex items-center justify-center">
          {googleAuthPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <GoogleMark />}
        </span>
        <span>{label}</span>
      </Button>
      {googleAuthPending && <div className="absolute inset-0 z-20 cursor-wait rounded-lg bg-background/15" />}
      <div
        ref={buttonHostRef}
        aria-label={label}
        className={cn(
          "absolute inset-0 z-10 overflow-hidden rounded-lg opacity-0 [&_div]:!h-full [&_div]:!w-full [&_iframe]:!h-full [&_iframe]:!w-full",
          googleReady && !googleAuthPending ? "pointer-events-auto" : "pointer-events-none"
        )}
      />
    </div>
  );
}
