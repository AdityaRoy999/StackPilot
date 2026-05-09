#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

const API_BASE = stripTrailingSlash(process.env.DOKSCP_API_URL || "http://localhost:8090/api/v1");
const FRONTEND_BASE = stripTrailingSlash(process.env.DOKSCP_FRONTEND_URL || "http://localhost:3000");
const TOKEN = process.env.DOKSCP_MCP_TOKEN || "";
const HTTP_TIMEOUT_MS = numberEnv("DOKSCP_MCP_HTTP_TIMEOUT_MS", 30_000);
const DEFAULT_WAIT_SECONDS = numberEnv("DOKSCP_MCP_DEPLOY_WAIT_SECONDS", 45);
const HOST_LOCAL_ROOT = resolveMaybeRelative(
  process.env.DOKSCP_LOCAL_PROJECTS_HOST_ROOT ||
    process.env.DOKSCP_LOCAL_PROJECTS_DIR ||
    path.join(REPO_ROOT, "local-projects"),
  REPO_ROOT
);
const CONTAINER_LOCAL_ROOT = toPosixPath(process.env.DOKSCP_LOCAL_PROJECTS_CONTAINER_ROOT || "/app/local-projects");

const IGNORE_NAMES = new Set([
  ".cache",
  ".codex_ai_venv",
  ".git",
  ".hg",
  ".idea",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".pytest_cache",
  ".ruff_cache",
  ".svn",
  ".turbo",
  ".venv",
  ".vscode",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "local-projects",
  "node_modules",
  "out",
  "target",
  "uploads",
  "venv",
]);

const IGNORE_EXACT_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "npm-debug.log",
  "yarn-error.log",
  "pnpm-debug.log",
]);

const DEFAULT_MAX_FILE_BYTES = numberEnv("DOKSCP_MCP_MAX_FILE_BYTES", 25 * 1024 * 1024);
const DEFAULT_MAX_TOTAL_BYTES = numberEnv("DOKSCP_MCP_MAX_TOTAL_BYTES", 300 * 1024 * 1024);
const DEFAULT_MAX_FILES = numberEnv("DOKSCP_MCP_MAX_FILES", 20_000);

const server = new McpServer({
  name: "dokscp-platform",
  version: "1.1.0",
});

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveMaybeRelative(value, base) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return base;
  return path.resolve(path.isAbsolute(cleaned) ? cleaned : path.join(base, cleaned));
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function textResult(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

function jsonResult(title, data) {
  return textResult(`${title}\n\n${JSON.stringify(data, null, 2)}`);
}

function apiHeaders(auth = true) {
  const headers = {
    "Content-Type": "application/json",
    "X-DOKSCP-CSRF": "1",
    "X-DOKSCP-MCP": "1",
  };
  if (auth && TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }
  return headers;
}

async function api(method, apiPath, body, options = {}) {
  const auth = options.auth !== false;
  if (auth && !TOKEN) {
    throw new Error(
      "DOKSCP_MCP_TOKEN is not set. Generate a token in Settings > MCP Integrations and add it to the IDE MCP environment."
    );
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${API_BASE}${apiPath}`;

  try {
    const init = {
      method,
      headers: apiHeaders(auth),
      signal: controller.signal,
    };
    if (body !== undefined && body !== null) {
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    const raw = await res.text();
    let json;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      json = { raw };
    }

    if (!res.ok) {
      const detail = json.error || json.message || json.raw || `HTTP ${res.status}`;
      throw new Error(`${method} ${apiPath} failed: ${detail}`);
    }

    return json;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${method} ${apiPath} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function safeName(value, fallback = "local-project") {
  const cleaned = String(value || "")
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

function projectNameFromPath(projectPath) {
  const base = path.basename(projectPath);
  return safeName(base || "local-project");
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function resolveProjectPath(inputPath) {
  if (inputPath) {
    const resolved = path.resolve(String(inputPath));
    if (await pathExists(resolved)) {
      return resolved;
    }
    throw new Error(`Local project path does not exist: ${resolved}`);
  }

  const candidates = [
    process.env.DOKSCP_PROJECT_PATH,
    process.env.DOKSCP_DEFAULT_PROJECT_PATH,
    process.env.WORKSPACE_FOLDER,
    process.env.INIT_CWD,
    process.cwd(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(String(candidate));
    if (await pathExists(resolved)) {
      return resolved;
    }
  }

  throw new Error(
    "No local project path was found. Pass project_path as an absolute path, or configure DOKSCP_PROJECT_PATH in the MCP server environment."
  );
}

function isEnvFile(fileName) {
  if (fileName === ".env") return true;
  if (fileName.startsWith(".env.") && !fileName.endsWith(".example") && !fileName.endsWith(".sample")) return true;
  return false;
}

function shouldIgnore(relativePath, name) {
  if (IGNORE_NAMES.has(name)) return true;
  if (IGNORE_EXACT_FILES.has(name)) return true;
  if (isEnvFile(name)) return true;
  const normalized = toPosixPath(relativePath);
  if (normalized.endsWith(".pem") || normalized.endsWith(".key") || normalized.endsWith(".p12")) return true;
  return false;
}

async function inspectProject(projectRoot, singleFileName = "") {
  const summary = {
    root: projectRoot,
    kind: "unknown",
    has_dockerfile: false,
    entrypoints: [],
    manifests: [],
    notes: [],
  };

  const checkFile = async (name) => {
    const target = path.join(projectRoot, name);
    if (await pathExists(target)) {
      summary.manifests.push(name);
      return true;
    }
    return false;
  };

  if (singleFileName) {
    summary.entrypoints.push(singleFileName);
    const ext = path.extname(singleFileName).toLowerCase();
    summary.kind = ext === ".py" ? "python-script" : ext === ".js" || ext === ".ts" ? "node-script" : "single-file";
    return summary;
  }

  summary.has_dockerfile = (await checkFile("Dockerfile")) || (await checkFile("dockerfile"));
  const hasPackage = await checkFile("package.json");
  const hasRequirements = await checkFile("requirements.txt");
  const hasPyproject = await checkFile("pyproject.toml");
  const hasGo = await checkFile("go.mod");
  const hasCargo = await checkFile("Cargo.toml");
  const hasComposer = await checkFile("composer.json");
  const hasStaticIndex = await checkFile("index.html");

  if (summary.has_dockerfile) summary.kind = "dockerfile";
  else if (hasPackage) summary.kind = "node";
  else if (hasRequirements || hasPyproject) summary.kind = "python";
  else if (hasGo) summary.kind = "go";
  else if (hasCargo) summary.kind = "rust";
  else if (hasComposer) summary.kind = "php";
  else if (hasStaticIndex) summary.kind = "static-html";

  const commonEntrypoints = [
    "main.py",
    "app.py",
    "server.py",
    "src/main.py",
    "src/app.py",
    "index.js",
    "server.js",
    "src/index.js",
    "src/server.js",
  ];
  for (const candidate of commonEntrypoints) {
    if (await pathExists(path.join(projectRoot, candidate))) {
      summary.entrypoints.push(candidate);
    }
  }

  if (!summary.has_dockerfile) {
    summary.notes.push("No Dockerfile found. DOKSCP will use deterministic generators first, then AI Dockerfile fallback when enabled.");
  }
  return summary;
}

async function copyFileChecked(source, destination, stats, options) {
  const info = await fs.stat(source);
  if (!info.isFile()) return;
  if (info.size > options.maxFileBytes) {
    stats.skipped.push({ path: source, reason: `file larger than ${options.maxFileBytes} bytes` });
    return;
  }
  if (stats.files >= options.maxFiles) {
    throw new Error(`Project has more than ${options.maxFiles} deployable files after exclusions.`);
  }
  if (stats.bytes + info.size > options.maxTotalBytes) {
    throw new Error(`Project is larger than ${options.maxTotalBytes} bytes after exclusions.`);
  }
  if (!options.dryRun) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
  stats.files += 1;
  stats.bytes += info.size;
}

async function copyDirectory(sourceRoot, destinationRoot, stats, options, relative = "") {
  const entries = await fs.readdir(path.join(sourceRoot, relative), { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(relative, entry.name);
    if (shouldIgnore(rel, entry.name)) {
      stats.ignored += 1;
      continue;
    }

    const src = path.join(sourceRoot, rel);
    const dst = path.join(destinationRoot, rel);
    if (entry.isSymbolicLink()) {
      stats.skipped.push({ path: src, reason: "symbolic links are skipped by default" });
      continue;
    }
    if (entry.isDirectory()) {
      await copyDirectory(sourceRoot, destinationRoot, stats, options, rel);
      continue;
    }
    if (entry.isFile()) {
      await copyFileChecked(src, dst, stats, options);
    }
  }
}

async function stageLocalProject(projectPath, options = {}) {
  const resolvedProjectPath = await resolveProjectPath(projectPath);
  const stat = await fs.stat(resolvedProjectPath);
  const isSingleFile = stat.isFile();
  const sourceRoot = isSingleFile ? path.dirname(resolvedProjectPath) : resolvedProjectPath;
  const sourceLabel = isSingleFile ? path.basename(resolvedProjectPath) : "";
  const nameBase = options.projectName || projectNameFromPath(resolvedProjectPath);
  const stageName = `${safeName(nameBase)}`;
  const stageRoot = path.join(HOST_LOCAL_ROOT, stageName);
  const containerPath = `${CONTAINER_LOCAL_ROOT}/${stageName}`;

  const stageRelativeToSource = path.relative(path.resolve(sourceRoot), path.resolve(stageRoot));
  if (stageRelativeToSource && !stageRelativeToSource.startsWith("..") && !path.isAbsolute(stageRelativeToSource)) {
    const firstSegment = stageRelativeToSource.split(path.sep)[0];
    if (!shouldIgnore(firstSegment, firstSegment)) {
      throw new Error(
        "Refusing to stage a project into a non-ignored child directory of itself. Set DOKSCP_LOCAL_PROJECTS_HOST_ROOT outside the project."
      );
    }
  }

  const stats = {
    files: 0,
    bytes: 0,
    ignored: 0,
    skipped: [],
  };
  const limits = {
    maxFileBytes: options.maxFileBytes || DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES,
    maxFiles: options.maxFiles || DEFAULT_MAX_FILES,
    dryRun: Boolean(options.dryRun),
  };

  if (!options.dryRun) {
    await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(stageRoot, { recursive: true });
  }
  if (isSingleFile) {
    await copyFileChecked(resolvedProjectPath, path.join(stageRoot, sourceLabel), stats, limits);
  } else {
    await copyDirectory(sourceRoot, stageRoot, stats, limits);
  }

  const analysis = await inspectProject(isSingleFile ? sourceRoot : resolvedProjectPath, sourceLabel);

  return {
    source_path: resolvedProjectPath,
    source_root: sourceRoot,
    single_file: isSingleFile ? sourceLabel : "",
    staged_host_path: stageRoot,
    staged_container_path: containerPath,
    stage_name: stageName,
    stats,
    analysis,
  };
}

function writeOctal(buffer, value, offset, length) {
  const text = Math.max(0, value).toString(8).padStart(length - 1, "0").slice(-(length - 1)) + "\0";
  buffer.write(text, offset, length, "ascii");
}

function splitTarPath(relativePath) {
  const normalized = toPosixPath(relativePath).replace(/^\/+/, "");
  if (Buffer.byteLength(normalized) <= 100) {
    return { name: normalized, prefix: "" };
  }
  const parts = normalized.split("/");
  let name = parts.pop() || "";
  let prefix = parts.join("/");
  while ((Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) && parts.length > 0) {
    name = `${parts.pop()}/${name}`;
    prefix = parts.join("/");
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) {
    throw new Error(`Path is too long for portable tar archive: ${relativePath}`);
  }
  return { name, prefix };
}

function tarHeader(relativePath, size, mtime, type = "0") {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitTarPath(relativePath);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, type === "5" ? 0o755 : 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, Math.floor(mtime / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) {
    header.write(prefix, 345, 155, "utf8");
  }
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeOctal(header, checksum, 148, 8);
  return header;
}

async function collectTarFiles(root) {
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relative = toPosixPath(path.relative(root, fullPath));
      if (!relative || shouldIgnore(entry.name, relative)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push({ fullPath, relative });
      }
    }
  }
  await walk(root);
  return files;
}

async function createTarArchive(root) {
  const chunks = [];
  const files = await collectTarFiles(root);
  for (const file of files) {
    const data = await fs.readFile(file.fullPath);
    const stat = await fs.stat(file.fullPath);
    chunks.push(tarHeader(file.relative, data.length, stat.mtimeMs, "0"));
    chunks.push(data);
    const remainder = data.length % 512;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return { archive: Buffer.concat(chunks), files };
}

async function uploadSourceArtifact(staged, projectName) {
  const { archive, files } = await createTarArchive(staged.staged_host_path);
  const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
  const uploaded = await api(
    "POST",
    "/source-artifacts",
    {
      name: projectName,
      archive_base64: archive.toString("base64"),
      archive_sha256: sha256,
      size_bytes: archive.length,
      file_count: files.length,
      source_root: staged.source_path,
      source_kind: staged.single_file ? "single_file_upload" : "local_workspace_upload",
      metadata: {
        stage_name: staged.stage_name,
        single_file: staged.single_file,
        analysis: staged.analysis,
      },
    },
    { timeoutMs: Math.max(HTTP_TIMEOUT_MS, 120_000) }
  );
  return uploaded.artifact || uploaded;
}

function versionString() {
  const date = new Date();
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
  return `mcp-${stamp}`;
}

function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1.0;
  const len1 = s1.length, len2 = s2.length;
  const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
  const matches1 = new Array(len1).fill(false), matches2 = new Array(len2).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow), end = Math.min(i + matchWindow + 1, len2);
    for (let j = start; j < end; j++) {
      if (!matches2[j] && s1[i] === s2[j]) {
        matches1[i] = matches2[j] = true; matches++; break;
      }
    }
  }
  if (matches === 0) return 0.0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (matches1[i]) {
      while (!matches2[k]) k++;
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }
  }
  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
  const prefixLen = Math.min(4, Math.min(len1, len2));
  let prefixMatch = 0;
  for (let i = 0; i < prefixLen; i++) { if (s1[i] === s2[i]) prefixMatch++; else break; }
  return jaro + prefixMatch * 0.1 * (1 - jaro);
}

function findBestVps(connections, inputName) {
  if (!inputName) return null;
  const search = inputName.toLowerCase();
  
  // 1. Try exact match
  let matched = connections.find(c => c.name && c.name.toLowerCase() === search);
  if (matched) return matched;
  
  // 2. Try substring match
  matched = connections.find(c => c.name && c.name.toLowerCase().includes(search));
  if (matched) return matched;
  
  // 3. Try fuzzy Jaro-Winkler match
  let bestScore = 0;
  for (const c of connections) {
    if (!c.name) continue;
    const score = jaroWinkler(search, c.name.toLowerCase());
    if (score > 0.75 && score > bestScore) {
      bestScore = score;
      matched = c;
    }
  }
  return matched;
}

async function getOrCreateLocalProject({ name, description, sourcePath, envVars = [], runtimeType = "kubernetes", vpsConnectionId = "", sourceType = "artifact" }) {
  const listResp = await api("GET", "/projects", null);
  const projects = listResp.projects || listResp || [];
  const existing = projects.find(p => p.name === name);

  if (existing) {
    const body = {
      source_type: sourceType,
      source_path: sourcePath,
      remote_runtime_type: runtimeType,
      env_vars: envVars,
    };
    if (vpsConnectionId) {
      body.execution_mode = "remote_host";
      body.remote_connection_id = vpsConnectionId;
      body.remote_runtime_type = "kubernetes";
      body.remote_k8s_exposure = "ingress";
      body.runtime_scheme = "https";
      body.local_https_enabled = false;
    } else {
      body.execution_mode = "local";
      body.remote_connection_id = "";
      body.remote_runtime_type = runtimeType;
      body.remote_k8s_exposure = "nodeport";
      body.runtime_scheme = "http";
      body.local_https_enabled = false;
    }
    const updated = await api("PUT", `/projects/${existing.id}`, body, { timeoutMs: 45_000 });
    return updated.project || updated;
  }

  const body = {
    name,
    description,
    source_type: sourceType,
    source_path: sourcePath,
    execution_mode: "local",
    remote_runtime_type: runtimeType,
    remote_k8s_exposure: "nodeport",
    runtime_scheme: "http",
    local_https_enabled: false,
    env_vars: envVars,
  };
  
  if (vpsConnectionId) {
    body.execution_mode = "remote_host";
    body.remote_connection_id = vpsConnectionId;
    body.remote_runtime_type = "kubernetes";
    body.remote_k8s_exposure = "ingress";
    body.runtime_scheme = "https";
  }

  const created = await api("POST", "/projects", body, { timeoutMs: 45_000 });
  return created.project || created;
}

async function createDeployment(projectId, version, options = {}) {
  const created = await api("POST", `/projects/${projectId}/deployments`, {
    version,
    commit_hash: options.commit_hash || options.commit_sha || "manual",
    commit_sha: options.commit_sha || options.commit_hash || "",
    branch: options.branch || "",
    trigger_source: options.trigger_source || "mcp",
  });
  return created.deployment || created;
}

async function createArtifactDeployment(projectId, version, commitHash, artifactId, options = {}) {
  const normalizedCommit = String(commitHash || "").trim();
  const gitSha = /^[0-9a-f]{7,64}$/i.test(normalizedCommit) ? normalizedCommit : "";
  const created = await api("POST", `/projects/${projectId}/deployments`, {
    version,
    commit_hash: normalizedCommit || "local-mcp",
    commit_sha: gitSha,
    source_artifact_id: artifactId,
    trigger_source: "mcp",
    branch: options.branch || "",
    environment_id: options.environment_id || "",
  });
  return created.deployment || created;
}

async function triggerDeployment(deploymentId) {
  return api("POST", `/deployments/${deploymentId}/trigger`, {});
}

async function deployLocalDocker(deploymentId) {
  return api("POST", `/deployments/${deploymentId}/docker/deploy`, {}, { timeoutMs: 120_000 });
}

async function getDeploymentStatus(deploymentId) {
  try {
    const data = await api("GET", `/deployments/${deploymentId}/logs`, undefined, { timeoutMs: 20_000 });
    return data.deployment || data;
  } catch (error) {
    const data = await api("GET", "/deployments", undefined, { timeoutMs: 20_000 });
    const deployments = data.deployments || [];
    const found = deployments.find((item) => item.id === deploymentId);
    if (found) return found;
    throw error;
  }
}

async function pollDeployment(deploymentId, waitSeconds) {
  const started = Date.now();
  const deadline = started + Math.max(0, waitSeconds) * 1000;
  let last = await getDeploymentStatus(deploymentId);

  while (Date.now() < deadline) {
    const status = String(last.status || "").toLowerCase();
    if (["running", "built", "failed", "cancelled"].includes(status)) {
      break;
    }
    await sleep(2500);
    last = await getDeploymentStatus(deploymentId);
  }

  return {
    deployment: last,
    waited_seconds: Math.round((Date.now() - started) / 1000),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactLogs(logs, maxChars = 3000) {
  const text = String(logs || "");
  if (text.length <= maxChars) return text;
  return `...${text.slice(-maxChars)}`;
}

async function handleListProjects() {
  const data = await api("GET", "/projects");
  const projects = data.projects || [];
  return jsonResult(`Found ${projects.length} project(s).`, { projects });
}

async function handleListDeployments() {
  const data = await api("GET", "/deployments");
  const deployments = data.deployments || [];
  return jsonResult(`Found ${deployments.length} deployment(s).`, { deployments });
}

async function handleHealth() {
  const data = await api("GET", "/health", undefined, { auth: false, timeoutMs: 10_000 });
  return jsonResult("DOKSCP backend is reachable.", {
    api_base: API_BASE,
    frontend_base: FRONTEND_BASE,
    mcp_token_configured: Boolean(TOKEN),
    local_projects_host_root: HOST_LOCAL_ROOT,
    local_projects_container_root: CONTAINER_LOCAL_ROOT,
    health: data,
  });
}

async function handleVerifyAuth() {
  const data = await api("GET", "/mcp/verify", undefined, { timeoutMs: 10_000 });
  return jsonResult("DOKSCP MCP token is valid.", data);
}

async function handleInspectLocalProject(args) {
  const resolvedProjectPath = await resolveProjectPath(args.project_path);
  const stat = await fs.stat(resolvedProjectPath);
  const analysis = await inspectProject(
    stat.isFile() ? path.dirname(resolvedProjectPath) : resolvedProjectPath,
    stat.isFile() ? path.basename(resolvedProjectPath) : ""
  );
  return jsonResult("Local project inspection complete.", {
    project_path: resolvedProjectPath,
    staging_root: HOST_LOCAL_ROOT,
    backend_source_root: CONTAINER_LOCAL_ROOT,
    analysis,
  });
}

async function handleDeployLocalProject(args) {
  const waitSeconds = Math.min(Number(args.wait_seconds ?? DEFAULT_WAIT_SECONDS), 600);
  const projectName = safeName(args.project_name || projectNameFromPath(args.project_path || process.cwd()));
  const runtimeType = args.runtime_type || "docker";
  const staged = await stageLocalProject(args.project_path, {
    projectName,
    dryRun: Boolean(args.dry_run),
    maxFileBytes: args.max_file_bytes,
    maxTotalBytes: args.max_total_bytes,
    maxFiles: args.max_files,
  });

  if (args.dry_run) {
    return jsonResult("Dry run complete. No project was created and no files were copied.", {
      project_name: projectName,
      staged,
      next_step:
        "Call dokscp_deploy_local_project again without dry_run to create the DOKSCP project, build it, deploy it, and return the preview URL.",
    });
  }

  const artifact = await uploadSourceArtifact(staged, args.project_name || projectName);

  let vpsConnectionId = "";
  if (args.vps_connection_name) {
    const listResp = await api("GET", "/ssh/connections", null);
    const connections = listResp.connections || listResp || [];
    const matched = findBestVps(connections, args.vps_connection_name);
    if (matched) {
      vpsConnectionId = matched.id;
    } else {
      throw new Error(`VPS connection matching '${args.vps_connection_name}' not found. Please create it in the DOKSCP Dashboard.`);
    }
  }

  const project = await getOrCreateLocalProject({
    name: args.project_name || projectName,
    description:
      args.description ||
      `Created by DOKSCP MCP from local path ${staged.source_path} on ${os.hostname()}.`,
    sourcePath: vpsConnectionId ? (args.remote_workspace_path || "/tmp") : "",
    envVars: args.env_vars || [],
    runtimeType,
    vpsConnectionId,
    sourceType: "artifact",
  });

  const deployment = await createArtifactDeployment(
    project.id,
    args.version || versionString(),
    args.commit_hash || "local-mcp",
    artifact.id,
    { branch: args.branch || "" }
  );
  const trigger = await triggerDeployment(deployment.id);
  const polled = args.wait_for_ready === false ? { deployment, waited_seconds: 0 } : await pollDeployment(deployment.id, waitSeconds);
  let finalDeployment = polled.deployment || deployment;
  let dockerDeploy = null;
  if (!args.build_only && !vpsConnectionId && runtimeType === "docker" && String(finalDeployment.status || "").toLowerCase() === "built") {
    dockerDeploy = await deployLocalDocker(deployment.id);
    finalDeployment = await getDeploymentStatus(deployment.id);
  }
  const runtimeUrl = finalDeployment.runtime_url || trigger.runtime_url || "";
  const status = finalDeployment.status || trigger.status || "queued";
  const logs = finalDeployment.logs || "";

  const response = {
    project: {
      id: project.id,
      name: project.name,
      source_type: "artifact",
      source_path: vpsConnectionId ? (args.remote_workspace_path || "/tmp") : "",
    },
    source_artifact: artifact,
    deployment: {
      id: deployment.id,
      status,
      version: deployment.version,
      runtime_url: runtimeUrl,
      dashboard_url: `${FRONTEND_BASE}/dashboard/deployments`,
      logs_excerpt: compactLogs(logs),
    },
    docker_deploy: dockerDeploy,
    staging: staged,
    wait: {
      requested_seconds: waitSeconds,
      waited_seconds: polled.waited_seconds || 0,
      still_running: ["queued", "building"].includes(String(status).toLowerCase()),
    },
  };

  const headline = runtimeUrl
    ? `Deployment ready. Preview URL: ${runtimeUrl}`
    : `Deployment ${status}. Use dokscp_get_deployment_status with deployment_id ${deployment.id} for updates.`;

  return jsonResult(headline, response);
}

async function handleDeployGithubRepo(args) {
  const repoUrl = args.repo_url;
  const name = args.project_name || safeName(repoUrl.split("/").pop()?.replace(/\.git$/, "") || "github-project");
  
  let vpsConnectionId = "";
  if (args.vps_connection_name) {
    const listResp = await api("GET", "/ssh/connections", null);
    const connections = listResp.connections || listResp || [];
    const matched = findBestVps(connections, args.vps_connection_name);
    if (matched) {
      vpsConnectionId = matched.id;
    } else {
      throw new Error(`VPS connection matching '${args.vps_connection_name}' not found. Please create it in the DOKSCP Dashboard.`);
    }
  }

  const projectBody = {
    name,
    repo_url: repoUrl,
    source_type: "github",
    execution_mode: vpsConnectionId ? "remote_host" : "local",
    remote_runtime_type: args.runtime_type || (vpsConnectionId ? "kubernetes" : "docker"),
    remote_connection_id: vpsConnectionId || undefined,
    remote_k8s_exposure: vpsConnectionId ? "ingress" : "nodeport",
    runtime_scheme: vpsConnectionId ? "https" : "http",
  };
  if (args.github_pat) projectBody.github_pat = args.github_pat;
  if (args.description) projectBody.description = args.description;

  const projectData = await api("POST", "/projects", projectBody, { timeoutMs: 45_000 });
  const project = projectData.project || projectData;
  const deployment = await createDeployment(project.id, args.version || versionString(), {
    branch: args.branch || "main",
    commit_hash: args.commit_hash || "",
    commit_sha: args.commit_sha || args.commit_hash || "",
    trigger_source: "mcp",
  });
  const trigger = await triggerDeployment(deployment.id);
  const waitSeconds = Math.min(Number(args.wait_seconds ?? DEFAULT_WAIT_SECONDS), 600);
  const polled = args.wait_for_ready === false ? { deployment, waited_seconds: 0 } : await pollDeployment(deployment.id, waitSeconds);
  let finalDeployment = polled.deployment || deployment;
  let dockerDeploy = null;
  if (!args.build_only && !vpsConnectionId && projectBody.remote_runtime_type === "docker" && String(finalDeployment.status || "").toLowerCase() === "built") {
    dockerDeploy = await deployLocalDocker(deployment.id);
    finalDeployment = await getDeploymentStatus(deployment.id);
  }
  const runtimeUrl = finalDeployment.runtime_url || trigger.runtime_url || "";

  return jsonResult(runtimeUrl ? `Deployment ready. Preview URL: ${runtimeUrl}` : `GitHub deployment ${finalDeployment.status || "queued"}.`, {
    project,
    deployment: finalDeployment,
    trigger,
    docker_deploy: dockerDeploy,
    wait: polled,
    note: "For private repositories, use github_pat or connect GitHub in the dashboard. Password auth does not work for Git clone.",
  });
}

async function handleGetDeploymentStatus(args) {
  const deployment = await getDeploymentStatus(args.deployment_id);
  return jsonResult(`Deployment ${args.deployment_id}: ${deployment.status || "unknown"}`, {
    deployment: {
      ...deployment,
      logs: args.include_logs ? compactLogs(deployment.logs, args.max_log_chars || 6000) : undefined,
    },
  });
}

async function handleGetDeploymentLogs(args) {
  const deployment = await getDeploymentStatus(args.deployment_id);
  return textResult(compactLogs(deployment.logs || "(no logs available)", args.max_chars || 12_000));
}

function registerTool(name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    try {
      return await handler(args || {});
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error?.message || String(error),
          },
        ],
      };
    }
  });
}

const deployLocalSchema = {
  project_path: z
    .string()
    .optional()
    .describe("Absolute path to the local project directory or single script file. If omitted, the MCP server tries DOKSCP_PROJECT_PATH, IDE workspace env vars, then process cwd."),
  project_name: z.string().optional().describe("DOKSCP project name. Auto-derived from project_path when omitted."),
  vps_connection_name: z.string().optional().describe("Optional saved VPS/SSH connection name to deploy to. Uses DOKSCP default if omitted."),
  remote_workspace_path: z.string().optional().describe("Remote base directory for uploaded source artifacts when deploying to a VPS. Default /tmp."),
  description: z.string().optional().describe("Optional project description stored in DOKSCP."),
  version: z.string().optional().describe("Deployment version label. Auto-generated when omitted."),
  commit_hash: z.string().optional().describe("Optional local commit hash or label."),
  branch: z.string().optional().describe("Optional branch or environment label for this deployment."),
  env_vars: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .optional()
    .describe("Build/runtime environment variables. Secret .env files are intentionally not copied from disk."),
  wait_for_ready: z.boolean().optional().describe("Wait until running/failed/built before returning. Default true."),
  wait_seconds: z.number().int().min(0).max(600).optional().describe("Maximum seconds to wait for a preview URL. Default 180."),
  build_only: z.boolean().optional().describe("Build an image without deploying to Kubernetes. Default false."),
  runtime_type: z.enum(["docker", "kubernetes"]).optional().describe("Runtime target. Defaults to docker for local preview links."),
  dry_run: z.boolean().optional().describe("Inspect and stage-plan only. Does not copy files or call DOKSCP APIs."),
  max_file_bytes: z.number().int().min(1).optional().describe("Per-file copy limit in bytes."),
  max_total_bytes: z.number().int().min(1).optional().describe("Total copied source limit in bytes."),
  max_files: z.number().int().min(1).optional().describe("Maximum number of copied source files."),
};

registerTool(
  "dokscp_health",
  "Check whether the DOKSCP backend is reachable and show MCP local-source configuration. Use this first when an IDE reports MCP trouble.",
  {},
  handleHealth
);

registerTool(
  "dokscp_verify_auth",
  "Verify the DOKSCP_MCP_TOKEN and confirm the MCP server can authenticate as the user.",
  {},
  handleVerifyAuth
);

registerTool(
  "dokscp_list_projects",
  "List DOKSCP projects for the authenticated user.",
  {},
  handleListProjects
);

registerTool(
  "dokscp_list_deployments",
  "List all DOKSCP deployments for the authenticated user, including runtime URLs when available.",
  {},
  handleListDeployments
);

registerTool(
  "dokscp_inspect_local_project",
  "Inspect a local IDE project path before deployment. Detects Dockerfile, common manifests, and likely stack.",
  {
    project_path: z.string().optional().describe("Absolute path to the local project directory or single script file."),
  },
  handleInspectLocalProject
);

registerTool(
  "dokscp_deploy_local_project",
  "Production deploy from the current IDE workspace or a local path. DO NOT manually create Dockerfiles, copy files to the VPS, or run bash commands. This tool handles EVERYTHING automatically: it stages local files, builds the Docker image, deploys to local Docker by default or Kubernetes/remote VPS when requested, then returns the live preview URL.",
  deployLocalSchema,
  handleDeployLocalProject
);

registerTool(
  "dokscp_deploy_current_project",
  "Alias for dokscp_deploy_local_project. DO NOT manually create Dockerfiles or copy files. This tool automatically stages, builds, and deploys your local workspace to local Docker by default or Kubernetes/remote VPS when requested, returning the live URL.",
  deployLocalSchema,
  handleDeployLocalProject
);

registerTool(
  "dokscp_deploy_github_repo",
  "Create a DOKSCP project from a GitHub repository URL and trigger a deployment. DO NOT manually clone or build. This tool handles EVERYTHING automatically: it fetches the repo, builds the image, deploys to local Docker by default or Kubernetes/remote VPS when requested, and returns the preview URL when ready.",
  {
    repo_url: z.string().describe("GitHub repository URL, for example https://github.com/user/repo"),
    project_name: z.string().optional(),
    description: z.string().optional(),
    branch: z.string().optional().describe("Branch or label to store as commit_hash."),
    github_pat: z.string().optional().describe("Personal access token for private repositories."),
    version: z.string().optional(),
    build_only: z.boolean().optional(),
    runtime_type: z.enum(["docker", "kubernetes"]).optional().describe("Runtime target. Defaults to docker without a VPS and kubernetes with a VPS."),
    wait_for_ready: z.boolean().optional(),
    wait_seconds: z.number().int().min(0).max(600).optional(),
    vps_connection_name: z.string().optional().describe("Optional saved VPS/SSH connection name to deploy to. Uses DOKSCP default if omitted."),
  },
  handleDeployGithubRepo
);

registerTool(
  "dokscp_get_deployment_status",
  "Check deployment status and optionally include recent logs.",
  {
    deployment_id: z.string(),
    include_logs: z.boolean().optional(),
    max_log_chars: z.number().int().min(500).max(50_000).optional(),
  },
  handleGetDeploymentStatus
);

registerTool(
  "dokscp_get_deployment_logs",
  "Get deployment build/runtime logs.",
  {
    deployment_id: z.string(),
    max_chars: z.number().int().min(500).max(100_000).optional(),
  },
  handleGetDeploymentLogs
);

registerTool(
  "dokscp_trigger_redeploy",
  "Re-trigger a build for an existing DOKSCP deployment.",
  {
    deployment_id: z.string(),
  },
  async ({ deployment_id }) => {
    const data = await triggerDeployment(deployment_id);
    return jsonResult("Redeploy queued.", data);
  }
);

registerTool(
  "dokscp_scale_deployment",
  "Scale a running Kubernetes deployment.",
  {
    deployment_id: z.string(),
    replicas: z.number().int().min(0).max(10),
  },
  async ({ deployment_id, replicas }) => {
    const data = await api("POST", `/deployments/${deployment_id}/kubernetes/scale`, { replicas });
    return jsonResult(`Scaled deployment ${deployment_id} to ${replicas} replica(s).`, data);
  }
);

registerTool(
  "dokscp_delete_deployment",
  "Delete an DOKSCP deployment and its runtime resources.",
  {
    deployment_id: z.string(),
    delete_image: z.boolean().optional(),
  },
  async ({ deployment_id, delete_image }) => {
    const data = await api("DELETE", `/deployments/${deployment_id}`, { delete_image: Boolean(delete_image) });
    return jsonResult(`Deleted deployment ${deployment_id}.`, data);
  }
);

// Backward-compatible aliases for older IDE configs and prompts.
registerTool("get_platform_health", "Alias for dokscp_health.", {}, handleHealth);
registerTool("list_projects", "Alias for dokscp_list_projects.", {}, handleListProjects);
registerTool("list_deployments", "Alias for dokscp_list_deployments.", {}, handleListDeployments);
registerTool("deploy_github_repo", "Alias for dokscp_deploy_github_repo.", {
  repo_url: z.string(),
  project_name: z.string().optional(),
  branch: z.string().optional(),
  github_pat: z.string().optional(),
  vps_connection_name: z.string().optional(),
}, handleDeployGithubRepo);
registerTool("get_deployment_status", "Alias for dokscp_get_deployment_status.", {
  deployment_id: z.string(),
  include_logs: z.boolean().optional(),
}, handleGetDeploymentStatus);
registerTool("get_deployment_logs", "Alias for dokscp_get_deployment_logs.", {
  deployment_id: z.string(),
}, handleGetDeploymentLogs);
registerTool("trigger_redeploy", "Alias for dokscp_trigger_redeploy.", {
  deployment_id: z.string(),
}, async ({ deployment_id }) => {
  const data = await triggerDeployment(deployment_id);
  return jsonResult("Redeploy queued.", data);
});

if (!TOKEN) {
  console.error("[dokscp-mcp] DOKSCP_MCP_TOKEN is not set. The server will start, but authenticated tools will return a setup error.");
}

const transport = new StdioServerTransport();
await server.connect(transport);
