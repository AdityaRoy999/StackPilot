// Drive the actual Linux desktop through StackPilot's routed noVNC viewer.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE || 'C:/Users/adiro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const sample=JSON.parse(await readFile('tests/artifacts/github-adapter-retry-desktop-compose.json','utf8'));
const browser=await chromium.launch({headless:true,executablePath:process.env.STACKPILOT_BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const result={repository:sample.repository,commit:sample.commit,url:sample.runtime_url,errors:[],viewerConnected:false,businessWorkflowPassed:false};
try {
  const page=await browser.newPage({viewport:{width:1440,height:950}});
  page.on('pageerror',e=>result.errors.push(e.message));
  await page.goto(sample.runtime_url,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.documentElement.classList.contains('noVNC_connected'),{},{timeout:30000});
  result.viewerConnected=true;
  const canvas=page.locator('canvas');
  await canvas.waitFor({state:'visible'});
  await page.waitForFunction(()=>{const c=document.querySelector('canvas');const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let i=0;i<data.length;i+=4*24)if(data[i]>150&&data[i+1]>150&&data[i+2]>150)return true;return false;},{},{timeout:30000});
  await page.waitForTimeout(1000);
  await page.screenshot({path:'tests/artifacts/github-compose-before.png',fullPage:true});
  const bounds=await canvas.boundingBox();
  const dims=await canvas.evaluate(c=>({width:c.width,height:c.height}));
  result.framebuffer=dims;
  const before=await canvas.evaluate(c=>c.toDataURL());
  await page.mouse.click(bounds.x+120*bounds.width/dims.width,bounds.y+92*bounds.height/dims.height);
  await page.waitForFunction(old=>document.querySelector('canvas').toDataURL()!==old,before,{timeout:10000});
  await page.waitForTimeout(700);
  await page.screenshot({path:'tests/artifacts/github-compose-after.png',fullPage:true});
  result.inputDispatchedThroughViewer=true;
  result.visualFrameChanged=true;
  result.businessWorkflowPassed=false;
  result.visualReviewRequired='Inspect before/after application labels: Hello, World! to Hello, Desktop!';
  console.log('COMPOSE_VIEWER_INPUT_AND_FRAME_CHANGE_PASS');
} catch(error) {
  await (await browser.contexts()[0].pages()[0]).screenshot({path:'tests/artifacts/github-compose-failure.png',fullPage:true});
  result.failure=error.message;
  throw error;
} finally {
  await writeFile('tests/artifacts/github-compose-workflow.json',JSON.stringify(result,null,2));
  await browser.close();
}
