const LOOPBACK_HOST = /^(localhost|127(?:\.\d+){3}|\[?::1\]?)$/i;

// A loopback development URL cannot be used by another device. The frontend
// proxies the same API/socket paths, while explicitly configured public hosts
// remain usable for installations that split their services.
export function apiTransportBase(configured = process.env.NEXT_PUBLIC_API_BASE_URL, origin = typeof window !== "undefined" ? window.location.origin : "") {
  if (!configured) return "/api/v1";
  try {
    const target = new URL(configured, origin || "http://localhost");
    if (origin && LOOPBACK_HOST.test(target.hostname) && !LOOPBACK_HOST.test(new URL(origin).hostname)) return "/api/v1";
  } catch { /* Relative paths are resolved by the browser. */ }
  return configured.replace(/\/+$/, "");
}

export function socketTransportBase(configured: string | undefined, origin = window.location.origin) {
  const source = configured ? new URL(configured, origin) : new URL(origin);
  const page = new URL(origin);
  const target = LOOPBACK_HOST.test(source.hostname) && !LOOPBACK_HOST.test(page.hostname) ? page : source;
  target.protocol = target.protocol === "https:" || target.protocol === "wss:" ? "wss:" : "ws:";
  return target.origin;
}
