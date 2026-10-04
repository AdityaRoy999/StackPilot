// Browser verification against a built website; uses an isolated Chrome profile.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const base = process.env.STACKPILOT_WEBSITE_URL || 'http://127.0.0.1:3006';
const candidates = [process.env.STACKPILOT_TEST_CHROME,
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
let executable;
for (const candidate of candidates.filter(Boolean)) {
  try { await access(candidate); executable = candidate; break; } catch { /* next candidate */ }
}
assert(executable, 'Install Chrome or set STACKPILOT_TEST_CHROME for the website smoke test');
const tempRoot = path.resolve(tmpdir());
const profile = await mkdtemp(path.join(tempRoot, 'stackpilot-website-qa-'));
const chrome = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exceptions = [];
const pending = new Map();
let serial = 0;
let sessionId;
function command(method, params = {}, targetSession = sessionId) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Page condition did not become true: ${expression}`);
}
const artifacts = path.resolve('../tests/artifacts');
try {
  let endpoint;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { endpoint = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; }
    catch { await delay(100); }
  }
  assert(endpoint, 'Isolated Chrome did not start');
  socket = new WebSocket(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.text);
    const request = pending.get(data.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error.message)); else request.resolve(data.result);
  });
  const target = await command('Target.createTarget', { url: 'about:blank' }, null);
  sessionId = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
  await command('Runtime.enable'); await command('Page.enable');
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch { /* preview is starting */ }
    await delay(100);
  }
  assert(ready, 'Website preview server did not start');
  await mkdir(artifacts, { recursive: true });
  const measurements = [];
  for (const width of [1280, 390]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 600 });
    await command('Page.navigate', { url: base });
    await until(`document.querySelector('h1')?.textContent.includes('Autonomous AI')`);
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `Home overflows at ${width}px`);
    assert(!await evaluate(`performance.getEntriesByType('resource').some(entry => entry.name.includes('preloader.mp4'))`), 'Home downloaded the removed preload video');
    for (const route of ['docs', 'contact', 'docs']) {
      await evaluate(`document.querySelector('a[href="/${route}"]').click()`);
      await until(`location.pathname === '/${route}' && !document.querySelector('h1')?.textContent.includes('Autonomous AI') && !!document.querySelector('a[href="/"]')`);
      // Wait for the lazy page to mount, rather than mistaking its fallback for completion.
      await until(`!!document.querySelector('a[title="Return to StackPilot Home"]')`);
      assert(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), `${route} overflows at ${width}px`);
      const milliseconds = await evaluate(`new Promise(resolve => {
        const started = performance.now();
        document.querySelector('a[title="Return to StackPilot Home"]').click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!document.querySelector('h1')?.textContent.includes('Autonomous AI')) throw new Error('Home was delayed');
          resolve(performance.now() - started);
        }));
      })`);
      measurements.push({ width, from: route, homePaintMs: Math.round(milliseconds * 10) / 10 });
    }
    await until(`!!document.querySelector('#setup-heading')`);
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Install card overflows');
    const screenshot = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(artifacts, `website-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    const installer = await fetch(`${base}/install.ps1`);
    assert(installer.ok && (await installer.text()).includes('ConfigureOnly'), 'Canonical installer download is missing');
  }
  assert.equal(exceptions.length, 0, `Website JavaScript exceptions: ${exceptions.join(', ')}`);
  const result = { verified: true, measurements, exceptions, note: 'Local headless Chrome, two-frame route paint check; not a cross-device performance guarantee.' };
  await writeFile(path.join(artifacts, 'website-navigation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await command('Browser.close', {}, null); } catch { /* browser may close before replying */ }
    socket.close();
  }
  for (const request of pending.values()) clearTimeout(request.timer);
  chrome.kill();
  await delay(1000);
  // Only remove the exact temporary profile created above, after checking its parent.
  if (path.dirname(profile) === tempRoot && path.basename(profile).startsWith('stackpilot-website-qa-')) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  }
}
