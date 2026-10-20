// Regression: restarting a quick tunnel must not preserve an obsolete QR address.
// All API calls are intercepted. No actual accounts or tunnels are changed.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.STACKPILOT_BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
let access={available:true,running:true,url:'https://first.fixture.invalid',ready:true};const actions=[];
let slowLists=true, readyAt=0;
const context=await browser.newContext({viewport:{width:1440,height:950}});
await context.addInitScript(()=>{localStorage.setItem('theme','dark');Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.__copied=value}}});});
await context.route('**/api/**',async route=>{
  const endpoint=new URL(route.request().url()).pathname.replace(/^\/api\/v1/,'');let data={};
  if(endpoint==='/auth/me')data={user:{id:'fixture',preferences:{color_mode:'dark',sidebar_collapsed:true}}};
  else if(endpoint==='/remote/access') {
    if(route.request().method()==='POST') {
      const action=route.request().postDataJSON().action;actions.push(action);
      access={...access,running:action!=='stop',url:action!=='stop'?'https://reconnected.fixture.invalid':'',ready:action==='restart'};
      if(action==='start')readyAt=Date.now()+700;
    }
    if(readyAt && Date.now()>=readyAt){access={...access,ready:true};readyAt=0;}
    data=access;
  }
  else if(endpoint==='/remote/devices'){if(slowLists)await new Promise(resolve=>setTimeout(resolve,6000));data={devices:[]};}
  else if(endpoint==='/remote/runs'){if(slowLists)await new Promise(resolve=>setTimeout(resolve,6000));data={runs:[]};}
  else if(endpoint==='/organizations')data={organizations:[]};
  else if(endpoint==='/remote/pairings')data={secret:'a'.repeat(64),expires_at:'2099-01-01T00:00:00Z'};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  const loaded=page.waitForResponse(response=>response.url().endsWith('/remote/access'));
  await page.goto((process.env.STACKPILOT_FRONTEND_URL||'http://127.0.0.1:3001')+'/dashboard/remote');
  await loaded;
  await page.getByRole('button',{name:'Connect remote device',exact:true}).click();
  await page.getByRole('dialog',{name:'Connect remote device',exact:true}).waitFor();
  await page.getByText('Connection address',{exact:true}).click();
  const address=page.getByRole('textbox',{name:'Secure host address'});
  await page.waitForFunction(()=>document.querySelector('#remote-origin')?.value==='https://first.fixture.invalid',null,{timeout:2500});
  slowLists=false;
  await page.getByRole('button',{name:'Pair a phone',exact:true}).click();
  await page.getByRole('button',{name:'Copy private pairing link'}).click();
  assert((await page.evaluate(()=>window.__copied)).startsWith('https://first.fixture.invalid/remote#pair='));
  access={...access,url:'https://second.fixture.invalid'};
  await page.waitForFunction(()=>document.querySelector('#remote-origin')?.value==='https://second.fixture.invalid',null,{timeout:12000});
  assert.equal(await page.getByRole('button',{name:'Copy private pairing link'}).count(),0,'Old QR/link must be invalidated on rotation');
  await page.getByRole('button',{name:'Pair a phone',exact:true}).click();await page.getByRole('button',{name:'Copy private pairing link'}).click();
  assert((await page.evaluate(()=>window.__copied)).startsWith('https://second.fixture.invalid/remote#pair='));
  await address.fill('https://custom.fixture.invalid');
  access={...access,url:'https://third.fixture.invalid'};
  await page.waitForTimeout(3500);
  assert.equal(await address.inputValue(),'https://custom.fixture.invalid','A custom gateway must survive managed-tunnel rotation');
  await address.fill('');
  assert.equal(await address.inputValue(),'https://third.fixture.invalid','Clearing custom input restores the current managed address');
  await page.getByRole('button',{name:'Reconnect link',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#remote-origin')?.value==='https://reconnected.fixture.invalid');
  assert.deepEqual(actions,['restart'],'Reconnect uses one serialized server action');
  await page.getByRole('button',{name:'Turn off',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#remote-origin')?.value==='');
  assert(await page.getByRole('button',{name:'Pair a phone',exact:true}).isDisabled(),'Stopped tunnel cannot issue a stale link');
  const started=Date.now();
  await page.getByRole('button',{name:'Enable remote link',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Creating secure link'}).waitFor();
  assert(await page.getByRole('button',{name:'Pair a phone',exact:true}).isDisabled(),'An assigned hostname is not ready until the public gateway responds');
  await page.getByRole('status').filter({hasText:'Remote link ready'}).waitFor({timeout:3000});
  assert(Date.now()-started<3000,'Startup must not wait for the old 30-second idle poll');
  assert(await page.getByRole('button',{name:'Pair a phone',exact:true}).isEnabled());
  assert.deepEqual(errors,[]);
  console.log('REMOTE_LINK_ROTATION_PASS: independent status, rotation, QR invalidation, custom gateway, serialized reconnect, stopped-link handling, fast readiness polling');
}finally{await browser.close()}
