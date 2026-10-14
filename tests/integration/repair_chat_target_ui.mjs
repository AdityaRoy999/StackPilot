// All API traffic is intercepted. Never runs an actual repair or browser action.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.STACKPILOT_FRONTEND_URL||'http://localhost:3000';
const browser=await chromium.launch({headless:true,executablePath:process.env.STACKPILOT_BROWSER_EXECUTABLE});
const projects=[{id:'old-project',name:'Other running app'},{id:'repair-project',name:'Repair target'}];
const deployments=[{id:'old-deployment',project_id:'old-project',status:'running',runtime_url:'http://localhost:58181'},
  {id:'failed-deployment',project_id:'repair-project',status:'failed',runtime_url:''}];
const session={id:'repair-fixture',project_id:'repair-project',deployment_id:'failed-deployment',session_type:'sre_incident',status:'failed',title:'Repair target'};
try {
 for(const width of [1440,1920,768]) {
  const context=await browser.newContext({viewport:{width,height:950}});
  await context.addInitScript(()=>{localStorage.setItem('theme','dark');localStorage.setItem('sidebar-collapsed','true');});
  let browserRequests=0;
  await context.route('**/api/**',async route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.includes('/browser/'))browserRequests++;
   let value={};
   if(p.endsWith('/auth/me'))value={user:{id:'fixture',preferences:{sidebar_collapsed:true,color_mode:'dark',ui_theme:'studio'}}};
   else if(p.endsWith('/organizations'))value={organizations:[]};
   else if(p.endsWith('/projects'))value={projects};
   else if(p.endsWith('/deployments'))value={deployments};
   else if(p.endsWith('/ai/sessions'))value={sessions:[session]};
   else if(p.endsWith('/ai/sessions/repair-fixture'))value={session,messages:[{id:'message',role:'assistant',content:'Recovery needs a new build.'}]};
   else if(p.endsWith('/ai/settings'))value={enabled:true,model:'nvidia/nemotron-3-super-120b-a12b',provider:'nvidia'};
   else if(p.endsWith('/ai/models'))value={models:[{id:'nvidia/nemotron-3-super-120b-a12b',mode:'thinking'}]};
   await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  });
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/dashboard/ai?session_id=repair-fixture');
  await page.getByText('Recovery needs a new build.',{exact:true}).waitFor();
  const composer=page.locator('[data-chat-composer]');
  await composer.getByRole('button',{name:/Repair target/}).waitFor();
  assert.equal(await page.getByText('Live computer',{exact:true}).count(),0,'Opening a saved repair chat must not open Live App');
  assert.equal(browserRequests,0,'Saved chat must not allocate a browser tab');
  assert(!await composer.innerText().then(text=>text.includes('Other running app')),'Repair selected an unrelated running project');
  await page.getByRole('button',{name:'New Chat',exact:true}).click();
  await composer.getByRole('button',{name:/All Projects/}).waitFor();
  assert.equal(await page.getByText('Live computer',{exact:true}).count(),0);
  assert.equal(browserRequests,0);
  assert.deepEqual(errors,[]);
  await mkdir('tests/artifacts',{recursive:true});
  await page.screenshot({path:`tests/artifacts/repair-chat-target-${width}.png`});
  console.log('PASS repair context and explicit Live App at '+width);
  await context.close();
 }
} finally {await browser.close();}
