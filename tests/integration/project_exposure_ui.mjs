// Intercepted fixture APIs: no user account, runtime or actual tunnel changes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.STACKPILOT_BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
await mkdir('tests/artifacts',{recursive:true});
try {
  for(const outcome of ['ready','failed']) {
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(()=>localStorage.setItem('theme','dark'));
    const local='http://localhost:64345',publicUrl='https://project.fixture.invalid';
    const deployment={id:'exposure-fixture',project_id:'project-fixture',project_name:'Exposure fixture',status:'running',branch:'main',version:'release-fixture',created_at:'2026-10-15T00:00:00Z',image_name:'fixture-api',runtime_provider:'local_docker',runtime_exposure:'local_docker',runtime_url:local,runtime_snapshot:{provider:'local_docker',container_port:8000}};
    let state={state:'ready',runtime_url:local,runtime_exposure:'local_docker'},finishAt=0;let posts=0;
    await context.route('**/api/**',async route=>{
      const endpoint=new URL(route.request().url()).pathname.replace(/^\/api\/v1/,'');let data={},status=200;
      if(endpoint==='/auth/me')data={user:{id:'fixture',preferences:{color_mode:'dark',sidebar_collapsed:true}}};
      else if(endpoint==='/organizations')data={organizations:[]};
      else if(endpoint==='/deployments')data={deployments:[deployment]};
      else if(endpoint.endsWith('/exposure')) {
        if(route.request().method()==='POST') {
          posts++;const input=route.request().postDataJSON();
          assert.equal(input.exposure_mode,'cloudflare_tunnel');assert.equal(input.port,undefined,'Draft runtime ports must never override the running app');
          state={...state,state:'queued',request_id:'fixture-request',requested_mode:'cloudflare_tunnel'};
          finishAt=Date.now()+1400;status=202;
        } else if(finishAt && Date.now()>=finishAt) {
          state=outcome==='ready'?{...state,state:'ready',runtime_url:publicUrl,runtime_exposure:'cloudflare_tunnel'}:{...state,state:'failed',error:'Fixture network is unavailable. Retry the connection.'};finishAt=0;
        }
        data=state;
      }
      else if(endpoint.endsWith('/kubernetes/status'))data={runtime:{provider:'local_docker',deployed:true,status:'running',runtime_url:local,container_name:'fixture-container',published_ports:['8000/tcp -> 127.0.0.1:64345']}};
      else if(endpoint.endsWith('/runtime/health'))data={healthy:true,available:true,status_code:200,message:'Runtime passed its workload health contract.'};
      else if(endpoint==='/ai/sessions')data={sessions:[]};
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    });
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto((process.env.STACKPILOT_FRONTEND_URL||'http://localhost:3000')+'/dashboard/deployments');
    await page.getByRole('button',{name:'Runtime',exact:true}).click();
    const dialog=page.getByRole('dialog');await dialog.getByText('Exposure',{exact:true}).waitFor();
    const exposure=dialog.getByText('Exposure',{exact:true}).locator('..');
    assert.match(await exposure.innerText(),/Local Docker/);
    assert.equal(await dialog.getByText(/Current target:|Kubernetes service/).count(),0,'Docker must not show Kubernetes replica text');
    await dialog.getByRole('button',{name:'Cloudflare Tunnel',exact:true}).click();
    await dialog.getByRole('status').filter({hasText:'Creating your public link'}).waitFor();
    assert.match(await exposure.innerText(),/Local Docker/,'Draft choice is not the confirmed exposure');
    assert(await dialog.getByRole('button',{name:'Cloudflare Tunnel',exact:true}).isDisabled());
    assert.equal(await dialog.locator('[aria-label="Named tunnel token"]').getAttribute('type'),'password');
    if(outcome==='ready') {
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('[role="dialog"] a')).some(a=>a.href==='https://project.fixture.invalid/'),null,{timeout:5000});
      assert.match(await exposure.innerText(),/Cloudflare Tunnel/);
    } else {
      await dialog.getByRole('alert').filter({hasText:'Fixture network is unavailable'}).waitFor({timeout:5000});
      assert.match(await exposure.innerText(),/Local Docker/);
      assert(await dialog.getByRole('button',{name:'Retry connection',exact:true}).isEnabled());
    }
    assert.equal(posts,1,'Polling must not create duplicate tunnels');assert.deepEqual(errors,[]);
    await page.screenshot({path:`tests/artifacts/project-exposure-${outcome}.png`,fullPage:true});
    console.log('PASS project exposure UI: '+outcome);await context.close();
  }
}finally{await browser.close()}
