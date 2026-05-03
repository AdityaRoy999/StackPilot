"use client";

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AxiosError } from "axios";
import Link from "next/link";
import { toast } from "sonner";
import { Eye, EyeOff, MailCheck, RotateCcw } from "lucide-react";

import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Step = "request" | "verify";

function getApiErrorMessage(error: unknown, fallback: string) {
  if (error instanceof AxiosError) {
    return (error.response?.data as { error?: string } | undefined)?.error || fallback;
  }
  return fallback;
}

export function ForgotPasswordClient() {
  const [step, setStep] = useState<Step>("request");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const maskedEmail = useMemo(() => {
    const normalized = email.trim();
    const [localPart, domain = ""] = normalized.split("@");
    if (!localPart || !domain) {
      return normalized;
    }
    if (localPart.length <= 2) {
      return `${localPart[0] ?? ""}***@${domain}`;
    }
    return `${localPart.slice(0, 2)}***@${domain}`;
  }, [email]);

  const requestMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post("/auth/forgot-password/request", { email });
      return response.data as { message?: string };
    },
    onSuccess: (data) => {
      toast.success(data.message || "If the account is eligible, the code is on its way.");
      setStep("verify");
    },
    onError: (error: unknown) => {
      toast.error(getApiErrorMessage(error, "Failed to start password reset"));
    },
  });

  const verifyMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post("/auth/forgot-password/verify", {
        email,
        otp,
        new_password: newPassword,
      });
      return response.data as { message?: string };
    },
    onSuccess: (data) => {
      toast.success(data.message || "Password updated successfully");
      setOtp("");
      setNewPassword("");
      setConfirmPassword("");
      setStep("request");
    },
    onError: (error: unknown) => {
      toast.error(getApiErrorMessage(error, "Failed to verify code"));
    },
  });

  const handleRequest = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      toast.error("Email is required");
      return;
    }
    requestMutation.mutate();
  };

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp.trim()) {
      toast.error("Verification code is required");
      return;
    }
    if (!newPassword) {
      toast.error("New password is required");
      return;
    }
    if (newPassword.length < 12) {
      toast.error("Password must be at least 12 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    verifyMutation.mutate();
  };

  const isBusy = requestMutation.isPending || verifyMutation.isPending;

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold tracking-tight text-center">
          Reset your password
        </CardTitle>
        <CardDescription className="text-center">
          {step === "request"
            ? "We'll send a one-time verification code to your email."
            : `Enter the code sent to ${maskedEmail || "your inbox"} and choose a new password.`}
        </CardDescription>
      </CardHeader>

      {step === "request" ? (
        <form onSubmit={handleRequest}>
          <CardContent className="space-y-4 pb-6">
            <div className="space-y-2">
              <Label htmlFor="reset-email">Email</Label>
              <Input
                id="reset-email"
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isBusy}
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4">
            <Button type="submit" className="w-full" disabled={isBusy}>
              {requestMutation.isPending ? "Sending code..." : "Send verification code"}
            </Button>
            <div className="text-center text-sm text-muted-foreground">
              Remembered it?{" "}
              <Link href="/auth/login" className="text-primary hover:underline">
                Back to sign in
              </Link>
            </div>
          </CardFooter>
        </form>
      ) : (
        <form onSubmit={handleVerify}>
          <CardContent className="space-y-4 pb-6">
            <div className="rounded-lg border border-border/80 bg-muted/20 p-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <MailCheck className="h-4 w-4" />
                Verification code sent
              </div>
              <p className="mt-1">
                Use the 6-digit code from your email. It expires quickly and can only be used once.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="verify-email">Email</Label>
              <Input
                id="verify-email"
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isBusy}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="otp">Verification code</Label>
              <Input
                id="otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                disabled={isBusy}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={isBusy}
                  className="pr-10"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => setShowPassword((current) => !current)}
                  disabled={isBusy}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">Use at least 12 characters.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm password</Label>
              <div className="relative">
                <Input
                  id="confirm-password"
                  type={showConfirmPassword ? "text" : "password"}
                  placeholder="Password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={isBusy}
                  className="pr-10"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => setShowConfirmPassword((current) => !current)}
                  disabled={isBusy}
                  aria-label={showConfirmPassword ? "Hide password confirmation" : "Show password confirmation"}
                >
                  {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4">
            <div className="flex w-full gap-3">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                disabled={isBusy}
                onClick={() => requestMutation.mutate()}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Resend code
              </Button>
              <Button type="submit" className="flex-1" disabled={isBusy}>
                {verifyMutation.isPending ? "Updating..." : "Update password"}
              </Button>
            </div>
            <div className="text-center text-sm text-muted-foreground">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => {
                  if (isBusy) return;
                  setStep("request");
                  setOtp("");
                  setNewPassword("");
                  setConfirmPassword("");
                }}
                disabled={isBusy}
              >
                Use a different email
              </button>
              {" · "}
              <Link href="/auth/login" className="text-primary hover:underline">
                Back to sign in
              </Link>
            </div>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}
