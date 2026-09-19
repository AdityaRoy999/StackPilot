"use client";

import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { Check, ChevronRight, Code, Laptop, Moon, Palette, Sparkles, Sun } from "lucide-react";
import api from "@/lib/api";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { UI_THEME_META, useUiTheme, type UiTheme } from "@/lib/ui-theme";
import { AppIcon, useIconSettings } from "@/lib/custom-icons";
import { useCustomThemes } from "@/lib/custom-themes";

const MODES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Laptop },
] as const;

// Module-level so the store identity is stable across renders.
const subscribeNever = () => () => {};

export function AppearanceSettings() {
  const [uiTheme, setUiTheme] = useUiTheme();
  const [iconSettings, iconActions] = useIconSettings();
  const [customThemes] = useCustomThemes();
  const { theme, setTheme } = useTheme();

  // next-themes resolves the active mode only on the client, so the selected
  // state must not be rendered during SSR. useSyncExternalStore gives a
  // hydration-safe "are we on the client yet" flag without a setState effect.
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);

  const activeMode = theme === "light" || theme === "dark" || theme === "system" ? theme : "system";

  useEffect(() => {
    api
      .get("/auth/preferences")
      .then((res) => {
        const mode = res.data?.color_mode;
        if (mode && ["light", "dark", "system"].includes(mode) && mode !== theme) {
          setTheme(mode);
        }
      })
      .catch(() => {});
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 text-foreground">
          <AppIcon name="palette" fallback={Palette} className="h-5 w-5 text-primary"  />
          <CardTitle>Appearance</CardTitle>
        </div>
        <CardDescription>
          Choose a theme for the whole interface. Colours, corner radius, elevation and typeface all
          change together.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-medium text-foreground">Theme</h4>
              <p className="text-xs text-muted-foreground">Applies instantly and is saved to your account across all devices.</p>
            </div>
            <Link href="/theme-builder">
              <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                <AppIcon name="code" fallback={Code} className="h-3.5 w-3.5 text-primary" />
                <span>Theme Builder</span>
              </Button>
            </Link>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {UI_THEME_META.map((meta) => {
              const isActive = mounted && uiTheme === meta.id;
              return (
                <button
                  key={meta.id}
                  type="button"
                  onClick={() => setUiTheme(meta.id as UiTheme)}
                  aria-pressed={isActive}
                  className={cn(
                    "group relative flex flex-col gap-3 rounded-xl border p-3 text-left transition-colors",
                    isActive
                      ? "border-primary bg-accent/40 ring-2 ring-primary/30"
                      : "border-border hover:border-primary/40 hover:bg-accent/20"
                  )}
                >
                  {isActive && (
                    // z-10 because the swatch preview is a later sibling and
                    // would otherwise paint over this badge. The ring keeps it
                    // legible against whichever colour sits under it.
                    <span className="absolute right-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background">
                      <AppIcon name="check" fallback={Check} className="h-3 w-3"  />
                    </span>
                  )}

                  {/* Miniature of the theme's own palette, not the active one. */}
                  <div
                    className="flex h-16 w-full overflow-hidden rounded-lg border border-border"
                    aria-hidden="true"
                  >
                    <span className="w-1/4" style={{ backgroundColor: meta.swatches[1] }} />
                    <span className="relative flex-1" style={{ backgroundColor: meta.swatches[0] }}>
                      <span
                        className="absolute left-2 top-3 h-2 w-10 rounded-full"
                        style={{ backgroundColor: meta.swatches[2] }}
                      />
                      <span
                        className="absolute left-2 top-7 h-1.5 w-14 rounded-full opacity-30"
                        style={{ backgroundColor: meta.swatches[2] }}
                      />
                      <span
                        className="absolute left-2 top-10 h-1.5 w-8 rounded-full opacity-20"
                        style={{ backgroundColor: meta.swatches[2] }}
                      />
                    </span>
                  </div>

                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{meta.name}</div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {meta.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Custom User Themes */}
          {customThemes.length > 0 && (
            <div className="space-y-3 pt-3 border-t border-border/60">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-foreground flex items-center gap-2">
                    <span>Custom & User Themes</span>
                    <Badge variant="outline" className="text-[10px] font-mono">JSON</Badge>
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    Themes configured and imported via the Theme Builder studio.
                  </p>
                </div>
                <Link href="/theme-builder">
                  <Button variant="ghost" size="sm" className="gap-1 text-xs text-primary h-7">
                    <span>Studio</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </Link>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {customThemes.map((theme) => {
                  const isActive = mounted && uiTheme === theme.id;
                  const bg = activeMode === "dark" ? theme.dark.background : theme.light.background;
                  const surface = activeMode === "dark" ? theme.dark.card : theme.light.card;
                  const accent = activeMode === "dark" ? theme.dark.primary : theme.light.primary;
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      onClick={() => setUiTheme(theme.id as any)}
                      aria-pressed={isActive}
                      className={cn(
                        "group relative flex flex-col gap-3 rounded-xl border p-3 text-left transition-colors cursor-pointer",
                        isActive
                          ? "border-primary bg-accent/40 ring-2 ring-primary/30"
                          : "border-border hover:border-primary/40 hover:bg-accent/20"
                      )}
                    >
                      {isActive && (
                        <span className="absolute right-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background">
                          <AppIcon name="check" fallback={Check} className="h-3 w-3" />
                        </span>
                      )}

                      <div
                        className="flex h-16 w-full overflow-hidden rounded-lg border border-border"
                        aria-hidden="true"
                      >
                        <span className="w-1/4" style={{ backgroundColor: surface }} />
                        <span className="relative flex-1" style={{ backgroundColor: bg }}>
                          <span
                            className="absolute left-2 top-3 h-2 w-10 rounded-full"
                            style={{ backgroundColor: accent }}
                          />
                          <span
                            className="absolute left-2 top-7 h-1.5 w-14 rounded-full opacity-30"
                            style={{ backgroundColor: accent }}
                          />
                          <span
                            className="absolute left-2 top-10 h-1.5 w-8 rounded-full opacity-20"
                            style={{ backgroundColor: accent }}
                          />
                        </span>
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-sm font-medium text-foreground truncate">{theme.name}</span>
                          <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4">Custom</Badge>
                        </div>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground line-clamp-2">
                          {theme.description}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-medium text-foreground">Mode</h4>
            <p className="text-xs text-muted-foreground">
              Each theme has its own light and dark palette.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {MODES.map((mode) => {
              const Icon = mode.icon;
              const isActive = mounted && activeMode === mode.value;
              return (
                <Button
                  key={mode.value}
                  type="button"
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setTheme(mode.value);
                    api.put("/auth/preferences", { color_mode: mode.value }).catch(() => {});
                  }}
                  aria-pressed={isActive}
                  className="gap-2"
                >
                  <AppIcon name={mode.value} fallback={Icon} size={16} className="h-4 w-4 shrink-0" />
                  <span>{mode.label}</span>
                </Button>
              );
            })}
          </div>
        </div>

        {/* Icon Style & Customization */}
        <div className="space-y-3 border-t border-border/60 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-medium text-foreground">Icons & Symbols</h4>
              <p className="text-xs text-muted-foreground">
                Switch between standard Lucide icons and custom vector icons across the entire website.
              </p>
            </div>
            <Link href="/change-icon">
              <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                <AppIcon name="sparkles" fallback={Sparkles} className="h-3.5 w-3.5 text-primary"  />
                <span>Open Icon Studio</span>
              </Button>
            </Link>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => iconActions.setMode("default")}
              className={cn(
                "flex flex-col gap-2 rounded-xl border p-4 text-left transition-all",
                mounted && iconSettings.mode === "default"
                  ? "border-primary bg-accent/40 ring-2 ring-primary/30"
                  : "border-border hover:border-primary/40 hover:bg-accent/20"
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm">Default Icons</span>
                {mounted && iconSettings.mode === "default" && (
                  <Badge variant="secondary" className="text-[10px]">Active</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Standard clean Lucide stroke icons.</p>
              <div className="mt-2 flex items-center gap-3 text-foreground">
                <AppIcon name="layout-dashboard" size={18} forceMode="default" />
                <AppIcon name="server" size={18} forceMode="default" />
                <AppIcon name="activity" size={18} forceMode="default" />
                <AppIcon name="star" size={18} forceMode="default" />
                <AppIcon name="settings" size={18} forceMode="default" />
              </div>
            </button>

            <button
              type="button"
              onClick={() => iconActions.setMode("custom")}
              className={cn(
                "flex flex-col gap-2 rounded-xl border p-4 text-left transition-all",
                mounted && iconSettings.mode === "custom"
                  ? "border-primary bg-primary/10 ring-2 ring-primary/30"
                  : "border-border hover:border-primary/40 hover:bg-accent/20"
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm flex items-center gap-1.5">
                  <span>Custom Icons</span>
                  <AppIcon name="sparkles" fallback={Sparkles} className="h-3.5 w-3.5 text-primary"  />
                </span>
                {mounted && iconSettings.mode === "custom" && (
                  <Badge className="text-[10px]">Active</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Tailored duotone vector icons with active accents and custom SVG support.</p>
              <div className="mt-2 flex items-center gap-3 text-primary">
                <AppIcon name="layout-dashboard" size={18} forceMode="custom" />
                <AppIcon name="server" size={18} forceMode="custom" />
                <AppIcon name="activity" size={18} forceMode="custom" />
                <AppIcon name="star" size={18} forceMode="custom" />
                <AppIcon name="settings" size={18} forceMode="custom" />
              </div>
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
