// localhost on a phone points to the phone itself. Paired platform transports
// must use the secure gateway origin, including after navigating to dashboard.
export const REMOTE_DEVICE_KEY = "stackpilot_remote_device";
export function isRemotePlatform(): boolean {
  return typeof window !== "undefined" && !!window.localStorage.getItem(REMOTE_DEVICE_KEY);
}
export function remoteHeaders(): Record<string, string> {
  if (!isRemotePlatform()) return {};
  return { Authorization: `Bearer ${window.localStorage.getItem(REMOTE_DEVICE_KEY)}` };
}
export function platformSocketBase(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}
export function forgetRemoteDevice() {
  window.localStorage.removeItem(REMOTE_DEVICE_KEY);
  window.localStorage.removeItem("stackpilot_remote_submitted");
}
export function remoteDestination(search: string): string {
  const destination = new URLSearchParams(search).get("next") || "/dashboard";
  return /^\/dashboard(?:[/?]|$)/.test(destination) && !destination.includes("\\")
    ? destination : "/dashboard";
}
export function remoteRuntimeHref(url: string, deploymentId?: string, remote = isRemotePlatform()): string {
  if (!remote) return url;
  try {
    const target = new URL(url);
    const privateHost = /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(target.hostname)
      || target.hostname.endsWith(".internal") || !target.hostname.includes(".");
    if (target.protocol === "http:" || privateHost) {
      const params = new URLSearchParams({ browser: "open", custom_url: url });
      if (deploymentId) params.set("deploymentId", deploymentId);
      return `/dashboard/ai?${params}`;
    }
  } catch { /* Keep existing non-URL labels unchanged. */ }
  return url;
}
