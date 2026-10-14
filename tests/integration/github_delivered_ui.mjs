// Interact with actual routed sample applications, with no network mocks.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE || 'C:/Users/adiro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const report=JSON.parse(await readFile('tests/artifacts/github-configured-qualification.json','utf8'));
const browser=await chromium.launch({headless:true,executablePath:process.env.STACKPILOT_BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const result={cases:[]};
try {
  const web=report.cases.find(c=>c.category==='web-standalone');
  const context=await browser.newContext({viewport:{width:1440,height:950}});
  const page=await context.newPage();
  const proof={category:web.category,repository:web.repository,commit:web.commit,url:web.runtime_url,errors:[]};
  page.on('pageerror',e=>proof.errors.push(e.message));
  await page.goto(web.runtime_url,{waitUntil:'networkidle'});
  const name='StackPilot qualification task';
  await page.locator('#todo-input').fill(name);
  await page.locator('#todo-input').press('Enter');
  await page.getByText(name,{exact:true}).waitFor();
  proof.create=true;
  await page.locator('.complete-btn:visible').first().check();
  proof.complete=await page.locator('.complete-btn:visible').first().isChecked();
  await page.reload({waitUntil:'networkidle'});
  proof.persist=await page.getByText(name,{exact:true}).isVisible() && await page.locator('.complete-btn:visible').first().isChecked();
  await page.screenshot({path:'tests/artifacts/github-standalone-web.png',fullPage:true});
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('.delete-todo:visible').first().click();
  await page.getByText(name,{exact:true}).waitFor({state:'detached'});
  proof.delete=true;
  proof.businessWorkflowPassed=proof.create && proof.complete && proof.persist && proof.delete && proof.errors.length===0;
  if(!proof.businessWorkflowPassed)throw new Error('Web workflow failed');
  result.cases.push(proof);
  console.log('WEB_CREATE_COMPLETE_RELOAD_DELETE_PASS');
  const desktop=report.cases.find(c=>c.category==='desktop-python-explicit');
  const desk=await context.newPage();
  await desk.goto(desktop.runtime_url,{waitUntil:'networkidle'});
  await desk.waitForFunction(()=>document.documentElement.classList.contains('noVNC_connected'),{},{timeout:30000});
  await desk.locator('canvas').waitFor({state:'visible',timeout:30000});
  await desk.waitForTimeout(1500);
  await desk.screenshot({path:'tests/artifacts/github-desktop-before.png',fullPage:true});
  result.cases.push({category:desktop.category,repository:desktop.repository,commit:desktop.commit,url:desktop.runtime_url,
    viewerConnected:true,actualInteractionPending:true});
  console.log('DESKTOP_VIEWER_CONNECTED');
  await writeFile('tests/artifacts/github-delivered-ui.json',JSON.stringify(result,null,2));
} finally {await browser.close();}
