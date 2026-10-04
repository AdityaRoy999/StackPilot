"use client";

import { createContext, useContext, useEffect, useSyncExternalStore, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  is_personal: boolean;
  role: "owner" | "admin" | "member" | "viewer";
  member_count: number;
  created_at: string;
}

interface WorkspaceContextType {
  organizations: Organization[];
  activeWorkspaceId: string | null;
  activeWorkspace: Organization | null;
  setActiveWorkspaceId: (id: string | null) => void;
  isLoading: boolean;
  refetchOrganizations: () => Promise<unknown>;
}

const WORKSPACE_STORAGE_KEY = "stackpilot_active_workspace_id";
const workspaceListeners = new Set<() => void>();
let fallbackWorkspaceId: string | null = null;

function subscribeWorkspace(listener: () => void) {
  workspaceListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === WORKSPACE_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    workspaceListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getWorkspaceSnapshot() {
  try { return window.localStorage.getItem(WORKSPACE_STORAGE_KEY); }
  catch { return fallbackWorkspaceId; }
}

function setWorkspaceSnapshot(id: string | null) {
  fallbackWorkspaceId = id;
  try {
    if (id) window.localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
    else window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  } catch { /* Continue with the in-memory selection when storage is blocked. */ }
  for (const listener of workspaceListeners) listener();
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const storedWorkspaceId = useSyncExternalStore(subscribeWorkspace, getWorkspaceSnapshot, () => null);

  const pathname = usePathname();
  const isAuthPage =
    Boolean(pathname?.startsWith("/auth")) ||
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/forgot-password";

  const { data: organizations = [], isLoading, isSuccess, refetch } = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => {
      const res = await api.get<{ organizations: Organization[] }>("/organizations");
      if (!Array.isArray(res.data.organizations)) throw new Error("Invalid workspace response");
      return res.data.organizations;
    },
    enabled: !isAuthPage && !pathname?.startsWith("/remote"),
    staleTime: 30000,
  });

  const setActiveWorkspaceId = (id: string | null) => {
    setWorkspaceSnapshot(id);
  };

  const activeWorkspace = storedWorkspaceId
    ? organizations.find((o) => o.id === storedWorkspaceId) || null
    : null;
  // Never send a stale ID from another login/deleted workspace as a filter
  // while the switcher labels the selection "All Workspaces".
  const activeWorkspaceId = activeWorkspace?.id || null;
  useEffect(() => {
    if (isSuccess && storedWorkspaceId && !activeWorkspace) setWorkspaceSnapshot(null);
  }, [isSuccess, storedWorkspaceId, activeWorkspace]);

  return (
    <WorkspaceContext.Provider
      value={{
        organizations,
        activeWorkspaceId,
        activeWorkspace,
        setActiveWorkspaceId,
        isLoading,
        refetchOrganizations: refetch,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return context;
}
