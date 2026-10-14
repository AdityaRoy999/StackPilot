// Production UI with mocked connection evidence; no remote machine is touched.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE || 'C:/Users/adiro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.STACKPILOT_BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const errors=[];const evidence={scope:'mocked_saved_windows_connection_on_production_frontend',passed:false};
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>localStorage.setItem('theme','dark'));
 await page.route('**/api/**',async route=>{
  const endpoint=new URL(route.request().url()).pathname.replace(/^\/api\/v1/,'');
  let data={};
  if(endpoint==='/auth/me')data={user:{id:'fixture-user',email:'fixture@example.test',preferences:{ui_theme:'studio',color_mode:'dark'}},github_connected:false};
  if(endpoint==='/organizations')data={organizations:[{id:'fixture-org',name:'Fixture workspace',role:'owner',is_personal:true}]};
  if(endpoint==='/projects')data={projects:[]};
  if(endpoint==='/ssh/connections')data={connections:[{id:'fixture-connection',name:'windows-build-vm',connection_type:'ssh',host:'vm.example.test',port:22,username:'builduser',auth_type:'key',host_capabilities:{os_family:'windows',os:'Windows fixture',powershell:'5.1',dotnet_cli:'yes',dotnet_sdks:'none installed',node_cli:'yes',java_cli:'no',git_cli:'yes',msbuild_cli:'no',windows_worker:'not_enrolled'}}]};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('http://localhost:3000/dashboard/settings',{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'Remote Connections',exact:true}).click();
 await page.getByText('windows-build-vm',{exact:true}).waitFor();
 await page.getByText('Connect a Windows VM',{exact:true}).click();
 await page.getByText('Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0',{exact:false}).waitFor();
 assert.equal(await page.getByText('none installed',{exact:true}).isVisible(),true);
 assert.equal(await page.getByRole('button',{name:'Prepare Docker',exact:true}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'Single-node Kubernetes',exact:true}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'Terminal',exact:true}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'Probe Host',exact:true}).isEnabled(),true);
 assert.equal(await page.getByText('Docker Daemon',{exact:true}).count(),0);
 assert.equal(errors.length,0);
 await page.screenshot({path:'tests/artifacts/windows-connection-settings.png',fullPage:true,animations:'disabled'});
 evidence.passed=true;evidence.persistentEvidenceDisplayed=true;evidence.pendingEnrollmentExplained=true;
 console.log('WINDOWS_CONNECTION_SETTINGS_UI_PASS');
} finally {
 evidence.errors=errors;await writeFile('tests/artifacts/windows-connection-ui.json',JSON.stringify(evidence,null,2));await browser.close();
}
