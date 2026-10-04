"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Building2,
  Check,
  Copy,
  Edit2,
  Loader2,
  Mail,
  Plus,
  Shield,
  Trash2,
  UserMinus,
  Users,
} from "@/lib/platform-icons";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import api from "@/lib/api";
import { AppIcon } from "@/lib/custom-icons";

interface Organization {
  id: string;
  name: string;
  slug: string;
  is_personal: boolean;
  role: Role;
  member_count: number;
  created_at: string;
}

interface Member {
  user_id: string;
  username: string;
  email: string;
  full_name: string;
  role: Role;
  joined_at: string;
}

interface Invitation {
  id: string;
  organization_id: string;
  email: string;
  role: Role;
  token: string;
  created_at: string;
  expires_at: string;
  is_expired: boolean;
  inviter_username: string;
}

type Role = "owner" | "admin" | "member" | "viewer";

const ROLE_ORDER: Role[] = ["viewer", "member", "admin", "owner"];
const rank = (role: Role) => ROLE_ORDER.indexOf(role);

const ROLE_SUMMARY: Record<Role, string> = {
  owner: "Full administrative ownership, including renaming and deleting the organization",
  admin: "Manage organization members, invite teammates, create and delete projects",
  member: "Create and deploy projects, manage environment variables and secrets",
  viewer: "Read-only access to organization projects and deployments",
};

function errorText(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "response" in error) {
    const detail = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
    if (detail) return detail;
  }
  return fallback;
}

export default function OrganizationPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [editName, setEditName] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const orgsQuery = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => {
      const res = await api.get<{ organizations: Organization[] }>("/organizations");
      return res.data.organizations || [];
    },
  });

  const organizations = orgsQuery.data || [];
  const active = organizations.find((org) => org.id === selectedId) || organizations[0];

  const membersQuery = useQuery({
    queryKey: ["organization-members", active?.id],
    queryFn: async () => {
      const res = await api.get<{ members: Member[] }>(`/organizations/${active!.id}/members`);
      return res.data.members || [];
    },
    enabled: Boolean(active?.id),
  });

  const invitationsQuery = useQuery({
    queryKey: ["organization-invitations", active?.id],
    queryFn: async () => {
      const res = await api.get<{ invitations: Invitation[] }>(`/organizations/${active!.id}/invitations`);
      return res.data.invitations || [];
    },
    enabled: Boolean(active?.id && !active.is_personal && rank(active.role) >= rank("admin")),
  });

  const createOrg = useMutation({
    mutationFn: async (name: string) => (await api.post("/organizations", { name })).data,
    onSuccess: (data) => {
      toast.success("Organization created successfully");
      setCreateOpen(false);
      setNewName("");
      setSelectedId(data?.organization?.id || "");
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (error) => toast.error(errorText(error, "Could not create the organization")),
  });

  const updateOrg = useMutation({
    mutationFn: async (name: string) =>
      (await api.patch(`/organizations/${active!.id}`, { name })).data,
    onSuccess: () => {
      toast.success("Organization renamed successfully");
      setRenameOpen(false);
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (error) => toast.error(errorText(error, "Could not rename organization")),
  });

  const deleteOrg = useMutation({
    mutationFn: async () => (await api.delete(`/organizations/${active!.id}`)).data,
    onSuccess: () => {
      toast.success("Organization deleted");
      setDeleteOpen(false);
      setDeleteConfirmText("");
      setSelectedId("");
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error) => toast.error(errorText(error, "Could not delete organization")),
  });

  const addMember = useMutation({
    mutationFn: async () =>
      (await api.post(`/organizations/${active!.id}/members`, { email: inviteEmail, role: inviteRole })).data,
    onSuccess: (data) => {
      if (data?.invited) {
        toast.success(data.message || "Invitation created for unregistered user");
      } else {
        toast.success("Member added successfully");
      }
      setInviteEmail("");
      queryClient.invalidateQueries({ queryKey: ["organization-members", active?.id] });
      queryClient.invalidateQueries({ queryKey: ["organization-invitations", active?.id] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (error) => toast.error(errorText(error, "Could not add or invite member")),
  });

  const revokeInvitation = useMutation({
    mutationFn: async (invitationId: string) =>
      (await api.delete(`/organizations/${active!.id}/invitations/${invitationId}`)).data,
    onSuccess: () => {
      toast.success("Invitation revoked");
      queryClient.invalidateQueries({ queryKey: ["organization-invitations", active?.id] });
    },
    onError: (error) => toast.error(errorText(error, "Could not revoke invitation")),
  });

  const changeRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: Role }) =>
      (await api.patch(`/organizations/${active!.id}/members/${userId}`, { role })).data,
    onSuccess: () => {
      toast.success("Role updated");
      queryClient.invalidateQueries({ queryKey: ["organization-members", active?.id] });
    },
    onError: (error) => toast.error(errorText(error, "Could not change role")),
  });

  const removeMember = useMutation({
    mutationFn: async (userId: string) =>
      (await api.delete(`/organizations/${active!.id}/members/${userId}`)).data,
    onSuccess: () => {
      toast.success("Member removed");
      queryClient.invalidateQueries({ queryKey: ["organization-members", active?.id] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (error) => toast.error(errorText(error, "Could not remove member")),
  });

  const handleCopyInviteLink = (token: string) => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const inviteUrl = `${origin}/invite/${token}`;
    navigator.clipboard.writeText(inviteUrl);
    setCopiedToken(token);
    toast.success("Invite link copied to clipboard");
    setTimeout(() => setCopiedToken(null), 2000);
  };

  const isOwner = active?.role === "owner";
  const canManage = active ? rank(active.role) >= rank("admin") : false;
  const isPersonal = active?.is_personal ?? false;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Organizations & Workspaces</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your personal workspace and collaborate with team members across shared projects.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2">
          <AppIcon name="plus" fallback={Plus} size={16} />
          <span>New organization</span>
        </Button>
      </div>

      {orgsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
          <AppIcon name="loader2" fallback={Loader2} className="h-5 w-5 animate-spin text-primary"  />
          <span>Loading organizations…</span>
        </div>
      ) : organizations.length === 0 ? (
        <Card className="border-dashed py-12 text-center bg-card">
          <CardContent className="text-muted-foreground">
            No organizations found.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[290px_1fr]">
          {/* Organization List Sidebar */}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1 pb-1">
              Your Workspaces
            </p>
            {organizations.map((org) => (
              <button
                key={org.id}
                type="button"
                onClick={() => setSelectedId(org.id)}
                className={cn(
                  "w-full rounded-xl border p-3.5 text-left transition-all",
                  org.id === active?.id
                    ? "border-primary bg-primary/5 shadow-xs"
                    : "border-border/70 bg-card hover:border-primary/40 hover:bg-accent/30"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <AppIcon name="building-2" fallback={Building2} size={16} className="shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-semibold text-foreground">{org.name}</span>
                  </div>
                  <Badge variant="outline" className="capitalize text-[10px] px-1.5 py-0 shrink-0">
                    {org.role}
                  </Badge>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground flex items-center gap-1.5">
                  <AppIcon name="users" fallback={Users} size={12} />
                  <span>{org.member_count} member{org.member_count === 1 ? "" : "s"}</span>
                  {org.is_personal && <span className="text-primary font-medium">· Personal</span>}
                </p>
              </button>
            ))}
          </div>

          {/* Active Organization Details */}
          <div className="space-y-6">
            {/* Header Card with Settings Actions */}
            <Card className="bg-card border-border/70">
              <CardHeader className="pb-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2.5">
                      <CardTitle className="text-xl font-bold text-foreground">{active?.name}</CardTitle>
                      <Badge variant="outline" className="capitalize text-xs">
                        {active?.role}
                      </Badge>
                      {active?.is_personal && (
                        <Badge variant="secondary" className="text-xs">
                          Default Personal Workspace
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="text-xs font-mono text-muted-foreground">
                      slug: {active?.slug} · created {active?.created_at ? new Date(active.created_at).toLocaleDateString() : ""}
                    </CardDescription>
                  </div>

                  {!isPersonal && (
                    <div className="flex items-center gap-2">
                      {canManage && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditName(active?.name || "");
                            setRenameOpen(true);
                          }}
                          className="h-8 gap-1.5 text-xs"
                        >
                          <AppIcon name="edit2" fallback={Edit2} className="h-3.5 w-3.5"  />
                          <span>Rename</span>
                        </Button>
                      )}
                      {isOwner && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setDeleteConfirmText("");
                            setDeleteOpen(true);
                          }}
                          className="h-8 gap-1.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                          <AppIcon name="trash2" fallback={Trash2} className="h-3.5 w-3.5"  />
                          <span>Delete</span>
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </CardHeader>
            </Card>

            {isPersonal ? (
              <Card className="border-border/60 bg-muted/20">
                <CardContent className="flex items-start gap-3 py-4 text-sm text-muted-foreground">
                  <AppIcon name="shield" fallback={Shield} className="mt-0.5 h-4 w-4 shrink-0 text-primary"  />
                  <p>
                    This is your personal workspace where your private projects live. It is private to you and cannot have additional members. To share and collaborate with teammates, create a new shared organization.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Add Member / Invite Teammate */}
                {canManage && (
                  <Card className="bg-card border-border/70">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base font-semibold">Invite Teammate</CardTitle>
                      <CardDescription>
                        Invite team members by email. If they do not have an account yet, a secure invite link is generated and they will automatically join when they register.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
                          <Label htmlFor="invite-email" className="text-xs font-semibold text-muted-foreground uppercase">
                            Email Address
                          </Label>
                          <Input
                            id="invite-email"
                            type="email"
                            value={inviteEmail}
                            onChange={(event) => setInviteEmail(event.target.value)}
                            placeholder="teammate@company.com"
                            className="h-10 bg-muted/30"
                          />
                        </div>
                        <div className="flex w-40 flex-col gap-1.5">
                          <Label htmlFor="invite-role" className="text-xs font-semibold text-muted-foreground uppercase">
                            Role
                          </Label>
                          <Select
                            value={inviteRole}
                            onValueChange={(val) => setInviteRole((val || "member") as Role)}
                          >
                            <SelectTrigger id="invite-role" className="h-10 w-full capitalize">
                              <SelectValue placeholder="Select role" />
                            </SelectTrigger>
                            <SelectContent>
                              {ROLE_ORDER.slice()
                                .reverse()
                                .filter((role) => rank(role) <= rank(active?.role ?? "viewer"))
                                .map((role) => (
                                  <SelectItem key={role} value={role} className="capitalize">
                                    {role}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Button
                          onClick={() => addMember.mutate()}
                          disabled={!inviteEmail.trim() || addMember.isPending}
                          className="h-10 px-4 gap-2"
                        >
                          {addMember.isPending ? (
                            <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  />
                          ) : (
                            <AppIcon name="mail" fallback={Mail} className="h-4 w-4"  />
                          )}
                          <span>Send Invite</span>
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">{ROLE_SUMMARY[inviteRole]}</p>
                    </CardContent>
                  </Card>
                )}

                {/* Pending Invitations Section */}
                {canManage && (invitationsQuery.data?.length ?? 0) > 0 && (
                  <Card className="bg-card border-border/70">
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-base font-semibold">
                        <AppIcon name="mail" fallback={Mail} className="h-4 w-4 text-primary"  />
                        <span>Pending Invitations ({invitationsQuery.data?.length})</span>
                      </CardTitle>
                      <CardDescription>
                        Users who have been invited but have not yet accepted or registered.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2.5">
                      {invitationsQuery.isLoading ? (
                        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                          <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  />
                          <span>Loading invitations…</span>
                        </div>
                      ) : (
                        invitationsQuery.data?.map((invite) => (
                          <div
                            key={invite.id}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 p-3"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="truncate text-sm font-semibold text-foreground">{invite.email}</p>
                                <Badge variant="outline" className="capitalize text-[10px]">
                                  {invite.role}
                                </Badge>
                                {invite.is_expired && (
                                  <Badge variant="destructive" className="text-[10px]">
                                    Expired
                                  </Badge>
                                )}
                              </div>
                              <p className="truncate text-xs text-muted-foreground mt-0.5">
                                Expires {new Date(invite.expires_at).toLocaleDateString()}
                                {invite.inviter_username ? ` · invited by @${invite.inviter_username}` : ""}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleCopyInviteLink(invite.token)}
                                className="h-7 gap-1 text-xs"
                              >
                                {copiedToken === invite.token ? (
                                  <>
                                    <AppIcon name="check" fallback={Check} className="h-3 w-3 text-emerald-500"  />
                                    <span>Copied</span>
                                  </>
                                ) : (
                                  <>
                                    <AppIcon name="copy" fallback={Copy} className="h-3 w-3"  />
                                    <span>Copy Link</span>
                                  </>
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => revokeInvitation.mutate(invite.id)}
                                disabled={revokeInvitation.isPending}
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                              >
                                <AppIcon name="trash2" fallback={Trash2} className="h-3.5 w-3.5"  />
                              </Button>
                            </div>
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>
                )}
              </>
            )}

            {/* Members List */}
            <Card className="bg-card border-border/70">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <AppIcon name="users" fallback={Users} className="h-4 w-4 text-primary"  />
                  <span>Members ({membersQuery.data?.length ?? 0})</span>
                </CardTitle>
                <CardDescription>
                  Roles: Viewer &lt; Member &lt; Admin &lt; Owner. Member required to reveal secrets and deploy; Admin required to delete projects.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {membersQuery.isLoading ? (
                  <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                    <AppIcon name="loader2" fallback={Loader2} className="h-4 w-4 animate-spin"  />
                    <span>Loading members…</span>
                  </div>
                ) : (
                  (membersQuery.data || []).map((member) => (
                    <div
                      key={member.user_id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3 bg-card"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-semibold text-foreground">
                            {member.full_name || member.username}
                          </p>
                          {member.full_name && (
                            <span className="text-xs text-muted-foreground">(@{member.username})</span>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {canManage && !isPersonal ? (
                          <Select
                            value={member.role}
                            onValueChange={(val) => {
                              if (val) changeRole.mutate({ userId: member.user_id, role: val as Role });
                            }}
                            disabled={rank(member.role) > rank(active?.role ?? "viewer")}
                          >
                            <SelectTrigger size="sm" className="h-8 w-28 bg-muted/30 capitalize text-xs font-medium">
                              <SelectValue placeholder="Role" />
                            </SelectTrigger>
                            <SelectContent>
                              {ROLE_ORDER.slice()
                                .reverse()
                                .filter((role) => rank(role) <= rank(active?.role ?? "viewer"))
                                .map((role) => (
                                  <SelectItem key={role} value={role} className="capitalize text-xs">
                                    {role}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant="outline" className="capitalize text-xs">
                            {member.role}
                          </Badge>
                        )}
                        {canManage && !isPersonal && rank(member.role) < rank(active?.role ?? "viewer") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeMember.mutate(member.user_id)}
                            disabled={removeMember.isPending}
                            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                            aria-label="Remove member"
                          >
                            <AppIcon name="user-minus" fallback={UserMinus} className="h-4 w-4"  />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Create Organization Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Team Organization</DialogTitle>
            <DialogDescription>
              Create a shared workspace for your team. You become its owner and can invite teammates with customized roles.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="org-name">Organization Name</Label>
            <Input
              id="org-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Engineering Team"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createOrg.mutate(newName.trim())}
              disabled={!newName.trim() || createOrg.isPending}
            >
              {createOrg.isPending && <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />}
              Create Organization
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Organization Dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Organization</DialogTitle>
            <DialogDescription>
              Change the display name of {active?.name}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="rename-org">New Name</Label>
            <Input
              id="rename-org"
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => updateOrg.mutate(editName.trim())}
              disabled={!editName.trim() || updateOrg.isPending}
            >
              {updateOrg.isPending && <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Organization Confirmation Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AppIcon name="alert-triangle" fallback={AlertTriangle} className="h-5 w-5"  />
              <span>Delete Organization</span>
            </DialogTitle>
            <DialogDescription>
              This action is permanent and cannot be undone. All projects and resources under <strong>{active?.name}</strong> will be permanently deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="delete-confirm" className="text-xs font-semibold text-muted-foreground">
              Type <strong>{active?.name}</strong> to confirm:
            </Label>
            <Input
              id="delete-confirm"
              value={deleteConfirmText}
              onChange={(event) => setDeleteConfirmText(event.target.value)}
              placeholder={active?.name}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteOrg.mutate()}
              disabled={deleteConfirmText.trim() !== active?.name || deleteOrg.isPending}
            >
              {deleteOrg.isPending && <AppIcon name="loader2" fallback={Loader2} className="mr-2 h-4 w-4 animate-spin"  />}
              Delete Organization
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
