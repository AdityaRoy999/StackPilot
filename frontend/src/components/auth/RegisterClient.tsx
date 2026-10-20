"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { AxiosError } from "axios";
import Link from "next/link";
import { toast } from "sonner";

import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoogleAuthButton } from "@/components/auth/GoogleAuthButton";
import { GitHubAuthButton } from "@/components/auth/GitHubAuthButton";
import { Eye, EyeOff } from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import styles from "./AuthSplitLayout.module.css";

export function RegisterClient({
  googleClientId,
  githubOAuthEnabled,
}: {
  googleClientId: string;
  githubOAuthEnabled: boolean;
}) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const registerMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post("/auth/register", {
        username,
        email,
        password,
        ...(inviteCode.trim() ? { invite_code: inviteCode.trim() } : {}),
      });
      return response.data;
    },
    onSuccess: (data: { message?: string }) => {
      toast.success(data.message || "Account created successfully! Please log in.");
      router.push("/auth/login");
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to create account"
          : "Failed to create account";
      toast.error(message);
    },
  });

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username) {
      toast.error("Username is required");
      return;
    }
    if (!email) {
      toast.error("Email is required");
      return;
    }
    if (!password) {
      toast.error("Password is required");
      return;
    }
    if (password.length < 12) {
      toast.error("Password must be at least 12 characters");
      return;
    }
    registerMutation.mutate();
  };

  const authButtonClass =
    "relative h-12 w-full justify-center rounded-lg border-border !bg-transparent px-4 text-sm font-medium !text-foreground shadow-none hover:!bg-muted hover:!text-foreground dark:!bg-transparent";
  const hasSocialAuth = githubOAuthEnabled || Boolean(googleClientId);

  return (
    <AuthSplitLayout headingId="register-heading" registration>
      <h1 id="register-heading" className={styles.heading}>Create an account</h1>
      <p className={styles.intro}>Bring your next project to life with StackPilot.</p>
      {hasSocialAuth && (
        <>
          <div className={styles.providers}>
            <GitHubAuthButton mode="signup" enabled={githubOAuthEnabled} className={authButtonClass} />
            {googleClientId && <GoogleAuthButton mode="signup" clientId={googleClientId} className={authButtonClass} />}
          </div>
          <div className={styles.divider}>or sign up with email</div>
        </>
      )}
      <form onSubmit={handleRegister} className={styles.fields}>
        <div className={styles.field}>
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            placeholder="Choose a username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={registerMutation.isPending}
            className="h-12 px-3.5 text-base md:text-sm"
          />
        </div>
        <div className={styles.field}>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={registerMutation.isPending}
            className="h-12 px-3.5 text-base md:text-sm"
          />
        </div>
        <div className={styles.field}>
          <Label htmlFor="password">Password</Label>
          <div className={styles.passwordInput}>
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder="Create a password"
              required
              minLength={12}
              aria-describedby="register-password-hint"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={registerMutation.isPending}
              className="h-12 pl-3.5 pr-12 text-base md:text-sm"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0.5 top-1/2 size-11 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowPassword((current) => !current)}
              disabled={registerMutation.isPending}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
            >
              {showPassword ? <AppIcon name="eye-off" fallback={EyeOff} className="h-4 w-4" /> : <AppIcon name="eye" fallback={Eye} className="h-4 w-4" />}
            </Button>
          </div>
          <p id="register-password-hint" className={styles.hint}>Use at least 12 characters.</p>
        </div>
        <div className={styles.field}>
          <Label htmlFor="invite-code">Invite code</Label>
          <Input
            id="invite-code"
            name="invite-code"
            autoComplete="off"
            placeholder="Enter your workspace invite code"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            disabled={registerMutation.isPending}
            className="h-12 px-3.5 text-base md:text-sm"
          />
        </div>
        <Button type="submit" className="mt-1 h-12 w-full text-sm font-semibold" disabled={registerMutation.isPending}>
          {registerMutation.isPending ? "Creating account..." : "Sign up"}
        </Button>
      </form>
      <div className={styles.signup}>
        Already have an account? <Link href="/auth/login" className={styles.link}>Sign in</Link>
      </div>
    </AuthSplitLayout>
  );
}
