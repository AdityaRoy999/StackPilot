// Production bundle/request measurements with fixture APIs; no account data is used.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STACKPILOT_PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.STACKPILOT_FRONTEND_URL || "http://localhost:3000";
const browser = await chromium.launch({ headless: true, executablePath: process.env.STACKPILOT_BROWSER_EXECUTABLE });
const results = [];
try {
  for (const route of (process.env.STACKPILOT_PERFORMANCE_ROUTES?.split(",") || ["/dashboard", "/dashboard/ai", "/dashboard/ai/history", "/dashboard/settings", "/dashboard/remote"])) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await context.addInitScript(() => { localStorage.setItem("theme", "dark"); localStorage.setItem("sidebar-collapsed", "true"); });
    const requests = {}, scripts = new Map(), bodies = [];
    await context.route("**/api/**", async interception => {
      const endpoint = new URL(interception.request().url()).pathname;
      requests[endpoint] = (requests[endpoint] || 0) + 1;
      let data = {};
      if (endpoint.endsWith("/auth/me")) data = { user: { id: "fixture", email: "fixture@example.test", preferences: { sidebar_collapsed: true, ui_theme: "studio", color_mode: "dark" } } };
      else if (endpoint.endsWith("/projects")) data = { projects: [{ id: "fixture", name: "Fixture project", source_type: "local", created_at: "2026-10-12", latest_deployment: null }] };
      else if (endpoint.endsWith("/organizations")) data = { organizations: [] };
      else if (endpoint.endsWith("/deployments")) data = { deployments: [] };
      else if (endpoint.endsWith("/ai/sessions")) data = { sessions: [] };
      else if (endpoint.endsWith("/ai/models")) data = { models: [] };
      else if (endpoint.endsWith("/ai/settings")) data = { enabled: true, model: "fixture", provider: "compatible" };
      else if (endpoint.endsWith("/stack")) data = { stack: { status: "unknown", components: [] } };
      else if (endpoint.endsWith("/ssh/connections")) data = { connections: [] };
      else if (endpoint.endsWith("/remote/devices")) data = { devices: [] };
      else if (endpoint.endsWith("/remote/runs")) data = { runs: [] };
      else if (endpoint.endsWith("/remote/access")) data = { available: false, running: false, url: "" };
      await interception.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    const page = await context.newPage();
    page.on("response", response => {
      if (new URL(response.url()).pathname.endsWith(".js")) bodies.push(response.body().then(body => scripts.set(response.url(), body.length)).catch(() => {}));
    });
    const start = performance.now();
    await page.goto(`${origin}${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(9000); // Includes the previous 8-second deployment poll and sidebar prefetch.
    await Promise.allSettled(bodies);
    results.push({ route, loadMs: Math.round(performance.now() - start - 9000), scriptCount: scripts.size, scriptBytes: [...scripts.values()].reduce((a, b) => a + b, 0), apiRequests: requests });
    await context.close();
  }
} finally { await browser.close(); }
await mkdir(path.resolve("tests/artifacts"), { recursive: true });
const filename = path.resolve("tests/artifacts", process.env.STACKPILOT_PERFORMANCE_LABEL || "frontend-performance.json");
await writeFile(filename, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
