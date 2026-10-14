import axios from "axios";

// RDP lives behind the frontend/Caddy proxy, including installations where the
// general API client is configured to address the C++ backend directly.
export const rdpApi = axios.create({ baseURL: "/api/v1", withCredentials: true, timeout: 25000,
  headers: { "Content-Type": "application/json", "X-StackPilot-CSRF": "1" } });

export interface RdpConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  domain: string;
  security: "nla" | "tls" | "any";
  ignore_certificate: boolean;
  keyboard_layout: string;
  has_password: boolean;
}

export async function rdpFilePayload(file: File) {
  if (!file.name.toLowerCase().endsWith(".rdp") || file.size > 65536 || !file.size) {
    throw new Error("Choose a .rdp file smaller than 64 KB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let content = "";
  for (const byte of bytes) content += String.fromCharCode(byte);
  return { filename: file.name, content: btoa(content) };
}

export function rdpError(error: unknown, fallback: string) {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof detail === "string" ? detail : fallback;
}
