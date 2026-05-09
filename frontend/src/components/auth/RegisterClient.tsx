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
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { GoogleAuthButton } from "@/components/auth/GoogleAuthButton";
import { GitHubAuthButton } from "@/components/auth/GitHubAuthButton";
import { Eye, EyeOff } from "lucide-react";

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
  const [showPassword, setShowPassword] = useState(false);

  const registerMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post("/auth/register", { username, email, password });
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
    "relative h-10 w-full justify-center rounded-lg border-border !bg-transparent px-4 text-sm font-medium !text-foreground shadow-none hover:!bg-muted hover:!text-foreground dark:!bg-transparent";

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold tracking-tight text-center">
          Create an Account
        </CardTitle>
        <CardDescription className="text-center">
          Join the DOKSCP Platform
        </CardDescription>
      </CardHeader>
      <div className="px-6">
        <div className="space-y-3">
          <GitHubAuthButton mode="signup" enabled={githubOAuthEnabled} className={authButtonClass} />
          <GoogleAuthButton mode="signup" clientId={googleClientId} className={authButtonClass} />
        </div>
        <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
          <div className="h-px flex-1 bg-border" />
          <span>or</span>
          <div className="h-px flex-1 bg-border" />
        </div>
      </div>
      <form onSubmit={handleRegister}>
        <CardContent className="space-y-4 pb-6">
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={registerMutation.isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={registerMutation.isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={registerMutation.isPending}
                className="pr-10"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-50"
                onClick={() => setShowPassword((current) => !current)}
                disabled={registerMutation.isPending}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col space-y-4">
          <Button
            type="submit"
            className="w-full"
            disabled={registerMutation.isPending}
          >
            {registerMutation.isPending ? "Creating account..." : "Sign up"}
          </Button>
          <div className="text-center text-sm text-gray-500">
            Already have an account?{" "}
            <Link href="/auth/login" className="text-blue-600 hover:underline">
              Sign in
            </Link>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
