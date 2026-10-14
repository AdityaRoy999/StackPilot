// Exercise the actual deployed sample without mocking its application APIs.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE || 'C:/Users/adiro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const report=JSON.parse(await readFile('tests/artifacts/github-category-qualification.json','utf8'));
const sample=report.cases.find(c=>c.category==='web');
if(!sample?.runtime_url)throw new Error('Web sample is not delivered yet');
const browser=await chromium.launch({headless:true,executablePath:process.env.STACKPILOT_BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
try {
  const context=await browser.newContext({viewport:{width:1440,height:950}});
  const page=await context.newPage();
  const result={repository:sample.repository,commit:sample.commit,url:sample.runtime_url,errors:[],requests:[]};
  page.on('pageerror',e=>result.errors.push(e.message));
  page.on('response',response=>{if(response.request().resourceType()==='fetch')result.requests.push({url:response.url(),status:response.status(),method:response.request().method()});});
  await page.goto(sample.runtime_url,{waitUntil:'networkidle'});
  result.initialText=await page.locator('body').innerText();
  const input=page.getByPlaceholder('Ajouter une nouvelle tache...');
  if(await input.count()) {
    await input.fill('StackPilot qualification task');
    await page.getByRole('button',{name:'Ajouter',exact:true}).click();
    await page.waitForTimeout(800);
    result.taskCreated=(await page.locator('body').innerText()).includes('StackPilot qualification task');
  }
  result.finalText=await page.locator('body').innerText();
  result.businessWorkflowPassed=result.taskCreated===true;
  await page.screenshot({path:'tests/artifacts/github-web-runtime.png',fullPage:true});
  await writeFile('tests/artifacts/github-web-runtime.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {await browser.close();}
