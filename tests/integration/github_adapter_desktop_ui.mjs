// Drive the actual Linux desktop through StackPilot's routed noVNC viewer.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE || 'C:/Users/adiro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const healed=process.argv.includes('--healed');
const report=JSON.parse(await readFile('tests/artifacts/'+(healed?'github-real-healing.json':'github-adapter-qualification.json'),'utf8'));
const sample=healed?report:report.cases.find(c=>c.category==='desktop-python-auto');
const prefix=healed?'github-healed-desktop':'github-adapter-desktop';
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
  // Wait for real colored application pixels, not merely a connected socket.
  await page.waitForFunction(()=>{
    const c=document.querySelector('canvas'),data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    for(let i=0;i<data.length;i+=4*32)if(data[i]>150 && data[i+1]>75 && data[i+1]<200 && data[i+2]<120)return true;
    return false;
  },{},{timeout:30000});
  result.visibleCalculator=true;
  await page.screenshot({path:'tests/artifacts/'+prefix+'-before.png',fullPage:true});
  const bounds=await canvas.boundingBox();
  const dimensions=await canvas.evaluate(c=>({width:c.width,height:c.height}));
  result.framebuffer=dimensions;
  const point=(x,y)=>({x:bounds.x+x*bounds.width/dimensions.width,y:bounds.y+y*bounds.height/dimensions.height});
  const display=point(640,210);
  const clear=point(472,535); await page.mouse.click(clear.x,clear.y);
  await page.mouse.click(display.x,display.y);
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.type('12+30');
  const equal=point(696,535);
  await page.mouse.click(equal.x,equal.y);
  await page.waitForTimeout(800);
  const resultText=point(810,210);
  await page.mouse.dblclick(resultText.x,resultText.y);
  await page.keyboard.press('Control+Insert');
  try {
    await page.waitForFunction(()=>document.querySelector('#noVNC_clipboard_text')?.value.trim()==='42',{},{timeout:5000});
    result.clipboard_transport_verified=true;
  } catch { result.clipboard_transport_verified=false; }
  result.calculatorResult=await page.locator('#noVNC_clipboard_text').inputValue();
  result.businessWorkflowPassed=result.calculatorResult.trim()==='42' && result.errors.length===0;
  await page.screenshot({path:'tests/artifacts/'+prefix+'-calculator.png',fullPage:true});
  result.visualReviewRequired='Inspect the actual calculator display for 42 after the routed input sequence';
  console.log(result.businessWorkflowPassed?'DESKTOP_CALCULATOR_12_PLUS_30_EQUALS_42_PASS':'DESKTOP_VIEWER_INPUT_AND_CAPTURE_COMPLETE_CLIPBOARD_UNVERIFIED');
} catch(error) {
  await (await browser.contexts()[0].pages()[0]).screenshot({path:'tests/artifacts/'+prefix+'-failure.png',fullPage:true});
  result.failure=error.message;
  throw error;
} finally {
  await writeFile('tests/artifacts/'+prefix+'-workflow.json',JSON.stringify(result,null,2));
  await browser.close();
}
