"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { 
  LayoutDashboard, 
  Server, 
  Settings, 
  LogOut, 
  ChevronLeft, 
  ChevronRight, 
  Sun, 
  Moon, 
  Laptop,
  Activity,
  Star,
  Network,
  Boxes,
  Gauge,
} from "lucide-react";
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

const navigation = [
  { name: "Projects", href: "/dashboard", icon: LayoutDashboard },
  { name: "Deployments", href: "/dashboard/deployments", icon: Server },
  { name: "Logs & Monitoring", href: "/dashboard/logging-monitoring", icon: Activity },
  { name: "Visualization", href: "/dashboard/logging-monitoring/visualization", icon: Gauge, nested: true },
  { name: "Infrastructure", href: "/dashboard/logging-monitoring/infrastructure", icon: Network, nested: true },
  { name: "Cluster Builder", href: "/dashboard/logging-monitoring/clusters", icon: Boxes, nested: true },
  { name: "AI Agent", href: "/dashboard/ai", icon: Star, filled: true },
  { name: "Settings", href: "/dashboard/settings", icon: Settings },
];

const themeOptions = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Laptop },
] as const;

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("sidebar-collapsed") === "true";
  });
  const [themeDialogOpen, setThemeDialogOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const activeThemeValue = theme === "light" || theme === "dark" || theme === "system" ? theme : "system";
  const activeTheme = themeOptions.find((option) => option.value === activeThemeValue) ?? themeOptions[2];
  const ActiveThemeIcon = activeTheme.icon;

  useEffect(() => {
    let cancelled = false;

    const checkSession = async () => {
      try {
        await api.get("/auth/me");
      } catch {
        if (!cancelled) {
          window.location.href = "/auth/login";
        }
      }
    };

    checkSession();
    const interval = setInterval(checkSession, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const toggleSidebar = () => {
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    localStorage.setItem("sidebar-collapsed", String(newState));
  };

  const handleLogout = async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      window.location.href = "/auth/login";
    }
  };

  const sidebarLabelClass = cn(
    "min-w-0 overflow-hidden truncate whitespace-nowrap text-left text-sm font-semibold transition-[max-width,opacity,transform] duration-150",
    isCollapsed
      ? "pointer-events-none max-w-0 -translate-x-1 opacity-0"
      : "max-w-36 translate-x-0 opacity-100 delay-75"
  );

  const renderSidebarLink = (item: (typeof navigation)[number], isActive: boolean) => (
    <Link
      key={item.name}
      href={item.href}
      className={cn(
        "group grid items-center rounded-xl text-sm font-semibold transition-colors",
        "overflow-hidden",
        isCollapsed
          ? "h-10 w-10 grid-cols-[40px_0fr] gap-0 justify-items-center px-0"
          : cn("h-10 w-full grid-cols-[40px_1fr] gap-3 px-0", item.nested && "ml-3 w-[calc(100%-0.75rem)]"),
        isActive
          ? "bg-accent text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground"
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-lg">
        <item.icon
          className={cn("h-5 w-5", isActive ? "text-primary" : "text-current")}
          fill={item.filled ? "currentColor" : "none"}
          strokeWidth={item.filled ? 2.4 : 2}
        />
      </div>
      {!isCollapsed && <span className={sidebarLabelClass}>{item.name}</span>}
    </Link>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside
        className={cn(
          "relative z-20 flex h-full shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 ease-out",
          isCollapsed ? "w-[72px]" : "w-[232px]"
        )}
      >
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleSidebar}
                  aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  className="absolute -right-3 top-8 z-30 h-7 w-7 rounded-full border border-border bg-card shadow-md hover:bg-accent"
                >
                  {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                </Button>
              }
            />
            <TooltipContent side="right">{isCollapsed ? "Expand sidebar" : "Collapse sidebar"}</TooltipContent>
          </Tooltip>

          <div className="flex h-full flex-col px-4 py-4">
            <div className="h-4 shrink-0" />
            <nav className={cn("space-y-2", isCollapsed ? "flex w-10 flex-col items-center" : "w-full")}>
              {navigation.map((item) => {
                const isActive = pathname === item.href;
                if (!isCollapsed) {
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

            <div className={cn("mt-auto flex shrink-0 flex-col gap-4 border-t border-border pt-5", isCollapsed ? "w-10 items-center" : "w-full items-stretch")}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      onClick={() => setThemeDialogOpen(true)}
                      className={cn(
                        "grid items-center rounded-xl p-0 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground",
                        isCollapsed
                          ? "h-10 w-10 grid-cols-[40px_0fr] gap-0 justify-items-center"
                          : "h-10 w-full grid-cols-[40px_1fr] gap-3"
                      )}
                      aria-label="Theme"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                        <ActiveThemeIcon className="h-5 w-5" />
                      </div>
                      {!isCollapsed && <span className={sidebarLabelClass}>{activeTheme.label}</span>}
                    </Button>
                  }
                />
                <TooltipContent side={isCollapsed ? "right" : "top"}>{activeTheme.label} theme</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      onClick={handleLogout}
                      className={cn(
                        "grid items-center rounded-xl p-0 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive",
                        isCollapsed
                          ? "h-10 w-10 grid-cols-[40px_0fr] gap-0 justify-items-center"
                          : "h-10 w-full grid-cols-[40px_1fr] gap-3"
                      )}
                      aria-label="Logout"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                        <LogOut className="h-5 w-5" />
                      </div>
                      {!isCollapsed && <span className={sidebarLabelClass}>Logout</span>}
                    </Button>
                  }
                />
                <TooltipContent side={isCollapsed ? "right" : "top"}>Logout</TooltipContent>
              </Tooltip>
            </div>
          </div>

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
                      className="justify-start"
                      onClick={() => {
                        setTheme(option.value);
                        setThemeDialogOpen(false);
                      }}
                    >
                      <ThemeIcon className="mr-2 h-4 w-4" />
                      {option.label}
                    </Button>
                  );
                })}
              </div>
            </DialogContent>
          </Dialog>
        </TooltipProvider>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <main className="flex-1 overflow-y-auto bg-background/50 p-5 scrollbar-thin md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
