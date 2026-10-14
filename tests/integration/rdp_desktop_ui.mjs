// Receives disposable fixture credentials on stdin. Never writes them to reports.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STACKPILOT_PLAYWRIGHT_MODULE || 'C:/Users/adiro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
let input = ''; for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(input);
const browser = await chromium.launch({ headless: true, executablePath: process.env.STACKPILOT_BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const evidence = { scope: 'real_xrdp_through_stackpilot_guacd_and_browser', passed: false, errors: [], responses: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, colorScheme: 'dark' });
  await context.addCookies([{ name: 'token', value: fixture.token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  page.on('pageerror', error => evidence.errors.push(error.message));
  evidence.inputInstructions = {};
  evidence.mouseFrames = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    const opcode = String(payload).match(/^\d+\.([^,;]*)/)?.[1];
    if (opcode) evidence.inputInstructions[opcode] = (evidence.inputInstructions[opcode] || 0) + 1;
    if (opcode === 'mouse' && evidence.mouseFrames.length < 6) evidence.mouseFrames.push(String(payload));
  }));
  page.on('response', response => { if (response.url().includes('/rdp/')) evidence.responses.push({path:new URL(response.url()).pathname,status:response.status()}); });
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/rdp/connections') {
      if (request.postDataJSON()?.password !== fixture.password) throw new Error('Unexpected password transmission');
      assert.equal(request.postDataJSON()?.security, 'tls');
      assert.equal(request.postDataJSON()?.keyboard_layout, 'en-us-qwerty');
      assert.equal(request.postDataJSON()?.ignore_certificate, true);
      evidence.passwordTransmissionVerified = true;
    }
  });
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await page.goto('http://localhost:3000/dashboard/remote', { waitUntil: 'networkidle' });
  assert.equal(await page.getByRole('region', { name: 'Remote desktops', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Add desktop', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Import .rdp', exact: true }).count(), 0);
  assert(await page.getByRole('button', { name: 'Connect remote device', exact: true }).isVisible());
  assert.equal(evidence.responses.length, 0, 'The Remote page must not load RDP connections');
  evidence.remotePageReservedForStackPilot = true;
  await page.goto('http://localhost:3000/dashboard/settings', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Remote Connections', exact: true }).click();
  await page.getByRole('region', { name: 'Remote desktops', exact: true }).waitFor();
  assert(await page.getByText('Server connections', { exact: true }).isVisible());
  evidence.settingsPlacement = true;
  await page.screenshot({ path: 'tests/artifacts/rdp-settings.png', animations: 'disabled' });
  const imported = Buffer.from(`full address:s:${fixture.host}:3389\r\nusername:s:rdpfixture\r\npassword 51:b:opaque-test-password\r\n`, 'utf16le');
  await page.getByLabel('Choose RDP file').setInputFiles({ name: 'Isolated RDP fixture.rdp', mimeType: 'application/x-rdp', buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), imported]) });
  const form = page.getByRole('dialog').filter({ hasText: 'Add remote desktop' });
  await form.waitFor();
  assert.equal(await form.getByLabel('Host or IP').inputValue(), fixture.host);
  assert.equal(await form.getByLabel('Password', { exact: true }).inputValue(), '');
  await form.getByLabel('Password', { exact: true }).fill(fixture.password);
  await form.getByText('Advanced', { exact: true }).click();
  await page.waitForTimeout(350);
  const formBounds = await form.boundingBox();
  assert(formBounds && formBounds.width >= 850 && formBounds.width <= 1408);
  const accountBounds = await form.getByLabel('Windows account', { exact: true }).boundingBox();
  const passwordBounds = await form.getByLabel('Password', { exact: true }).boundingBox();
  assert(accountBounds && passwordBounds && Math.abs(accountBounds.y - passwordBounds.y) <= 1);
  const security = form.getByRole('combobox', { name: 'Security', exact: true });
  assert.equal(await security.evaluate(element => element.tagName), 'BUTTON');
  await security.click();
  await page.getByRole('option', { name: 'TLS', exact: true }).waitFor();
  assert(await page.locator('[data-slot="select-content"][data-open]').isVisible());
  await page.screenshot({ path: 'tests/artifacts/rdp-security-menu.png', animations: 'disabled' });
  await page.getByRole('option', { name: 'TLS', exact: true }).click();
  assert.equal((await security.locator('[data-slot="select-value"]').textContent()).trim(), 'TLS');
  const keyboard = form.getByRole('combobox', { name: 'Remote keyboard', exact: true });
  await keyboard.click();
  await page.getByRole('option', { name: 'German', exact: true }).click();
  assert.equal((await keyboard.locator('[data-slot="select-value"]').textContent()).trim(), 'German');
  await keyboard.focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('option', { name: 'English (US)', exact: true }).waitFor();
  await page.screenshot({ path: 'tests/artifacts/rdp-keyboard-menu.png', animations: 'disabled' });
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  assert.equal((await keyboard.locator('[data-slot="select-value"]').textContent()).trim(), 'English (US)');
  await form.getByRole('checkbox', { name: 'Allow this host’s self-signed certificate', exact: true }).check();
  await page.screenshot({ path: 'tests/artifacts/rdp-connection-form.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  const narrowBounds = await form.boundingBox();
  assert(narrowBounds && narrowBounds.x >= 0 && narrowBounds.x + narrowBounds.width <= 390);
  assert(await form.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await keyboard.click();
  await page.getByRole('option', { name: 'English (US)', exact: true }).waitFor();
  const menuBounds = await page.locator('[data-slot="select-content"][data-open]').boundingBox();
  assert(menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 390);
  await page.keyboard.press('Escape');
  assert(await form.isVisible());
  await page.screenshot({ path: 'tests/artifacts/rdp-connection-form-mobile.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.waitForTimeout(350);
  evidence.widerResponsiveForm = true;
  evidence.customDropdowns = true;
  evidence.dropdownKeyboardControls = true;
  await form.getByRole('button', { name: 'Save desktop', exact: true }).click();
  await form.waitFor({ state: 'hidden' });
  const card = page.locator('article').filter({ hasText: 'Isolated RDP fixture' });
  await card.getByRole('button', { name: 'Open', exact: true }).click();
  const viewer = page.getByRole('dialog');
  await viewer.getByText(/^Connected ·/).waitFor({ timeout: 45000 });
  const display = page.locator('[data-rdp-screen]');
  let desktopReady = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      execFileSync('docker', ['exec', fixture.container, 'sh', '-c', 'for file in /proc/[0-9]*/comm; do read -r name < "$file" 2>/dev/null || continue; [ "$name" = xterm ] && exit 0; done; exit 1'], { stdio: 'ignore' });
      desktopReady = true; break;
    } catch { await page.waitForTimeout(500); }
  }
  assert(desktopReady, 'The fixture desktop did not start');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-rdp-screen] canvas')].some(canvas => {
    if (canvas.width < 300 || canvas.height < 200) return false;
    const color = canvas.getContext('2d')?.getImageData(100, 100, 1, 1).data;
    return color && color[0] > 230 && color[1] > 230 && color[2] > 230;
  }), { timeout: 20000 });
  await page.waitForTimeout(3000);
  const bounds = await display.boundingBox();
  assert(bounds && bounds.width > 600 && bounds.height > 300);
  // Click the actual xterm and type through the RDP keyboard transport.
  await page.mouse.click(bounds.x + 180, bounds.y + 110);
  await page.waitForTimeout(500);
  evidence.browserFocus = await display.evaluate(element => document.activeElement === element);
  evidence.remoteFocus = execFileSync('docker', ['exec', '-u', 'rdpfixture', fixture.container, 'env', 'DISPLAY=:10', 'xprop', '-root', '_NET_ACTIVE_WINDOW'], {encoding:'utf8'}).trim();
  await page.keyboard.type("printf 'RDP_KEYBOARD_OK\\n' > /home/rdpfixture/keyboard-evidence", { delay: 25 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  const remoteText = execFileSync('docker', ['exec', fixture.container, 'cat', '/home/rdpfixture/keyboard-evidence'], { encoding: 'utf8' }).trim();
  assert.equal(remoteText, 'RDP_KEYBOARD_OK');
  evidence.importReviewed = true; evidence.realDesktopFrame = true; evidence.keyboardAndPointer = true;
  await page.screenshot({ path: 'tests/artifacts/rdp-desktop-viewer.png', animations: 'disabled' });
  await viewer.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.evaluate(() => document.exitFullscreen());
  evidence.fullscreen = true;
  await page.setViewportSize({ width: 1100, height: 780 });
  await page.waitForTimeout(1200);
  assert(await viewer.getByText(/^Connected ·/).isVisible());
  evidence.resize = true;
  await display.focus();
  await page.keyboard.press('Escape');
  assert(await viewer.isVisible());
  await viewer.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await viewer.waitFor({ state: 'hidden' });
  await card.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('dialog').getByText(/^Connected ·/).waitFor({ timeout: 45000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
  evidence.reconnect = true; evidence.passed = true;
  assert.equal(evidence.errors.length, 0);
  console.log('RDP_DESKTOP_UI_PASS');
} catch (error) {
  evidence.failure = error.message;
  const page = browser.contexts()[0]?.pages()[0];
  if (page) { evidence.visibleAlerts = await page.getByRole('alert').allTextContents(); await page.screenshot({ path: 'tests/artifacts/rdp-desktop-failure.png' }); }
  throw error;
} finally {
  await writeFile('tests/artifacts/rdp-desktop-ui.json', JSON.stringify(evidence, null, 2));
  await browser.close();
}
