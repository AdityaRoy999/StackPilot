"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { AxiosError } from "axios";
import Link from "next/link";
import { toast } from "sonner";

import api from "@/lib/api";
import { destinationAfterLogin } from "@/lib/onboarding";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoogleAuthButton } from "@/components/auth/GoogleAuthButton";
import { GitHubAuthButton } from "@/components/auth/GitHubAuthButton";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { Eye, EyeOff } from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import styles from "./AuthSplitLayout.module.css";

export function LoginClient({
  googleClientId,
  githubOAuthEnabled,
}: {
  googleClientId: string;
  githubOAuthEnabled: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const loginMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post("/auth/login", { email, password });
      return response.data;
    },
    onSuccess: async () => {
      toast.success("Login successful!");
      router.push(await destinationAfterLogin());
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to login"
          : "Failed to login";
      toast.error(message);
    },
  });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      toast.error("Email is required");
      return;
    }
    if (!password) {
      toast.error("Password is required");
      return;
    }
    loginMutation.mutate();
  };

  const authButtonClass =
    "relative h-12 w-full justify-center rounded-lg border-border !bg-transparent px-4 text-sm font-medium !text-foreground shadow-none hover:!bg-muted hover:!text-foreground dark:!bg-transparent";
  const hasSocialAuth = githubOAuthEnabled || Boolean(googleClientId);

  return (
    <AuthSplitLayout headingId="login-heading">
      <h1 id="login-heading" className={styles.heading}>Welcome back</h1>
      <p className={styles.intro}>Sign in to your StackPilot workspace.</p>
      {hasSocialAuth && (
        <>
          <div className={styles.providers}>
            <GitHubAuthButton mode="signin" enabled={githubOAuthEnabled} className={authButtonClass} />
            {googleClientId && <GoogleAuthButton mode="signin" clientId={googleClientId} className={authButtonClass} />}
          </div>
          <div className={styles.divider}>or continue with email</div>
        </>
      )}
      <form onSubmit={handleLogin} className={styles.fields}>
        <div className={styles.field}>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            placeholder="you@example.com"
            required
            className="h-12 px-3.5 text-base md:text-sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loginMutation.isPending}
          />
        </div>
        <div className={styles.field}>
          <div className={styles.passwordLabel}>
            <Label htmlFor="password">Password</Label>
            <Link href="/auth/forgot-password" className={styles.link}>Forgot password?</Link>
          </div>
          <div className={styles.passwordInput}>
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Enter your password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loginMutation.isPending}
              className="h-12 pl-3.5 pr-12 text-base md:text-sm"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0.5 top-1/2 size-11 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowPassword((current) => !current)}
              disabled={loginMutation.isPending}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
            >
              {showPassword ? <AppIcon name="eye-off" fallback={EyeOff} className="h-4 w-4"  /> : <AppIcon name="eye" fallback={Eye} className="h-4 w-4"  />}
            </Button>
          </div>
        </div>
        <Button
          type="submit"
          className="mt-1 h-12 w-full text-sm font-semibold"
          disabled={loginMutation.isPending}
        >
          {loginMutation.isPending ? "Signing in..." : "Sign in"}
        </Button>
      </form>
      <div className={styles.signup}>
        Don&apos;t have an account?{" "}
        <Link href="/auth/register" className={styles.link}>
          Sign up
        </Link>
      </div>
    </AuthSplitLayout>
  );
}
