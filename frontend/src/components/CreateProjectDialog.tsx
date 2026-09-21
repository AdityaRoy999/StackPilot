"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Database,
  Eye,
  EyeOff,
  FolderTree,
  GitBranch,
  Globe,
  HardDrive,
  Info,
  Key,
  Link2,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/context/WorkspaceContext";
import { GitHubAuthButton } from "@/components/auth/GitHubAuthButton";
import { ProjectEnvEditor, ProjectEnvVar } from "@/components/ProjectEnvEditor";
import { RemoteSshTerminal } from "@/components/RemoteSshTerminal";
import { DockerTagSelector } from "@/components/DockerTagSelector";
import { AppIcon } from "@/lib/custom-icons";

interface GitHubRepo {
  id: number;
  full_name: string;
  clone_url: string;
  private: boolean;
  description: string;
}

interface GitHubReposResponse {
  repositories?: GitHubRepo[];
  warnings?: string[];
}

interface GitHubBranch {
  name: string;
  protected?: boolean;
  commit_sha?: string;
}

interface GitHubBranchesResponse {
  repository: string;
  branches: GitHubBranch[];
  count: number;
}

interface MeResponse {
  user: {
    github_connected: boolean;
    github_username: string;
    github_oauth_available: boolean;
  };
}

interface SshConnection {
  id: string;
  name: string;
  connection_type: "ssh" | "tailscale" | "headscale";
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "key" | "tailscale" | "headscale";
  last_tested_at: string;
}

interface SshConnectionsResponse {
  connections: SshConnection[];
}

interface SshBrowseEntry {
  name: string;
  directory: boolean;
  path: string;
}

interface SshBrowseResponse {
  path: string;
  entries: SshBrowseEntry[];
}

type SourceType = "github" | "ssh" | "local" | "application";
type ExecutionMode = "local" | "remote_host";
type RuntimeScheme = "http" | "https";
type RemoteRuntimeType = "docker" | "kubernetes";
type RemoteK8sExposure = "nodeport" | "ingress";

interface LocalBrowseEntry {
  name: string;
  directory: boolean;
  path: string;
}

interface LocalBrowseResponse {
  path: string;
  roots: { name: string; path: string }[];
  entries: LocalBrowseEntry[];
}

interface ProjectEnvironmentDraft {
  id: string;
  name: string;
  branch: string;
  auto_deploy: boolean;
  require_ci: boolean;
  cleanup_previous_on_success: boolean;
  env_vars: ProjectEnvVar[];
}

interface ApplicationField {
  id: string;
  label: string;
  envKey: string;
  type: "text" | "password" | "port";
  defaultValue: string;
  required?: boolean;
  secret?: boolean;
  helpText?: string;
}

export interface DockerHubItem {
  name: string;
  description: string;
  star_count: number;
  pull_count: number;
  is_official: boolean;
}

function formatPulls(count: number): string {
  if (!count) return "0";
  if (count >= 1000000000) return `${(count / 1000000000).toFixed(1)}B`;
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(0)}K`;
  return count.toString();
}

function guessPortForImage(imageName: string): number {
  const lower = imageName.toLowerCase();
  if (lower.includes("redis")) return 6379;
  if (lower.includes("postgres")) return 5432;
  if (lower.includes("mysql") || lower.includes("mariadb")) return 3306;
  if (lower.includes("mongo")) return 27017;
  if (lower.includes("nginx") || lower.includes("apache") || lower.includes("httpd") || lower.includes("caddy") || lower.includes("traefik")) return 80;
  if (lower.includes("rabbitmq")) return 5672;
  if (lower.includes("nats")) return 4222;
  if (lower.includes("elastic") || lower.includes("opensearch")) return 9200;
  if (lower.includes("kafka")) return 9092;
  if (lower.includes("clickhouse")) return 8123;
  if (lower.includes("memcached")) return 11211;
  if (lower.includes("prometheus")) return 9090;
  if (lower.includes("grafana")) return 3000;
  if (lower.includes("vault")) return 8200;
  if (lower.includes("minio")) return 9000;
  return 80;
}

interface ServiceCredentialPreset {
  detectedType: string;
  defaultPort: number;
  description: string;
  fields: ApplicationField[];
}

function detectServiceCredentials(imageName: string): ServiceCredentialPreset {
  const lower = imageName.toLowerCase();

  if (lower.includes("mysql") || lower.includes("mariadb")) {
    return {
      detectedType: lower.includes("mariadb") ? "MariaDB Database" : "MySQL Database",
      defaultPort: 3306,
      description: "Official MySQL/MariaDB images require a root password to initialize the database storage engine.",
      fields: [
        { id: "root_password", label: "Root Password", envKey: "MYSQL_ROOT_PASSWORD", type: "password", defaultValue: "", secret: true, required: true, helpText: "Superuser root password (required on first container start)" },
        { id: "database", label: "Initial Database", envKey: "MYSQL_DATABASE", type: "text", defaultValue: "app", required: false, helpText: "Database created on startup" },
        { id: "username", label: "Application User", envKey: "MYSQL_USER", type: "text", defaultValue: "app", required: false, helpText: "Standard application username" },
        { id: "password", label: "User Password", envKey: "MYSQL_PASSWORD", type: "password", defaultValue: "", secret: true, required: false, helpText: "Password for the application user" },
      ],
    };
  }

  if (lower.includes("postgres") || lower.includes("timescale") || lower.includes("postgis") || lower.includes("supabase")) {
    return {
      detectedType: "PostgreSQL Database",
      defaultPort: 5432,
      description: "Official PostgreSQL images require a password for the superuser to initialize data.",
      fields: [
        { id: "password", label: "Superuser Password", envKey: "POSTGRES_PASSWORD", type: "password", defaultValue: "", secret: true, required: true, helpText: "Superuser password for postgres" },
        { id: "username", label: "Superuser Name", envKey: "POSTGRES_USER", type: "text", defaultValue: "postgres", required: true, helpText: "Database superuser username" },
        { id: "database", label: "Initial Database", envKey: "POSTGRES_DB", type: "text", defaultValue: "app", required: false, helpText: "Database created on startup" },
      ],
    };
  }

  if (lower.includes("mongo")) {
    return {
      detectedType: "MongoDB Database",
      defaultPort: 27017,
      description: "Official MongoDB images require root administrative credentials to initialize authentication.",
      fields: [
        { id: "password", label: "Root Password", envKey: "MONGO_INITDB_ROOT_PASSWORD", type: "password", defaultValue: "", secret: true, required: true, helpText: "Administrative root password" },
        { id: "username", label: "Root Username", envKey: "MONGO_INITDB_ROOT_USERNAME", type: "text", defaultValue: "admin", required: true, helpText: "Administrative root username" },
        { id: "database", label: "Initial Database", envKey: "MONGO_INITDB_DATABASE", type: "text", defaultValue: "app", required: false, helpText: "Initial database" },
      ],
    };
  }

  if (lower.includes("redis") || lower.includes("keydb")) {
    return {
      detectedType: "Redis Cache",
      defaultPort: 6379,
      description: "In-memory key-value cache with optional requirepass authentication.",
      fields: [
        { id: "password", label: "Requirepass Password", envKey: "REDIS_PASSWORD", type: "password", defaultValue: "", secret: true, required: false, helpText: "Optional password for redis AUTH" },
      ],
    };
  }

  if (lower.includes("rabbitmq")) {
    return {
      detectedType: "RabbitMQ Broker",
      defaultPort: 5672,
      description: "Message broker with AMQP protocol and web management dashboard.",
      fields: [
        { id: "username", label: "Management User", envKey: "RABBITMQ_DEFAULT_USER", type: "text", defaultValue: "admin", required: true, helpText: "Web management & AMQP username" },
        { id: "password", label: "Management Password", envKey: "RABBITMQ_DEFAULT_PASS", type: "password", defaultValue: "", secret: true, required: true, helpText: "Web management & AMQP password" },
      ],
    };
  }

  if (lower.includes("minio")) {
    return {
      detectedType: "MinIO S3 Storage",
      defaultPort: 9000,
      description: "S3 compatible object storage with browser console UI.",
      fields: [
        { id: "username", label: "Root Access Key", envKey: "MINIO_ROOT_USER", type: "text", defaultValue: "minioadmin", required: true, helpText: "S3 access key / dashboard username" },
        { id: "password", label: "Root Secret Key", envKey: "MINIO_ROOT_PASSWORD", type: "password", defaultValue: "", secret: true, required: true, helpText: "S3 secret key (min 8 chars)" },
      ],
    };
  }

  if (lower.includes("clickhouse")) {
    return {
      detectedType: "ClickHouse Database",
      defaultPort: 8123,
      description: "High-performance real-time analytical columnar database.",
      fields: [
        { id: "username", label: "User", envKey: "CLICKHOUSE_USER", type: "text", defaultValue: "default", required: true },
        { id: "password", label: "Password", envKey: "CLICKHOUSE_PASSWORD", type: "password", defaultValue: "", secret: true, required: true },
        { id: "database", label: "Database", envKey: "CLICKHOUSE_DB", type: "text", defaultValue: "default", required: false },
      ],
    };
  }

  if (lower.includes("neo4j")) {
    return {
      detectedType: "Neo4j Graph DB",
      defaultPort: 7474,
      description: "Graph database management system.",
      fields: [
        { id: "password", label: "Auth (neo4j/password)", envKey: "NEO4J_AUTH", type: "password", defaultValue: "", secret: true, required: true, helpText: "Format: neo4j/<password>" },
      ],
    };
  }

  return {
    detectedType: "Generic Container",
    defaultPort: guessPortForImage(imageName),
    description: "General container image from Docker Hub.",
    fields: [],
  };
}

interface ApplicationTemplate {
  id: string;
  name: string;
  category: string;
  image: string;
  description: string;
  primaryPort: number;
  fields: ApplicationField[];
}

const APPLICATION_TEMPLATES: ApplicationTemplate[] = [
  {
    id: "postgres",
    name: "PostgreSQL",
    category: "Database",
    image: "postgres:16-alpine",
    description: "Relational database with persistent storage.",
    primaryPort: 5432,
    fields: [
      { id: "database", label: "Database", envKey: "POSTGRES_DB", type: "text", defaultValue: "app", required: true },
      { id: "username", label: "Username", envKey: "POSTGRES_USER", type: "text", defaultValue: "app", required: true },
      { id: "password", label: "Password", envKey: "POSTGRES_PASSWORD", type: "password", defaultValue: "", required: true, secret: true },
      { id: "public_port", label: "Public Port", envKey: "APP_PUBLIC_PORT", type: "port", defaultValue: "15432", required: true },
    ],
  },
  {
    id: "mysql",
    name: "MySQL",
    category: "Database",
    image: "mysql:8.4",
    description: "MySQL server with configurable database and user.",
    primaryPort: 3306,
    fields: [
      { id: "database", label: "Database", envKey: "MYSQL_DATABASE", type: "text", defaultValue: "app", required: true },
      { id: "username", label: "Username", envKey: "MYSQL_USER", type: "text", defaultValue: "app", required: true },
      { id: "password", label: "Password", envKey: "MYSQL_PASSWORD", type: "password", defaultValue: "", required: true, secret: true },
      { id: "root_password", label: "Root Password", envKey: "MYSQL_ROOT_PASSWORD", type: "password", defaultValue: "", required: true, secret: true },
      { id: "public_port", label: "Public Port", envKey: "APP_PUBLIC_PORT", type: "port", defaultValue: "13306", required: true },
    ],
  },
  {
    id: "mariadb",
    name: "MariaDB",
    category: "Database",
    image: "mariadb:11",
    description: "MySQL-compatible database with persistent storage.",
    primaryPort: 3306,
    fields: [
      { id: "database", label: "Database", envKey: "MYSQL_DATABASE", type: "text", defaultValue: "app", required: true },
      { id: "username", label: "Username", envKey: "MYSQL_USER", type: "text", defaultValue: "app", required: true },
      { id: "password", label: "Password", envKey: "MYSQL_PASSWORD", type: "password", defaultValue: "", required: true, secret: true },
      { id: "root_password", label: "Root Password", envKey: "MYSQL_ROOT_PASSWORD", type: "password", defaultValue: "", required: true, secret: true },
      { id: "public_port", label: "Public Port", envKey: "APP_PUBLIC_PORT", type: "port", defaultValue: "13307", required: true },
    ],
  },
  {
    id: "redis",
    name: "Redis",
    category: "Cache",
    image: "redis:7-alpine",
    description: "Fast in-memory cache and queue backend.",
    primaryPort: 6379,
    fields: [
      { id: "password", label: "Password", envKey: "REDIS_PASSWORD", type: "password", defaultValue: "", secret: true },
      { id: "public_port", label: "Public Port", envKey: "APP_PUBLIC_PORT", type: "port", defaultValue: "16379", required: true },
    ],
  },
  {
    id: "mongo",
    name: "MongoDB",
    category: "Database",
    image: "mongo:7",
    description: "Document database with root credentials.",
    primaryPort: 27017,
    fields: [
      { id: "username", label: "Root Username", envKey: "MONGO_INITDB_ROOT_USERNAME", type: "text", defaultValue: "admin", required: true },
      { id: "password", label: "Root Password", envKey: "MONGO_INITDB_ROOT_PASSWORD", type: "password", defaultValue: "", required: true, secret: true },
      { id: "public_port", label: "Public Port", envKey: "APP_PUBLIC_PORT", type: "port", defaultValue: "27018", required: true },
    ],
  },
  {
    id: "rabbitmq",
    name: "RabbitMQ",
    category: "Queue",
    image: "rabbitmq:3-management-alpine",
    description: "Message broker with the management UI enabled.",
    primaryPort: 5672,
    fields: [
      { id: "username", label: "Username", envKey: "RABBITMQ_DEFAULT_USER", type: "text", defaultValue: "admin", required: true },
      { id: "password", label: "Password", envKey: "RABBITMQ_DEFAULT_PASS", type: "password", defaultValue: "", required: true, secret: true },
      { id: "public_port", label: "Broker Port", envKey: "APP_PUBLIC_PORT", type: "port", defaultValue: "15672", required: true },
      { id: "public_ui_port", label: "Management Port", envKey: "APP_PUBLIC_UI_PORT", type: "port", defaultValue: "15673", required: true },
    ],
  },
  {
    id: "nats",
    name: "NATS",
    category: "Queue",
    image: "nats:2-alpine",
    description: "Lightweight message broker with monitoring.",
    primaryPort: 4222,
    fields: [
      { id: "public_port", label: "Client Port", envKey: "APP_PUBLIC_PORT", type: "port", defaultValue: "14222", required: true },
      { id: "public_ui_port", label: "Monitor Port", envKey: "APP_PUBLIC_UI_PORT", type: "port", defaultValue: "18222", required: true },
    ],
  },
  {
    id: "minio",
    name: "MinIO",
    category: "Storage",
    image: "minio/minio:latest",
    description: "S3-compatible object storage with a browser console.",
    primaryPort: 9000,
    fields: [
      { id: "username", label: "Root User", envKey: "MINIO_ROOT_USER", type: "text", defaultValue: "minioadmin", required: true },
      { id: "password", label: "Root Password", envKey: "MINIO_ROOT_PASSWORD", type: "password", defaultValue: "", required: true, secret: true },
      { id: "public_port", label: "API Port", envKey: "APP_PUBLIC_PORT", type: "port", defaultValue: "19000", required: true },
      { id: "public_ui_port", label: "Console Port", envKey: "APP_PUBLIC_UI_PORT", type: "port", defaultValue: "19001", required: true },
    ],
  },
  {
    id: "grafana",
    name: "Grafana",
    category: "Monitoring",
    image: "grafana/grafana-oss:11.5.2",
    description: "Dashboard and observability UI.",
    primaryPort: 3000,
    fields: [
      { id: "username", label: "Admin User", envKey: "GF_SECURITY_ADMIN_USER", type: "text", defaultValue: "admin", required: true },
      { id: "password", label: "Admin Password", envKey: "GF_SECURITY_ADMIN_PASSWORD", type: "password", defaultValue: "", required: true, secret: true },
      { id: "public_port", label: "Public Port", envKey: "APP_PUBLIC_PORT", type: "port", defaultValue: "13000", required: true },
    ],
  },
  {
    id: "prometheus",
    name: "Prometheus",
    category: "Monitoring",
    image: "prom/prometheus:v2.55.1",
    description: "Metrics collector and query UI.",
    primaryPort: 9090,
    fields: [
      { id: "public_port", label: "Public Port", envKey: "APP_PUBLIC_PORT", type: "port", defaultValue: "19090", required: true },
    ],
  },
  {
    id: "adminer",
    name: "Adminer",
    category: "Utility",
    image: "adminer:latest",
    description: "Lightweight database administration UI.",
    primaryPort: 8080,
    fields: [
      { id: "public_port", label: "Public Port", envKey: "APP_PUBLIC_PORT", type: "port", defaultValue: "18080", required: true },
    ],
  },
  {
    id: "nginx",
    name: "Nginx",
    category: "Web",
    image: "nginx:alpine",
    description: "Simple web server starter application.",
    primaryPort: 80,
    fields: [
      { id: "public_port", label: "Public Port", envKey: "APP_PUBLIC_PORT", type: "port", defaultValue: "8088", required: true },
    ],
  },
];

function randomSecret(length = 28) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

function initialApplicationConfig(template: ApplicationTemplate) {
  return Object.fromEntries(
    template.fields.map((field) => [field.id, field.secret && !field.defaultValue ? randomSecret() : field.defaultValue])
  );
}

function conciseApplicationProjectName(template: ApplicationTemplate) {
  return template.name;
}

function isGeneratedApplicationProjectName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (lower === "dockerhub" || lower === "custom-image") return true;
  if (APPLICATION_TEMPLATES.some((template) => template.id === lower || conciseApplicationProjectName(template).toLowerCase() === lower)) {
    return true;
  }
  return /^ai\s+.+\s+\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/i.test(trimmed);
}

function GuideSection({ heading, items }: { heading: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <h3 className="font-medium text-foreground">{heading}</h3>
      <div className="mt-3 space-y-2">
        {items.map((item) => (
          <p key={item} className="text-sm leading-relaxed text-muted-foreground">
            {item}
          </p>
        ))}
      </div>
    </div>
  );
}

const selectedTabClass =
  "h-full rounded-lg px-3 text-sm font-semibold data-[active]:!border-black data-[active]:!bg-black data-[active]:!text-white dark:data-[active]:!border-white dark:data-[active]:!bg-white dark:data-[active]:!text-black";

const segmentedTabsListClass = "grid h-10 w-full rounded-xl border border-border bg-muted/30 p-1";
const segmentedButtonClass =
  "h-8 justify-center rounded-lg border border-transparent px-3 text-sm font-semibold text-muted-foreground hover:bg-accent/60 hover:text-foreground";
const segmentedButtonActiveClass =
  "!border-black !bg-black !text-white hover:!bg-black hover:!text-white dark:!border-white dark:!bg-white dark:!text-black dark:hover:!bg-white dark:hover:!text-black";

function getRemoteHomePath(username?: string) {
  if (!username) return "/home";
  return username === "root" ? "/root" : `/home/${username}`;
}

function defaultProjectEnvironments(): ProjectEnvironmentDraft[] {
  return [
    {
      id: "development",
      name: "development",
      branch: "dev",
      auto_deploy: true,
      require_ci: false,
      cleanup_previous_on_success: true,
      env_vars: [],
    },
    {
      id: "production",
      name: "production",
      branch: "main",
      auto_deploy: false,
      require_ci: true,
      cleanup_previous_on_success: false,
      env_vars: [],
    },
  ];
}

export function CreateProjectDialog() {
  const router = useRouter();
  const { organizations, activeWorkspaceId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [organizationId, setOrganizationId] = useState<string>("");
  const [sourceType, setSourceType] = useState<SourceType>("github");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [githubPat, setGithubPat] = useState("");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [envVars, setEnvVars] = useState<ProjectEnvVar[]>([]);
  const [sshConnectionId, setSshConnectionId] = useState("");
  const [sshSourcePath, setSshSourcePath] = useState("");
  const [githubRemoteWorkspacePath, setGithubRemoteWorkspacePath] = useState("");
  const [sshBrowsePath, setSshBrowsePath] = useState("");
  const [sshEntries, setSshEntries] = useState<SshBrowseEntry[]>([]);
  const [hasBrowsedSshPath, setHasBrowsedSshPath] = useState(false);
  const [showSshConnectionPicker, setShowSshConnectionPicker] = useState(false);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("local");
  const [remoteRuntimeType, setRemoteRuntimeType] = useState<RemoteRuntimeType>("docker");
  const [remoteK8sExposure, setRemoteK8sExposure] = useState<RemoteK8sExposure>("nodeport");
  const [runtimeScheme, setRuntimeScheme] = useState<RuntimeScheme>("http");
  const [, setLocalHttpsEnabled] = useState(false);
  const [localExposureMode, setLocalExposureMode] = useState<"direct" | "portless" | "cloudflare_tunnel">("direct");
  const [cloudflareTunnelToken, setCloudflareTunnelToken] = useState("");
  const [localSourcePath, setLocalSourcePath] = useState("");
  const [localBrowsePath, setLocalBrowsePath] = useState("");
  const [localRoots, setLocalRoots] = useState<LocalBrowseResponse["roots"]>([]);
  const [localEntries, setLocalEntries] = useState<LocalBrowseEntry[]>([]);
  const [showRemoteTerminal, setShowRemoteTerminal] = useState(false);
  const [remoteTerminalCwd, setRemoteTerminalCwd] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [environments, setEnvironments] = useState<ProjectEnvironmentDraft[]>(() => defaultProjectEnvironments());
  const [applicationTemplateId, setApplicationTemplateId] = useState(APPLICATION_TEMPLATES[0].id);
  const [applicationSearch, setApplicationSearch] = useState("");
  const [dockerHubResults, setDockerHubResults] = useState<DockerHubItem[]>([]);
  const [isSearchingDockerHub, setIsSearchingDockerHub] = useState(false);
  const [selectedDockerHubImage, setSelectedDockerHubImage] = useState<DockerHubItem | null>(null);
  const [visiblePasswords, setVisiblePasswords] = useState<Record<string, boolean>>({});
  const [copiedFieldId, setCopiedFieldId] = useState<string | null>(null);
  const [newCustomKey, setNewCustomKey] = useState("");
  const [newCustomVal, setNewCustomVal] = useState("");
  const [newCustomIsSecret, setNewCustomIsSecret] = useState(true);
  const [applicationConfig, setApplicationConfig] = useState<Record<string, string>>(() =>
    initialApplicationConfig(APPLICATION_TEMPLATES[0])
  );

  useEffect(() => {
    const q = applicationSearch.trim();
    if (!q || q.length < 2) {
      setDockerHubResults([]);
      setIsSearchingDockerHub(false);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        setIsSearchingDockerHub(true);
        const res = await fetch(`/api/dockerhub?query=${encodeURIComponent(q)}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.results)) {
            setDockerHubResults(data.results);
          }
        }
      } catch (err) {
        console.error("Docker Hub search error:", err);
      } finally {
        setIsSearchingDockerHub(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [applicationSearch]);

  useEffect(() => {
    if (open) {
      const defaultOrg = activeWorkspaceId || organizations.find((o) => o.is_personal)?.id || organizations[0]?.id || "";
      setOrganizationId(defaultOrg);
    }
  }, [open, activeWorkspaceId, organizations]);

  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await api.get("/auth/me");
      return res.data as MeResponse;
    },
    enabled: open,
  });

  const sshConnectionsQuery = useQuery({
    queryKey: ["ssh-connections"],
    queryFn: async () => {
      const res = await api.get("/ssh/connections");
      return res.data as SshConnectionsResponse;
    },
    enabled: open,
  });

  const githubConnected = Boolean(meQuery.data?.user?.github_connected);
  const githubUsername = meQuery.data?.user?.github_username || "";
  const githubOAuthAvailable = Boolean(meQuery.data?.user?.github_oauth_available);
  const sshConnections = sshConnectionsQuery.data?.connections;
  const activeSshConnection = useMemo(
    () => sshConnections?.find((connection) => connection.id === sshConnectionId) ?? null,
    [sshConnectionId, sshConnections]
  );
  const runtimeHttpsAllowed =
    (executionMode === "remote_host" && remoteRuntimeType === "docker") ||
    (executionMode === "remote_host" && remoteRuntimeType === "kubernetes" && remoteK8sExposure === "ingress");
  const effectiveRuntimeScheme: RuntimeScheme = runtimeHttpsAllowed ? runtimeScheme : "http";
  const effectiveRemoteK8sExposure: RemoteK8sExposure =
    remoteRuntimeType === "kubernetes" && executionMode === "remote_host" ? remoteK8sExposure : "nodeport";
  const effectiveLocalHttpsEnabled = false;

  const isDockerHubSelected = applicationTemplateId === "dockerhub" || applicationTemplateId.startsWith("dockerhub:");

  const selectedApplicationTemplate = useMemo(() => {
    if (isDockerHubSelected) {
      const imageName = applicationConfig.image || selectedDockerHubImage?.name || "custom-image:latest";
      const preset = detectServiceCredentials(imageName);
      const port = parseInt(applicationConfig.container_port || String(preset.defaultPort), 10) || preset.defaultPort;

      const baseFields: ApplicationField[] = [
        { id: "image", label: "Docker Image Tag", envKey: "APP_IMAGE", type: "text" as const, defaultValue: imageName, required: true },
        { id: "container_port", label: "Container Port", envKey: "CONTAINER_PORT", type: "port" as const, defaultValue: String(port), required: true },
        { id: "public_port", label: "Public Port", envKey: "APP_PUBLIC_PORT", type: "port" as const, defaultValue: applicationConfig.public_port || String(10000 + port), required: true },
      ];

      const knownKeys = new Set([...baseFields.map((f) => f.id), ...preset.fields.map((f) => f.id), ...preset.fields.map((f) => f.envKey)]);
      const dynamicFields: ApplicationField[] = [];
      Object.keys(applicationConfig).forEach((k) => {
        if (!["image", "name", "container_port", "public_port", "template_id"].includes(k) && !knownKeys.has(k)) {
          const isSecret =
            k.toLowerCase().includes("pass") ||
            k.toLowerCase().includes("secret") ||
            k.toLowerCase().includes("key") ||
            k.toLowerCase().includes("auth");
          dynamicFields.push({
            id: k,
            label: k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
            envKey: k,
            type: isSecret ? "password" : "text",
            defaultValue: "",
            secret: isSecret,
            required: false,
          });
        }
      });

      return {
        id: "dockerhub",
        name: applicationConfig.name || selectedDockerHubImage?.name || imageName,
        category: preset.detectedType !== "Generic Container" ? preset.detectedType : "Docker Hub",
        image: imageName,
        description: selectedDockerHubImage?.description || preset.description,
        primaryPort: port,
        fields: [...baseFields, ...preset.fields, ...dynamicFields],
      };
    }
    return (
      APPLICATION_TEMPLATES.find((template) => template.id === applicationTemplateId) ?? APPLICATION_TEMPLATES[0]
    );
  }, [isDockerHubSelected, applicationTemplateId, applicationConfig, selectedDockerHubImage]);

  const filteredApplicationTemplates = useMemo(() => {
    const query = applicationSearch.trim().toLowerCase();
    if (!query) return APPLICATION_TEMPLATES;
    return APPLICATION_TEMPLATES.filter((template) =>
      [template.name, template.category, template.image, template.description].some((value) =>
        value.toLowerCase().includes(query)
      )
    );
  }, [applicationSearch]);

  const fetchReposMutation = useMutation({
    mutationFn: async (pat?: string) => {
      const res = pat ? await api.post("/github/repos", { pat }) : await api.get("/github/repos");
      const data = res.data as GitHubRepo[] | GitHubReposResponse;
      return Array.isArray(data)
        ? { repositories: data, warnings: [] }
        : { repositories: data.repositories || [], warnings: data.warnings || [] };
    },
    onSuccess: (data) => {
      setRepos(data.repositories);
      toast.success(`Fetched ${data.repositories.length} repositories`);
      data.warnings.forEach((warning) => toast.warning(warning));
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Unable to load repositories"
          : "Unable to load repositories";
      toast.error(message);
    },
  });

  const fetchBranchesMutation = useMutation({
    mutationFn: async (targetRepoUrl: string) => {
      const res = await api.post("/github/branches", {
        repo_url: targetRepoUrl,
        pat: githubPat || undefined,
      });
      return res.data as GitHubBranchesResponse;
    },
    onSuccess: (data) => {
      const nextBranches = data.branches || [];
      setBranches(nextBranches);
      if (nextBranches.length === 0) {
        toast.warning("No branches were returned for this repository");
        return;
      }

      const names = nextBranches.map((branch) => branch.name);
      setEnvironments((current) => {
        const used = new Set<string>();
        return current.map((environment) => {
          const preferred =
            environment.name.toLowerCase() === "production"
              ? (names.includes("main") ? "main" : names.includes("master") ? "master" : names[0])
              : (names.includes(environment.branch) ? environment.branch : names.includes("dev") ? "dev" : names.find((name) => name !== "main" && name !== "master") || names[0]);
          const branch = used.has(preferred)
            ? names.find((name) => !used.has(name)) || preferred
            : preferred;
          used.add(branch);
          return { ...environment, branch };
        });
      });
      toast.success(`Loaded ${nextBranches.length} branches`);
    },
    onError: (error: unknown) => {
      setBranches([]);
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string; details?: string } | undefined)?.details ||
            (error.response?.data as { error?: string } | undefined)?.error ||
            "Unable to load repository branches"
          : "Unable to load repository branches";
      toast.error(message);
    },
  });

  const browseSshMutation = useMutation({
    mutationFn: async (path: string) => {
      const res = await api.post(`/ssh/connections/${sshConnectionId}/browse`, { path });
      return res.data as SshBrowseResponse;
    },
    onSuccess: (data) => {
      setSshBrowsePath(data.path);
      setRemoteTerminalCwd(data.path);
      setSshEntries(data.entries);
      setHasBrowsedSshPath(true);
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Unable to browse remote path"
          : "Unable to browse remote path";
      toast.error(message);
    },
  });

  const browseLocalMutation = useMutation({
    mutationFn: async (path: string) => {
      const res = await api.post("/local/sources/browse", { path });
      return res.data as LocalBrowseResponse;
    },
    onSuccess: (data) => {
      setLocalRoots(data.roots || []);
      setLocalBrowsePath(data.path || "");
      setLocalEntries(data.entries || []);
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Unable to browse local source path"
          : "Unable to browse local source path";
      toast.error(message);
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const environmentPayload = environments.map((environment) => ({
        name: environment.name.trim().toLowerCase(),
        branch: sourceType === "application" ? "application" : environment.branch.trim(),
        auto_deploy: environment.auto_deploy,
        require_ci: sourceType === "application" ? false : environment.require_ci,
        cleanup_previous_on_success: environment.cleanup_previous_on_success,
        env_vars: environment.env_vars,
        execution_mode: executionMode,
        remote_connection_id: executionMode === "remote_host" ? sshConnectionId : "",
        remote_runtime_type: remoteRuntimeType,
        remote_k8s_exposure: effectiveRemoteK8sExposure,
        runtime_scheme: effectiveRuntimeScheme,
        local_exposure_mode: executionMode === "local" ? localExposureMode : undefined,
        cloudflare_tunnel_token: executionMode === "local" && localExposureMode === "cloudflare_tunnel" ? cloudflareTunnelToken : undefined,
      }));
      const payload =
        sourceType === "ssh"
          ? {
              name,
              description,
              env_vars: envVars,
              source_type: "ssh",
              ssh_connection_id: sshConnectionId,
              source_path: sshSourcePath,
              execution_mode: executionMode,
              remote_connection_id: executionMode === "remote_host" ? sshConnectionId : "",
              remote_runtime_type: remoteRuntimeType,
              remote_k8s_exposure: effectiveRemoteK8sExposure,
              runtime_scheme: effectiveRuntimeScheme,
              local_https_enabled: effectiveLocalHttpsEnabled,
              local_exposure_mode: executionMode === "local" ? localExposureMode : undefined,
              cloudflare_tunnel_token: executionMode === "local" && localExposureMode === "cloudflare_tunnel" ? cloudflareTunnelToken : undefined,
            }
          : sourceType === "local"
          ? {
              name,
              description,
              env_vars: envVars,
              source_type: "local",
              source_path: localSourcePath,
              execution_mode: "local",
              remote_runtime_type: remoteRuntimeType,
              remote_k8s_exposure: effectiveRemoteK8sExposure,
              runtime_scheme: effectiveRuntimeScheme,
              local_https_enabled: effectiveLocalHttpsEnabled,
              local_exposure_mode: localExposureMode,
              cloudflare_tunnel_token: localExposureMode === "cloudflare_tunnel" ? cloudflareTunnelToken : undefined,
            }
          : sourceType === "application"
          ? {
              name,
              description,
              env_vars: [
                ...envVars,
                ...selectedApplicationTemplate.fields
                  .filter((f) => !["image", "container_port", "public_port"].includes(f.id) && applicationConfig[f.id])
                  .map((f) => ({
                    key: f.envKey,
                    value: applicationConfig[f.id],
                    is_secret: f.secret ?? false,
                  })),
              ],
              source_type: "application",
              application_template_id: applicationTemplateId,
              application_config: {
                ...applicationConfig,
                ...Object.fromEntries(
                  selectedApplicationTemplate.fields
                    .filter((f) => applicationConfig[f.id])
                    .map((f) => [f.envKey, applicationConfig[f.id]])
                ),
              },
              source_path: executionMode === "remote_host" ? githubRemoteWorkspacePath || "/tmp" : "",
              execution_mode: executionMode,
              remote_connection_id: executionMode === "remote_host" ? sshConnectionId : "",
              remote_runtime_type: remoteRuntimeType,
              remote_k8s_exposure: effectiveRemoteK8sExposure,
              runtime_scheme: effectiveRuntimeScheme,
              local_https_enabled: effectiveLocalHttpsEnabled,
              local_exposure_mode: executionMode === "local" ? localExposureMode : undefined,
              cloudflare_tunnel_token: executionMode === "local" && localExposureMode === "cloudflare_tunnel" ? cloudflareTunnelToken : undefined,
            }
          : {
              name,
              description,
              env_vars: envVars,
              source_type: "github",
              repo_url: repoUrl,
              github_pat: githubPat,
              source_path: executionMode === "remote_host" ? githubRemoteWorkspacePath : "",
              execution_mode: executionMode,
              remote_connection_id: executionMode === "remote_host" ? sshConnectionId : "",
              remote_runtime_type: remoteRuntimeType,
              remote_k8s_exposure: effectiveRemoteK8sExposure,
              runtime_scheme: effectiveRuntimeScheme,
              local_https_enabled: effectiveLocalHttpsEnabled,
              local_exposure_mode: executionMode === "local" ? localExposureMode : undefined,
              cloudflare_tunnel_token: executionMode === "local" && localExposureMode === "cloudflare_tunnel" ? cloudflareTunnelToken : undefined,
            };
      const res = await api.post("/projects", {
        ...payload,
        organization_id: organizationId || undefined,
        environments: environmentPayload,
      });
      return res.data;
    },
    onSuccess: (data) => {
      toast.success("Project created successfully");
      (data?.warnings || []).forEach((warning: string) => toast.warning(warning));
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["deployments"] });
      setOpen(false);
      resetForm();
      if (data?.project?.id) {
        router.push(`/dashboard/projects/${data.project.id}`);
      }
    },
    onError: (error: unknown) => {
      const message =
        error instanceof AxiosError
          ? (error.response?.data as { error?: string } | undefined)?.error || "Failed to create project"
          : "Failed to create project";
      toast.error(message);
    },
  });

  const resetForm = () => {
    setSourceType("github");
    setName("");
    setDescription("");
    setRepoUrl("");
    setGithubPat("");
    setRepos([]);
    setBranches([]);
    setEnvVars([]);
    setSshConnectionId("");
    setSshSourcePath("");
    setGithubRemoteWorkspacePath("");
    setSshBrowsePath("");
    setSshEntries([]);
    setHasBrowsedSshPath(false);
    setShowSshConnectionPicker(false);
    setExecutionMode("local");
    setRemoteRuntimeType("docker");
    setRemoteK8sExposure("nodeport");
    setRuntimeScheme("http");
    setLocalHttpsEnabled(false);
    setLocalSourcePath("");
    setLocalBrowsePath("");
    setLocalRoots([]);
    setLocalEntries([]);
    setShowRemoteTerminal(false);
    setRemoteTerminalCwd("");
    setEnvironments(defaultProjectEnvironments());
    setApplicationTemplateId(APPLICATION_TEMPLATES[0].id);
    setApplicationSearch("");
    setDockerHubResults([]);
    setIsSearchingDockerHub(false);
    setSelectedDockerHubImage(null);
    setApplicationConfig(initialApplicationConfig(APPLICATION_TEMPLATES[0]));
  };

  const handleFetchRepos = () => {
    if (!githubPat) {
      toast.error("Please enter a GitHub PAT first");
      return;
    }
    fetchReposMutation.mutate(githubPat);
  };

  const handleLoadConnectedRepos = () => {
    fetchReposMutation.mutate(undefined);
  };

  const handleRepoSelect = (repo: GitHubRepo) => {
    setRepoUrl(repo.clone_url);
    if (!name) setName(repo.full_name.split("/")[1]);
    if (!description) setDescription(repo.description || "");
    fetchBranchesMutation.mutate(repo.clone_url);
  };

  const handleApplicationTemplateSelect = (template: ApplicationTemplate) => {
    setSelectedDockerHubImage(null);
    const shouldReplaceName = isGeneratedApplicationProjectName(name);
    setApplicationTemplateId(template.id);
    setApplicationConfig(initialApplicationConfig(template));
    if (shouldReplaceName) {
      setName(conciseApplicationProjectName(template));
    }
    if (!description.trim()) setDescription(template.description);
  };

  const handleDockerHubSelect = (item: DockerHubItem) => {
    setSelectedDockerHubImage(item);
    setApplicationTemplateId("dockerhub");
    const preset = detectServiceCredentials(item.name);
    const defaultPort = preset.defaultPort;
    const parts = item.name.split("/");
    const simpleName = parts[parts.length - 1];
    const capitalized = simpleName.charAt(0).toUpperCase() + simpleName.slice(1);
    const shouldReplaceName = isGeneratedApplicationProjectName(name) || !name.trim();

    const newConfig: Record<string, string> = {
      image: item.name.includes(":") ? item.name : `${item.name}:latest`,
      name: capitalized,
      container_port: defaultPort.toString(),
      public_port: (10000 + defaultPort).toString(),
    };

    preset.fields.forEach((f) => {
      if (f.secret) {
        const pass = randomSecret(20);
        newConfig[f.id] = pass;
        newConfig[f.envKey] = pass;
      } else if (f.defaultValue) {
        newConfig[f.id] = f.defaultValue;
        newConfig[f.envKey] = f.defaultValue;
      }
    });

    setApplicationConfig(newConfig);

    if (shouldReplaceName) {
      setName(capitalized);
    }
    if (!description.trim()) {
      setDescription(item.description || preset.description || `Docker Hub image ${item.name}`);
    }
    if (preset.detectedType !== "Generic Container") {
      toast.success(`Detected ${preset.detectedType}: credentials and default port ${defaultPort} auto-configured`);
    }
  };

  const handleCustomImageSelect = (customImage: string) => {
    const trimmed = customImage.trim();
    if (!trimmed) return;
    const preset = detectServiceCredentials(trimmed);
    const defaultPort = preset.defaultPort;
    const rawName = trimmed.split(":")[0];
    const parts = rawName.split("/");
    const simpleName = parts[parts.length - 1];
    const capitalized = simpleName.charAt(0).toUpperCase() + simpleName.slice(1);

    const item: DockerHubItem = {
      name: trimmed,
      description: `Docker container image ${trimmed}`,
      star_count: 0,
      pull_count: 0,
      is_official: false,
    };
    setSelectedDockerHubImage(item);
    setApplicationTemplateId("dockerhub");

    const newConfig: Record<string, string> = {
      image: trimmed.includes(":") ? trimmed : `${trimmed}:latest`,
      name: capitalized,
      container_port: defaultPort.toString(),
      public_port: (10000 + defaultPort).toString(),
    };

    preset.fields.forEach((f) => {
      if (f.secret) {
        const pass = randomSecret(20);
        newConfig[f.id] = pass;
        newConfig[f.envKey] = pass;
      } else if (f.defaultValue) {
        newConfig[f.id] = f.defaultValue;
        newConfig[f.envKey] = f.defaultValue;
      }
    });

    setApplicationConfig(newConfig);

    if (isGeneratedApplicationProjectName(name) || !name.trim()) {
      setName(capitalized);
    }
    if (!description.trim()) {
      setDescription(`Custom Docker image ${trimmed}`);
    }
    if (preset.detectedType !== "Generic Container") {
      toast.success(`Detected ${preset.detectedType}: credentials and default port ${defaultPort} auto-configured`);
    }
  };

  const handleApplicationSourceSelect = () => {
    setSourceType("application");
    if (isGeneratedApplicationProjectName(name)) setName(conciseApplicationProjectName(selectedApplicationTemplate));
    if (!description.trim()) setDescription(selectedApplicationTemplate.description);
  };

  const handleBrowseCurrentPath = () => {
    if (!sshConnectionId) {
      toast.error("Choose an SSH connection first");
      return;
    }
    const defaultRemoteHome = getRemoteHomePath(activeSshConnection?.username);
    const targetPath =
      sourceType === "github" || sourceType === "application"
        ? sshBrowsePath || githubRemoteWorkspacePath || defaultRemoteHome
        : sshBrowsePath || sshSourcePath || defaultRemoteHome;
    const normalizedPath =
      activeSshConnection?.username === "root" && targetPath === "/home/root" ? "/root" : targetPath;
    if (normalizedPath !== targetPath) {
      if (sourceType === "github") {
        setGithubRemoteWorkspacePath(normalizedPath);
      } else if (sourceType === "application") {
        setGithubRemoteWorkspacePath(normalizedPath);
      } else {
        setSshSourcePath(normalizedPath);
      }
      setRemoteTerminalCwd(normalizedPath);
    }
    browseSshMutation.mutate(normalizedPath);
  };

  const handleBrowseParent = () => {
    const current =
      sourceType === "github" || sourceType === "application"
        ? sshBrowsePath || githubRemoteWorkspacePath
        : sshBrowsePath || sshSourcePath;
    if (!current || current === "/") {
      browseSshMutation.mutate("/");
      return;
    }
    const segments = current.split("/").filter(Boolean);
    segments.pop();
    const parent = segments.length > 0 ? `/${segments.join("/")}` : "/";
    browseSshMutation.mutate(parent);
  };

  const handleSelectSshDirectory = (entry: SshBrowseEntry) => {
    if (sourceType === "github" || sourceType === "application") {
      setGithubRemoteWorkspacePath(entry.path);
    } else {
      setSshSourcePath(entry.path);
    }
    setRemoteTerminalCwd(entry.path);
    if (entry.directory) {
      browseSshMutation.mutate(entry.path);
    }
  };

  const handleBrowseLocalPath = () => {
    browseLocalMutation.mutate(localBrowsePath || localSourcePath || "");
  };

  const handleBrowseLocalParent = () => {
    const current = localBrowsePath || localSourcePath;
    if (!current) {
      browseLocalMutation.mutate("");
      return;
    }
    const segments = current.split("/").filter(Boolean);
    segments.pop();
    browseLocalMutation.mutate(segments.length > 0 ? `/${segments.join("/")}` : "/");
  };

  const handleSelectLocalDirectory = (entry: LocalBrowseEntry) => {
    setLocalSourcePath(entry.path);
    browseLocalMutation.mutate(entry.path);
  };

  const updateEnvironment = (id: string, patch: Partial<ProjectEnvironmentDraft>) => {
    setEnvironments((current) =>
      current.map((environment) =>
        environment.id === id ? { ...environment, ...patch } : environment
      )
    );
  };

  const addEnvironment = () => {
    setEnvironments((current) => [
      ...current,
      {
        id: `environment-${Date.now()}`,
        name: `environment-${current.length + 1}`,
        branch: "",
        auto_deploy: true,
        require_ci: false,
        cleanup_previous_on_success: false,
        env_vars: [],
      },
    ]);
  };

  const removeEnvironment = (id: string) => {
    setEnvironments((current) => (current.length <= 1 ? current : current.filter((environment) => environment.id !== id)));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) {
      toast.error("Project name is required");
      return;
    }
    if (sourceType === "github" && !repoUrl) {
      toast.error("Repository URL is required");
      return;
    }
    if (sourceType === "github" && executionMode === "remote_host" && !sshConnectionId) {
      toast.error("Choose a saved SSH/VPS connection for server-side GitHub builds");
      return;
    }
    if (sourceType === "github" && executionMode === "remote_host" && !githubRemoteWorkspacePath) {
      toast.error("Choose the remote workspace path where the GitHub repo should be cloned");
      return;
    }
    if (sourceType === "ssh" && (!sshConnectionId || !sshSourcePath)) {
      toast.error("Choose an SSH connection and remote path");
      return;
    }
    if (sourceType === "local" && !localSourcePath) {
      toast.error("Choose a local source path");
      return;
    }
    if (sourceType === "application") {
      if (!selectedApplicationTemplate) {
        toast.error("Choose an application template");
        return;
      }
      if (executionMode === "remote_host" && !sshConnectionId) {
        toast.error("Choose a saved SSH/VPS connection for server-side application deploys");
        return;
      }
      if (executionMode === "remote_host" && !githubRemoteWorkspacePath.trim()) {
        toast.error("Remote workspace path is required for remote application deployment");
        document.getElementById("applicationRemoteWorkspacePath")?.focus();
        return;
      }
      const missingField = selectedApplicationTemplate.fields.find(
        (field) => field.required && !String(applicationConfig[field.id] || "").trim()
      );
      if (missingField) {
        toast.error(`${missingField.label} is required`);
        return;
      }
    }
    const normalizedNames = environments.map((environment) => environment.name.trim().toLowerCase());
    const normalizedBranches =
      sourceType === "application" ? environments.map(() => "application") : environments.map((environment) => environment.branch.trim());
    if (normalizedNames.some((value) => !value) || normalizedBranches.some((value) => !value)) {
      toast.error("Every environment needs a name and branch");
      return;
    }
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      toast.error("Environment names must be unique");
      return;
    }
    createMutation.mutate();
  };

  useEffect(() => {
    if (open && sourceType === "github" && githubConnected && repos.length === 0 && fetchReposMutation.status === "idle") {
      fetchReposMutation.mutate(undefined);
    }
  }, [open, sourceType, githubConnected, repos.length, fetchReposMutation.status, fetchReposMutation]);

  useEffect(() => {
    if (open && sourceType === "local" && localRoots.length === 0 && browseLocalMutation.status === "idle") {
      browseLocalMutation.mutate("");
    }
  }, [open, sourceType, localRoots.length, browseLocalMutation.status, browseLocalMutation]);

  const renderRuntimePreferences = () => {
    const runtimeScope = executionMode === "remote_host" ? "Remote" : "Local";
    const segmentedGroupClass = cn(segmentedTabsListClass, "grid-cols-2");

    return (
      <div className="space-y-3">
        <div className="space-y-2">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {runtimeScope} Runtime
          </Label>
          <div className={segmentedGroupClass}>
            <Button
              type="button"
              variant="ghost"
              className={cn(segmentedButtonClass, remoteRuntimeType === "docker" && segmentedButtonActiveClass)}
              onClick={() => {
                setRemoteRuntimeType("docker");
                setRemoteK8sExposure("nodeport");
                setLocalHttpsEnabled(false);
              }}
            >
              <AppIcon name="server" fallback={Server} className="mr-2 h-4 w-4"  />
              {runtimeScope} Docker
            </Button>
            <Button
              type="button"
              variant="ghost"
              className={cn(segmentedButtonClass, remoteRuntimeType === "kubernetes" && segmentedButtonActiveClass)}
              onClick={() => setRemoteRuntimeType("kubernetes")}
            >
              <AppIcon name="server" fallback={Server} className="mr-2 h-4 w-4"  />
              {runtimeScope} Kubernetes
            </Button>
          </div>
        </div>

        {remoteRuntimeType === "kubernetes" ? (
          <>
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Kubernetes Exposure
              </Label>
              <div className={segmentedGroupClass}>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(segmentedButtonClass, remoteK8sExposure === "nodeport" && segmentedButtonActiveClass)}
                  onClick={() => {
                    setRemoteK8sExposure("nodeport");
                    setRuntimeScheme("http");
                    setLocalHttpsEnabled(false);
                  }}
                >
                  NodePort
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(segmentedButtonClass, remoteK8sExposure === "ingress" && segmentedButtonActiveClass)}
                  onClick={() => setRemoteK8sExposure("ingress")}
                  disabled={executionMode !== "remote_host"}
                  title={executionMode !== "remote_host" ? "Ingress requires a prepared remote Kubernetes host" : undefined}
                >
                  Ingress
                </Button>
              </div>
            </div>

            {remoteK8sExposure === "ingress" ? (
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Runtime URL Scheme
                </Label>
                <div className={segmentedGroupClass}>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, runtimeScheme === "http" && segmentedButtonActiveClass)}
                    onClick={() => {
                      setRuntimeScheme("http");
                      setLocalHttpsEnabled(false);
                    }}
                  >
                    HTTP
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, runtimeScheme === "https" && segmentedButtonActiveClass)}
                    onClick={() => {
                      setRuntimeScheme("https");
                      setLocalHttpsEnabled(executionMode === "local");
                    }}
                  >
                    HTTPS
                  </Button>
                </div>
              </div>
            ) : (
              <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                NodePort exposes HTTP on a node port. Choose Ingress when you need a domain and optional HTTPS.
              </p>
            )}
          </>
        ) : executionMode === "remote_host" ? (
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Runtime URL Scheme
            </Label>
            <div className={segmentedGroupClass}>
              <Button
                type="button"
                variant="ghost"
                className={cn(segmentedButtonClass, runtimeScheme === "http" && segmentedButtonActiveClass)}
                onClick={() => setRuntimeScheme("http")}
              >
                HTTP
              </Button>
              <Button
                type="button"
                variant="ghost"
                className={cn(segmentedButtonClass, runtimeScheme === "https" && segmentedButtonActiveClass)}
                onClick={() => setRuntimeScheme("https")}
              >
                HTTPS
              </Button>
            </div>
            <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              Remote Docker can use HTTPS when the server reverse proxy terminates TLS.
            </p>
          </div>
        ) : null}
      </div>
    );
  };

  const renderEnvironmentSettings = () => (
    <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Branch Environments
          </Label>
          <p className="mt-1 text-sm text-muted-foreground">
            {sourceType === "application"
              ? "Application catalog projects use environments for target settings and variables. The source branch is fixed internally."
              : "Map GitHub branches to deployable environments and choose how CI and replacement cleanup behave."}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addEnvironment}>
          <AppIcon name="plus" fallback={Plus} className="mr-2 h-4 w-4"  />
          Add
        </Button>
      </div>

      <div className="space-y-3">
        {environments.map((environment) => (
          <div key={environment.id} className="rounded-xl border border-border bg-card p-3">
            <div className="grid gap-3 lg:grid-cols-[1fr,1fr,auto]">
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Environment
                </Label>
                <Input
                  value={environment.name}
                  onChange={(event) => updateEnvironment(environment.id, { name: event.target.value })}
                  placeholder="development"
                  className="bg-muted/40"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Branch
                </Label>
                {sourceType === "application" ? (
                  <Input value="application" disabled className="bg-muted/40 text-muted-foreground" />
                ) : sourceType === "github" && branches.length > 0 ? (
                  <Select
                    value={environment.branch}
                    onValueChange={(value) => value && updateEnvironment(environment.id, { branch: value })}
                  >
                    <SelectTrigger className="h-10 w-full bg-muted/40">
                      <SelectValue placeholder="Select branch" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {branches.map((branch) => (
                        <SelectItem key={branch.name} value={branch.name}>
                          <span className="truncate">{branch.name}</span>
                          {branch.protected ? (
                            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              protected
                            </span>
                          ) : null}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={environment.branch}
                    onChange={(event) => updateEnvironment(environment.id, { branch: event.target.value })}
                    placeholder="dev"
                    className="bg-muted/40"
                  />
                )}
              </div>
              <div className="flex items-end justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  disabled={environments.length <= 1}
                  onClick={() => removeEnvironment(environment.id)}
                >
                  <AppIcon name="trash2" fallback={Trash2} className="h-4 w-4"  />
                </Button>
              </div>
            </div>

            <div className="mt-3 grid gap-2 lg:grid-cols-3">
              <Button
                type="button"
                variant="outline"
                className={cn(
                  "justify-start",
                  environment.auto_deploy && "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                )}
                onClick={() => updateEnvironment(environment.id, { auto_deploy: !environment.auto_deploy })}
              >
                <AppIcon name="git-branch" fallback={GitBranch} className="mr-2 h-4 w-4"  />
                {environment.auto_deploy ? "Auto deploy on push" : "Manual deploy only"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={cn(
                  "justify-start",
                  environment.require_ci && "border-blue-500/40 bg-blue-500/10 text-blue-500"
                )}
                onClick={() => updateEnvironment(environment.id, { require_ci: !environment.require_ci })}
                disabled={sourceType === "application"}
              >
                <AppIcon name="shield-check" fallback={ShieldCheck} className="mr-2 h-4 w-4"  />
                {sourceType === "application"
                  ? "CI checks do not apply"
                  : environment.require_ci
                    ? "Require CI checks"
                    : "Do not wait for CI"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={cn(
                  "justify-start",
                  environment.cleanup_previous_on_success && "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                )}
                onClick={() =>
                  updateEnvironment(environment.id, {
                    cleanup_previous_on_success: !environment.cleanup_previous_on_success,
                  })
                }
              >
                <AppIcon name="trash2" fallback={Trash2} className="mr-2 h-4 w-4"  />
                {environment.cleanup_previous_on_success ? "Clean old runtime" : "Keep old runtime"}
              </Button>
            </div>

            <div className="mt-3">
              <ProjectEnvEditor
                title={`${environment.name || "Environment"} variables`}
                description="These override shared project variables only for this branch environment."
                envVars={environment.env_vars}
                onChange={(nextEnvVars) => updateEnvironment(environment.id, { env_vars: nextEnvVars })}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) resetForm();
      }}
    >
      <DialogTrigger
        render={
          <Button>
            <AppIcon name="plus" fallback={Plus} size={16} className="mr-2 h-4 w-4" /> New Project
          </Button>
        }
      />
      <DialogContent className="!flex h-[min(90vh,940px)] !w-[min(96vw,1120px)] !max-w-[1120px] flex-col overflow-hidden rounded-2xl p-0">
        <DialogHeader className="shrink-0 border-b border-border p-6">
          <div className="flex items-start justify-between gap-4 pr-8">
            <div className="space-y-2">
              <DialogTitle className="flex items-center gap-2">
                <AppIcon name="plus" fallback={Plus} size={20} className="h-5 w-5 text-primary" />
                Create New Project
              </DialogTitle>
              <DialogDescription>
                Choose GitHub, a saved SSH/VPS folder, an allowed local folder, or a ready-made application template.
              </DialogDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setHelpOpen(true)} className="shrink-0">
              <AppIcon name="info" fallback={Info} className="mr-2 h-4 w-4"  />
              Guide
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin p-6 pb-4">
          <form onSubmit={handleSubmit} className="space-y-5 pb-2">
            <div className="space-y-3">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Project Source</Label>
              <div className={cn(segmentedTabsListClass, "grid-cols-4")}>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, sourceType === "github" && segmentedButtonActiveClass)}
                    onClick={() => setSourceType("github")}
                  >
                    <AppIcon name="git-branch" fallback={GitBranch} className="mr-2 h-4 w-4"  />
                    GitHub
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, sourceType === "ssh" && segmentedButtonActiveClass)}
                    onClick={() => setSourceType("ssh")}
                  >
                    <AppIcon name="server" fallback={Server} className="mr-2 h-4 w-4"  />
                    SSH / VPS
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, sourceType === "application" && segmentedButtonActiveClass)}
                    onClick={handleApplicationSourceSelect}
                  >
                    <AppIcon name="boxes" fallback={Boxes} className="mr-2 h-4 w-4"  />
                    Apps
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(segmentedButtonClass, sourceType === "local" && segmentedButtonActiveClass)}
                    onClick={() => setSourceType("local")}
                  >
                    <AppIcon name="hard-drive" fallback={HardDrive} className="mr-2 h-4 w-4"  />
                    Local
                  </Button>
              </div>
            </div>

            {sourceType === "github" ? (
              <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
                <div className="space-y-3 rounded-xl border border-border bg-muted/25 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        GitHub Account
                      </Label>
                      <p className="text-sm text-foreground">
                        {githubConnected
                          ? `Signed in as ${githubUsername || "GitHub user"}`
                          : "Use your GitHub connection to load repositories automatically."}
                      </p>
                    </div>
                    {githubConnected && (
                      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        <AppIcon name="check-circle2" fallback={CheckCircle2} className="h-3.5 w-3.5"  />
                        Signed in
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {githubConnected ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleLoadConnectedRepos}
                        disabled={fetchReposMutation.isPending}
                      >
                        {fetchReposMutation.isPending ? (
                          <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4 animate-spin"  />
                        ) : (
                          <AppIcon name="git-branch" fallback={GitBranch} className="mr-2 h-4 w-4"  />
                        )}
                        Load Repositories
                      </Button>
                    ) : githubOAuthAvailable ? (
                      <GitHubAuthButton mode="connect" enabled className="rounded-lg" />
                    ) : (
                      <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
                        <AppIcon name="link2" fallback={Link2} className="h-3.5 w-3.5"  />
                        GitHub OAuth not configured
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  <div className="h-px flex-1 bg-border" />
                  <span>or</span>
                  <div className="h-px flex-1 bg-border" />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="githubPat" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    GitHub Personal Access Token (PAT)
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="githubPat"
                      type="password"
                      value={githubPat}
                      onChange={(e) => setGithubPat(e.target.value)}
                      placeholder="ghp_xxxxxxxxxxxx"
                      autoComplete="off"
                      className="bg-muted/40"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleFetchRepos}
                      disabled={fetchReposMutation.isPending}
                      className="shrink-0"
                    >
                      {fetchReposMutation.isPending ? (
                        <AppIcon name="refresh-cw" fallback={RefreshCw} className="h-4 w-4 animate-spin"  />
                      ) : (
                        <AppIcon name="git-branch" fallback={GitBranch} className="mr-2 h-4 w-4"  />
                      )}
                      Fetch
                    </Button>
                  </div>
                </div>

                {repos.length > 0 && (
                  <div className="space-y-2">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Select Repository</Label>
                    <div className="max-h-[160px] divide-y divide-border/60 overflow-y-auto rounded-lg border border-border bg-muted/30 scrollbar-thin">
                      {repos.map((repo) => (
                        <button
                          key={repo.id}
                          type="button"
                          onClick={() => handleRepoSelect(repo)}
                          className={cn(
                            "group flex w-full items-center justify-between px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent",
                            repoUrl === repo.clone_url ? "bg-accent" : "bg-transparent"
                          )}
                        >
                          <div className="flex flex-col">
                            <span className="font-medium text-foreground">{repo.full_name}</span>
                            {repo.private && <span className="text-[10px] font-medium text-amber-500">Private</span>}
                          </div>
                          {repoUrl === repo.clone_url && <AppIcon name="check-circle2" fallback={CheckCircle2} className="h-4 w-4 text-primary"  />}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="repoUrl" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Repository URL
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="repoUrl"
                      value={repoUrl}
                      onChange={(e) => {
                        setRepoUrl(e.target.value);
                        setBranches([]);
                      }}
                      onBlur={() => {
                        if (repoUrl.trim()) fetchBranchesMutation.mutate(repoUrl.trim());
                      }}
                      placeholder="https://github.com/user/repo"
                      className="bg-muted/40"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => fetchBranchesMutation.mutate(repoUrl.trim())}
                      disabled={!repoUrl.trim() || fetchBranchesMutation.isPending}
                      className="shrink-0"
                    >
                      {fetchBranchesMutation.isPending ? (
                        <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4 animate-spin"  />
                      ) : (
                        <AppIcon name="git-branch" fallback={GitBranch} className="mr-2 h-4 w-4"  />
                      )}
                      Branches
                    </Button>
                  </div>
                  {sourceType === "github" && repoUrl && (
                    <p className="text-xs text-muted-foreground">
                      {fetchBranchesMutation.isPending
                        ? "Loading branches from GitHub..."
                        : branches.length > 0
                          ? `${branches.length} branches loaded. Environment branch fields now use the selector.`
                          : "Load branches to select dev/main instead of typing them manually."}
                    </p>
                  )}
                </div>

                <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Execution Target
                  </Label>
                  <div className={cn(segmentedTabsListClass, "grid-cols-2")}>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(segmentedButtonClass, executionMode === "local" && segmentedButtonActiveClass)}
                      onClick={() => setExecutionMode("local")}
                    >
                      <AppIcon name="hard-drive" fallback={HardDrive} className="mr-2 h-4 w-4"  />
                      Run locally
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(segmentedButtonClass, executionMode === "remote_host" && segmentedButtonActiveClass)}
                      onClick={() => setExecutionMode("remote_host")}
                    >
                      <AppIcon name="server" fallback={Server} className="mr-2 h-4 w-4"  />
                      Run on server
                    </Button>
                  </div>

                  {renderRuntimePreferences()}

                  {executionMode === "remote_host" && (
                    <div className="space-y-3">
                      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
                        The first deployment will run on the selected server using the runtime above. Docker stays
                        HTTP; Kubernetes Ingress can use HTTPS when the host is prepared.
                      </div>

                      <div className="grid gap-3 lg:grid-cols-[1fr,auto]">
                        <div className="grid gap-2">
                          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Server Connection
                          </Label>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-11 w-full justify-between bg-muted/40 px-3 font-normal"
                            onClick={() => setShowSshConnectionPicker((current) => !current)}
                          >
                            <span className={cn("truncate", !activeSshConnection && "text-muted-foreground")}>
                              {activeSshConnection
                                ? `${activeSshConnection.name} - ${activeSshConnection.username}@${activeSshConnection.host}${activeSshConnection.connection_type === "ssh" ? `:${activeSshConnection.port}` : ""}`
                                : "Select a saved connection"}
                            </span>
                            <AppIcon name="chevron-right" fallback={ChevronRight} className={cn("h-4 w-4 text-muted-foreground transition-transform", showSshConnectionPicker && "rotate-90")}  />
                          </Button>
                        </div>
                        <div className="self-end">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => queryClient.invalidateQueries({ queryKey: ["ssh-connections"] })}
                            disabled={sshConnectionsQuery.isFetching}
                          >
                            {sshConnectionsQuery.isFetching ? (
                              <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4 animate-spin"  />
                            ) : (
                              <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4"  />
                            )}
                            Refresh
                          </Button>
                        </div>
                      </div>

                      {showSshConnectionPicker && (
                        <div className="max-h-[180px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                          {sshConnections && sshConnections.length > 0 ? (
                            sshConnections.map((connection) => {
                              const isActive = connection.id === sshConnectionId;
                              return (
                                <button
                                  key={connection.id}
                                  type="button"
                                  onClick={() => {
                                    setSshConnectionId(connection.id);
                                    const defaultPath = getRemoteHomePath(connection.username);
                                    setGithubRemoteWorkspacePath((current) => current || defaultPath);
                                    setRemoteTerminalCwd(defaultPath);
                                    setSshBrowsePath("");
                                    setSshEntries([]);
                                    setHasBrowsedSshPath(false);
                                    setShowRemoteTerminal(false);
                                    setShowSshConnectionPicker(false);
                                  }}
                                  className={cn(
                                    "flex w-full items-start justify-between gap-3 border-b border-border/60 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-accent",
                                    isActive && "bg-accent"
                                  )}
                                >
                                  <div className="min-w-0">
                                    <div className="truncate font-medium text-foreground">{connection.name}</div>
                                    <div className="truncate text-sm text-muted-foreground">
                                      {connection.username}@{connection.host}
                                      {connection.connection_type === "ssh" ? `:${connection.port}` : ""}
                                    </div>
                                  </div>
                                  {isActive ? <AppIcon name="check-circle2" fallback={CheckCircle2} className="mt-0.5 h-4 w-4 shrink-0 text-primary"  /> : null}
                                </button>
                              );
                            })
                          ) : (
                            <div className="px-3 py-4 text-sm text-muted-foreground">
                              No saved SSH connections yet. Create one in Settings first.
                            </div>
                          )}
                        </div>
                      )}

                      {activeSshConnection && (
                        <>
                          <div className="space-y-2">
                            <Label
                              htmlFor="githubRemoteWorkspacePath"
                              className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                            >
                              Remote Workspace Path
                            </Label>
                            <div className="flex gap-2">
                              <Input
                                id="githubRemoteWorkspacePath"
                                value={githubRemoteWorkspacePath}
                                onChange={(e) => setGithubRemoteWorkspacePath(e.target.value)}
                                placeholder={`${getRemoteHomePath(activeSshConnection.username)}/stackpilot-workspaces`}
                                className="bg-muted/40"
                              />
                              <Button
                                type="button"
                                variant="outline"
                                onClick={handleBrowseCurrentPath}
                                disabled={!sshConnectionId || browseSshMutation.isPending}
                              >
                                {browseSshMutation.isPending ? (
                                  <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4 animate-spin"  />
                                ) : (
                                  <AppIcon name="folder-tree" fallback={FolderTree} className="mr-2 h-4 w-4"  />
                                )}
                                Browse
                              </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              StackPilot will clone each GitHub deployment under this folder in an isolated
                              <span className="font-mono"> stackpilot-builds/&lt;deployment-id&gt;</span> workspace.
                            </p>
                          </div>

                          {hasBrowsedSshPath && (
                            <div className="space-y-3 rounded-xl border border-border bg-muted/25 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                    Remote Browser
                                  </p>
                                  <p className="text-sm text-foreground">
                                    {sshBrowsePath || githubRemoteWorkspacePath || getRemoteHomePath(activeSshConnection.username)}
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={handleBrowseParent}
                                  disabled={browseSshMutation.isPending}
                                >
                                  Up
                                </Button>
                              </div>
                              {sshEntries.length > 0 ? (
                                <div className="max-h-[160px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                                  {sshEntries.map((entry) => (
                                    <button
                                      key={entry.path}
                                      type="button"
                                      onClick={() => handleSelectSshDirectory(entry)}
                                      className={cn(
                                        "flex w-full items-center justify-between border-b border-border/60 px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent",
                                        githubRemoteWorkspacePath === entry.path ? "bg-accent" : "bg-transparent"
                                      )}
                                    >
                                      <div className="flex items-center gap-2">
                                        <AppIcon name="folder-tree" fallback={FolderTree} className="h-4 w-4 text-muted-foreground"  />
                                        <span className="text-foreground">{entry.name}</span>
                                      </div>
                                      {entry.directory && <AppIcon name="chevron-right" fallback={ChevronRight} className="h-4 w-4 text-muted-foreground"  />}
                                    </button>
                                  ))}
                                </div>
                              ) : (
                                <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                                  This remote folder is empty. You can still use it as the workspace path.
                                </div>
                              )}
                            </div>
                          )}

                          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                  Server Terminal
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  Optional shell access for this server before creating the project.
                                </p>
                              </div>
                              <Button
                                type="button"
                                variant={showRemoteTerminal ? "default" : "outline"}
                                onClick={() => {
                                  setRemoteTerminalCwd(githubRemoteWorkspacePath || getRemoteHomePath(activeSshConnection.username));
                                  setShowRemoteTerminal((current) => !current);
                                }}
                              >
                                <AppIcon name="terminal" fallback={Terminal} className="mr-2 h-4 w-4"  />
                                Terminal
                              </Button>
                            </div>
                            {showRemoteTerminal && (
                              <RemoteSshTerminal
                                connectionId={sshConnectionId}
                                cwd={remoteTerminalCwd || githubRemoteWorkspacePath || getRemoteHomePath(activeSshConnection.username)}
                              />
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : sourceType === "application" ? (
              <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr),minmax(0,1.25fr)]">
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Application Catalog & Docker Hub
                        </Label>
                        {isSearchingDockerHub && (
                          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <AppIcon name="refresh-cw" fallback={RefreshCw} className="h-3 w-3 animate-spin text-primary" />
                            Searching Docker Hub...
                          </span>
                        )}
                      </div>
                      <Input
                        value={applicationSearch}
                        onChange={(event) => setApplicationSearch(event.target.value)}
                        placeholder="Search templates or any Docker Hub image (e.g. redis, nginx, meilisearch)..."
                        className="bg-muted/40"
                      />
                    </div>
                    <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
                      {applicationSearch.trim().length > 0 && (
                        <button
                          type="button"
                          onClick={() => handleCustomImageSelect(applicationSearch.trim())}
                          className={cn(
                            "w-full rounded-xl border border-dashed border-primary/40 bg-primary/5 p-3 text-left transition-colors hover:bg-primary/10",
                            isDockerHubSelected && applicationConfig.image === applicationSearch.trim() && "border-primary bg-primary/15"
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <AppIcon name="boxes" fallback={Boxes} className="h-4 w-4 text-primary shrink-0" />
                              <span className="font-medium text-foreground text-xs truncate">
                                Pull image tag: <code className="text-primary font-bold">{applicationSearch.trim()}</code>
                              </span>
                            </div>
                            <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">
                              Custom Image
                            </span>
                          </div>
                        </button>
                      )}

                      {filteredApplicationTemplates.length > 0 && (
                        <div className="space-y-1.5">
                          {applicationSearch.trim().length > 0 && (
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1 pt-1">
                              Curated Templates
                            </p>
                          )}
                          {filteredApplicationTemplates.map((template) => {
                            const isActive = !isDockerHubSelected && template.id === applicationTemplateId;
                            return (
                              <button
                                key={template.id}
                                type="button"
                                onClick={() => handleApplicationTemplateSelect(template)}
                                className={cn(
                                  "w-full rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent",
                                  isActive && "border-primary/50 bg-accent"
                                )}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <AppIcon name="boxes" fallback={Boxes} className="h-4 w-4 text-muted-foreground" />
                                      <span className="font-medium text-foreground text-sm">{template.name}</span>
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">{template.description}</p>
                                    <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
                                      {template.image}
                                    </p>
                                  </div>
                                  <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    {template.category}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {dockerHubResults.length > 0 && (
                        <div className="space-y-1.5 pt-1">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-primary px-1 pt-1 flex items-center justify-between">
                            <span>Docker Hub Registry</span>
                            <span className="text-[9px] text-muted-foreground lowercase">pulls on-demand</span>
                          </p>
                          {dockerHubResults.map((item) => {
                            const isItemActive =
                              isDockerHubSelected &&
                              (selectedDockerHubImage?.name === item.name || applicationConfig.image?.startsWith(item.name));
                            return (
                              <button
                                key={item.name}
                                type="button"
                                onClick={() => handleDockerHubSelect(item)}
                                className={cn(
                                  "w-full rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent",
                                  isItemActive && "border-primary/50 bg-accent"
                                )}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <AppIcon name="boxes" fallback={Boxes} className="h-4 w-4 text-muted-foreground shrink-0" />
                                      <span className="font-medium text-foreground text-sm font-mono">{item.name}</span>
                                      {item.is_official && (
                                        <span className="rounded-full bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.2 text-[9px] font-semibold uppercase tracking-wider text-emerald-400">
                                          Official
                                        </span>
                                      )}
                                    </div>
                                    {item.description && (
                                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                                        {item.description}
                                      </p>
                                    )}
                                    <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground font-mono">
                                      <span>⭐ {item.star_count.toLocaleString()}</span>
                                      <span>⬇ {formatPulls(item.pull_count)} pulls</span>
                                    </div>
                                  </div>
                                  <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    Docker Hub
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {filteredApplicationTemplates.length === 0 && dockerHubResults.length === 0 && !isSearchingDockerHub && applicationSearch.trim().length > 0 && (
                        <div className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                          No matching curated templates found. You can click the "Pull image tag" button above to pull <code className="text-primary">{applicationSearch.trim()}</code> directly from Docker Hub!
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-xl border border-border bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Selected Application
                          </Label>
                          <h3 className="mt-1 text-lg font-semibold text-foreground">{selectedApplicationTemplate.name}</h3>
                          <p className="mt-1 text-sm text-muted-foreground">{selectedApplicationTemplate.description}</p>
                        </div>
                        <div className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground">
                          port {selectedApplicationTemplate.primaryPort}
                        </div>
                      </div>

                      {/* Database & Credentials Guidance Banner */}
                      {selectedApplicationTemplate.fields.some((f) => f.secret) && (
                        <div className="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-3 text-xs">
                          <div className="flex items-start gap-2.5">
                            <AppIcon name="database" fallback={Database} className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                            <div className="space-y-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-foreground">
                                  Database Credentials &amp; Passwords
                                </span>
                                <span className="rounded-full bg-primary/10 border border-primary/20 px-2 py-0.2 text-[10px] font-mono font-medium text-primary">
                                  Auto-Configured &amp; Encrypted
                                </span>
                              </div>
                              <p className="text-muted-foreground text-[11px] leading-relaxed">
                                Docker Hub database images require specific environment variables (such as <code className="text-primary font-mono">MYSQL_ROOT_PASSWORD</code> or <code className="text-primary font-mono">POSTGRES_PASSWORD</code>) to initialize storage on first run. StackPilot has pre-populated and generated secure passwords below. You can view, copy, or regenerate them at any time.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        {selectedApplicationTemplate.fields.map((field) => (
                          <div key={field.id} className="space-y-1.5 rounded-lg border border-border/60 bg-muted/20 p-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <Label
                                htmlFor={`application-${field.id}`}
                                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"
                              >
                                {field.secret && <AppIcon name="key" fallback={Key} className="h-3 w-3 text-primary" />}
                                {field.label}
                              </Label>
                              <span className="font-mono text-[10px] text-muted-foreground/80">{field.envKey}</span>
                            </div>

                            {field.id === "image" ? (
                              <DockerTagSelector
                                imageName={
                                  applicationConfig.image ||
                                  selectedDockerHubImage?.name ||
                                  selectedApplicationTemplate.image ||
                                  "custom-image"
                                }
                                value={applicationConfig[field.id] || field.defaultValue || "latest"}
                                onChange={(_tag, fullImage) => {
                                  setApplicationConfig((current) => ({
                                    ...current,
                                    image: fullImage,
                                    [field.id]: fullImage,
                                  }));
                                }}
                              />
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <div className="relative flex-1">
                                  <Input
                                    id={`application-${field.id}`}
                                    type={
                                      field.type === "password" || field.secret
                                        ? visiblePasswords[field.id]
                                          ? "text"
                                          : "password"
                                        : field.type === "port"
                                        ? "number"
                                        : "text"
                                    }
                                    value={applicationConfig[field.id] ?? ""}
                                    min={field.type === "port" ? 1 : undefined}
                                    max={field.type === "port" ? 65535 : undefined}
                                    onChange={(event) => {
                                      const val = event.target.value;
                                      setApplicationConfig((current) => ({
                                        ...current,
                                        [field.id]: val,
                                        [field.envKey]: val,
                                      }));
                                    }}
                                    placeholder={field.defaultValue || field.envKey}
                                    autoComplete="off"
                                    className="bg-background text-xs font-mono pr-16"
                                  />
                                  {(field.secret || field.type === "password") && (
                                    <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          setVisiblePasswords((prev) => ({
                                            ...prev,
                                            [field.id]: !prev[field.id],
                                          }))
                                        }
                                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                        title={visiblePasswords[field.id] ? "Hide password" : "Show password"}
                                      >
                                        {visiblePasswords[field.id] ? (
                                          <AppIcon name="eye-off" fallback={EyeOff} className="h-3.5 w-3.5" />
                                        ) : (
                                          <AppIcon name="eye" fallback={Eye} className="h-3.5 w-3.5" />
                                        )}
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => {
                                          const val = applicationConfig[field.id] || "";
                                          if (val) {
                                            navigator.clipboard.writeText(val);
                                            setCopiedFieldId(field.id);
                                            setTimeout(() => setCopiedFieldId(null), 2000);
                                            toast.success(`Copied ${field.label} to clipboard`);
                                          }
                                        }}
                                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                        title="Copy to clipboard"
                                      >
                                        {copiedFieldId === field.id ? (
                                          <AppIcon name="check" fallback={Check} className="h-3.5 w-3.5 text-emerald-400" />
                                        ) : (
                                          <AppIcon name="copy" fallback={Copy} className="h-3.5 w-3.5" />
                                        )}
                                      </Button>
                                    </div>
                                  )}
                                </div>

                                {field.secret && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                      const secret = randomSecret(20);
                                      setApplicationConfig((current) => ({
                                        ...current,
                                        [field.id]: secret,
                                        [field.envKey]: secret,
                                      }));
                                      toast.success(`Generated new ${field.label}`);
                                    }}
                                    className="shrink-0 h-9 px-2 text-xs"
                                    title="Generate new random secure password"
                                  >
                                    <AppIcon name="sparkles" fallback={Sparkles} className="h-3.5 w-3.5 text-primary mr-1" />
                                    Generate
                                  </Button>
                                )}
                              </div>
                            )}

                            {field.helpText && (
                              <p className="text-[10px] text-muted-foreground/80 leading-normal">{field.helpText}</p>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Quick Credential Presets Bar */}
                      <div className="mt-4 space-y-2 border-t border-border/60 pt-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Credential Presets &amp; Custom Variables
                          </Label>
                          <span className="text-[10px] text-muted-foreground">Click to quick-add credentials</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              const rootPass = randomSecret(20);
                              const userPass = randomSecret(20);
                              setApplicationConfig((prev) => ({
                                ...prev,
                                container_port: "3306",
                                public_port: prev.public_port || "13306",
                                root_password: rootPass,
                                MYSQL_ROOT_PASSWORD: rootPass,
                                database: "app",
                                MYSQL_DATABASE: "app",
                                username: "app",
                                MYSQL_USER: "app",
                                password: userPass,
                                MYSQL_PASSWORD: userPass,
                              }));
                              toast.success("Applied MySQL / MariaDB credentials preset with generated passwords");
                            }}
                          >
                            + MySQL / MariaDB
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              const pass = randomSecret(20);
                              setApplicationConfig((prev) => ({
                                ...prev,
                                container_port: "5432",
                                public_port: prev.public_port || "15432",
                                password: pass,
                                POSTGRES_PASSWORD: pass,
                                username: "postgres",
                                POSTGRES_USER: "postgres",
                                database: "app",
                                POSTGRES_DB: "app",
                              }));
                              toast.success("Applied PostgreSQL credentials preset with generated password");
                            }}
                          >
                            + PostgreSQL
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              const pass = randomSecret(20);
                              setApplicationConfig((prev) => ({
                                ...prev,
                                container_port: "27017",
                                public_port: prev.public_port || "27018",
                                password: pass,
                                MONGO_INITDB_ROOT_PASSWORD: pass,
                                username: "admin",
                                MONGO_INITDB_ROOT_USERNAME: "admin",
                                database: "app",
                                MONGO_INITDB_DATABASE: "app",
                              }));
                              toast.success("Applied MongoDB credentials preset with generated password");
                            }}
                          >
                            + MongoDB
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              const pass = randomSecret(20);
                              setApplicationConfig((prev) => ({
                                ...prev,
                                container_port: "6379",
                                public_port: prev.public_port || "16379",
                                password: pass,
                                REDIS_PASSWORD: pass,
                              }));
                              toast.success("Applied Redis password preset");
                            }}
                          >
                            + Redis Password
                          </Button>
                        </div>

                        {/* Add Custom Env Var / Password Row */}
                        <div className="flex flex-wrap items-center gap-2 pt-2">
                          <Input
                            value={newCustomKey}
                            onChange={(e) => setNewCustomKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
                            placeholder="VARIABLE_NAME (e.g. AUTH_SECRET)"
                            className="h-8 text-xs font-mono w-48 bg-muted/30"
                          />
                          <Input
                            value={newCustomVal}
                            onChange={(e) => setNewCustomVal(e.target.value)}
                            placeholder="Value / Secret"
                            type={newCustomIsSecret ? "password" : "text"}
                            className="h-8 text-xs font-mono flex-1 min-w-[140px] bg-muted/30"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setNewCustomVal(randomSecret(20))}
                            className="h-8 px-2 text-xs"
                            title="Generate secret for this field"
                          >
                            <AppIcon name="sparkles" fallback={Sparkles} className="h-3 w-3 mr-1 text-primary" />
                            Random
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              if (!newCustomKey.trim()) {
                                toast.error("Please enter a variable name");
                                return;
                              }
                              const k = newCustomKey.trim();
                              setApplicationConfig((prev) => ({
                                ...prev,
                                [k]: newCustomVal,
                              }));
                              setNewCustomKey("");
                              setNewCustomVal("");
                              toast.success(`Added ${k} to configuration`);
                            }}
                            className="h-8 text-xs"
                          >
                            <AppIcon name="plus" fallback={Plus} className="h-3 w-3 mr-1" />
                            Add
                          </Button>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
                      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Execution Target
                      </Label>
                      <div className={cn(segmentedTabsListClass, "grid-cols-2")}>
                        <Button
                          type="button"
                          variant="ghost"
                          className={cn(segmentedButtonClass, executionMode === "local" && segmentedButtonActiveClass)}
                          onClick={() => setExecutionMode("local")}
                        >
                          <AppIcon name="hard-drive" fallback={HardDrive} className="mr-2 h-4 w-4"  />
                          Run locally
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className={cn(segmentedButtonClass, executionMode === "remote_host" && segmentedButtonActiveClass)}
                          onClick={() => setExecutionMode("remote_host")}
                        >
                          <AppIcon name="server" fallback={Server} className="mr-2 h-4 w-4"  />
                          Run on server
                        </Button>
                      </div>

                      {renderRuntimePreferences()}

                      {executionMode === "remote_host" && (
                        <div className="space-y-3">
                          <div className="grid gap-3 lg:grid-cols-[1fr,auto]">
                            <div className="grid gap-2">
                              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                Server Connection
                              </Label>
                              <Button
                                type="button"
                                variant="outline"
                                className="h-11 w-full justify-between bg-muted/40 px-3 font-normal"
                                onClick={() => setShowSshConnectionPicker((current) => !current)}
                              >
                                <span className={cn("truncate", !activeSshConnection && "text-muted-foreground")}>
                                  {activeSshConnection
                                    ? `${activeSshConnection.name} - ${activeSshConnection.username}@${activeSshConnection.host}${activeSshConnection.connection_type === "ssh" ? `:${activeSshConnection.port}` : ""}`
                                    : "Select a saved connection"}
                                </span>
                                <AppIcon name="chevron-right" fallback={ChevronRight} className={cn("h-4 w-4 text-muted-foreground transition-transform", showSshConnectionPicker && "rotate-90")}  />
                              </Button>
                            </div>
                            <div className="self-end">
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => queryClient.invalidateQueries({ queryKey: ["ssh-connections"] })}
                                disabled={sshConnectionsQuery.isFetching}
                              >
                                {sshConnectionsQuery.isFetching ? (
                                  <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4 animate-spin"  />
                                ) : (
                                  <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4"  />
                                )}
                                Refresh
                              </Button>
                            </div>
                          </div>

                          {showSshConnectionPicker && (
                            <div className="max-h-[180px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                              {sshConnections && sshConnections.length > 0 ? (
                                sshConnections.map((connection) => {
                                  const isActive = connection.id === sshConnectionId;
                                  return (
                                    <button
                                      key={connection.id}
                                      type="button"
                                      onClick={() => {
                                        setSshConnectionId(connection.id);
                                        const defaultPath = getRemoteHomePath(connection.username);
                                        setGithubRemoteWorkspacePath((current) => current || defaultPath);
                                        setRemoteTerminalCwd(defaultPath);
                                        setSshBrowsePath("");
                                        setSshEntries([]);
                                        setHasBrowsedSshPath(false);
                                        setShowRemoteTerminal(false);
                                        setShowSshConnectionPicker(false);
                                      }}
                                      className={cn(
                                        "flex w-full items-start justify-between gap-3 border-b border-border/60 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-accent",
                                        isActive && "bg-accent"
                                      )}
                                    >
                                      <div className="min-w-0">
                                        <div className="truncate font-medium text-foreground">{connection.name}</div>
                                        <div className="truncate text-sm text-muted-foreground">
                                          {connection.username}@{connection.host}
                                          {connection.connection_type === "ssh" ? `:${connection.port}` : ""}
                                        </div>
                                      </div>
                                      {isActive ? <AppIcon name="check-circle2" fallback={CheckCircle2} className="mt-0.5 h-4 w-4 shrink-0 text-primary"  /> : null}
                                    </button>
                                  );
                                })
                              ) : (
                                <div className="px-3 py-4 text-sm text-muted-foreground">
                                  No saved SSH connections yet. Create one in Settings first.
                                </div>
                              )}
                            </div>
                          )}

                          {activeSshConnection && (
                            <div className="space-y-2">
                              <Label
                                htmlFor="applicationRemoteWorkspacePath"
                                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                              >
                                Remote Workspace Path
                              </Label>
                              <div className="flex gap-2">
                                <Input
                                  id="applicationRemoteWorkspacePath"
                                  value={githubRemoteWorkspacePath}
                                  onChange={(event) => setGithubRemoteWorkspacePath(event.target.value)}
                                  placeholder={`${getRemoteHomePath(activeSshConnection.username)}/stackpilot-workspaces`}
                                  className="bg-muted/40"
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={handleBrowseCurrentPath}
                                  disabled={!sshConnectionId || browseSshMutation.isPending}
                                >
                                  {browseSshMutation.isPending ? (
                                    <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4 animate-spin"  />
                                  ) : (
                                    <AppIcon name="folder-tree" fallback={FolderTree} className="mr-2 h-4 w-4"  />
                                  )}
                                  Browse
                                </Button>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                StackPilot generates a compose source bundle here, then builds and runs it on the selected server.
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : sourceType === "ssh" ? (
              <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
                <div className="space-y-3">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Execution Target
                  </Label>
                  <div className={cn(segmentedTabsListClass, "grid-cols-2")}>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(segmentedButtonClass, executionMode === "local" && segmentedButtonActiveClass)}
                      onClick={() => setExecutionMode("local")}
                    >
                      <AppIcon name="hard-drive" fallback={HardDrive} className="mr-2 h-4 w-4"  />
                      Run locally
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(segmentedButtonClass, executionMode === "remote_host" && segmentedButtonActiveClass)}
                      onClick={() => setExecutionMode("remote_host")}
                    >
                      <AppIcon name="server" fallback={Server} className="mr-2 h-4 w-4"  />
                      Run on server
                    </Button>
                  </div>
                  {renderRuntimePreferences()}
                  {executionMode === "remote_host" && (
                    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
                      The first deployment will run on this server using the runtime above. Docker stays HTTP;
                      Kubernetes Ingress can use HTTPS when the host is prepared.
                    </div>
                  )}
                </div>

                <div className="grid gap-4 lg:grid-cols-[1fr,auto]">
                  <div className="grid gap-2">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Saved SSH Connection
                    </Label>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 w-full justify-between bg-muted/40 px-3 font-normal"
                      onClick={() => setShowSshConnectionPicker((current) => !current)}
                    >
                      <span className={cn("truncate", !activeSshConnection && "text-muted-foreground")}>
                        {activeSshConnection
                          ? `${activeSshConnection.name} - ${activeSshConnection.username}@${activeSshConnection.host}${activeSshConnection.connection_type === "ssh" ? `:${activeSshConnection.port}` : ""}`
                          : "Select a saved connection"}
                      </span>
                      <AppIcon name="chevron-right" fallback={ChevronRight} className={cn("h-4 w-4 text-muted-foreground transition-transform", showSshConnectionPicker && "rotate-90")}  />
                    </Button>
                  </div>
                  <div className="self-end">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => queryClient.invalidateQueries({ queryKey: ["ssh-connections"] })}
                      disabled={sshConnectionsQuery.isFetching}
                    >
                      {sshConnectionsQuery.isFetching ? (
                        <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4 animate-spin"  />
                      ) : (
                        <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4"  />
                      )}
                      Refresh
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Local HTTPS is stored for local Kubernetes/Ingress experiments. Plain Docker builds stay HTTP.
                  </p>
                </div>

                {showSshConnectionPicker && (
                  <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-3">
                    {sshConnections && sshConnections.length > 0 ? (
                      <div className="max-h-[220px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                        {sshConnections.map((connection) => {
                          const isActive = connection.id === sshConnectionId;
                          return (
                            <button
                              key={connection.id}
                              type="button"
                              onClick={() => {
                                setSshConnectionId(connection.id);
                                setSshEntries([]);
                                setSshBrowsePath("");
                                setHasBrowsedSshPath(false);
                                const defaultPath = getRemoteHomePath(connection.username);
                                setSshSourcePath(defaultPath);
                                setRemoteTerminalCwd(defaultPath);
                                setShowSshConnectionPicker(false);
                              }}
                              className={cn(
                                "flex w-full items-start justify-between gap-3 border-b border-border/60 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-accent",
                                isActive && "bg-accent"
                              )}
                            >
                              <div className="min-w-0">
                                <div className="truncate font-medium text-foreground">{connection.name}</div>
                                <div className="truncate text-sm text-muted-foreground">
                                  {connection.username}@{connection.host}
                                  {connection.connection_type === "ssh" ? `:${connection.port}` : ""}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                  {connection.connection_type === "headscale" ? "headscale" : connection.connection_type === "tailscale" ? "tailscale" : connection.auth_type}
                                </span>
                                {isActive ? <AppIcon name="check-circle2" fallback={CheckCircle2} className="mt-0.5 h-4 w-4 text-primary"  /> : null}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                        No saved SSH connections yet. Create one in Settings first.
                      </div>
                    )}
                  </div>
                )}

                {activeSshConnection && (
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-500">
                    Using {activeSshConnection.username}@{activeSshConnection.host}
                    {activeSshConnection.connection_type === "ssh" ? `:${activeSshConnection.port}` : ""} via{" "}
                    {activeSshConnection.connection_type === "headscale" ? "Headscale SSH" : activeSshConnection.connection_type === "tailscale" ? "Tailscale SSH" : "standard SSH"}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="sshSourcePath" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Remote Project Path
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="sshSourcePath"
                      value={sshSourcePath}
                      onChange={(e) => setSshSourcePath(e.target.value)}
                      placeholder="/home/user/apps/my-project"
                      className="bg-muted/40"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleBrowseCurrentPath}
                      disabled={!sshConnectionId || browseSshMutation.isPending}
                    >
                      {browseSshMutation.isPending ? (
                        <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4 animate-spin"  />
                      ) : (
                        <AppIcon name="folder-tree" fallback={FolderTree} className="mr-2 h-4 w-4"  />
                      )}
                      Browse
                    </Button>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant={showRemoteTerminal ? "default" : "outline"}
                            size="icon-lg"
                            onClick={() => {
                              setRemoteTerminalCwd(sshBrowsePath || sshSourcePath || getRemoteHomePath(activeSshConnection?.username));
                              setShowRemoteTerminal((current) => !current);
                            }}
                            disabled={!sshConnectionId}
                          >
                            <AppIcon name="terminal" fallback={Terminal} className="h-4 w-4"  />
                          </Button>
                        }
                      />
                      <TooltipContent side="top">Open SSH terminal</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                {sshConnectionId && (
                  <div className="space-y-3 rounded-xl border border-border bg-muted/25 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Remote Browser
                        </p>
                        <p className="text-sm text-foreground">{sshBrowsePath || sshSourcePath || getRemoteHomePath(activeSshConnection?.username)}</p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleBrowseParent}
                        disabled={browseSshMutation.isPending}
                      >
                        Up
                      </Button>
                    </div>

                    {sshEntries.length > 0 ? (
                      <div className="max-h-[180px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                        {sshEntries.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            onClick={() => handleSelectSshDirectory(entry)}
                            className={cn(
                              "flex w-full items-center justify-between border-b border-border/60 px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent",
                              sshSourcePath === entry.path ? "bg-accent" : "bg-transparent"
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <AppIcon name="folder-tree" fallback={FolderTree} className="h-4 w-4 text-muted-foreground"  />
                              <span className="text-foreground">{entry.name}</span>
                            </div>
                            {entry.directory && <AppIcon name="chevron-right" fallback={ChevronRight} className="h-4 w-4 text-muted-foreground"  />}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                        Browse a remote folder to pick the exact VPS path you want to build from.
                      </div>
                    )}
                  </div>
                )}

                {showRemoteTerminal && (
                  <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          SSH Terminal
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Interactive shell on the selected SSH/VPS connection. You can run git, install tools, and navigate normally.
                        </p>
                      </div>
                      <AppIcon name="terminal" fallback={Terminal} className="h-5 w-5 text-muted-foreground"  />
                    </div>
                    <RemoteSshTerminal
                      connectionId={sshConnectionId}
                      cwd={remoteTerminalCwd || sshBrowsePath || sshSourcePath || getRemoteHomePath(activeSshConnection?.username)}
                      className="h-[min(56vh,520px)] min-h-[420px]"
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
                <div className="space-y-2">
                  <Label htmlFor="localSourcePath" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Local Project Path
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="localSourcePath"
                      value={localSourcePath}
                      onChange={(e) => setLocalSourcePath(e.target.value)}
                      placeholder="/app/local-projects/my-project"
                      className="bg-muted/40"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleBrowseLocalPath}
                      disabled={browseLocalMutation.isPending}
                    >
                      {browseLocalMutation.isPending ? (
                        <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4 animate-spin"  />
                      ) : (
                        <AppIcon name="folder-tree" fallback={FolderTree} className="mr-2 h-4 w-4"  />
                      )}
                      Browse
                    </Button>
                  </div>
                </div>

                {renderRuntimePreferences()}

                <div className="space-y-3 rounded-xl border border-border bg-muted/25 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Allowed Local Roots
                      </p>
                      <p className="text-sm text-foreground">{localBrowsePath || "Select a mounted local source root"}</p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleBrowseLocalParent}
                      disabled={browseLocalMutation.isPending || !localBrowsePath}
                    >
                      Up
                    </Button>
                  </div>

                  {!localBrowsePath && localRoots.length > 0 && (
                    <div className="grid gap-2 lg:grid-cols-2">
                      {localRoots.map((root) => (
                        <Button
                          key={root.path}
                          type="button"
                          variant="outline"
                          className="justify-start truncate"
                          onClick={() => {
                            setLocalSourcePath(root.path);
                            browseLocalMutation.mutate(root.path);
                          }}
                        >
                          <AppIcon name="hard-drive" fallback={HardDrive} className="mr-2 h-4 w-4"  />
                          <span className="truncate">{root.path}</span>
                        </Button>
                      ))}
                    </div>
                  )}

                  {localEntries.length > 0 ? (
                    <div className="max-h-[180px] overflow-y-auto rounded-lg border border-border bg-card scrollbar-thin">
                      {localEntries.map((entry) => (
                        <button
                          key={entry.path}
                          type="button"
                          onClick={() => handleSelectLocalDirectory(entry)}
                          className={cn(
                            "flex w-full items-center justify-between border-b border-border/60 px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent",
                            localSourcePath === entry.path ? "bg-accent" : "bg-transparent"
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <AppIcon name="folder-tree" fallback={FolderTree} className="h-4 w-4 shrink-0 text-muted-foreground"  />
                            <span className="truncate text-foreground">{entry.name}</span>
                          </div>
                          <AppIcon name="chevron-right" fallback={ChevronRight} className="h-4 w-4 shrink-0 text-muted-foreground"  />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      Local projects must live under the configured mounted local source root.
                    </div>
                  )}
                </div>
              </div>
            )}

            {renderEnvironmentSettings()}

            <ProjectEnvEditor envVars={envVars} onChange={setEnvVars} />

            <div className="space-y-4">
              {organizations.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="project-org" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Workspace / Organization
                  </Label>
                  <Select value={organizationId} onValueChange={(val) => setOrganizationId(val || "")}>
                    <SelectTrigger id="project-org" className="bg-muted/40">
                      <SelectValue placeholder="Select workspace" />
                    </SelectTrigger>
                    <SelectContent>
                      {organizations
                        .filter((org) => org.role !== "viewer")
                        .map((org) => (
                          <SelectItem key={org.id} value={org.id}>
                            <span className="flex items-center gap-2">
                              <span className="font-medium">{org.name}</span>
                              <span className="text-[11px] text-muted-foreground">
                                {org.is_personal ? "(Personal Workspace)" : `(${org.role})`}
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="name" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Project Name
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-awesome-app"
                  required
                  className="bg-muted/40"
                />
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor="description"
                  className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  Description
                </Label>
                <Input
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A short description..."
                  className="bg-muted/40"
                />
              </div>
            </div>
          </form>
        </div>

        <DialogFooter className="shrink-0 border-t border-border bg-muted/30 px-6 pt-4 pb-6 sm:pb-6">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" onClick={handleSubmit} disabled={createMutation.isPending} className="min-w-[140px]">
            {createMutation.isPending ? (
              <>
                <AppIcon name="refresh-cw" fallback={RefreshCw} className="mr-2 h-4 w-4 animate-spin"  />
                Creating...
              </>
            ) : (
              "Create Project"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="!w-[min(90vw,620px)] !max-w-[620px] rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AppIcon name="info" fallback={Info} className="h-5 w-5 text-primary"  />
            Project Creation Guide
          </DialogTitle>
          <DialogDescription>
            These choices decide where the source comes from and where the first Docker build runs. Runtime upgrades
            happen after creation from the deployment screen.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="github" className="max-h-[56vh] overflow-hidden">
              <TabsList className={cn(segmentedTabsListClass, "grid-cols-4")}>
            <TabsTrigger value="github" className={selectedTabClass}>
              GitHub
            </TabsTrigger>
            <TabsTrigger value="ssh" className={selectedTabClass}>
              SSH / VPS
            </TabsTrigger>
            <TabsTrigger value="application" className={selectedTabClass}>
              Apps
            </TabsTrigger>
            <TabsTrigger value="local" className={selectedTabClass}>
              Local
            </TabsTrigger>
          </TabsList>

          <div className="mt-4 max-h-[44vh] overflow-y-auto pr-1 scrollbar-thin">
            <TabsContent value="github" className="space-y-3">
              <GuideSection
                heading="GitHub source"
                items={[
                  "Use GitHub OAuth or a PAT to load public and private repositories.",
                  "Pick a repository, then StackPilot stores the project record and creates the first Docker deployment.",
                  "If you choose Run on server, select the server and a remote workspace path. The repo is cloned under stackpilot-builds/<deployment-id> inside that path.",
                ]}
              />
              <GuideSection
                heading="After creation"
                items={[
                  "Open Deployments to view logs, metrics, runtime details, or delete the deployment.",
                  "Use the runtime controls later if you want Kubernetes, NodePort, or Ingress instead of plain Docker.",
                ]}
              />
            </TabsContent>

            <TabsContent value="ssh" className="space-y-3">
              <GuideSection
                heading="SSH / VPS source"
                items={[
                  "Use this when the source folder already exists on a saved server or Tailscale machine.",
                  "Browse to the actual project folder, not only the parent folder.",
                  "Run locally copies the remote source to StackPilot and builds on this machine. Run on server builds and runs on that same remote server.",
                ]}
              />
              <GuideSection
                heading="Terminal"
                items={[
                  "The terminal lets you run normal shell commands on the selected connection.",
                  "You can git clone, install missing tools, inspect files, then choose the final project folder.",
                ]}
              />
            </TabsContent>

            <TabsContent value="application" className="space-y-3">
              <GuideSection
                heading="Application source"
                items={[
                  "Use this when you want StackPilot to generate a deployable compose project from a known application image.",
                  "Pick an application, configure ports and credentials, then deploy locally or on a saved server.",
                  "Secrets are stored as project environment variables; the generated source keeps only non-secret metadata.",
                ]}
              />
              <GuideSection
                heading="Catalog scope"
                items={[
                  "The catalog starts with common databases, queues, monitoring tools, storage, and utilities.",
                  "Each template is still a normal Docker image workflow, so more application types can be added without changing the deployment engine.",
                ]}
              />
            </TabsContent>

            <TabsContent value="local" className="space-y-3">
              <GuideSection
                heading="Local source"
                items={[
                  "Use this for folders already available on the host running StackPilot.",
                  "Local projects must live inside the allowed local source roots configured for the backend container.",
                  "Direct arbitrary laptop paths are intentionally blocked; mount or import the project into the allowed root so builds are reproducible and safe.",
                ]}
              />
              <GuideSection
                heading="NodePort vs Ingress"
                items={[
                  "NodePort exposes a Kubernetes app on a high node port, useful for local testing.",
                  "Ingress routes domain-based HTTP traffic through an ingress controller, better for production-style URLs and TLS.",
                ]}
              />
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter>
          <Button type="button" onClick={() => setHelpOpen(false)}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
