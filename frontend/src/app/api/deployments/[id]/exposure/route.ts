import { NextRequest, NextResponse } from "next/server";

type RouteContext = { params: Promise<{ id: string }> };

async function forward(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const base = process.env.INTERNAL_API_URL || `${process.env.STACKPILOT_BACKEND_INTERNAL_URL || process.env.BACKEND_INTERNAL_URL || "http://backend:8090"}/api/v1`;
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const key of ["cookie", "authorization", "origin", "referer", "x-stackpilot-csrf"]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  let body: string | undefined;
  if (request.method === "POST") {
    try {
      const input = await request.json();
      body = JSON.stringify({ exposure_mode: input.exposure_mode, tunnel_token: input.tunnel_token, public_url: input.public_url });
    } catch {
      return NextResponse.json({ error: "Invalid connection details" }, { status: 400 });
    }
  }
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/deployments/${encodeURIComponent(id)}/exposure`, {
      method: request.method, headers, body, cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
    });
    return NextResponse.json(await response.json(), { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not reach StackPilot to check the connection. Refresh its status before retrying." }, { status: 502 });
  }
}

export const GET = forward;
export const POST = forward;
