export function defaultProjectEnvironments() {
  return [{ id: "production", name: "production", branch: "HEAD", auto_deploy: false, require_ci: false, cleanup_previous_on_success: false, env_vars: [] }];
}

export function preferredRepositoryBranch(names: string[], current: string, defaultBranch?: string) {
  if (current === "HEAD") return current;
  if (names.includes(current)) return current;
  if (defaultBranch && names.includes(defaultBranch)) return defaultBranch;
  return names.includes("main") ? "main" : names.includes("master") ? "master" : names[0] || current;
}

export function inferProjectName(source: string) {
  return source.trim().replace(/\/$/, "").split(/[/:\\]/).pop()?.replace(/\.git$/, "") || "";
}

export function isGitHubRepositorySource(source: string) {
  const value = source.trim();
  const path = value.match(/^git@github\.com:([^?#]+)$/i)?.[1];
  if (path) return /^[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(path);
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" &&
      /^[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(url.pathname.replace(/^\//, ""));
  } catch {
    return false;
  }
}
