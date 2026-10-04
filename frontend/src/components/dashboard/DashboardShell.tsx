"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  Check,
} from "@/lib/platform-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  { name: "Setup guide", href: "/dashboard/setup", icon: Check, iconName: "check" },
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
  const asideRef = useRef<HTMLElement | null>(null);
  const [themeDialogOpen, setThemeDialogOpen] = useState(false);
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
      element.classList.add("transition-[width]", "duration-200", "ease-out");
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkSession = async () => {
      try {
        const res = await api.get("/auth/me");
        const prefs = res.data?.user?.preferences;
        if (prefs && !cancelled) {
          if (prefs.sidebar_collapsed !== undefined && prefs.sidebar_collapsed !== sidebarStore.getSnapshot()) {
            window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(prefs.sidebar_collapsed));
            for (const listener of sidebarListeners) listener();
          }
          if (prefs.ui_theme) {
            const currentTheme = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
            if (currentTheme !== prefs.ui_theme) {
              setUiTheme(prefs.ui_theme as UiTheme);
            }
          }
          if (prefs.color_mode && ["light", "dark", "system"].includes(prefs.color_mode)) {
            if (theme !== prefs.color_mode) {
              setTheme(prefs.color_mode);
            }
          }
        }
      } catch (error: unknown) {
        const status = (error as { response?: { status?: number } }).response?.status;
        if (!cancelled && status === 401) {
          window.location.href = isRemotePlatform() ? "/remote" : "/auth/login";
        }
      }
    };

    checkSession();
    const interval = setInterval(checkSession, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [theme, setTheme]);

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

  // The label lives in a collapsing grid column so it slides away instead of
  // popping out of the DOM. Keeping it mounted is what makes the toggle smooth.
  const labelClass = cn(
    "min-w-0 overflow-hidden truncate whitespace-nowrap text-left text-sm font-medium transition-opacity duration-150",
    sidebarCollapsed ? "opacity-0" : "opacity-100"
  );

  // Collapsed drops the gap and centers the tracks; otherwise the 8px gap sits
  // entirely to the right of the icon and shifts it off-center in the rail.
  const rowClass = (isCollapsed: boolean) =>
    cn(
      "grid h-11 items-center rounded-xl transition-[grid-template-columns] duration-200 ease-out",
      isCollapsed ? "grid-cols-[40px_0fr] justify-center gap-0" : "grid-cols-[40px_1fr] gap-2"
    );

  const renderSidebarLink = (item: (typeof navigation)[number], isActive: boolean) => (
    <Link
      key={item.name}
      href={item.href}
      onClick={() => setMobileMenuOpen(false)}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        rowClass(sidebarCollapsed),
        "relative w-full",
        isActive
          ? "bg-accent font-semibold text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      )}
    >
      <span className="flex h-10 w-10 items-center justify-center">
        <AppIcon
          name={item.iconName}
          fallback={item.icon}
          size={20}
          className={cn("h-5 w-5", isActive ? "text-primary" : "text-current")}
        />
      </span>
      <span className={labelClass}>{item.name}</span>
    </Link>
  );

  const sidebarContent = (
        <TooltipProvider>
          {/* Brand + toggle share a row, so the control never floats over content. */}
          <div
            className={cn(
              "flex h-14 shrink-0 items-center border-b border-border",
              sidebarCollapsed ? "justify-center px-2" : "justify-between pl-3 pr-2"
            )}
          >
            {!sidebarCollapsed && (
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
                  <AppIcon name="star" size={19} />
                </span>
                <span className="truncate text-base font-semibold tracking-tight">StackPilot</span>
              </span>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => isMobileSidebar ? setMobileMenuOpen(false) : toggleSidebar()}
                    aria-label={isMobileSidebar ? "Close navigation" : isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                    aria-expanded={isMobileSidebar ? mobileMenuOpen : !isCollapsed}
                    className="h-11 w-11 shrink-0 text-muted-foreground hover:text-foreground"
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
          </div>

          <div className={cn("shrink-0 py-2.5", sidebarCollapsed ? "flex justify-center px-1" : "px-3")}>
            <WorkspaceSwitcher isCollapsed={sidebarCollapsed} />
          </div>

          <nav
            className={cn(
              "no-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden py-3",
              sidebarCollapsed ? "items-center px-2" : "px-3"
            )}
          >
            {navigation.map((item) => {
              if (item.nested && !sidebarCollapsed) {
                if (item.name !== "Visualization") return null;
                return (
                  <div key="monitoring-sections" className="ml-5 flex flex-col gap-1 border-l border-border pl-4">
                    {navigation.filter((entry) => entry.nested).map((entry) =>
                      renderSidebarLink(entry, pathname === entry.href)
                    )}
                  </div>
                );
              }
              const isActive =
                item.name === "Projects"
                  ? pathname === "/dashboard" || pathname.startsWith("/dashboard/projects")
                  : pathname === item.href;
              if (!sidebarCollapsed) {
                return renderSidebarLink(item, isActive);
              }
              return (
                <Tooltip key={item.name}>
                  <TooltipTrigger render={renderSidebarLink(item, isActive)} />
                  <TooltipContent side="right">{item.name}</TooltipContent>
                </Tooltip>
              );
            })}
          </nav>

          <div
            className={cn(
              "flex shrink-0 flex-col gap-0.5 border-t border-border py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
              sidebarCollapsed ? "items-center px-2" : "px-3"
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    onClick={() => { setMobileMenuOpen(false); setThemeDialogOpen(true); }}
                    aria-label="Theme"
                    className={cn(
                      rowClass(sidebarCollapsed),
                      "w-full justify-start p-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    )}
                  >
                    <span className="flex h-10 w-10 items-center justify-center">
                      <AppIcon name={activeTheme.iconName} fallback={ActiveThemeIcon} size={18} className="h-[18px] w-[18px]" />
                    </span>
                    <span className={labelClass}>{activeTheme.label}</span>
                  </Button>
                }
              />
              <TooltipContent side="right">{activeTheme.label} theme</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    onClick={handleLogout}
                    aria-label="Logout"
                    className={cn(
                      rowClass(sidebarCollapsed),
                      "w-full justify-start p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    )}
                  >
                    <span className="flex h-10 w-10 items-center justify-center">
                      <AppIcon name="log-out" fallback={LogOut} size={18} className="h-[18px] w-[18px]" />
                    </span>
                    <span className={labelClass}>Logout</span>
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
        className={cn(
          "z-20 hidden h-full shrink-0 flex-col border-r border-border bg-card sm:flex",
          sidebarCollapsed ? "w-[60px]" : "w-[288px]"
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

          <Dialog open={themeDialogOpen} onOpenChange={setThemeDialogOpen}>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>Theme</DialogTitle>
                <DialogDescription>Choose the interface mode for this device.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                {themeOptions.map((option) => {
                  const ThemeIcon = option.icon;
                  const isSelected = activeThemeValue === option.value;

                  return (
                    <Button
                      key={option.value}
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      className="justify-start gap-2"
                      onClick={() => {
                        setTheme(option.value);
                        api.put("/auth/preferences", { color_mode: option.value }).catch(() => {});
                        setThemeDialogOpen(false);
                      }}
                    >
                      <AppIcon name={option.iconName} fallback={ThemeIcon} size={16} className="h-4 w-4 shrink-0" />
                      <span>{option.label}</span>
                    </Button>
                  );
                })}
              </div>
            </DialogContent>
          </Dialog>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-3 pt-[env(safe-area-inset-top)] sm:hidden">
          <Button variant="ghost" size="icon" className="h-12 w-12 shrink-0" aria-label="Open navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(true)}>
            <PanelLeftOpen className="h-5 w-5" />
          </Button>
          <Link href="/dashboard" className="min-w-0 truncate font-semibold">StackPilot</Link>
          <span className="ml-auto truncate text-xs text-muted-foreground">{navigation.find(item => item.href === pathname)?.name || "Dashboard"}</span>
        </header>
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1 bg-background/50 scrollbar-thin",
            isFullBleed ? "overflow-hidden p-0" : "overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-5 md:p-8"
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
