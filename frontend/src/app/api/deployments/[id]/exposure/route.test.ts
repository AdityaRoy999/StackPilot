import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

afterEach(() => vi.unstubAllGlobals());

describe("deployment exposure proxy", () => {
  it("forwards the browser origin and CSRF header for backend validation", async () => {
    const upstream = vi.fn(async (_input: string, _init: RequestInit) => Response.json({ error: "Unauthorized" }, { status: 401 }));
    vi.stubGlobal("fetch", upstream);
    const request = new NextRequest("http://localhost:3000/api/deployments/test/exposure", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-stackpilot-csrf": "1",
      },
      body: "{}",
    });

    const response = await POST(request, { params: Promise.resolve({ id: "test" }) });
    expect(response.status).toBe(401);
    expect(upstream).toHaveBeenCalledOnce();
    const options = upstream.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({ Origin: "http://localhost:3000", "X-stackpilot-CSRF": "1" });
  });
});
