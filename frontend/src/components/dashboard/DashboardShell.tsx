"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  LayoutDashboard,
  Server,
  Settings,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  Laptop,
  Activity,
  Star,
  Network,
  Boxes,
  Gauge,
  KeyRound,
  Smartphone,
} from "@/lib/platform-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTheme } from "next-themes";
import api from "@/lib/api";
import { isRemotePlatform, forgetRemoteDevice } from "@/lib/remote-platform";
import { remoteRequest } from "@/lib/remote";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { AppIcon } from "@/lib/custom-icons";
import { setUiTheme, UI_THEME_STORAGE_KEY, type UiTheme } from "@/lib/ui-theme";

const navigation = [
  { name: "Projects", href: "/dashboard", icon: LayoutDashboard, iconName: "layout-dashboard" },
  { name: "Deployments", href: "/dashboard/deployments", icon: Server, iconName: "server" },
  { name: "Logs & Monitoring", href: "/dashboard/logging-monitoring", icon: Activity, iconName: "activity" },
  { name: "Visualization", href: "/dashboard/logging-monitoring/visualization", icon: Gauge, iconName: "gauge", nested: true },
  { name: "Infrastructure", href: "/dashboard/logging-monitoring/infrastructure", icon: Network, iconName: "network", nested: true },
  { name: "Cluster Builder", href: "/dashboard/logging-monitoring/clusters", icon: Boxes, iconName: "boxes", nested: true },
  { name: "AI Agent", href: "/dashboard/ai", icon: Star, iconName: "star", filled: true },
  { name: "Secrets", href: "/dashboard/secrets", icon: KeyRound, iconName: "key-round" },
  { name: "Organization", href: "/dashboard/organization", icon: Building2, iconName: "building-2" },
  { name: "Remote", href: "/dashboard/remote", icon: Smartphone, iconName: "smartphone" },
  { name: "Settings", href: "/dashboard/settings", icon: Settings, iconName: "settings" },
];

// Routes that own their entire viewport (no shell padding, no page scroll).
const FULL_BLEED_ROUTES = ["/dashboard/ai"];

const themeOptions = [
  { value: "light", label: "Light", icon: Sun, iconName: "sun" },
  { value: "dark", label: "Dark", icon: Moon, iconName: "moon" },
  { value: "system", label: "System", icon: Laptop, iconName: "laptop" },
] as const;

const SIDEBAR_STORAGE_KEY = "sidebar-collapsed";

const subscribeNever = () => () => {};
const mobileSidebarQuery = "(max-width: 639px)";

function subscribeMobileSidebar(listener: () => void) {
  const media = window.matchMedia(mobileSidebarQuery);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

function getMobileSidebarSnapshot() {
  return window.matchMedia(mobileSidebarQuery).matches;
}

// localStorage is external state, so it is read through useSyncExternalStore
// rather than mirrored into an effect. This keeps server and client markup in
// agreement during hydration and avoids cascading renders.
const sidebarListeners = new Set<() => void>();

const sidebarStore = {
  subscribe(listener: () => void) {
    sidebarListeners.add(listener);
    return () => {
      sidebarListeners.delete(listener);
    };
  },
  getSnapshot() {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  },
  getServerSnapshot() {
    return false;
  },
  set(collapsed: boolean) {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
    for (const listener of sidebarListeners) listener();
    api.put("/auth/preferences", { sidebar_collapsed: collapsed }).catch(() => {});
  },
};

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const asideRef = useRef<HTMLElement | null>(null);
  const colorModeInitialized = useRef(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isCollapsed = useSyncExternalStore(
    sidebarStore.subscribe,
    sidebarStore.getSnapshot,
    sidebarStore.getServerSnapshot
  );
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
  const isMobileSidebar = useSyncExternalStore(subscribeMobileSidebar, getMobileSidebarSnapshot, () => false);
  const sidebarCollapsed = isCollapsed && !isMobileSidebar;
  const { theme, setTheme } = useTheme();
  const activeThemeValue = mounted && (theme === "light" || theme === "dark" || theme === "system") ? theme : "system";
  const activeTheme = themeOptions.find((option) => option.value === activeThemeValue) ?? themeOptions[2];
  const ActiveThemeIcon = activeTheme.icon;
  const isFullBleed = FULL_BLEED_ROUTES.includes(pathname);

  // Animate width only after the first paint, so restoring a collapsed sidebar
  // on load appears instant instead of sliding in from the expanded width.
  useEffect(() => {
    const element = asideRef.current;
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      element.dataset.animate = "true";
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Share the account response with Settings and source pickers instead of
  // starting another auth request for every page mount.
  const sessionQuery = useQuery({
    queryKey: ["me"],
    queryFn: async ({ signal }) => (await api.get<{ user?: { preferences?: {
      sidebar_collapsed?: boolean; ui_theme?: UiTheme; color_mode?: string;
    } } }>("/auth/me", { signal })).data,
    refetchInterval: 60000,
    retry: false,
  });
  useEffect(() => {
    const prefs = sessionQuery.data?.user?.preferences;
    if (!prefs) return;
    if (prefs.sidebar_collapsed !== undefined && prefs.sidebar_collapsed !== sidebarStore.getSnapshot()) {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(prefs.sidebar_collapsed));
      for (const listener of sidebarListeners) listener();
    }
    if (prefs.ui_theme && window.localStorage.getItem(UI_THEME_STORAGE_KEY) !== prefs.ui_theme) setUiTheme(prefs.ui_theme);
    if (!colorModeInitialized.current && prefs.color_mode && ["light", "dark", "system"].includes(prefs.color_mode)) {
      colorModeInitialized.current = true;
      setTheme(prefs.color_mode);
    }
  }, [sessionQuery.data, setTheme]);
  useEffect(() => {
    const status = (sessionQuery.error as { response?: { status?: number } } | null)?.response?.status;
    if (status === 401) window.location.href = isRemotePlatform() ? "/remote" : "/auth/login";
  }, [sessionQuery.error]);

  const toggleSidebar = () => {
    sidebarStore.set(!isCollapsed);
  };

  const handleLogout = async () => {
    if (isRemotePlatform()) {
      try { await remoteRequest("/device", undefined, "DELETE"); }
      finally { forgetRemoteDevice(); window.location.href = "/remote"; }
      return;
    }
    try {
      await api.post("/auth/logout");
    } finally {
      window.location.href = "/auth/login";
    }
  };

  useEffect(() => {
    if (isRemotePlatform() && "serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/remote-sw.js", { scope: "/" }).catch(() => {});
    }
  }, []);

  // Fixed icon tracks and padding keep every row anchored while the rail narrows.
  const labelClass = cn(
    "min-w-0 overflow-hidden truncate whitespace-nowrap text-left text-sm font-medium transition-opacity duration-150",
    sidebarCollapsed ? "opacity-0" : "opacity-100"
  );

  const rowClass = "grid h-9 grid-cols-[36px_148px] items-center gap-2 overflow-hidden rounded-md";

  const renderSidebarLink = (item: (typeof navigation)[number], isActive: boolean) => (
    <Link
      key={item.name}
      href={item.href}
      prefetch={false}
      onPointerEnter={() => { if (pathname !== item.href) router.prefetch(item.href); }}
      onFocus={() => { if (pathname !== item.href) router.prefetch(item.href); }}
      onClick={() => setMobileMenuOpen(false)}
      aria-label={item.name}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        rowClass,
        "relative w-full",
        isActive
          ? "bg-accent font-semibold text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      )}
    >
      <span className="flex size-9 items-center justify-center">
        <AppIcon
          name={item.iconName}
          fallback={item.icon}
          size={18}
          className={cn("size-[18px]", isActive ? "text-primary" : "text-current")}
        />
      </span>
      <span aria-hidden={sidebarCollapsed} className={labelClass}>{item.name}</span>
    </Link>
  );

  const sidebarContent = (
        <TooltipProvider>
          <div className="grid h-11 shrink-0 grid-cols-[36px_148px] items-center gap-2 overflow-hidden px-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => isMobileSidebar ? setMobileMenuOpen(false) : toggleSidebar()}
                    aria-label={isMobileSidebar ? "Close navigation" : isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                    aria-expanded={isMobileSidebar ? mobileMenuOpen : !isCollapsed}
                    className="size-9 shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    {isCollapsed ? (
                      <AppIcon name="panel-left-open" fallback={PanelLeftOpen} size={18} className="h-[18px] w-[18px]" />
                    ) : (
                      <AppIcon name="panel-left-close" fallback={PanelLeftClose} size={18} className="h-[18px] w-[18px]" />
                    )}
                  </Button>
                }
              />
              <TooltipContent side="right">{isCollapsed ? "Expand sidebar" : "Collapse sidebar"}</TooltipContent>
            </Tooltip>
            <span aria-hidden={sidebarCollapsed} className={cn(labelClass, "text-base font-semibold tracking-tight")}>StackPilot</span>
          </div>

          <div className="shrink-0 px-2 py-2">
            <WorkspaceSwitcher isCollapsed={sidebarCollapsed} />
          </div>

          <nav
            aria-label="Workspace navigation"
            className="no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-2 py-2"
          >
            {navigation.map((item) => {
              const isActive =
                item.name === "Projects"
                  ? pathname === "/dashboard" || pathname.startsWith("/dashboard/projects")
                  : pathname === item.href;
              return (
                <Tooltip key={item.name}>
                  <TooltipTrigger render={renderSidebarLink(item, isActive)} />
                  <TooltipContent side="right">{item.name}</TooltipContent>
                </Tooltip>
              );
            })}
          </nav>

          <div
            className="flex shrink-0 flex-col gap-0.5 px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
          >
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" aria-label="Theme" className={cn(rowClass, "w-full justify-start p-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground")} />}>
                <span className="flex size-9 items-center justify-center"><AppIcon name={activeTheme.iconName} fallback={ActiveThemeIcon} size={18} className="h-[18px] w-[18px]" /></span>
                <span aria-hidden={sidebarCollapsed} className={labelClass}>{activeTheme.label}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent side={isMobileSidebar ? "top" : "right"} align={isMobileSidebar ? "start" : "end"} sideOffset={10} className="!w-auto min-w-0 max-w-[calc(100vw-2rem)] !rounded-xl" aria-label="Theme options">
                <DropdownMenuRadioGroup className="flex gap-1" value={activeThemeValue} onValueChange={value => {
                  colorModeInitialized.current = true;
                  setTheme(String(value));
                  api.put("/auth/preferences", { color_mode: value }).catch(() => {});
                }}>
                  {themeOptions.map(option => <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick className="theme-option !flex-col !gap-1 !rounded-lg !px-2 !py-2 min-h-14 w-16 text-xs [&>[data-slot=dropdown-menu-radio-item-indicator]]:hidden"><AppIcon name={option.iconName} fallback={option.icon} size={16} /><span>{option.label}</span></DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    onClick={handleLogout}
                    aria-label="Logout"
                    className={cn(
                      rowClass,
                      "w-full justify-start p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    )}
                  >
                    <span className="flex size-9 items-center justify-center">
                      <AppIcon name="log-out" fallback={LogOut} size={18} className="h-[18px] w-[18px]" />
                    </span>
                    <span aria-hidden={sidebarCollapsed} className={labelClass}>Logout</span>
                  </Button>
                }
              />
              <TooltipContent side="right">Logout</TooltipContent>
            </Tooltip>
          </div>


        </TooltipProvider>
  );

  return (
    <div data-slot="dashboard-shell" className="flex h-dvh overflow-hidden bg-background text-foreground">
      <aside
        ref={asideRef}
        data-collapsed={sidebarCollapsed}
        className={cn(
          "z-20 hidden h-full shrink-0 flex-col bg-card transition-none data-[animate=true]:transition-[width] data-[animate=true]:duration-200 data-[animate=true]:ease-out motion-reduce:!transition-none sm:flex",
          sidebarCollapsed ? "w-[52px]" : "w-[208px]"
        )}
      >
        {sidebarContent}
      </aside>

      <Dialog open={mobileMenuOpen && isMobileSidebar} onOpenChange={setMobileMenuOpen}>
        <DialogContent
          data-mobile-navigation="true"
          showCloseButton={false}
          className="!left-0 !top-0 !flex !h-dvh !max-h-dvh !w-[min(20rem,calc(100vw-2rem))] !max-w-none !translate-x-0 !translate-y-0 !flex-col !rounded-none bg-card p-0 pt-[env(safe-area-inset-top)]"
        >
          <DialogTitle className="sr-only">Navigation</DialogTitle>
          <DialogDescription className="sr-only">Switch workspaces and navigate StackPilot.</DialogDescription>
          {sidebarContent}
        </DialogContent>
      </Dialog>

      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", !isFullBleed && "bg-card")}>
        {!isFullBleed && (
          <header data-workspace-header className="hidden h-11 shrink-0 items-center justify-between gap-4 bg-card px-5 sm:flex md:px-8">
            <div className="flex min-w-0 items-center gap-3 text-sm">
              <span className="text-muted-foreground">Workspace</span><span aria-hidden="true" className="text-muted-foreground/50">/</span>
              <span className="truncate font-medium">{navigation.find(item => item.href === pathname)?.name || (pathname.startsWith("/dashboard/projects/") ? "Project overview" : "Dashboard")}</span>
            </div>

          </header>
        )}
        <header className="flex shrink-0 items-center gap-3 bg-card px-3 pt-[env(safe-area-inset-top)] sm:hidden">
          <Button variant="ghost" size="icon" className="size-11 shrink-0" aria-label="Open navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(true)}>
            <PanelLeftOpen className="h-5 w-5" />
          </Button>
          <Link prefetch={false} href="/dashboard" className="min-w-0 truncate font-semibold">StackPilot</Link>
          <span className="ml-auto truncate text-xs text-muted-foreground">{navigation.find(item => item.href === pathname)?.name || "Dashboard"}</span>
        </header>
        <main
          data-full-bleed={isFullBleed}
          className={cn(
            "min-h-0 min-w-0 flex-1 bg-background/50 scrollbar-thin",
            isFullBleed ? "overflow-hidden p-0" : "rounded-tl-none bg-background overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:rounded-tl-2xl sm:p-5 md:p-8"
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
