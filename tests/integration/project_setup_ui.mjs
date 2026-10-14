// Opt-in production UI qualification. Every API call is mocked; no projects,
// deployments, user data, or external repositories are mutated.
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
const project = { id: "11111111-1111-4111-8111-111111111111", name: "Fixture storefront", description: "A source project", source_type: "github", repo_url: "https://github.com/fixture/storefront", created_at: "2026-10-12T08:00:00Z", updated_at: "2026-10-12T08:00:00Z", latest_deployment: null };
const components = [
  { id: "nextjs", name: "Next.js", role: "frontend", kind: "framework", evidence: ["frontend/package.json"] },
  { id: "express", name: "Express", role: "backend", kind: "framework", evidence: ["backend/package.json"] },
  { id: "postgres", name: "PostgreSQL", role: "database", kind: "client", evidence: ["backend/package.json"] },
  { id: "react", name: "React", role: "frontend", kind: "framework", evidence: ["frontend/package.json"] },
  { id: "node", name: "Node.js", role: "runtime", kind: "runtime", evidence: ["backend/Dockerfile", "backend/package.json", "frontend/Dockerfile", "frontend/package.json"] },
  { id: "docker", name: "Docker", role: "infrastructure", kind: "configuration", evidence: ["backend/Dockerfile", "docker-compose.yml", "frontend/Dockerfile"] },
  { id: "redis", name: "Redis", role: "cache", kind: "service", evidence: ["docker-compose.yml"] },
];
const stack = { status: "detected", components, manifests: [], files_scanned: 2, truncated: false, method: "manifests", message: "Database clients do not provision a database." };
let created = 0, inspected = 0, editLoads = 0, payload;
const deployment = { id: "fixture-deployment", project_id: project.id, project_name: project.name, status: "failed", version: "v1.0.0", branch: "main", commit_hash: "", image_name: "fixture:local", created_at: project.created_at };
const environment = { id: "fixture-environment", name: "production", branch: "main", auto_deploy: false, require_ci: false, cleanup_previous_on_success: true, runtime_type: "docker", runtime_config: {} };
const errors = [];
async function context(width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => { localStorage.setItem("theme", "dark"); localStorage.setItem("sidebar-collapsed", "true"); });
  await context.route("**/api/**", async route => {
    const url = new URL(route.request().url()); const endpoint = url.pathname.replace(/^\/api\/v1/, "");
    let data = {};
    if (endpoint === "/auth/me") data = { user: { id: "fixture-user", email: "fixture@example.test", preferences: { sidebar_collapsed: true, ui_theme: "studio", color_mode: "dark" }, github_connected: false } };
    else if (endpoint === "/organizations") data = { organizations: [{ id: "workspace-fixture", name: "Fixture workspace", role: "owner", is_personal: true }] };
    else if (endpoint === "/projects" && route.request().method() === "POST") {
      created++; payload = route.request().postDataJSON();
      await new Promise(resolve => setTimeout(resolve, 250));
      // Deliberately omit id to keep qualification on the dashboard.
      data = { project: {} };
    } else if (endpoint === "/projects") data = { projects: [project] };
    else if (endpoint === `/projects/${project.id}/stack`) data = { stack, details: { workspace: "Fixture workspace", source_type: "github", repo_url: project.repo_url, execution_mode: "local", remote_runtime_type: "docker", runtime_scheme: "http", variables: 2, environments: [{ name: "production", branch: "HEAD", auto_deploy: false, require_ci: false, variables: 1 }] } };
    else if (endpoint === "/projects/inspect-stack") { inspected++; data = { stack }; }
    else if (endpoint === "/ssh/connections") data = { connections: [] };
    else if (endpoint === "/github/repos") data = { repositories: [] };
    else if (endpoint === `/projects/${project.id}`) { editLoads++; data = { project }; }
    else if (endpoint === `/projects/${project.id}/environments`) data = { environments: [environment] };
    else if (endpoint === `/projects/${project.id}/deployments` || endpoint === "/deployments") data = { deployments: [deployment] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/dashboard`, { timeout: 90000 });
  await page.getByRole("link", { name: project.name, exact: true }).waitFor();
  return { context, page };
}
async function checkGuide(page, width) {
  const trigger = page.getByRole("button", { name: "Project creation guide", exact: true });
  const projectButton = await page.getByRole("button", { name: "New project", exact: true }).elementHandle();
  const { newProject, guide } = await trigger.evaluate((node, button) => ({
    newProject: button.getBoundingClientRect().toJSON(),
    guide: node.getBoundingClientRect().toJSON(),
  }), projectButton);
  assert.equal(guide.height, newProject.height, "Guide and New project buttons have different heights");
  assert.equal(newProject.height, width < 640 ? 44 : 36, "Project controls are not compact on desktop");
  assert(newProject.width <= 140, "New project has too much horizontal padding");
  assert.equal(await trigger.evaluate(node => getComputedStyle(node).cursor), "pointer");
  assert(guide.x > newProject.x + newProject.width && Math.abs(guide.y + guide.height / 2 - newProject.y - newProject.height / 2) <= 1, "Guide must sit beside New project");
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, `project-controls-${width}.png`) });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Project Creation Guide", exact: true });
  await dialog.waitFor();
  if (width === 1440) assert((await dialog.boundingBox()).width >= 900, "Guide is too narrow");
  assert.equal(created, width === 1440 ? 0 : 1, "Opening help must not create a project");
  for (const tab of ["SSH / VPS", "Apps", "Local", "GitHub"]) {
    await dialog.getByRole("tab", { name: tab, exact: true }).click();
    await dialog.getByRole("tabpanel", { name: tab, exact: true }).waitFor();
  }
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `Guide overflows at ${width}px`);
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, `project-guide-${width}.png`) });
  await dialog.getByRole("button", { name: "Got it", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await trigger.click();
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await trigger.evaluate(node => document.activeElement === node), true, "Closing Guide must return keyboard focus to its button");
}
async function openWizard(page) {
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const creationDialog = page.getByRole("dialog", { name: "New project", exact: true });
  await creationDialog.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
  const layout = await creationDialog.evaluate(node => {
    const modal = node.getBoundingClientRect();
    const steps = node.querySelector('nav').getBoundingClientRect();
    const form = node.querySelector('form').getBoundingClientRect();
    const footer = node.querySelector('[data-slot="dialog-footer"]').getBoundingClientRect();
    return { top: steps.top - modal.top, railHeight: steps.height, contentTop: form.top - modal.top, contentHeight: node.querySelector('form').parentElement.clientHeight, height: modal.height, footerHeight: footer.height, footerGap: modal.bottom - footer.bottom };
  });
  assert(layout.top <= 12 && layout.railHeight <= 70 && layout.contentTop <= 95, `Too much space before the form: ${JSON.stringify(layout)}`);
  // Phone buttons retain their 44px touch targets plus the compact 8px gutters.
  assert(layout.contentHeight >= layout.height - 150 && layout.footerHeight <= 64 && layout.footerGap <= 2, `Content or footer has excess spacing: ${JSON.stringify(layout)}`);
  assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Guide", exact: true }).count(), 0);
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, `project-source-${page.viewportSize().width}.png`) });
  if (page.viewportSize().width === 1440) {
    const access = creationDialog.locator("summary").filter({ hasText: "GitHub connection / private repository access" });
    await access.click();
    // Bounding boxes exist even while a disclosure clips its children. Wait for
    // the whole input to be exposed, then verify it can receive pointer input.
    await page.waitForFunction(() => {
      const input = document.querySelector("#githubPat");
      return input.closest("details").getBoundingClientRect().bottom >= input.getBoundingClientRect().bottom - .5;
    });
    await creationDialog.locator("#githubPat").click({ trial: true });
    const divider = await creationDialog.getByText("or", { exact: true }).boundingBox();
    const tokenLabel = await creationDialog.locator('label[for="githubPat"]').boundingBox();
    assert(tokenLabel.y - divider.y - divider.height >= 12, "OR divider needs breathing room before the token field");
    await page.screenshot({ animations: "disabled", path: path.join(artifacts, "project-github-access-spacing.png") });
    await access.click();
  }
  await page.getByRole("button", { name: "Local", exact: true }).click();
  await page.locator("#localSourcePath").fill("/app/local-projects/ui-fixture");
  const steps = page.getByRole("navigation", { name: "Project setup progress" });
  assert.equal(await steps.getByRole("button").count(), 4);
  await page.getByRole("button", { name: "Configure project", exact: true }).click();
  await page.locator("#name").fill("Local fixture");
  await page.locator("summary").filter({ hasText: /^Environment variables/ }).click();
  await page.getByRole("button", { name: "Add Variable", exact: true }).click();
  await page.getByPlaceholder("EMAILJS_SERVICE_ID", { exact: true }).fill("DATABASE_URL");
  await page.getByPlaceholder("value", { exact: true }).fill("private-ui-fixture-value");
  const envFiles = page.locator("summary").filter({ hasText: /^Environment variables/ }).locator("..").locator('input[type="file"][aria-label="Select env files"]');
  assert.equal(await envFiles.getAttribute("multiple"), "");
  await envFiles.setInputFiles([
    { name: ".env", mimeType: "text/plain", buffer: Buffer.from("IMPORT_ONE=first\nIMPORT_TWO=second\n") },
    { name: ".env.production", mimeType: "text/plain", buffer: Buffer.from("IMPORT_ONE=override\n") },
  ]);
  await page.getByRole("status").filter({ hasText: "Imported .env, .env.production" }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Variable 1 value", exact: true }).inputValue(), "private-ui-fixture-value", "Import must preserve manual variables");
  assert.equal(await page.getByRole("textbox", { name: "Variable 2 value", exact: true }).inputValue(), "override");
  const importedName = page.getByRole("textbox", { name: "Variable 2 name", exact: true });
  await importedName.press("End");
  await importedName.pressSequentially("_EDIT");
  assert.equal(await importedName.inputValue(), "IMPORT_ONE_EDIT", "Editing a variable name must retain input focus");
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, `project-env-files-${page.viewportSize().width}.png`) });
  await envFiles.setInputFiles({ name: "invalid.env", mimeType: "text/plain", buffer: Buffer.from("# No assignments") });
  await page.getByRole("alert").filter({ hasText: "Each selected file" }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Variable 2 value", exact: true }).inputValue(), "override", "Invalid imports must leave variables intact");
  await page.getByRole("button", { name: "Review project", exact: true }).click();
  await page.getByRole("region", { name: "Project configuration review" }).waitFor();
  assert(!(await page.getByRole("dialog").innerText()).includes("private-ui-fixture-value"));
}
try {
  const { context: desktop, page } = await context(1440);
  assert.equal(editLoads, 0, "Closed project editors must not fetch project details");
  await page.getByRole("button", { name: "Edit project", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Project Settings", exact: true });
  await editor.getByRole("button", { name: "Save Changes", exact: true }).waitFor();
  assert.equal(editLoads, 1);
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "hidden" });
  await checkGuide(page, 1440);
  const database = page.getByRole("img", { name: "PostgreSQL · Database client", exact: true });
  const mutedColor = await database.locator("svg").evaluate(node => getComputedStyle(node).color);
  await database.hover();
  await page.locator('[data-slot="tooltip-content"]').filter({ hasText: "PostgreSQL · Database client" }).waitFor();
  assert.notEqual(await database.locator("svg").evaluate(node => getComputedStyle(node).color), mutedColor, "Stack symbols must gain color on hover");
  await page.getByRole("button", { name: `Project information for ${project.name}` }).click();
  assert.equal(await page.locator('[aria-label="Application stack"] svg[data-technology]').count(), components.length);
  const files = page.getByRole("dialog").getByLabel("Docker source files");
  assert.equal(await files.locator("summary").getByText("Docker", { exact: true }).count(), 1);
  assert.equal(await files.getByText("backend/Dockerfile", { exact: true }).isVisible(), false);
  const opening = await files.evaluate(node => new Promise(resolve => {
    const frames = [node.getBoundingClientRect().height];
    const start = performance.now();
    node.querySelector("summary").click();
    function sample() {
      frames.push(node.getBoundingClientRect().height);
      if (performance.now() - start < 380) requestAnimationFrame(sample);
      else resolve(frames);
    }
    requestAnimationFrame(sample);
  }));
  assert(new Set(opening.map(value => Math.round(value * 4))).size >= 4, "Source files expand in a jump instead of an animation");
  const expansion = opening.at(-1) - opening[0];
  assert(Math.max(...opening.slice(1).map((value, index) => value - opening[index])) < expansion * .55, "Source files have an abrupt expansion step");
  await files.getByRole("list", { name: "Source files" }).waitFor({ state: "visible" });
  assert.equal(await files.getByRole("list", { name: "Source files" }).getByRole("listitem").count(), 3);
  assert.equal(await files.getByText("frontend/Dockerfile", { exact: true }).isVisible(), true);
  await files.locator("summary").click();
  await files.getByText("frontend/Dockerfile", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("dialog").evaluate(node => node.getBoundingClientRect().width > 900), true);
  assert(!(await page.getByRole("dialog").innerText()).includes("Stack labels describe"));
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, "project-stack-desktop.png") });
  await page.getByRole("heading", { name: "PostgreSQL", exact: true }).count();
  assert((await page.getByRole("dialog").innerText()).includes("Client dependency"));
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  assert((await page.getByRole("dialog").innerText()).includes("Fixture workspace"));
  await page.getByRole("button", { name: "Environments", exact: true }).click();
  assert((await page.getByRole("dialog").innerText()).includes("Repository default"));
  await page.keyboard.press("Escape");
  await page.goto(`${origin}/dashboard/deployments`);
  const row = page.getByRole("row").filter({ hasText: project.name });
  for (const name of ["Build", "Logs", "Runtime", "Metrics", "Rollback", "Delete"]) await row.getByRole("button", { name, exact: true }).waitFor();
  assert.equal(await row.getByRole("button", { name: "More", exact: true }).count(), 0);
  assert.equal(await row.getByRole("cell").last().evaluate(node => [...node.querySelectorAll('div')].some(child => child.scrollWidth > child.clientWidth + 1)), false);
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, "deployment-actions-desktop.png") });
  await page.goto(`${origin}/dashboard/projects/${project.id}`);
  const exposure = page.locator("#deployExposureMode");
  await exposure.waitFor();
  assert((await exposure.innerText()).includes("Direct Port (localhost)"));
  assert(await exposure.evaluate(node => node.getBoundingClientRect().width >= 250));
  const commit = await page.getByPlaceholder("Leave empty to build branch head").boundingBox();
  const ingress = await exposure.boundingBox();
  assert(Math.abs(commit.y - ingress.y) <= 2 && commit.x + commit.width < ingress.x,
    "Commit SHA and ingress must share the same desktop row");
  await exposure.click();
  const options = page.getByRole("listbox");
  assert.equal(await options.getByRole("option").count(), 3);
  assert((await options.innerText()).includes("Cloudflare Tunnel (HTTPS)"));
  assert.equal(await options.getByRole("option").evaluateAll(nodes => nodes.every(node => !!node.querySelector('svg') && node.scrollWidth <= node.clientWidth + 1)), true);
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, "project-exposure-desktop.png") });
  await page.keyboard.press("Escape");
  await page.goto(`${origin}/dashboard`);
  await openWizard(page);
  assert.equal(created, 0, "Review must not create a project");
  await page.getByRole("region", { name: "Detected application stack" }).getByText("Next.js", { exact: true }).waitFor();
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, "project-review-desktop.png") });
  // Implicit form submission on Review advances only to Confirm.
  await page.locator("#project-setup").evaluate(form => form.requestSubmit());
  await page.getByRole("region", { name: "Project creation confirmation" }).waitFor();
  assert.equal(created, 0, "Enter on Review must not create a project");
  assert.equal(inspected, 1, "Moving to Confirm must reuse the completed inspection");
  assert((await page.getByRole("dialog").innerText()).includes("Fixture workspace"));
  assert((await page.getByRole("dialog").innerText()).includes("DATABASE_URL"));
  assert(!(await page.getByRole("dialog").innerText()).includes("private-ui-fixture-value"));
  await page.screenshot({ animations: "disabled", path: path.join(artifacts, "project-confirmation-desktop.png") });
  // Two synchronous submits simulate an accidental double-click before React
  // has repainted the pending state; only one request may be sent.
  await page.locator("#project-setup").evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(created, 1); assert.equal(payload.source_type, "local");
  assert.equal(payload.name, "Local fixture"); assert.equal(payload.environments[0].branch, "HEAD");
  await desktop.close();
  for (const width of [375, 768, 1024]) {
    const { context: responsive, page: small } = await context(width);
    await checkGuide(small, width);
    await openWizard(small);
    await small.getByRole("button", { name: "Continue to confirmation", exact: true }).click();
    await small.getByRole("region", { name: "Project creation confirmation" }).waitFor();
    await small.getByRole("button", { name: "Create project", exact: true }).waitFor();
    assert.equal(created, 1, `Clicking Continue submitted the project at ${width}px`);
    const overflow = await small.getByRole("dialog").evaluate(node => ({ width: node.getBoundingClientRect().width, viewport: innerWidth, overflow: node.scrollWidth - node.clientWidth }));
    assert(overflow.width <= overflow.viewport && overflow.overflow <= 1, `Modal overflows at ${width}px`);
    await small.screenshot({ animations: "disabled", path: path.join(artifacts, `project-confirmation-${width}.png`) });
    await small.keyboard.press("Escape");
    await small.getByRole("button", { name: `Project information for ${project.name}` }).click();
    const infoOverflow = await small.getByRole("dialog").evaluate(node => node.scrollWidth - node.clientWidth);
    assert(infoOverflow <= 1, `Info modal overflows at ${width}px`);
    await small.keyboard.press("Escape");
    await small.goto(`${origin}/dashboard/projects/${project.id}`);
    await small.locator("#deployExposureMode").click();
    const mobileOptions = small.getByRole("listbox");
    assert.equal(await mobileOptions.getByRole("option").evaluateAll(nodes => nodes.every(node => [...node.querySelectorAll('span')].every(child => child.scrollWidth <= child.clientWidth + 1))), true, `Ingress option text clipped at ${width}px`);
    await small.keyboard.press("Escape");
    await responsive.close();
  }
  assert.equal(created, 1, "Only the explicitly confirmed project may be created");
  assert.deepEqual(errors, []);
  console.log("PROJECT_SETUP_UI_PASS: compact layout, Guide placement and keyboard focus, creation boundary, duplicate-submit guard, inspection reuse, brand SVGs, expandable files, visible deployment actions, ingress labels, 4 viewport widths");
} finally { await browser.close(); }
