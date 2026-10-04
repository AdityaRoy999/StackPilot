"use client";

import { use } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Building2, CheckCircle2, Loader2, LogIn, ShieldAlert, UserPlus } from "@/lib/platform-icons";
import { AppIcon } from "@/lib/custom-icons";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import api from "@/lib/api";

interface InviteInfo {
  valid: boolean;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  email: string;
  role: string;
  expires_at: string;
  inviter_username: string;
}

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const resolvedParams = use(params);
  const token = resolvedParams.token;
  const router = useRouter();

  const userQuery = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const res = await api.get("/auth/me");
        return res.data;
      } catch {
        return null;
      }
    },
  });

  const inviteQuery = useQuery({
    queryKey: ["invite-info", token],
    queryFn: async () => {
      const res = await api.get<InviteInfo>(`/organizations/invitations/${token}`);
      return res.data;
    },
    enabled: Boolean(token),
    retry: false,
  });

  const joinMutation = useMutation({
    mutationFn: async () => {
      const res = await api.post(`/organizations/join/${token}`);
      return res.data;
    },
    onSuccess: (data) => {
      toast.success(data?.message || "Successfully joined organization!");
      router.push("/dashboard/organization");
    },
    onError: (error: unknown) => {
      const msg =
        error && typeof error === "object" && "response" in error
          ? (error as { response?: { data?: { error?: string } } }).response?.data?.error
          : "Failed to join organization";
      toast.error(msg || "Failed to join organization");
    },
  });

  const isAuthenticated = Boolean(userQuery.data?.user);

  if (inviteQuery.isLoading || userQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <AppIcon name="loader2" fallback={Loader2} className="h-5 w-5 animate-spin text-primary"  />
          <span>Loading invitation details…</span>
        </div>
      </div>
    );
  }

  if (inviteQuery.isError || !inviteQuery.data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border/70 bg-card text-center">
          <CardHeader>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive mb-2">
              <AppIcon name="shield-alert" fallback={ShieldAlert} className="h-6 w-6"  />
            </div>
            <CardTitle className="text-xl">Invalid or Expired Invitation</CardTitle>
            <CardDescription className="text-sm">
              This organization invitation link is no longer valid or has expired. Please contact your organization administrator for a new invite.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex justify-center pt-2 pb-6">
            <Link href="/dashboard" className={cn(buttonVariants({ variant: "outline" }))}>
              Return to Dashboard
            </Link>
          </CardFooter>
        </Card>
      </div>
    );
  }

  const invite = inviteQuery.data;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <Card className="w-full max-w-lg border-border/70 bg-card shadow-lg">
        <CardHeader className="text-center pb-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary mb-3">
            <AppIcon name="building2" fallback={Building2} className="h-7 w-7"  />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">You&apos;re Invited!</CardTitle>
          <CardDescription className="text-sm mt-1">
            {invite.inviter_username ? (
              <span>
                <strong>@{invite.inviter_username}</strong> has invited you to collaborate on StackPilot.
              </span>
            ) : (
              <span>You have been invited to collaborate on StackPilot.</span>
            )}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="rounded-xl border border-border/80 bg-muted/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Organization
              </span>
              <span className="text-sm font-bold text-foreground">{invite.organization_name}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Assigned Role
              </span>
              <Badge variant="outline" className="capitalize text-xs font-semibold">
                {invite.role}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Invited Email
              </span>
              <span className="text-xs font-mono text-muted-foreground">{invite.email}</span>
            </div>
          </div>

          {!isAuthenticated && (
            <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 text-xs text-muted-foreground">
              Please sign in or create an account to accept this invitation.
            </div>
          )}
        </CardContent>

        <CardFooter className="flex flex-col gap-2.5 pt-2 pb-6">
          {isAuthenticated ? (
            <Button
              className="w-full h-10 gap-2 font-semibold"
              onClick={() => joinMutation.mutate()}
              disabled={joinMutation.isPending}
            >
              {joinMutation.isPending ? (
                <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  />
              ) : (
                <AppIcon name="check-circle2" fallback={CheckCircle2} className="h-4 w-4"  />
              )}
              <span>Accept & Join {invite.organization_name}</span>
            </Button>
          ) : (
            <div className="flex w-full gap-3">
              <Link
                href={`/auth/login?redirect=/invite/${token}`}
                className={cn(buttonVariants({ variant: "outline" }), "flex-1 gap-2")}
              >
                <AppIcon name="log-in" fallback={LogIn} className="h-4 w-4"  />
                <span>Log In</span>
              </Link>
              <Link
                href={`/auth/register?redirect=/invite/${token}`}
                className={cn(buttonVariants({ variant: "default" }), "flex-1 gap-2")}
              >
                <AppIcon name="user-plus" fallback={UserPlus} className="h-4 w-4"  />
                <span>Sign Up</span>
              </Link>
            </div>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
