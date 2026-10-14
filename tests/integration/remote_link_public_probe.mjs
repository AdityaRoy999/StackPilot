// Public, unauthenticated entry-page probe; no pairing secrets are used or logged.
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE||'playwright');
// Cloudflared writes its structured logs to stderr.
const logs=spawnSync('docker',['logs','--tail','100','stackpilot-remote-tunnel'],{encoding:'utf8'});
const origin=(logs.stdout+logs.stderr).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];if(!origin)throw new Error('No current tunnel address');
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true});const failed=[],errors=[];
page.on('requestfailed',request=>failed.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText}));
page.on('response',response=>{if(response.status()>=400)failed.push({path:new URL(response.url()).pathname,status:response.status()});});
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(origin+'/remote',{timeout:60000});await page.waitForFunction(()=>document.body.innerText.includes('On your computer'),null,{timeout:60000});
 console.log('REMOTE_PUBLIC_ENTRY_PASS '+JSON.stringify({https:true,interactive:true,failed,errors}));
}catch(e){console.log('REMOTE_PUBLIC_ENTRY_DIAGNOSTICS '+JSON.stringify({text:await page.locator('body').innerText(),failed,errors}));throw e;}finally{await browser.close()}
