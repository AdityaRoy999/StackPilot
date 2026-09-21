import { NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: deploymentId } = await params;
  if (!deploymentId) {
    return NextResponse.json({ error: "Deployment ID is required" }, { status: 400 });
  }

  try {
    const body = await request.json();
    const exposureMode = body.exposure_mode || "direct"; // "direct" | "portless" | "cloudflare_tunnel"
    const tunnelToken = body.tunnel_token || "";
    const projectName = body.project_name || "app";
    const port = body.port || 3000;

    const backendBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8090/api/v1";
    const cookieHeader = request.headers.get("cookie") || "";
    const authHeader = request.headers.get("authorization") || "";

    const candidateUrls = [
      process.env.INTERNAL_API_URL,
      "http://backend:8090/api/v1",
      backendBaseUrl,
    ].filter(Boolean) as string[];

    for (const url of candidateUrls) {
      try {
        const backendRes = await fetch(`${url}/deployments/${deploymentId}/exposure`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-stackpilot-CSRF": "1",
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
          body: JSON.stringify({
            exposure_mode: exposureMode,
            tunnel_token: tunnelToken,
            project_name: projectName,
            port,
          }),
        });

        if (backendRes.ok) {
          const data = await backendRes.json();
          return NextResponse.json(data);
        } else {
          const data = await backendRes.json().catch(() => ({}));
          return NextResponse.json(data, { status: backendRes.status });
        }
      } catch {
        // Try next candidate URL
      }
    }

    return NextResponse.json(
      { error: "Could not reach StackPilot backend to update deployment exposure" },
      { status: 502 }
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to update deployment exposure" },
      { status: 500 }
    );
  }
}
