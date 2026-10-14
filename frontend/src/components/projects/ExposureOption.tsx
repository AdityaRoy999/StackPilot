import { Globe } from "@/lib/platform-icons";
import { Plug } from "lucide-react";
import { TechnologyIcon } from "./TechnologyIcon";

export type ExposureMode = "direct" | "portless" | "cloudflare_tunnel";
export const exposureOptions = [
  { value: "direct", label: <ExposureOption mode="direct" /> },
  { value: "portless", label: <ExposureOption mode="portless" /> },
  { value: "cloudflare_tunnel", label: <ExposureOption mode="cloudflare_tunnel" /> },
];
export const runtimeOptions = [
  { value: "docker", label: <span className="inline-flex items-center gap-2"><TechnologyIcon id="docker" className="size-4" />Docker</span> },
  { value: "kubernetes", label: <span className="inline-flex items-center gap-2"><TechnologyIcon id="kubernetes" className="size-4" />Kubernetes</span> },
];
export function ExposureOption({ mode, compact = false }: { mode: ExposureMode; compact?: boolean }) {
  const label = mode === "cloudflare_tunnel" ? (compact ? "Cloudflare" : "Cloudflare Tunnel (HTTPS)")
    : mode === "portless" ? (compact ? "Portless" : "Portless (.localhost)")
    : compact ? "Direct Port" : "Direct Port (localhost)";
  return <span className="inline-flex min-w-0 items-center gap-2">{mode === "cloudflare_tunnel" ? <TechnologyIcon id="cloudflare" className="size-4" /> : mode === "portless" ? <Globe className="size-4" /> : <Plug className="size-4" />}<span>{label}</span></span>;
}
