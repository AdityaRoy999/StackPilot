// Every API is mocked. No servers, devices, projects, or tunnels are modified.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STACKPILOT_PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.STACKPILOT_FRONTEND_URL || "http://localhost:3000";
const artifacts = path.resolve("tests/artifacts");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.STACKPILOT_BROWSER_EXECUTABLE ? { executablePath: process.env.STACKPILOT_BROWSER_EXECUTABLE } : {}) });
const servers = ["Control", "Worker A", "Worker B"].map((name, index) => ({ id: `server-${index}`, name, host: `192.0.2.${index + 1}`, username: "fixture", host_capabilities: { docker_daemon: "yes" }, last_probed_at: "2026-10-12T08:00:00Z" }));
const errors = [];
async function fixture(width, reducedMotion = "no-preference") {
  const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion });
  const state = { clusters: [], installs: 0, joins: [], failWorker: false, failInit: false, approved: false, mutations: [], phoneClaim: null };
  await context.addInitScript(() => { localStorage.setItem("theme", "dark"); localStorage.setItem("sidebar-collapsed", "true"); });
  await context.route("**/api/**", async route => {
    const request = route.request(), endpoint = new URL(request.url()).pathname.replace(/^\/api\/v1/, ""), method = request.method();
    let data = {}, status = 200;
    if (method !== "GET") state.mutations.push(endpoint);
    if (endpoint === "/auth/me") data = { user: { id: "fixture", full_name: "Fixture user", email: "fixture@example.test", password_enabled: true, preferences: { sidebar_collapsed: true, ui_theme: "studio", color_mode: "dark" } } };
    else if (endpoint === "/auth/login-history") data = { history: [{ id: "login-fixture", login_method: "password", device: "Fixture laptop", ip_address: "192.0.2.9", user_agent: "Fixture browser", created_at: "2026-10-12T08:00:00Z" }] };
    else if (endpoint === "/auth/audit-logs") data = { logs: [{ id: "audit-fixture", action: "project.updated", target_type: "project", target_id: "fixture", ip_address: "192.0.2.9", metadata: {}, created_at: "2026-10-12T08:00:00Z" }] };
    else if (endpoint === "/organizations") data = { organizations: [{ id: "workspace-fixture", name: "Fixture workspace", is_personal: true, role: "owner" }] };
    else if (endpoint === "/ssh/connections") data = { connections: servers };
    else if (endpoint === "/infrastructure/inventory") data = { mode: "local", docker: { available: true, containers: [], images: [] }, kubernetes: { available: true, namespaces: [{ name: "default" }], nodes: [], pods: [], deployments: [], services: [], events: [] } };
    else if (endpoint === "/projects") data = { projects: [] };
    else if (endpoint === "/deployments") data = { deployments: [] };
    else if (endpoint === "/ai/settings") data = { enabled: true, provider: "nvidia_nim", model: "fixture" };
    else if (endpoint === "/ai/models") data = { provider: "nvidia_nim", selected_model: "fixture", models: [] };
    else if (endpoint === "/ai/sessions") data = { sessions: [] };
    else if (endpoint.endsWith("/cluster/status")) data = { success: true, message: "Fixture status checked", details: "Fixture cluster healthy" };
    else if (endpoint === "/ssh/clusters") data = { clusters: state.clusters };
    else if (endpoint.endsWith("/cluster/init")) {
      state.installs++;
      await new Promise(resolve => setTimeout(resolve, 350));
      if (state.failInit) { data = { success: false, error: "Fixture install failed", hint: "Check your server" }; state.failInit = false; }
      else {
        const cluster = { id: "cluster-fixture", name: request.postDataJSON().cluster_name, control_plane_connection_id: "server-0", control_plane_name: "Control", control_plane_host: servers[0].host, server_url: "https://192.0.2.1:6443", status: "ready", nodes: [{ id: "node-0", connection_id: "server-0", connection_name: "Control", role: "server", status: "ready" }] };
        state.clusters = [cluster]; data = { success: true, message: "Installed", cluster };
      }
    } else if (endpoint.endsWith("/cluster/join")) {
      const id = request.postDataJSON().worker_connection_id; state.joins.push(id);
      if (state.failWorker && id === "server-2") { status = 409; data = { success: false, error: "Fixture worker failed", worker_connection_id: id }; state.failWorker = false; }
      else { state.clusters[0].nodes.push({ id: `node-${id}`, connection_id: id, connection_name: servers.find(s => s.id === id).name, role: "agent", status: "ready" }); data = { success: true, worker_connection_id: id, message: "Joined" }; }
    } else if (endpoint === "/remote/access") data = { available: true, running: true, url: "https://remote.fixture.invalid" };
    else if (endpoint === "/remote/connect") { state.phoneClaim = request.postDataJSON(); data = { name: state.phoneClaim.name, status: "pending", confirmation_code: "123456" }; }
    else if (endpoint === "/remote/device") data = { name: state.phoneClaim?.name, status: "pending", confirmation_code: "123456" };
    else if (endpoint === "/remote/pairings") data = { secret: "a".repeat(64), expires_at: "2099-01-01T00:00:00Z" };
    else if (endpoint === "/remote/devices") {
      if (method === "POST") { state.approved = true; data = { ok: true }; }
      else data = { devices: [
        { id: "phone-one", name: "My Android", status: "approved", last_seen_at: "2026-10-12T09:00:00Z", expires_at: "2099-01-01T00:00:00Z", created_at: "2026-10-11T08:00:00Z", location_label: "Home", timezone: "Asia/Kolkata", user_agent: "Mozilla/5.0 (Linux; Android 15) Chrome/130.0", request_count: "12" },
        { id: "old-phone", name: "Previous phone", status: "revoked", last_seen_at: null, expires_at: "2099-01-01T00:00:00Z", created_at: "2026-10-01T08:00:00Z" },
        ...(!state.approved ? [{ id: "pending-phone", name: "New phone", status: "pending", confirmation_code: "123456", expires_at: "2099-01-01T00:00:00Z", last_seen_at: null }] : []),
      ] };
    } else if (endpoint === "/remote/runs") data = { runs: [{ id: "run-1", device_id: "phone-one", session_id: "session-1", title: "Android task", state: "completed", created_at: "2026-10-12T09:00:00Z" }, { id: "run-2", device_id: "old-phone", session_id: "session-2", title: "Previous task", state: "cancelled", created_at: "2026-10-11T09:00:00Z" }] };
    else if (endpoint === "/infrastructure/inventory") data = { mode: "local", docker: { available: true, containers: [], images: [] }, kubernetes: { available: true, namespaces: [{ name: "default" }], nodes: [], pods: [], deployments: [], services: [], events: [] } };
    else if (endpoint === "/projects") data = { projects: [] };
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
  });
  const page = await context.newPage(); page.setDefaultNavigationTimeout(90000); page.on("pageerror", error => errors.push(error.message));
  return { context, page, state };
}
async function sizeCheck(page, name) {
  const overflow = await page.getByRole("dialog").evaluate(node => ({ delta: node.scrollWidth - node.clientWidth, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, screenWidth: innerWidth, screenHeight: innerHeight }));
  assert(overflow.delta <= 1 && overflow.width <= overflow.screenWidth && overflow.height <= overflow.screenHeight, `${name} overflows: ${JSON.stringify(overflow)}`);
}
async function checkSettingsLayout(page, width) {
  await page.goto(`${origin}/dashboard/settings`);
  await page.getByRole("region", { name: "Account Settings", exact: true }).waitFor();
  const categories = page.getByRole("navigation", { name: "Settings categories", exact: true });
  assert.equal(await categories.getByRole("button").count(), 6);
  for (const button of await categories.getByRole("button").all()) {
    await button.click();
    await button.hover();
    await page.waitForFunction(() => {
      const selected = document.querySelector('nav[aria-label="Settings categories"] [aria-current="page"]');
      return selected && getComputedStyle(selected).backgroundColor === "rgb(255, 255, 255)" && getComputedStyle(selected).color === "rgb(0, 0, 0)";
    });
    assert.equal(await button.getAttribute("aria-current"), "page", "The whole selected category should receive the active state");
    const height = (await button.boundingBox()).height;
    assert(width < 640 ? height >= 44 : height >= 36 && height <= 42, `Settings category height is not compact at ${width}px: ${height}`);
  }
  await categories.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("region", { name: "Account Settings", exact: true }).waitFor();
  const layout = await page.locator("[data-account-layout]").evaluate(node => ({
    profile: node.querySelector("[data-account-profile]").getBoundingClientRect().toJSON(),
    activity: node.querySelector("[data-account-activity]").getBoundingClientRect().toJSON(),
    overflow: node.scrollWidth - node.clientWidth,
  }));
  assert(layout.overflow <= 1, `Account content overflows at ${width}px`);
  if (width >= 1024) {
    assert(layout.activity.x >= layout.profile.right + 16 && Math.abs(layout.activity.y - layout.profile.y) <= 1, "Account activity should sit beside the form");
  } else assert(layout.activity.y >= layout.profile.bottom + 16, "Account activity should stack on small screens");
  assert(await categories.evaluate(node => node.scrollWidth <= node.clientWidth + 1), "Settings categories overflow");
  assert(await categories.evaluate(node => parseFloat(getComputedStyle(node).columnGap) >= 20), "Settings categories are too close together");
  if (width >= 1024) {
    assert(await categories.evaluate(node => node.getBoundingClientRect().right - node.lastElementChild.getBoundingClientRect().right <= 12), "Settings categories leave unused space on the right");
    assert.equal(await categories.getByRole("button").first().evaluate(node => getComputedStyle(node, "::before").height), "16px");
  }
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, `account-settings-${width}.png`) });
  for (const [name, text] of [["Login History", "Fixture laptop"], ["Audit Logs", "project updated"]]) {
    await page.getByRole("button", { name, exact: true }).click();
    const dialog = page.getByRole("dialog", { name, exact: true });
    await dialog.getByText(text, { exact: true }).waitFor();
    await sizeCheck(page, `${name} ${width}`);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }
  await page.getByRole("textbox", { name: "Search settings", exact: true }).fill("login history");
  assert.equal(await categories.getByRole("button").count(), 1);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
}
async function checkSidebarMotion(page) {
  const aside = page.locator('[data-slot="dashboard-shell"] > aside');
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-slot="dashboard-shell"] > aside').getBoundingClientRect().width >= 207.9);
  const frames = await aside.evaluate(node => new Promise(resolve => {
    const selectors = 'nav a svg, nav a > span:last-child, button[aria-label^="Workspace:"] svg, button[aria-label="Theme"] svg, button[aria-label="Logout"] svg, button[aria-label$="sidebar"] svg';
    const sample = () => ({ width: node.getBoundingClientRect().width, points: Array.from(node.querySelectorAll(selectors)).map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; }) });
    const frames = [sample()], start = performance.now();
    node.querySelector('button[aria-label="Collapse sidebar"]').click();
    function next() {
      frames.push(sample());
      if (performance.now() - start < 350) requestAnimationFrame(next);
      else resolve(frames);
    }
    requestAnimationFrame(next);
  }));
  assert(new Set(frames.map(frame => Math.round(frame.width))).size >= 4, "Sidebar does not animate its width");
  assert.equal(Math.round(frames.at(-1).width), 52);
  for (const frame of frames) for (let i = 0; i < frame.points.length; i++) {
    assert(Math.abs(frame.points[i].x - frames[0].points[i].x) <= 1 && Math.abs(frame.points[i].y - frames[0].points[i].y) <= 1, `Sidebar element ${i} moved during collapse: ${JSON.stringify({ before: frames[0].points[i], after: frame.points[i] })}`);
  }
  assert.equal(await aside.evaluate(node => getComputedStyle(node).borderRightWidth), "0px");
  const header = page.locator("[data-workspace-header]");
  assert.equal(await header.evaluate(node => getComputedStyle(node).borderBottomWidth), "0px");
  assert.equal((await header.boundingBox()).height, 44);
  // The workspace popover must remain usable outside the slim rail.
  const workspace = aside.getByRole("button", { name: /^Workspace:/ });
  await workspace.click();
  await aside.getByRole("button", { name: "Manage Organizations", exact: true }).click({ trial: true });
  await workspace.click();
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, "compact-shell-desktop.png") });
}
async function clusterReview(page, workers = true) {
  await page.goto(`${origin}/dashboard/logging-monitoring/clusters`);
  await page.getByText("You haven’t created a cluster yet.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: /Your clusters|Set up cluster/ }).count(), 0);
  assert.equal(await page.locator("#clusterName").count(), 0);
  await page.getByRole("button", { name: "Create clusters", exact: true }).click();
  await page.locator("#clusterName").fill("Fixture cluster");
  const rail = page.getByRole("navigation", { name: "Cluster setup progress" });
  assert.equal(await rail.locator('[data-reached="true"]').count(), 1);
  assert.equal(await rail.locator("li").nth(1).locator(".setup-progress-circle").evaluate(node => getComputedStyle(node).borderTopStyle), "dotted");
  assert.equal(await page.locator("[data-cluster-footer]").getByRole("button", { name: "Continue", exact: true }).count(), 1);
  assert.equal(await page.locator("[data-cluster-footer]").getByRole("button", { name: "Cancel", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator("summary").filter({ hasText: "Advanced settings" }).click();
  await page.locator("#controlPlaneSudo").fill("private-fixture-password");
  await page.getByRole("button", { name: "Continue to workers" }).click();
  if (workers) { await page.getByRole('checkbox').nth(0).click(); await page.getByRole('checkbox').nth(1).click(); }
  await page.getByRole("button", { name: "Review cluster" }).click();
  await page.getByRole("region", { name: "Cluster creation confirmation" }).waitFor();
  assert.equal(await rail.locator('[data-reached="true"]').count(), 4);
  assert.equal(await rail.locator("li").first().evaluate(node => getComputedStyle(node, "::after").borderTopStyle), "solid");
  assert(!(await page.getByRole("dialog").innerText()).includes("private-fixture-password"));
}
try {
  const { context, page, state } = await fixture(1440);
  state.failWorker = true;
  await clusterReview(page);
  assert.equal(state.installs, 0); assert.equal(state.joins.length, 0);
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, "cluster-confirmation-desktop.png") });
  await page.getByRole("button", { name: "Create cluster", exact: true }).evaluate(node => { node.click(); node.click(); });
  await page.getByRole("alert").filter({ hasText: "worker join operation failed" }).waitFor();
  assert.equal(state.installs, 1); assert.deepEqual(state.joins, ["server-1", "server-2"]);
  await page.getByRole("button", { name: "Confirm cluster", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).waitFor();
  assert.equal(state.installs, 1, "Retry reinstalled the control plane"); assert.deepEqual(state.joins, ["server-1", "server-2", "server-2"], "Retry rejoined a completed worker");
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Fixture cluster", exact: true }).waitFor();
  const cluster = page.getByRole("region", { name: "Fixture cluster", exact: true });
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, "cluster-actions-desktop.png") });
  assert.equal(await cluster.getByRole("button", { name: /More/ }).count(), 0);
  await cluster.getByRole("button", { name: "Delete cluster Fixture cluster", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await cluster.getByRole("button", { name: "Check status", exact: true }).click();
  await cluster.getByRole("button", { name: "Operation output", exact: true }).click();
  const output = page.getByRole("dialog", { name: "Operation output", exact: true });
  await output.getByText("Fixture status checked", { exact: true }).waitFor();
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, "cluster-operation-output.png") });
  await page.keyboard.press("Escape");
  await output.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  const themeMenu = page.locator('[data-slot="dropdown-menu-content"]'); await themeMenu.waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  const placement = await themeMenu.boundingBox(), anchor = await page.getByRole("button", { name: "Theme", exact: true }).boundingBox();
  assert(placement.height < 90, "Theme selector is too tall");
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, "theme-compact-desktop.png") });
  assert(placement.x >= anchor.x + anchor.width && placement.x < 140, "Theme menu isn't beside the moon button");
  await page.getByRole("menuitemradio", { name: "Light", exact: true }).click();
  await themeMenu.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.documentElement.classList.contains("light"));
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
  await themeMenu.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  assert.equal(await page.getByRole("link", { name: "Setup guide", exact: true }).count(), 0);
  await checkSettingsLayout(page, 1440);
  await checkSidebarMotion(page);
  await page.goto(`${origin}/dashboard/setup`); await page.waitForURL(`${origin}/dashboard`);
  await page.goto(`${origin}/dashboard/logging-monitoring/infrastructure`);
  const resources = page.getByRole("tablist", { name: "Cluster resources", exact: true });
  await resources.waitFor();
  assert.equal(await resources.getByRole("tab").count(), 6);
  assert.equal(await resources.evaluate(node => parseFloat(getComputedStyle(node).columnGap) >= 12), true);
  assert.equal(await resources.getByRole("tab").first().evaluate(node => getComputedStyle(node, "::before").height), "16px");
  for (const name of ["Pods", "Services", "Nodes", "Namespaces", "Events", "Workloads"]) await resources.getByRole("tab", { name, exact: true }).click();
  await resources.scrollIntoViewIfNeeded();
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, "cluster-explorer-tabs.png") });
  await page.goto(`${origin}/dashboard/ai`);
  await page.getByRole("button", { name: "Agent settings", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Chat menu", exact: true }).isVisible(), false);
  await page.getByRole("button", { name: "Agent settings", exact: true }).click();
  const agentSettings = page.getByRole("dialog", { name: "Agent Settings", exact: true });
  await agentSettings.getByRole("tab", { name: "Appearance", exact: true }).click();
  assert.equal(await agentSettings.getByRole("tab").count(), 6);
  assert((await agentSettings.boundingBox()).width >= 1080, "Agent Settings is too narrow");
  assert(await agentSettings.getByRole("tablist").evaluate(node => node.getBoundingClientRect().right - node.lastElementChild.getBoundingClientRect().right <= 5), "Agent categories do not stretch across the modal");
  assert(await agentSettings.getByRole("tablist").evaluate(node => parseFloat(getComputedStyle(node).columnGap) >= 24), "Agent categories need more spacing");
  await sizeCheck(page, "Agent settings desktop");
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, "agent-settings-tabs-desktop.png") });
  const resizing = await agentSettings.evaluate(node => new Promise(resolve => {
    const frames = [{ height: node.getBoundingClientRect().height, y: node.getBoundingClientRect().y }], start = performance.now();
    Array.from(node.querySelectorAll('[role="tab"]')).find(tab => tab.textContent === "Permissions").click();
    function sample() {
      const rect = node.getBoundingClientRect(); frames.push({ height: rect.height, y: rect.y });
      if (performance.now() - start < 420) requestAnimationFrame(sample); else resolve(frames);
    }
    requestAnimationFrame(sample);
  }));
  const heightChange = Math.abs(resizing.at(-1).height - resizing[0].height);
  assert(heightChange > 4 && new Set(resizing.map(frame => Math.round(frame.height))).size >= 4, `Agent Settings must animate its height when changing sections: ${JSON.stringify(resizing)}`);
  assert(Math.max(...resizing.slice(1).map((frame, index) => Math.abs(frame.height - resizing[index].height))) < heightChange * .6, `Agent Settings has an abrupt resize: ${JSON.stringify(resizing)}`);
  assert(Math.max(...resizing.map(frame => frame.height)) <= Math.max(resizing[0].height, resizing.at(-1).height) + 2, "Outgoing panels must not inflate the modal during a section switch");
  await sizeCheck(page, "Agent settings after resize");
  await agentSettings.getByRole("button", { name: "Done", exact: true }).click();
  await agentSettings.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.getByRole("button", { name: "Live App", exact: true }).click();
  await page.getByRole("button", { name: "Chat menu", exact: true }).waitFor();
  await page.setViewportSize({ width: 1920, height: 950 });
  await page.getByRole("button", { name: "Agent settings", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Chat menu", exact: true }).isVisible(), false);
  await context.close();
  for (const width of [375, 768, 1024, 1440]) {
    const { context, page, state } = await fixture(width);
    await clusterReview(page, false); assert.equal(state.installs, 0); await sizeCheck(page, `Cluster ${width}`);
    await page.screenshot({ animations: "disabled", path: path.join(artifacts, `cluster-wizard-${width}.png`) });
    await page.keyboard.press("Escape");
    await page.goto(`${origin}/dashboard/remote`);
    await page.getByRole("region", { name: "Recent connections" }).getByText("My Android", { exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    const devices = page.getByRole("table", { name: "Remote devices" });
    await devices.getByRole("button", { name: "Device details for My Android", exact: true }).click();
    const details = page.locator("#device-details-phone-one");
    await details.getByText("Asia/Kolkata", { exact: true }).waitFor();
    assert((await details.innerText()).includes("Home")); assert((await details.innerText()).includes("12"));
    await details.getByRole("button", { name: "View history" }).click();
    const history = page.getByRole("region", { name: "Connection history" });
    assert.equal(await history.getByRole("link").count(), 1); assert((await history.innerText()).includes("Android task"));
    assert.equal(await history.getByRole("table", { name: "Remote request history" }).count(), 1);
    await page.getByRole("combobox", { name: "Filter history by device", exact: true }).click();
    await page.getByRole("option", { name: "All devices", exact: true }).click();
    assert.equal(await history.getByRole("link").count(), 2);
    await page.screenshot({ animations: "disabled", path: path.join(artifacts, `remote-tables-${width}.png`) });
    await page.getByRole("button", { name: "Connect remote device", exact: true }).click();
    await page.locator("#remote-origin").waitFor({ state: "attached" }); await sizeCheck(page, `Remote ${width}`);
    await page.getByRole("button", { name: "Pair a phone", exact: true }).click();
    await page.getByRole("button", { name: "Copy private pairing link" }).waitFor();
    await page.screenshot({ animations: "disabled", path: path.join(artifacts, `remote-pairing-${width}.png`) });
    await page.getByRole("dialog").getByRole("button", { name: "Approve device" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert(state.approved); assert(state.mutations.includes("/remote/pairings"));
    assert(await page.locator("[data-remote-page]").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    if (width === 375) {
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("dialog", { name: "Navigation" }).getByRole("button", { name: "Theme", exact: true }).click();
      const mobileTheme = page.locator('[data-slot="dropdown-menu-content"]'); await mobileTheme.waitFor();
      const bounds = await mobileTheme.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, "Theme menu clips on a phone");
      await page.keyboard.press("Escape"); await mobileTheme.waitFor({ state: "hidden" });
      await page.keyboard.press("Escape"); await page.getByRole("dialog", { name: "Navigation" }).waitFor({ state: "hidden" });
    }
    await checkSettingsLayout(page, width);
    await page.route("**/api/v1/ai/sessions", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions: [{ id: "history-fixture", title: "Fixture conversation", session_type: "agent_chat", message_count: 2, preview: "A fixture preview", last_model: "fixture-model", memory_summary: "## Saved next step\n\nVerify the fixture.", created_at: "2026-10-12T08:00:00Z", updated_at: "2026-10-12T08:00:00Z" }] }) }));
    await page.goto(`${origin}/dashboard/ai/history`);
    const searchHistory = page.getByRole("textbox", { name: "Search chat history", exact: true });
    await searchHistory.waitFor();
    await page.getByRole("heading", { name: "Fixture conversation", exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Saved next step", exact: true }).count(), 0, "Closed history context should not parse markdown");
    await page.locator("summary").filter({ hasText: "Saved conversation context" }).click();
    await page.getByRole("heading", { name: "Saved next step", exact: true }).waitFor();
    await searchHistory.fill("no match");
    await page.getByText("No conversations match these filters.", { exact: true }).waitFor();
    await searchHistory.fill("fixture-model");
    await page.getByRole("heading", { name: "Fixture conversation", exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Chat history overflows at ${width}px`);
    if (width >= 1024) {
      const searchBox = await searchHistory.boundingBox(), refresh = await page.getByRole("button", { name: "Refresh", exact: true }).boundingBox();
      assert(searchBox.x + searchBox.width < refresh.x && Math.abs(searchBox.y - refresh.y) <= 4, "Chat search should sit beside the top actions");
    }
    await page.screenshot({ animations: "disabled", path: path.join(artifacts, `chat-history-${width}.png`) });
    await page.unroute("**/api/v1/ai/sessions");
    await page.goto(`${origin}/dashboard/ai`);
    if (width >= 640) await page.waitForFunction(() => {
      const aside = document.querySelector('[data-slot="dashboard-shell"] > aside');
      return aside.dataset.collapsed === "true" && Math.abs(aside.getBoundingClientRect().width - 52) < .5;
    });
    if (await page.getByRole("button", { name: "Chat menu", exact: true }).isVisible()) {
      await page.getByRole("button", { name: "Chat menu", exact: true }).click();
      await page.getByRole("menuitem", { name: "Agent settings", exact: true }).click();
    } else await page.getByRole("button", { name: "Agent settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Agent Settings", exact: true });
    await settings.getByRole("tab", { name: "Browser", exact: true }).click();
    await settings.getByRole("tab", { name: "Model & replies", exact: true }).click();
    await sizeCheck(page, `Agent settings ${width}`);
    await page.screenshot({ animations: "disabled", path: path.join(artifacts, `agent-settings-${width}.png`) });
    await context.close();
  }
  const reduced = await fixture(1024, "reduce");
  await reduced.page.goto(`${origin}/dashboard/remote`);
  await reduced.page.getByRole("region", { name: "Recent connections" }).getByText("My Android", { exact: true }).click();
  await reduced.page.getByRole("button", { name: "Device details for My Android", exact: true }).click();
  assert.equal(await reduced.page.locator("#device-details-phone-one").locator("..").locator("..").evaluate(node => getComputedStyle(node).transitionDuration), "0s");
  await reduced.page.goto(`${origin}/dashboard/ai`);
  await reduced.page.getByRole("button", { name: "Agent settings", exact: true }).click();
  const reducedDialog = reduced.page.getByRole("dialog", { name: "Agent Settings", exact: true });
  await reducedDialog.getByRole("tab", { name: "Appearance", exact: true }).click();
  assert.equal(await reducedDialog.evaluate(node => node.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => frame.height))), false, "Reduced motion must skip modal height animation");
  await reduced.context.close();
  const installFailure = await fixture(1024); installFailure.state.failInit = true;
  await clusterReview(installFailure.page, false);
  await installFailure.page.getByRole("button", { name: "Create cluster", exact: true }).click();
  await installFailure.page.getByRole("alert").filter({ hasText: "Fixture install failed" }).waitFor();
  assert.equal(installFailure.state.joins.length, 0);
  await installFailure.page.getByRole("button", { name: "Create cluster", exact: true }).click();
  await installFailure.page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).waitFor();
  assert.equal(installFailure.state.installs, 2); await installFailure.context.close();
  const phone = await fixture(375);
  await phone.page.goto(`${origin}/remote#pair=${"b".repeat(64)}`);
  await phone.page.locator("#phone-name").fill("Fixture phone");
  await phone.page.locator("#phone-location").fill("Fixture office");
  await phone.page.getByRole("button", { name: "Connect this phone", exact: true }).click();
  await phone.page.getByRole("heading", { name: "Confirm this phone on your computer" }).waitFor();
  assert.equal(phone.state.phoneClaim.name, "Fixture phone"); assert.equal(phone.state.phoneClaim.location_label, "Fixture office");
  assert.equal(typeof phone.state.phoneClaim.timezone, "string"); assert(!phone.page.url().includes("#pair="));
  assert(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await phone.context.close();
  assert.deepEqual(errors, []);
  console.log("WORKSPACE_SETUP_UI_PASS: smooth modal resize without overshoot, top chat-history search, lazy saved context, compact Settings categories with consistent white selection, stationary sidebar collapse, slim shell, full-width settings categories, account activity dialogs, final confirmation, duplicate submit, partial recovery, four viewports, device history, pairing approvals, adjacent theme menu, legacy redirect, reduced motion");
} finally { await browser.close(); }
