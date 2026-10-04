"use client";

import React, { useEffect, useSyncExternalStore } from "react";
import api from "@/lib/api";
import { toast } from "sonner";
import { sanitizeIconSvg } from "./svg-safety";
import { PLATFORM_LUCIDE_ICONS } from "./platform-icon-map";
import { getIconPack, loadIconPack, subscribeIconPacks } from "./icon-pack-loader";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Bell,
  Blocks,
  Bot,
  Boxes,
  Brain,
  BrainCircuit,
  Building2,
  Calendar,
  Check,
  CheckCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Clipboard,
  ClipboardCopy,
  Clock,
  Cloud,
  Code,
  Code2,
  Columns,
  Copy,
  Cpu,
  Database,
  Download,
  Edit,
  Edit2,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode,
  FileCode2,
  FileText,
  Filter,
  Flame,
  Focus,
  Folder,
  FolderTree,
  FolderUp,
  Gauge,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Globe,
  HardDrive,
  HelpCircle,
  History,
  Info,
  Key,
  KeyRound,
  Laptop,
  Layers,
  LayoutDashboard,
  Link2,
  Loader2,
  Lock,
  LogIn,
  LogOut,
  Mail,
  MailCheck,
  Maximize2,
  MemoryStick,
  Menu,
  MessageSquare,
  Minimize2,
  Minus,
  Moon,
  MoreHorizontal,
  MoreVertical,
  Network,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plug,
  Plus,
  Power,
  Radio,
  RefreshCw,
  Rocket,
  RotateCcw,
  RotateCw,
  Save,
  ScrollText,
  Search,
  Send,
  Server,
  Settings,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  Sun,
  Terminal,
  TerminalSquare,
  Thermometer,
  Trash2,
  Undo2,
  Unlock,
  Unplug,
  Upload,
  UploadCloud,
  User,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  Wand2,
  Wifi,
  Wrench,
  X,
  XCircle,
  Zap,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type IconMode = "default" | "custom";
export type IconPack = "duotone" | "neon" | "minimal" | "carbon" | "iconoir" | "fluent" | "badges";

export type IconCategory =
  | "navigation"
  | "actions"
  | "infrastructure"
  | "devops"
  | "ai"
  | "observability"
  | "status"
  | "security"
  | "team"
  | "theme"
  | "arrows";

export interface IconDefinition {
  id: string;
  name: string;
  category: IconCategory;
  description: string;
  defaultIcon: LucideIcon;
  customSvg: (props: SvgIconProps) => React.ReactNode;
}

export interface SvgIconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  className?: string;
  pack?: IconPack;
  primaryColor?: string;
  secondaryColor?: string;
}

export interface IconSettings {
  mode: IconMode;
  pack: IconPack;
  overrides: Record<string, string>; // iconId -> raw custom SVG
  iconModes?: Record<string, "default" | "custom">; // fine-grained per-icon individual toggle
}

export const DEFAULT_ICON_SETTINGS: IconSettings = {
  mode: "default",
  pack: "duotone",
  overrides: {},
  iconModes: {},
};

export const ICON_STORAGE_KEY = "stackpilot.icon-settings";

/**
 * Normalizes and inverts any uploaded SVG so that:
 * - On Dark theme: rendered in crisp white (currentColor)
 * - On Light theme: rendered in crisp black (currentColor)
 * Overrides hardcoded hex colors (#000, #fff, black, white) with currentColor.
 */
export function adaptSvgColors(rawSvg: string): string {
  const safe = sanitizeIconSvg(rawSvg);
  if (!safe) return "";
  const document = new DOMParser().parseFromString(safe, "image/svg+xml");
  const svg = document.documentElement;
  if (!svg.hasAttribute("viewBox")) {
    const width = parseFloat(svg.getAttribute("width") || "24");
    const height = parseFloat(svg.getAttribute("height") || "24");
    if (width > 0 && height > 0) svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  if (!svg.hasAttribute("fill")) svg.setAttribute("fill", "currentColor");
  for (const node of [svg, ...Array.from(svg.querySelectorAll("*"))]) {
    for (const name of ["fill", "stroke", "stop-color"]) {
      const value = node.getAttribute(name);
      if (value && /^(?:black|white|#(?:000|000000|111|111111|fff|ffffff))$/i.test(value.trim())) node.setAttribute(name, "currentColor");
    }
  }
  return new XMLSerializer().serializeToString(svg);
}

// ---------------------------------------------------------------------------
// Custom Vector Icon Implementations (High-Contrast Adaptive Modern Icons)
// ---------------------------------------------------------------------------

const createSvg = (
  props: SvgIconProps,
  paths: (pack: IconPack) => React.ReactNode
) => {
  const { size = 20, className = "", pack = "duotone", ...rest } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={pack === "minimal" ? 1.5 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("inline-block shrink-0 stroke-current", className)}
      {...rest}
    >
      {paths(pack)}
    </svg>
  );
};

export const ICON_DEFINITIONS: IconDefinition[] = [
  // ──────────────── Navigation ────────────────
  {
    id: "layout-dashboard",
    name: "Projects / Dashboard",
    category: "navigation",
    description: "Main workspace and project overview",
    defaultIcon: LayoutDashboard,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="3" y="3" width="7" height="9" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <rect x="14" y="3" width="7" height="5" rx="2" className={pack === "duotone" ? "fill-current/10 stroke-current" : "stroke-current"} />
          <rect x="14" y="12" width="7" height="9" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <rect x="3" y="16" width="7" height="5" rx="2" className={pack === "duotone" ? "fill-current/10 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "server",
    name: "Deployments",
    category: "navigation",
    description: "Running services and application instances",
    defaultIcon: Server,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="2" y="2" width="20" height="8" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <rect x="2" y="14" width="20" height="8" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <circle cx="6" cy="6" r="1" className="fill-current stroke-current" />
          <circle cx="6" cy="18" r="1" className="fill-current stroke-current" />
          <line x1="10" y1="6" x2="18" y2="6" className="stroke-current" />
          <line x1="10" y1="18" x2="18" y2="18" className="stroke-current" />
        </>
      )),
  },
  {
    id: "activity",
    name: "Logs & Monitoring",
    category: "navigation",
    description: "Real-time metrics, telemetry and error logs",
    defaultIcon: Activity,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" className="stroke-current stroke-[2.2]" />
          {pack === "duotone" && (
            <path d="M2 12h4l3-9 6 18 3-9h4v6H2z" className="fill-current/10 stroke-none" />
          )}
        </>
      )),
  },
  {
    id: "gauge",
    name: "Visualization",
    category: "navigation",
    description: "Cluster performance and resource gauges",
    defaultIcon: Gauge,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="m12 14 4-4" className="stroke-current stroke-[2.5]" />
          <path d="M3.34 19a10 10 0 1 1 17.32 0" className={pack === "duotone" ? "fill-current/10 stroke-current" : "stroke-current"} />
          <circle cx="12" cy="14" r="2" className="fill-current stroke-current" />
        </>
      )),
  },
  {
    id: "network",
    name: "Infrastructure",
    category: "navigation",
    description: "Node connections and ingress routing",
    defaultIcon: Network,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="16" y="16" width="6" height="6" rx="1.5" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <rect x="2" y="16" width="6" height="6" rx="1.5" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <rect x="9" y="2" width="6" height="6" rx="1.5" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8" className="stroke-current" />
        </>
      )),
  },
  {
    id: "boxes",
    name: "Cluster Builder",
    category: "navigation",
    description: "Multi-service container composer",
    defaultIcon: Boxes,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l6 3.43a2 2 0 0 0 2.06 0l6-3.43a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L11 9.49a2 2 0 0 0-2.06 0z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="m12 9 6-3.43a2 2 0 0 0 .97-1.71V2.62A2 2 0 0 0 18 .91L12 4.34 6 .91a2 2 0 0 0-.97 1.71v1.24a2 2 0 0 0 .97 1.71z" className="stroke-current" />
          <path d="m12 22 5-2.88M12 9v13M7 19.12l5 2.88" className="stroke-current" />
        </>
      )),
  },
  {
    id: "star",
    name: "AI Agent",
    category: "navigation",
    description: "Autonomous reasoning and delivery cockpit",
    defaultIcon: Star,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M12 2l2.6 6.8L22 10.3l-5.4 4.8 1.6 7.4L12 18.6l-6.2 3.9 1.6-7.4L2 10.3l7.4-1.5z" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "key-round",
    name: "Secrets",
    category: "navigation",
    description: "Environment secrets and encrypted keys",
    defaultIcon: KeyRound,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="8" cy="15" r="5" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <path d="m11.5 11.5 7.5-7.5M16 4l3 3M14 6l1.5 1.5" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "building-2",
    name: "Organization",
    category: "navigation",
    description: "Workspaces, teams and RBAC permissions",
    defaultIcon: Building2,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M18 9h4a2 2 0 0 1 2 2v11h-6M6 13H2a2 2 0 0 0-2 2v7h6" className="stroke-current" />
          <line x1="10" y1="6" x2="14" y2="6" className="stroke-current" />
          <line x1="10" y1="10" x2="14" y2="10" className="stroke-current" />
          <line x1="10" y1="14" x2="14" y2="14" className="stroke-current" />
          <line x1="10" y1="18" x2="14" y2="18" className="stroke-current" />
        </>
      )),
  },
  {
    id: "settings",
    name: "Settings",
    category: "navigation",
    description: "Account, appearance and cluster configuration",
    defaultIcon: Settings,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="12" cy="12" r="3" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" className="stroke-current" />
        </>
      )),
  },
  {
    id: "panel-left-close",
    name: "Collapse Sidebar",
    category: "navigation",
    description: "Collapse rail menu",
    defaultIcon: PanelLeftClose,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="3" y="3" width="18" height="18" rx="3.5" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} strokeWidth={1.8} />
          <path d="M9 3.5v17" className="stroke-current" strokeWidth={1.8} />
          <rect x="3.5" y="3.5" width="5.5" height="17" rx="1.5" className="fill-current stroke-none" />
          <path d="M15 9.5L12.5 12l2.5 2.5" className="stroke-current" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
        </>
      )),
  },
  {
    id: "panel-left-open",
    name: "Expand Sidebar",
    category: "navigation",
    description: "Expand rail menu",
    defaultIcon: PanelLeftOpen,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="3" y="3" width="18" height="18" rx="3.5" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} strokeWidth={1.8} />
          <path d="M9 3.5v17" className="stroke-current" strokeWidth={1.8} />
          <rect x="3.5" y="3.5" width="5.5" height="17" rx="1.5" className="fill-current stroke-none" />
          <path d="M12.5 9.5L15 12l-2.5 2.5" className="stroke-current" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
        </>
      )),
  },
  {
    id: "log-out",
    name: "Logout",
    category: "navigation",
    description: "Sign out of active session",
    defaultIcon: LogOut,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "log-in",
    name: "Login / Authenticate",
    category: "navigation",
    description: "User sign in authentication",
    defaultIcon: LogIn,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "menu",
    name: "Menu",
    category: "navigation",
    description: "Mobile hamburger navigation toggle",
    defaultIcon: Menu,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <line x1="4" x2="20" y1="12" y2="12" className="stroke-current stroke-[2.5]" />
          <line x1="4" x2="20" y1="6" y2="6" className="stroke-current stroke-[2.5]" />
          <line x1="4" x2="20" y1="18" y2="18" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },

  // ──────────────── Actions ────────────────
  {
    id: "plus",
    name: "Create / Add",
    category: "actions",
    description: "New project, connection or member",
    defaultIcon: Plus,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <line x1="12" y1="5" x2="12" y2="19" className="stroke-current stroke-[2.5]" />
          <line x1="5" y1="12" x2="19" y2="12" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "trash-2",
    name: "Delete / Remove",
    category: "actions",
    description: "Destructive resource removal",
    defaultIcon: Trash2,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" className={pack === "duotone" ? "fill-current/10 stroke-current" : "stroke-current"} />
          <line x1="10" y1="11" x2="10" y2="17" className="stroke-current" />
          <line x1="14" y1="11" x2="14" y2="17" className="stroke-current" />
        </>
      )),
  },
  {
    id: "edit",
    name: "Edit / Configure",
    category: "actions",
    description: "Modify parameters and settings",
    defaultIcon: Edit,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" className="stroke-current" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "refresh-cw",
    name: "Sync / Refresh",
    category: "actions",
    description: "Reload active state from cluster",
    defaultIcon: RefreshCw,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" className="stroke-current stroke-[2.2]" />
          <path d="M21 3v5h-5" className="stroke-current stroke-[2.2]" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" className="stroke-current stroke-[2.2]" />
          <path d="M8 16H3v5" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "send",
    name: "Send / Dispatch",
    category: "actions",
    description: "Submit prompt or invite",
    defaultIcon: Send,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="m22 2-7 20-4-9-9-4Z" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <path d="M22 2 11 13" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "upload",
    name: "Upload",
    category: "actions",
    description: "Upload code artifact or SVG",
    defaultIcon: Upload,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "download",
    name: "Download / Export",
    category: "actions",
    description: "Save artifact or backup",
    defaultIcon: Download,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "copy",
    name: "Copy",
    category: "actions",
    description: "Copy text to clipboard",
    defaultIcon: Copy,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="9" y="9" width="13" height="13" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" className="stroke-current" />
        </>
      )),
  },
  {
    id: "clipboard",
    name: "Clipboard",
    category: "actions",
    description: "Clipboard inspect and paste",
    defaultIcon: Clipboard,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect width="8" height="4" x="8" y="2" rx="1" ry="1" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" className="stroke-current" />
        </>
      )),
  },
  {
    id: "clipboard-copy",
    name: "Clipboard Copy",
    category: "actions",
    description: "Duplicate token or configuration",
    defaultIcon: ClipboardCopy,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect width="8" height="4" x="8" y="2" rx="1" ry="1" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" className="stroke-current" />
          <path d="M16 4h2a2 2 0 0 1 2 2v4M21 14H11" className="stroke-current" />
          <path d="m15 10-4 4 4 4" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "check",
    name: "Checkmark",
    category: "actions",
    description: "Confirmation and success",
    defaultIcon: Check,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M20 6 9 17l-5-5" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "x",
    name: "Close / Dismiss",
    category: "actions",
    description: "Cancel modal or clear input",
    defaultIcon: X,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M18 6 6 18M6 6l12 12" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "search",
    name: "Search",
    category: "actions",
    description: "Search projects and services",
    defaultIcon: Search,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="11" cy="11" r="8" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="m21 21-4.3-4.3" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "filter",
    name: "Filter",
    category: "actions",
    description: "Filter catalog items",
    defaultIcon: Filter,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "eye",
    name: "Show / View",
    category: "actions",
    description: "Reveal secret or inspect",
    defaultIcon: Eye,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" className={pack === "duotone" ? "fill-current/10 stroke-current" : "stroke-current"} />
          <circle cx="12" cy="12" r="3" className="fill-current stroke-current" />
        </>
      )),
  },
  {
    id: "eye-off",
    name: "Hide / Mask",
    category: "actions",
    description: "Mask secret key value",
    defaultIcon: EyeOff,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "save",
    name: "Save",
    category: "actions",
    description: "Commit configuration",
    defaultIcon: Save,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <polyline points="17 21 17 13 7 13 7 21" className="stroke-current" />
          <polyline points="7 3 7 8 15 8" className="stroke-current" />
        </>
      )),
  },
  {
    id: "rotate-ccw",
    name: "Reset / Revert",
    category: "actions",
    description: "Revert to default",
    defaultIcon: RotateCcw,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" className="stroke-current stroke-[2.2]" />
          <path d="M3 3v5h5" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "rotate-cw",
    name: "Rotate / Redo",
    category: "actions",
    description: "Rotate clockwise or repeat build",
    defaultIcon: RotateCw,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.83 6.72 2.24L21 8" className="stroke-current stroke-[2.2]" />
          <path d="M21 3v5h-5" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "play",
    name: "Start / Resume",
    category: "actions",
    description: "Launch container workload",
    defaultIcon: Play,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <polygon points="5 3 19 12 5 21 5 3" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "pause",
    name: "Pause / Stop",
    category: "actions",
    description: "Halt running process",
    defaultIcon: Pause,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="6" y="4" width="4" height="16" rx="1" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
          <rect x="14" y="4" width="4" height="16" rx="1" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "external-link",
    name: "External Link",
    category: "actions",
    description: "Open in browser window",
    defaultIcon: ExternalLink,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" className="stroke-current" />
        </>
      )),
  },
  {
    id: "more-horizontal",
    name: "More Actions",
    category: "actions",
    description: "Horizontal action menu",
    defaultIcon: MoreHorizontal,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <circle cx="12" cy="12" r="1.5" className="fill-current stroke-current" />
          <circle cx="19" cy="12" r="1.5" className="fill-current stroke-current" />
          <circle cx="5" cy="12" r="1.5" className="fill-current stroke-current" />
        </>
      )),
  },
  {
    id: "more-vertical",
    name: "Vertical Menu",
    category: "actions",
    description: "Contextual actions dropdown",
    defaultIcon: MoreVertical,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <circle cx="12" cy="5" r="1.5" className="fill-current stroke-current" />
          <circle cx="12" cy="12" r="1.5" className="fill-current stroke-current" />
          <circle cx="12" cy="19" r="1.5" className="fill-current stroke-current" />
        </>
      )),
  },
  {
    id: "sliders-horizontal",
    name: "Filters & Controls",
    category: "actions",
    description: "Advanced filter controls and sliders",
    defaultIcon: SlidersHorizontal,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <line x1="21" x2="14" y1="4" y2="4" className="stroke-current stroke-[2.2]" />
          <line x1="10" x2="3" y1="4" y2="4" className="stroke-current stroke-[2.2]" />
          <line x1="21" x2="12" y1="12" y2="12" className="stroke-current stroke-[2.2]" />
          <line x1="8" x2="3" y1="12" y2="12" className="stroke-current stroke-[2.2]" />
          <line x1="21" x2="16" y1="20" y2="20" className="stroke-current stroke-[2.2]" />
          <line x1="12" x2="3" y1="20" y2="20" className="stroke-current stroke-[2.2]" />
          <circle cx="12" cy="4" r="2" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
          <circle cx="10" cy="12" r="2" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
          <circle cx="14" cy="20" r="2" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "undo2",
    name: "Undo",
    category: "actions",
    description: "Rollback last modification",
    defaultIcon: Undo2,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M9 14 4 9l5-5" className="stroke-current stroke-[2.2]" />
          <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "focus",
    name: "Focus Target",
    category: "actions",
    description: "Center and zoom viewport",
    defaultIcon: Focus,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <circle cx="12" cy="12" r="3" className="fill-current stroke-current" />
          <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },

  // ──────────────── Infrastructure ────────────────
  {
    id: "cpu",
    name: "CPU / Compute",
    category: "infrastructure",
    description: "Processor core allocation and limits",
    defaultIcon: Cpu,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <rect x="9" y="9" width="6" height="6" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
          <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" className="stroke-current" />
        </>
      )),
  },
  {
    id: "database",
    name: "Database",
    category: "infrastructure",
    description: "Postgres, MySQL & Redis persistence",
    defaultIcon: Database,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <ellipse cx="12" cy="5" rx="9" ry="3" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" className="stroke-current" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" className="stroke-current" />
        </>
      )),
  },
  {
    id: "hard-drive",
    name: "Storage Volume",
    category: "infrastructure",
    description: "Disk storage & persistent volumes",
    defaultIcon: HardDrive,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <line x1="12" y1="18" x2="12.01" y2="18" className="stroke-current stroke-[2.5]" />
          <rect x="2" y="2" width="20" height="8" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <rect x="2" y="14" width="20" height="8" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <line x1="6" y1="6" x2="6.01" y2="6" className="stroke-current stroke-[2.5]" />
          <line x1="6" y1="18" x2="6.01" y2="18" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "memory-stick",
    name: "RAM / Memory",
    category: "infrastructure",
    description: "Node memory and heap consumption",
    defaultIcon: MemoryStick,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M6 6h12M6 10h12M6 14h12" className="stroke-current" />
          <circle cx="10" cy="18" r="1" className="fill-current stroke-current" />
          <circle cx="14" cy="18" r="1" className="fill-current stroke-current" />
        </>
      )),
  },
  {
    id: "wifi",
    name: "Wireless Network",
    category: "infrastructure",
    description: "Network telemetry and signal stability",
    defaultIcon: Wifi,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M12 20h.01M2 8.82a15 15 0 0 1 20 0M5 12.86a10 10 0 0 1 14 0M8.5 16.43a5 5 0 0 1 7 0" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "radio",
    name: "Radio Broadcast",
    category: "infrastructure",
    description: "Service mesh live event broadcasting",
    defaultIcon: Radio,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="12" cy="12" r="2" className="fill-current stroke-current" />
          <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" className={pack === "duotone" ? "stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "plug",
    name: "Plug / Connect",
    category: "infrastructure",
    description: "Cluster connection interface",
    defaultIcon: Plug,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "unplug",
    name: "Disconnect / Unplug",
    category: "infrastructure",
    description: "Sever node connection",
    defaultIcon: Unplug,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="m19 5 3-3M2 22l3-3M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4l2.6 2.6zM7.5 13.5 10 11M10.5 16.5 13 14M14 6l3.7 3.7a2.4 2.4 0 0 1 0 3.4L15.4 15M17.7 2.3l2.6 2.6a2.4 2.4 0 0 1 0 3.4L18 10.6" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "power",
    name: "Power State",
    category: "infrastructure",
    description: "Restart or initialize runtime",
    defaultIcon: Power,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M12 2v10M18.36 6.64a9 9 0 1 1-12.73 0" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "thermometer",
    name: "Host Temperature",
    category: "infrastructure",
    description: "CPU and GPU thermal sensors",
    defaultIcon: Thermometer,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <circle cx="11.5" cy="17.5" r="2" className="fill-current stroke-current" />
        </>
      )),
  },
  {
    id: "columns",
    name: "Split Panes",
    category: "infrastructure",
    description: "Multi-column infrastructure view",
    defaultIcon: Columns,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect width="18" height="18" x="3" y="3" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M12 3v18" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },

  // ──────────────── DevOps, Cloud & Code ────────────────
  {
    id: "git-branch",
    name: "Git Branch",
    category: "devops",
    description: "Repository branch source",
    defaultIcon: GitBranch,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <line x1="6" y1="3" x2="6" y2="15" className="stroke-current" />
          <circle cx="18" cy="6" r="3" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
          <circle cx="6" cy="18" r="3" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
          <path d="M18 9a9 9 0 0 1-9 9" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "git-commit",
    name: "Git Commit",
    category: "devops",
    description: "Git commit hash revision",
    defaultIcon: GitCommit,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="12" cy="12" r="4" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
          <line x1="1.05" x2="8" y1="12" y2="12" className="stroke-current stroke-[2.5]" />
          <line x1="16" x2="22.95" y1="12" y2="12" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "git-pull-request",
    name: "Pull Request",
    category: "devops",
    description: "GitHub automated PR build",
    defaultIcon: GitPullRequest,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="18" cy="18" r="3" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <circle cx="6" cy="6" r="3" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "terminal",
    name: "SSH / Terminal",
    category: "devops",
    description: "Interactive shell console and logs",
    defaultIcon: Terminal,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="2" y="3" width="20" height="18" rx="3" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="m6 9 4 3-4 3" className="stroke-current stroke-[2.5]" />
          <line x1="13" y1="15" x2="17" y2="15" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "terminal-square",
    name: "MCP Server Tool",
    category: "devops",
    description: "Model Context Protocol CLI tool",
    defaultIcon: TerminalSquare,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="m7 10 3 2-3 2M13 14h4" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "code-2",
    name: "Source Code",
    category: "devops",
    description: "Application source code",
    defaultIcon: Code2,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="m18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "folder",
    name: "Folder",
    category: "devops",
    description: "Directory container",
    defaultIcon: Folder,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "folder-tree",
    name: "Workspace Tree",
    category: "devops",
    description: "File hierarchy and tree structure",
    defaultIcon: FolderTree,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M4 3v18M4 9h5M4 15h5" className="stroke-current" />
          <rect x="9" y="7" width="12" height="4" rx="1" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <rect x="9" y="13" width="12" height="4" rx="1" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "folder-up",
    name: "Upload Directory",
    category: "devops",
    description: "Bundle and upload folder",
    defaultIcon: FolderUp,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M12 10v6M9 13l3-3 3 3" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "file-code",
    name: "Code File",
    category: "devops",
    description: "Source code script file",
    defaultIcon: FileCode,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <polyline points="14 2 14 8 20 8" className="stroke-current" />
          <path d="m10 13-2 2 2 2M14 17l2-2-2-2" className="stroke-current stroke-[2]" />
        </>
      )),
  },
  {
    id: "file-text",
    name: "Document File",
    category: "devops",
    description: "Config, yaml or log document",
    defaultIcon: FileText,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <polyline points="14 2 14 8 20 8" className="stroke-current" />
          <line x1="16" x2="8" y1="13" y2="13" className="stroke-current" />
          <line x1="16" x2="8" y1="17" y2="17" className="stroke-current" />
        </>
      )),
  },
  {
    id: "layers",
    name: "Stack Layers",
    category: "devops",
    description: "Layered architecture and abstractions",
    defaultIcon: Layers,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <polygon points="12 2 2 7 12 12 22 7 12 2" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <polyline points="2 17 12 22 22 17" className="stroke-current" />
          <polyline points="2 12 12 17 22 12" className="stroke-current" />
        </>
      )),
  },
  {
    id: "blocks",
    name: "Microservices",
    category: "devops",
    description: "Modular application extensions",
    defaultIcon: Blocks,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect width="7" height="7" x="14" y="3" rx="1" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3" className="stroke-current" />
        </>
      )),
  },
  {
    id: "rocket",
    name: "Production Deploy",
    category: "devops",
    description: "Launch container to cluster",
    defaultIcon: Rocket,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" className="stroke-current" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" className="stroke-current" />
        </>
      )),
  },
  {
    id: "upload-cloud",
    name: "Cloud Deployment",
    category: "devops",
    description: "Deploy package to cloud registry",
    defaultIcon: UploadCloud,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M12 12v9M16 16l-4-4-4 4" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "cloud",
    name: "Cloud Provider",
    category: "devops",
    description: "Remote cloud infrastructure",
    defaultIcon: Cloud,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "wrench",
    name: "DevOps Tools",
    category: "devops",
    description: "Troubleshooting and maintenance",
    defaultIcon: Wrench,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "link-2",
    name: "Webhook / Endpoint",
    category: "devops",
    description: "Service interconnect and URLs",
    defaultIcon: Link2,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },

  // ──────────────── AI & Automation ────────────────
  {
    id: "sparkles",
    name: "AI Magic",
    category: "ai",
    description: "Generative intelligence copilot",
    defaultIcon: Sparkles,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "bot",
    name: "Autonomous Bot",
    category: "ai",
    description: "Background autonomous worker",
    defaultIcon: Bot,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="3" y="11" width="18" height="10" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <circle cx="12" cy="5" r="2" className="stroke-current" />
          <path d="M12 7v4M8 16h.01M16 16h.01" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "brain",
    name: "Reasoning & Thought",
    category: "ai",
    description: "Thinking process & chain of thought",
    defaultIcon: Brain,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" className="stroke-current" />
        </>
      )),
  },
  {
    id: "brain-circuit",
    name: "Neural Circuit",
    category: "ai",
    description: "Machine learning neural mesh",
    defaultIcon: BrainCircuit,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" className="stroke-current" />
          <path d="M9 13a4.5 4.5 0 0 0 3-4M12 15h3" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "wand2",
    name: "AI Prompt Wizard",
    category: "ai",
    description: "Automated Dockerfile generator",
    defaultIcon: Wand2,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="m14 7 3 3M5 6v4M3 8h4M19 14v4M17 16h4" className="stroke-current" />
        </>
      )),
  },

  // ──────────────── Observability ────────────────
  {
    id: "bar-chart-3",
    name: "Metrics & Analytics",
    category: "observability",
    description: "Cluster bandwidth & performance graphs",
    defaultIcon: BarChart3,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <line x1="12" x2="12" y1="20" y2="10" className="stroke-current stroke-[2.5]" />
          <line x1="18" x2="18" y1="20" y2="4" className="stroke-current stroke-[2.5]" />
          <line x1="6" x2="6" y1="20" y2="16" className="stroke-current stroke-[2.5]" />
          {pack === "duotone" && (
            <rect x="4" y="15" width="4" height="6" rx="1" className="fill-current/20 stroke-none" />
          )}
        </>
      )),
  },
  {
    id: "history",
    name: "History / Revisions",
    category: "observability",
    description: "Deployment timeline and revisions",
    defaultIcon: History,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" className="stroke-current" />
          <path d="M3 3v5h5" className="stroke-current" />
          <path d="M12 7v5l4 2" className="stroke-current" />
        </>
      )),
  },
  {
    id: "clock",
    name: "Latency / Duration",
    category: "observability",
    description: "Build duration and execution latency",
    defaultIcon: Clock,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="12" cy="12" r="10" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <polyline points="12 6 12 12 16 14" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "flame",
    name: "High Resource Load",
    category: "observability",
    description: "Resource saturation alert",
    defaultIcon: Flame,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "scroll-text",
    name: "Build & Runtime Logs",
    category: "observability",
    description: "Streaming container log output",
    defaultIcon: ScrollText,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M19 17V5a2 2 0 0 0-2-2H4" className="stroke-current" />
          <path d="M15 8h-5M15 12h-5" className="stroke-current" />
        </>
      )),
  },

  // ──────────────── Status & Health ────────────────
  {
    id: "check-circle-2",
    name: "Healthy / Operational",
    category: "status",
    description: "Operational status indicator",
    defaultIcon: CheckCircle2,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="12" cy="12" r="10" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="m9 12 2 2 4-4" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "alert-triangle",
    name: "Warning / Drift",
    category: "status",
    description: "High CPU, drift or non-critical error",
    defaultIcon: AlertTriangle,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <line x1="12" y1="9" x2="12" y2="13" className="stroke-current stroke-[2.5]" />
          <circle cx="12" cy="17" r="1" className="fill-current stroke-current" />
        </>
      )),
  },
  {
    id: "alert-circle",
    name: "Critical Alert",
    category: "status",
    description: "Container crash or deploy failure",
    defaultIcon: AlertCircle,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="12" cy="12" r="10" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <line x1="12" y1="8" x2="12" y2="12" className="stroke-current stroke-[2.5]" />
          <circle cx="12" cy="16" r="1" className="fill-current stroke-current" />
        </>
      )),
  },
  {
    id: "x-circle",
    name: "Failed / Inactive",
    category: "status",
    description: "Stopped or unreachable node",
    defaultIcon: XCircle,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="12" cy="12" r="10" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="m15 9-6 6M9 9l6 6" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "loader-2",
    name: "Loading / Spinner",
    category: "status",
    description: "Background execution indicator",
    defaultIcon: Loader2,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M21 12a9 9 0 1 1-6.219-8.56" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "minus",
    name: "Idle / Superseded",
    category: "status",
    description: "Neutral or bypassed execution",
    defaultIcon: Minus,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <line x1="5" x2="19" y1="12" y2="12" className="stroke-current stroke-[3]" />
        </>
      )),
  },
  {
    id: "square",
    name: "Terminated / Stopped",
    category: "status",
    description: "Stopped container workload",
    defaultIcon: Square,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect width="18" height="18" x="3" y="3" rx="2" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "zap",
    name: "Real-time Event / Trigger",
    category: "status",
    description: "Instant trigger or webhook execution",
    defaultIcon: Zap,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
        </>
      )),
  },

  // ──────────────── Security & Access ────────────────
  {
    id: "lock",
    name: "Encrypted / Locked",
    category: "security",
    description: "Restricted permission access",
    defaultIcon: Lock,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="3" y="11" width="18" height="11" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "unlock",
    name: "Public / Unlocked",
    category: "security",
    description: "Open access permission",
    defaultIcon: Unlock,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="3" y="11" width="18" height="11" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M7 11V7a5 5 0 0 1 9.9-1" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "shield",
    name: "Security Firewall",
    category: "security",
    description: "Security perimeter shield",
    defaultIcon: Shield,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "shield-check",
    name: "RBAC Verified",
    category: "security",
    description: "Access authorization verified",
    defaultIcon: ShieldCheck,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="m9 12 2 2 4-4" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "shield-alert",
    name: "Security Vulnerability",
    category: "security",
    description: "CVE vulnerability or exposed port",
    defaultIcon: ShieldAlert,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <line x1="12" y1="8" x2="12" y2="12" className="stroke-current stroke-[2.5]" />
          <circle cx="12" cy="16" r="1" className="fill-current stroke-current" />
        </>
      )),
  },

  // ──────────────── Team & Collaboration ────────────────
  {
    id: "users",
    name: "Team Members",
    category: "team",
    description: "Collaborators and organization roles",
    defaultIcon: Users,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" className="stroke-current" />
          <circle cx="9" cy="7" r="4" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" className="stroke-current" />
        </>
      )),
  },
  {
    id: "user",
    name: "User Account",
    category: "team",
    description: "Individual user profile",
    defaultIcon: User,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" className="stroke-current" />
          <circle cx="12" cy="7" r="4" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "user-plus",
    name: "Invite Teammate",
    category: "team",
    description: "Add new user to workspace",
    defaultIcon: UserPlus,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" className="stroke-current" />
          <circle cx="8.5" cy="7" r="4" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <line x1="20" y1="8" x2="20" y2="14" className="stroke-current stroke-[2.2]" />
          <line x1="23" y1="11" x2="17" y2="11" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "user-minus",
    name: "Remove Member",
    category: "team",
    description: "Revoke collaborator workspace access",
    defaultIcon: UserMinus,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" className="stroke-current" />
          <circle cx="8.5" cy="7" r="4" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <line x1="23" y1="11" x2="17" y2="11" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "user-check",
    name: "Verified Member",
    category: "team",
    description: "Active and confirmed account",
    defaultIcon: UserCheck,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" className="stroke-current" />
          <circle cx="8.5" cy="7" r="4" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
          <polyline points="17 11 19 13 23 9" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "mail",
    name: "Email Invite",
    category: "team",
    description: "System notifications and invites",
    defaultIcon: Mail,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect width="20" height="16" x="2" y="4" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "mail-check",
    name: "Email Confirmed",
    category: "team",
    description: "Verified email address",
    defaultIcon: MailCheck,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h9" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" className="stroke-current" />
          <path d="m16 19 2 2 4-4" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "message-square",
    name: "Comments & Chat",
    category: "team",
    description: "Collaboration thread message",
    defaultIcon: MessageSquare,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "bell",
    name: "Notifications",
    category: "team",
    description: "Workspace activity and alert bell",
    defaultIcon: Bell,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "help-circle",
    name: "Help & Docs",
    category: "team",
    description: "Documentation and guide articles",
    defaultIcon: HelpCircle,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="12" cy="12" r="10" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "info",
    name: "Information",
    category: "team",
    description: "Informational callout indicator",
    defaultIcon: Info,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="12" cy="12" r="10" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M12 16v-4M12 8h.01" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "calendar",
    name: "Calendar / Schedule",
    category: "team",
    description: "Scheduled jobs and token expiry",
    defaultIcon: Calendar,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect width="18" height="18" x="3" y="4" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <line x1="16" x2="16" y1="2" y2="6" className="stroke-current" />
          <line x1="8" x2="8" y1="2" y2="6" className="stroke-current" />
          <line x1="3" x2="21" y1="10" y2="10" className="stroke-current" />
        </>
      )),
  },

  // ──────────────── Themes ────────────────
  {
    id: "sun",
    name: "Light Mode",
    category: "theme",
    description: "Light interface theme",
    defaultIcon: Sun,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="12" cy="12" r="4" className={pack === "duotone" ? "fill-current/25 stroke-current" : "stroke-current"} />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "moon",
    name: "Dark Mode",
    category: "theme",
    description: "Dark interface theme",
    defaultIcon: Moon,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" className={pack === "duotone" ? "fill-current/20 stroke-current" : "stroke-current"} />
        </>
      )),
  },
  {
    id: "laptop",
    name: "System Mode",
    category: "theme",
    description: "OS synchronized theme",
    defaultIcon: Laptop,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <rect x="3" y="4" width="18" height="12" rx="2" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <path d="M2 20h20" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "palette",
    name: "Theme Palette",
    category: "theme",
    description: "Color system picker",
    defaultIcon: Palette,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="13.5" cy="6.5" r=".5" className="fill-current stroke-current" />
          <circle cx="17.5" cy="10.5" r=".5" className="fill-current stroke-current" />
          <circle cx="8.5" cy="7.5" r=".5" className="fill-current stroke-current" />
          <circle cx="6.5" cy="12.5" r=".5" className="fill-current stroke-current" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C22 6.5 17.5 2 12 2Z" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
        </>
      )),
  },

  // ──────────────── Arrows & Navigation ────────────────
  {
    id: "arrow-left",
    name: "Arrow Left / Back",
    category: "arrows",
    description: "Navigate to previous screen",
    defaultIcon: ArrowLeft,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="m12 19-7-7 7-7M19 12H5" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "arrow-right",
    name: "Arrow Right / Forward",
    category: "arrows",
    description: "Advance or continue",
    defaultIcon: ArrowRight,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M5 12h14M12 5l7 7-7 7" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "arrow-up",
    name: "Arrow Up",
    category: "arrows",
    description: "Ascend or scroll to top",
    defaultIcon: ArrowUp,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="m5 12 7-7 7 7M12 19V5" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "arrow-down",
    name: "Arrow Down",
    category: "arrows",
    description: "Descend or scroll down",
    defaultIcon: ArrowDown,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="M12 5v14M19 12l-7 7-7-7" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "arrow-up-down",
    name: "Sort Order",
    category: "arrows",
    description: "Sort table columns ascending or descending",
    defaultIcon: ArrowUpDown,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="m21 16-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "chevron-down",
    name: "Chevron Down",
    category: "arrows",
    description: "Expand accordion or dropdown",
    defaultIcon: ChevronDown,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="m6 9 6 6 6-6" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "chevron-up",
    name: "Chevron Up",
    category: "arrows",
    description: "Collapse accordion or dropdown",
    defaultIcon: ChevronUp,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="m18 15-6-6-6 6" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "chevron-left",
    name: "Chevron Left",
    category: "arrows",
    description: "Previous page pagination",
    defaultIcon: ChevronLeft,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="m15 18-6-6 6-6" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "chevron-right",
    name: "Chevron Right",
    category: "arrows",
    description: "Breadcrumb navigation & next page",
    defaultIcon: ChevronRight,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="m9 18 6-6-6-6" className="stroke-current stroke-[2.5]" />
        </>
      )),
  },
  {
    id: "chevrons-up-down",
    name: "Select Toggle",
    category: "arrows",
    description: "Combobox switcher indicator",
    defaultIcon: ChevronsUpDown,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <path d="m7 15 5 5 5-5M7 9l5-5 5 5" className="stroke-current stroke-[2.2]" />
        </>
      )),
  },
  {
    id: "maximize-2",
    name: "Maximize",
    category: "arrows",
    description: "Expand terminal or viewer",
    defaultIcon: Maximize2,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <polyline points="15 3 21 3 21 9" className="stroke-current" />
          <polyline points="9 21 3 21 3 15" className="stroke-current" />
          <line x1="21" y1="3" x2="14" y2="10" className="stroke-current" />
          <line x1="3" y1="21" x2="10" y2="14" className="stroke-current" />
        </>
      )),
  },
  {
    id: "minimize-2",
    name: "Minimize",
    category: "arrows",
    description: "Restore standard dimensions",
    defaultIcon: Minimize2,
    customSvg: (p) =>
      createSvg(p, () => (
        <>
          <polyline points="4 14 10 14 10 20" className="stroke-current" />
          <polyline points="20 10 14 10 14 4" className="stroke-current" />
          <line x1="14" y1="10" x2="21" y2="3" className="stroke-current" />
          <line x1="3" y1="21" x2="10" y2="14" className="stroke-current" />
        </>
      )),
  },
  {
    id: "globe",
    name: "Public Domain / Web",
    category: "infrastructure",
    description: "Ingress routing and external URL",
    defaultIcon: Globe,
    customSvg: (p) =>
      createSvg(p, (pack) => (
        <>
          <circle cx="12" cy="12" r="10" className={pack === "duotone" ? "fill-current/15 stroke-current" : "stroke-current"} />
          <line x1="2" x2="22" y1="12" y2="12" className="stroke-current stroke-[2]" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" className="stroke-current" />
        </>
      )),
  },
];

export const ICON_ALIASES: Record<string, string> = {
  // Lucide variants & shorthand IDs used across various dashboard components
  "building2": "building-2",
  "check-circle2": "check-circle-2",
  "check-circle": "check-circle-2",
  "code2": "code-2",
  "code": "code-2",
  "edit2": "edit",
  "file-code2": "file-code",
  "key": "key-round",
  "link": "link-2",
  "link2": "link-2",
  "maximize2": "maximize-2",
  "minimize2": "minimize-2",
  "terminal-icon": "terminal",
  "settings2": "settings",
  "sliders": "sliders-horizontal",
  "chevron-right-icon": "chevron-right",
  "chevron-down-icon": "chevron-down",
  "chevron-up-icon": "chevron-up",
  "check-icon": "check",
  "circle-check-icon": "check-circle-2",
  "x-icon": "x",
  "loader2": "loader-2",
  "triangle-alert-icon": "alert-triangle",
  "octagon-x-icon": "x-circle",
  "info-icon": "info",
};

export function resolveCanonicalIconId(name: string): string {
  if (!name) return "";
  const direct = name.trim().toLowerCase();
  return ICON_ALIASES[direct] || direct;
}

// Include every Lucide symbol used by the platform, not just the original curated set.
export const PLATFORM_ICON_IDS: Record<string, string> = {};
for (const [name, Icon] of Object.entries(PLATFORM_LUCIDE_ICONS)) {
  const existing = ICON_DEFINITIONS.find((definition) => definition.defaultIcon === Icon);
  const id = existing?.id || name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  PLATFORM_ICON_IDS[name] = id;
  if (!existing) ICON_DEFINITIONS.push({
    id,
    name: name.replace(/([a-z0-9])([A-Z])/g, "$1 $2"),
    category: "actions",
    description: "Platform interface icon",
    defaultIcon: Icon,
    customSvg: ({ pack, ...props }) => <Icon strokeWidth={pack === "minimal" ? 1.5 : 1.75} {...props} />,
  });
}

export const ICON_MAP = new Map<string, IconDefinition>(
  ICON_DEFINITIONS.map((def) => [def.id, def])
);

// Register aliases in ICON_MAP for fast lookup
Object.entries(ICON_ALIASES).forEach(([alias, targetId]) => {
  const targetDef = ICON_MAP.get(targetId);
  if (targetDef && !ICON_MAP.has(alias)) {
    ICON_MAP.set(alias, targetDef);
  }
});

// ---------------------------------------------------------------------------
// Store Subscription & Memoized Referential Snapshot
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let cachedSettings: IconSettings = DEFAULT_ICON_SETTINGS;
let rawCachedString: string | null = null;
let hasSyncedWithDb = false;

function syncWithDatabase() {
  if (typeof window === "undefined" || hasSyncedWithDb) return;
  // Login icons mount before a session exists. Do not consume the one-time
  // restore there; dashboard icons will restore after authentication.
  if (/^\/(?:auth(?:\/|$)|remote(?:\/|$)|login$|register$|forgot-password$)/.test(window.location.pathname)) return;
  hasSyncedWithDb = true;
  const initialSnapshot = rawCachedString;
  api
    .get("/auth/icon-settings")
    .then((res) => {
      if (rawCachedString !== initialSnapshot) return;
      if (res.data && (res.data.mode || res.data.overrides || res.data.pack || res.data.icon_modes || res.data.iconModes)) {
        const current = readFromStorage();
        let fetchedIconModes: Record<string, "default" | "custom"> = {};
        if (res.data.icon_modes && typeof res.data.icon_modes === "object") {
          fetchedIconModes = res.data.icon_modes;
        } else if (res.data.iconModes && typeof res.data.iconModes === "object") {
          fetchedIconModes = res.data.iconModes;
        } else if (res.data.overrides?.__icon_modes__) {
          try {
            fetchedIconModes = JSON.parse(res.data.overrides.__icon_modes__);
          } catch {}
        }
        
        const cleanOverrides = { ...(res.data.overrides || {}) };
        delete cleanOverrides.__icon_modes__;

        const merged: IconSettings = {
          mode: res.data.mode === "custom" ? "custom" : "default",
          pack: res.data.pack || current.pack || "duotone",
          overrides: cleanOverrides,
          iconModes: fetchedIconModes,
        };
        try {
          const str = JSON.stringify(merged);
          rawCachedString = str;
          cachedSettings = merged;
          window.localStorage.setItem(ICON_STORAGE_KEY, str);
          document.documentElement.setAttribute("data-icon-mode", merged.mode);
          document.documentElement.setAttribute("data-icon-pack", merged.pack);
        } catch {
          // Ignore storage errors
        }
        emit();
      }
    })
    .catch(() => {
      // Keep the local fallback, but allow a later authenticated mount to retry.
      hasSyncedWithDb = false;
    });
}

function readFromStorage(): IconSettings {
  if (typeof window === "undefined") return DEFAULT_ICON_SETTINGS;
  try {
    const raw = window.localStorage.getItem(ICON_STORAGE_KEY);
    if (raw === rawCachedString) {
      return cachedSettings;
    }
    rawCachedString = raw;
    if (!raw) {
      cachedSettings = DEFAULT_ICON_SETTINGS;
      return cachedSettings;
    }
    const parsed = JSON.parse(raw);
    let parsedIconModes: Record<string, "default" | "custom"> = {};
    if (parsed.iconModes && typeof parsed.iconModes === "object") {
      parsedIconModes = parsed.iconModes;
    } else if (parsed.overrides?.__icon_modes__) {
      try {
        parsedIconModes = JSON.parse(parsed.overrides.__icon_modes__);
      } catch {}
    }

    const cleanOverrides = { ...(typeof parsed.overrides === "object" && parsed.overrides !== null ? parsed.overrides : {}) };
    delete cleanOverrides.__icon_modes__;

    cachedSettings = {
      mode: parsed.mode === "custom" ? "custom" : "default",
      pack: ["duotone", "neon", "minimal", "carbon", "iconoir", "fluent", "badges"].includes(parsed.pack)
        ? parsed.pack
        : "duotone",
      overrides: cleanOverrides,
      iconModes: parsedIconModes,
    };
    return cachedSettings;
  } catch {
    cachedSettings = DEFAULT_ICON_SETTINGS;
    return cachedSettings;
  }
}

function emit() {
  readFromStorage();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  syncWithDatabase();
  const onStorage = (event: StorageEvent) => {
    if (event.key === ICON_STORAGE_KEY) {
      readFromStorage();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): IconSettings {
  return readFromStorage();
}

function getServerSnapshot(): IconSettings {
  return DEFAULT_ICON_SETTINGS;
}

let iconSaveTimer: ReturnType<typeof setTimeout> | undefined;
let iconSaveQueue: Promise<unknown> = Promise.resolve();

export function saveIconSettings(settings: IconSettings) {
  try {
    const str = JSON.stringify(settings);
    rawCachedString = str;
    cachedSettings = settings;
    window.localStorage.setItem(ICON_STORAGE_KEY, str);
    document.documentElement.setAttribute("data-icon-mode", settings.mode);
    document.documentElement.setAttribute("data-icon-pack", settings.pack);
  } catch {
    // Session fallback
  }
  emit();

  // Persist permanently to PostgreSQL Database so custom icons survive cache clears.
  // We mirror iconModes inside overrides.__icon_modes__ as well as top-level icon_modes
  const payload = {
    ...settings,
    icon_modes: settings.iconModes || {},
    overrides: {
      ...(settings.overrides || {}),
      ...(settings.iconModes ? { __icon_modes__: JSON.stringify(settings.iconModes) } : {}),
    },
  };
  clearTimeout(iconSaveTimer);
  iconSaveTimer = setTimeout(() => {
    iconSaveQueue = iconSaveQueue.catch(() => {}).then(() => api.put("/auth/icon-settings", payload)).catch(() => {
      toast.error("Icons changed locally, but the server could not save them. Retry your change when connected.");
    });
  }, 200);
}

export function useIconSettings(): [
  IconSettings,
  {
    setMode: (mode: IconMode) => void;
    setPack: (pack: IconPack) => void;
    setIconMode: (iconId: string, mode: "default" | "custom") => void;
    setAllIconModes: (mode: "default" | "custom") => void;
    setOverride: (iconId: string, svgContent: string) => void;
    resetIcon: (iconId: string) => void;
    resetAll: () => void;
  }
] {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const actions = {
    setMode: (mode: IconMode) => {
      const nextModes: Record<string, "default" | "custom"> = {};
      ICON_DEFINITIONS.forEach((def) => {
        nextModes[def.id] = mode;
      });
      saveIconSettings({
        ...getSnapshot(),
        mode,
        iconModes: nextModes,
        overrides: getSnapshot().overrides,
      });
    },
    setPack: (pack: IconPack) => saveIconSettings({ ...getSnapshot(), pack }),
    setIconMode: (iconId: string, mode: "default" | "custom") => {
      const canonical = resolveCanonicalIconId(iconId);
      const nextModes = { ...(getSnapshot().iconModes || {}) };
      nextModes[iconId] = mode;
      if (canonical && canonical !== iconId) {
        nextModes[canonical] = mode;
      }
      saveIconSettings({
        ...getSnapshot(),
        iconModes: nextModes,
      });
    },
    setAllIconModes: (mode: "default" | "custom") => {
      const nextModes: Record<string, "default" | "custom"> = {};
      ICON_DEFINITIONS.forEach((def) => {
        nextModes[def.id] = mode;
      });
      saveIconSettings({
        ...getSnapshot(),
        mode,
        iconModes: nextModes,
        overrides: getSnapshot().overrides,
      });
    },
    setOverride: (iconId: string, svgContent: string) => {
      const canonical = resolveCanonicalIconId(iconId);
      const adapted = adaptSvgColors(svgContent);
      const nextOverrides = { ...getSnapshot().overrides, [iconId]: adapted };
      if (canonical && canonical !== iconId) {
        nextOverrides[canonical] = adapted;
      }
      const nextModes = { ...(getSnapshot().iconModes || {}) };
      nextModes[iconId] = "custom";
      if (canonical && canonical !== iconId) {
        nextModes[canonical] = "custom";
      }
      saveIconSettings({
        ...getSnapshot(),
        overrides: nextOverrides,
        iconModes: nextModes,
      });
    },
    resetIcon: (iconId: string) => {
      const canonical = resolveCanonicalIconId(iconId);
      const overrides = { ...getSnapshot().overrides };
      delete overrides[iconId];
      if (canonical) delete overrides[canonical];

      const iconModes = { ...(getSnapshot().iconModes || {}) };
      delete iconModes[iconId];
      if (canonical) delete iconModes[canonical];

      saveIconSettings({ ...getSnapshot(), overrides, iconModes });
    },
    resetAll: () => saveIconSettings(DEFAULT_ICON_SETTINGS),
  };

  return [settings, actions];
}

// ---------------------------------------------------------------------------
// AppIcon Component: Dynamic Adaptive Icon Rendering with Theme Inversion
// ---------------------------------------------------------------------------

const subscribeNever = () => () => {};

export interface AppIconProps extends LucideProps {
  name: string; // Identifier matching ICON_DEFINITIONS or Lucide icon name
  fallback?: LucideIcon;
  forceMode?: IconMode;
  packOverride?: IconPack;
}

export function AppIcon({
  name,
  fallback,
  forceMode,
  packOverride,
  size = 18,
  className,
  ...props
}: AppIconProps) {
  const [settings] = useIconSettings();
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);

  const activeSettings = mounted ? settings : DEFAULT_ICON_SETTINGS;
  const selectedPack = packOverride || activeSettings?.pack || "duotone";
  const vectors = useSyncExternalStore(subscribeIconPacks, () => getIconPack(selectedPack), () => null);
  const canonicalId = resolveCanonicalIconId(name);
  const def = ICON_MAP.get(canonicalId) || ICON_MAP.get(name);
  const rawFallback = (fallback as (LucideIcon & { __stackpilotRawIcon?: LucideIcon }) | undefined)?.__stackpilotRawIcon || fallback;
  const FallbackIcon = rawFallback || def?.defaultIcon || Sparkles;

  // Determine whether this icon should be rendered custom or default
  // 1. If forceMode prop is explicitly supplied, respect it
  // 2. When global mode is "custom", every icon is automatically custom unless explicitly set to "default"
  // 3. When global mode is "default", icons are default unless individually set to "custom" or has an uploaded SVG override
  let isCustom = false;
  if (forceMode) {
    isCustom = forceMode === "custom";
  } else {
    const individual =
      activeSettings?.iconModes?.[name] ??
      (canonicalId ? activeSettings?.iconModes?.[canonicalId] : undefined);

    if (activeSettings?.mode === "custom") {
      // In Custom Mode: every icon is automatically custom unless explicitly set to default
      isCustom = individual !== "default";
    } else {
      // In Default Mode: icons are strictly default (standard Lucide stroke) across the whole site
      // unless an icon was individually set to custom in Icon Studio
      isCustom = individual === "custom";
    }
  }

  useEffect(() => {
    if (mounted && isCustom) loadIconPack(selectedPack);
  }, [mounted, isCustom, selectedPack]);

  // 1. When custom is active, render custom SVG upload override OR custom vector pack
  if (isCustom) {
    const customSvgString =
      activeSettings?.overrides?.[name] ||
      (canonicalId ? activeSettings?.overrides?.[canonicalId] : undefined);

    if (customSvgString && customSvgString.trim().startsWith("<")) {
      const rawSvg = sanitizeIconSvg(adaptSvgColors(customSvgString));
      return (
        <span
          className={cn(
            "app-custom-svg inline-flex items-center justify-center shrink-0 transition-colors",
            "[&_svg]:w-full [&_svg]:h-full [&_svg]:max-w-full [&_svg]:max-h-full",
            className
          )}
          style={{ width: /(?:^|\s)(?:w-|size-)/.test(className || "") ? undefined : size, height: /(?:^|\s)(?:h-|size-)/.test(className || "") ? undefined : size }}
          dangerouslySetInnerHTML={{ __html: rawSvg }}
          suppressHydrationWarning
        />
      );
    }

    if (def) {
      const vector = vectors?.[def.id];
      if (vector) {
        const svgProps = { ...props };
        delete svgProps.children;
        delete svgProps.dangerouslySetInnerHTML;
        return (
          <svg
            {...svgProps}
            aria-hidden="true"
            width={size}
            height={size}
            viewBox={vector.viewBox}
            fill="none"
            className={cn("inline-block shrink-0", className)}
            dangerouslySetInnerHTML={{ __html: vector.body }}
            suppressHydrationWarning
          />
        );
      }
      return def.customSvg({
        size,
        className: cn("stroke-current shrink-0", className),
        pack: packOverride || activeSettings?.pack || "duotone",
        ...props,
      });
    }
  }

  // 2. When default is active, strictly render standard Lucide stroke icon
  if (typeof FallbackIcon === "function" || (typeof FallbackIcon === "object" && FallbackIcon !== null)) {
    return (
      <FallbackIcon size={size} className={cn("stroke-current shrink-0", className)} {...props} />
    );
  }
  return (
    <Sparkles size={size} className={cn("stroke-current shrink-0", className)} {...props} />
  );
}

/**
 * Script injected into <head> to prevent icon layout shifts before hydration
 */
export const ICON_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(
  ICON_STORAGE_KEY
)});if(s){var p=JSON.parse(s);if(p.mode)document.documentElement.setAttribute('data-icon-mode',p.mode);if(p.pack)document.documentElement.setAttribute('data-icon-pack',p.pack);}}catch(e){}})();`;
