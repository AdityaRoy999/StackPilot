// Fixture APIs only: no account data or deployment mutations.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STACKPILOT_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.STACKPILOT_FRONTEND_URL || 'http://localhost:3000';
await mkdir('tests/artifacts', { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.STACKPILOT_BROWSER_EXECUTABLE });
try {
  for (const width of [375, 1440, 1920]) {
    const context = await browser.newContext({ viewport: { width, height: 950 } });
    await context.addInitScript(() => { localStorage.setItem('theme', 'dark'); localStorage.setItem('sidebar-collapsed', 'true'); });
    const deployment = { id: 'release-fixture', project_id: 'project-fixture', project_name: 'multi-agent-rag', status: 'failed', branch: 'main', commit_hash: 'bddd927', version: 'release-5bb727ef-e89a-4a64-9637-3980906c5187', created_at: '2026-10-12T17:49:55Z', image_name: 'fixture-api', environment_name: 'production', runtime_snapshot: { archetype: 'monorepo' } };
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url()).pathname;
      if (/\/(projects|deployments)(\/|$)/.test(url)) assert.equal(route.request().method(), 'GET', 'This visual test must never mutate deployments');
      let data = {};
      if (url.endsWith('/auth/me')) data = { user: { id: 'fixture', preferences: { sidebar_collapsed: true, ui_theme: 'studio', color_mode: 'dark' } } };
      else if (url.endsWith('/organizations')) data = { organizations: [] };
      else if (url.endsWith('/projects')) data = { projects: [{ id: 'project-fixture', name: 'multi-agent-rag', source_type: 'github', repo_url: 'https://github.com/example/repo', env_var_count: 21, created_at: deployment.created_at, latest_deployment: deployment }] };
      else if (url.endsWith('/deployments')) data = { deployments: [deployment] };
      else if (url.endsWith('/ai/sessions')) data = { sessions: [{ id: 'repair-fixture', deployment_id: deployment.id, session_type: 'sre_incident', status: 'failed' }] };
      else if (url.endsWith('/ai/settings')) data = { enabled: true };
      else if (url.endsWith('/stack')) data = { stack: { status: 'unknown', components: [] } };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/dashboard`, { waitUntil: 'networkidle' });
    await page.getByText('multi-agent-rag', { exact: true }).waitFor();
    assert.equal(await page.getByText(/environment variables configured|Last release/).count(), 0);
    await page.goto(`${origin}/dashboard/deployments`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'View repair', exact: true }).waitFor();
    assert.equal(await page.getByText('Monorepo', { exact: true }).count(), 0);
    const row = page.getByRole('row').filter({ has: page.getByText('multi-agent-rag', { exact: true }) });
    const buttons = row.getByRole('button');
    const positions = await buttons.evaluateAll(nodes => nodes.map(node => ({ name: node.textContent.trim(), y: node.getBoundingClientRect().y })));
    assert(positions.length >= 7, 'All deployment actions must remain available');
    assert(Math.max(...positions.map(p => p.y)) - Math.min(...positions.map(p => p.y)) <= 1, 'Deployment actions should be side by side');
    if (width >= 1280) {
      const dimensions = await page.locator('[data-slot="table-container"]').first().evaluate(node => ({ available: node.clientWidth, content: node.scrollWidth }));
      assert(dimensions.content <= dimensions.available + 1, 'All desktop actions should fit without horizontal scrolling');
    }
    assert(await row.getByText('release-5bb727ef').count(), 'Generated release IDs should be compact');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `tests/artifacts/deployment-reliability-${width}.png`, fullPage: true });
    console.log(`PASS deployment/card layout at ${width}px`);
    await context.close();
  }
} finally { await browser.close(); }
