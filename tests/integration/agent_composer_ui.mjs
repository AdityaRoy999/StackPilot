// UI fixtures plus a real authenticated speech path using synthesized test audio.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE||'playwright');
let incoming='';for await(const chunk of process.stdin)incoming+=chunk;
const input=JSON.parse(incoming);
const origin=process.env.STACKPILOT_FRONTEND_URL||'http://localhost:3000';
const browser=await chromium.launch({headless:true,executablePath:process.env.STACKPILOT_BROWSER_EXECUTABLE,
  args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+path.resolve('tests/artifacts/dictation-fixture.wav')]});
const models=[{id:'nvidia/nemotron-mini-4b-instruct',mode:'fast'},...Array.from({length:65},(_,i)=>({id:`fixture/model-${String(i).padStart(2,'0')}`,mode:'fast'}))];
const deployment={id:'release-fixture',project_id:'project-fixture',project_name:'Composer fixture',status:'running',version:'fixture',branch:'main',created_at:'2026-10-13T00:00:00Z',image_name:'fixture'};
const results=[];
try {
  for(const width of [1440,375]) {
    const context=await browser.newContext({viewport:{width,height:950},permissions:['microphone']});
    await context.addInitScript(()=>{
      localStorage.setItem('theme','dark');localStorage.setItem('sidebar-collapsed','true');
      // The previous vendor recognizer failed with "network". It must not be used.
      window.SpeechRecognition=class{start(){throw new Error('Browser vendor speech service unavailable');}};
      window.webkitSpeechRecognition=window.SpeechRecognition;
      window.__audioAttachments=0;
      const recorder=window.MediaRecorder;
      window.MediaRecorder=class extends recorder{constructor(...args){super(...args);window.__audioAttachments++;}};
    });
    let dictationCalls=0;
    await context.route('**/api/**',async route=>{
      const endpoint=new URL(route.request().url()).pathname;
      if(endpoint.endsWith('/ai/dictation')) {
        dictationCalls++;
        const response=await route.fetch({url:'http://127.0.0.1:8090/api/v1/ai/dictation',headers:{...route.request().headers(),Authorization:'Bearer '+input.token}});
        assert.equal(response.status(),200,'Authenticated dictation request failed: '+(await response.text()));
        await route.fulfill({response});return;
      }
      if(/\/(projects|deployments)(\/|$)/.test(endpoint))assert.equal(route.request().method(),'GET');
      let data={};
      if(endpoint.endsWith('/auth/me'))data={user:{id:'fixture',preferences:{sidebar_collapsed:true,ui_theme:'studio',color_mode:'dark'}}};
      else if(endpoint.endsWith('/organizations'))data={organizations:[]};
      else if(endpoint.endsWith('/projects'))data={projects:[{id:'project-fixture',name:'Composer fixture',source_type:'github',created_at:deployment.created_at,latest_deployment:deployment}]};
      else if(endpoint.endsWith('/deployments'))data={deployments:[deployment]};
      else if(endpoint.endsWith('/ai/sessions'))data={sessions:[]};
      else if(endpoint.endsWith('/ai/settings'))data={enabled:true,provider:'nvidia',model:models[0].id,agent_access_mode:'full_access',color_mode:'dark'};
      else if(endpoint.endsWith('/ai/models'))data={models,selected_model:models[0].id};
      else if(endpoint.endsWith('/stack'))data={stack:{status:'unknown',components:[]}};
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/dashboard/ai',{waitUntil:'networkidle'});
    const composer=page.locator('[data-chat-composer]');
    await composer.waitFor();
    const picker=width<640?page.getByRole('button',{name:/Choose model:/}):page.getByRole('button',{name:/Fast \|/});
    const before=Date.now();await picker.click();
    const modal=page.getByRole('dialog',{name:'Choose a model'});await modal.waitFor();
    const openMs=Date.now()-before;
    const list=modal.getByLabel('Available models');
    assert.equal(await list.getByRole('button',{name:/^Use /}).count(),24,'Only the first page of models should mount');
    await modal.getByLabel('Search models').fill('nemotron');
    assert.equal(await list.getByRole('button',{name:/^Use /}).count(),1);
    await modal.getByLabel('Search models').fill('');
    await modal.getByRole('button',{name:'Show more models'}).click();
    assert.equal(await list.getByRole('button',{name:/^Use /}).count(),48);
    await modal.getByRole('button',{name:'Use a custom model ID'}).click();
    await modal.getByLabel('Custom model ID').fill('fixture/custom');
    await mkdir('tests/artifacts',{recursive:true});
    await page.screenshot({path:`tests/artifacts/model-picker-${width}.png`});
    assert(await modal.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Model picker must not overflow horizontally');
    await page.keyboard.press('Escape');
    const mic=composer.getByRole('button',{name:'Start dictation',exact:true}).filter({visible:true});
    assert.equal(await mic.getAttribute('title'),null,'Native button titles must be removed');
    await mic.hover();await page.getByRole('tooltip').waitFor();
    assert((await page.getByRole('tooltip').innerText()).match(/dictat/i));
    await composer.getByRole('textbox',{name:'Message StackPilot'}).fill('Please');
    await mic.click();
    const stop=composer.getByRole('button',{name:'Stop dictation',exact:true}).filter({visible:true});
    await stop.waitFor();
    assert.equal(await stop.locator('.dictation-orb').count(),1);
    assert.equal((await stop.innerText()).trim(),'','Listening uses only the orb');
    assert.equal(await stop.locator('.dictation-orb').evaluate(node=>getComputedStyle(node).filter==='none'),false);
    const text=composer.getByRole('textbox',{name:'Message StackPilot'});
    await assert.doesNotReject(async()=>{await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Message StackPilot"]').value.includes('deployment'),null,{timeout:20000});});
    assert((await text.inputValue()).startsWith('Please '));
    assert.equal(await composer.locator('audio').count(),0,'Dictation must not attach a voice message');
    assert.equal(await page.evaluate(()=>window.__audioAttachments),0,'Dictation must not create a MediaRecorder');
    await page.screenshot({path:`tests/artifacts/live-dictation-${width}.png`});
    const finalResponse=page.waitForResponse(response=>response.url().includes('/ai/dictation')&&response.request().postDataJSON()?.action==='stop');
    await stop.click();await finalResponse;
    await mic.waitFor();
    const spoken=await text.inputValue();
    assert(spoken.includes('deployment'),'Recognized words must remain in the prompt after stopping');
    assert.equal(await composer.locator('audio').count(),0);
    // Desktop target selector contains the website action; mobile exposes it in chat options.
    if(width>=640) {
      await composer.getByRole('button',{name:/All Projects/}).click();
      await page.getByRole('button',{name:/Custom Website \/ URL/}).click();
      const target=page.getByRole('dialog',{name:'Website target'});await target.waitFor();
      assert.equal(await target.getByRole('textbox',{name:'Target URL'}).count(),1);
      await page.screenshot({path:'tests/artifacts/website-target.png'});
      await page.keyboard.press('Escape');
      await page.goto(origin+'/dashboard/deployments',{waitUntil:'networkidle'});
      assert(await page.locator('main').evaluate(node=>parseFloat(getComputedStyle(node).borderTopLeftRadius)>0),'The content frame should bend smoothly below the header');
      await page.screenshot({path:'tests/artifacts/workspace-corner.png'});
      const logs=page.getByRole('button',{name:'Logs',exact:true});await logs.hover();
      await page.getByRole('tooltip').filter({hasText:'Logs'}).waitFor();
      assert.equal(await logs.getAttribute('title'),null);
    }
    assert.deepEqual(errors,[]);
    results.push({width,openMs,dictationCalls,text:spoken});
    await context.close();
  }
  await writeFile('tests/artifacts/agent-composer-qa.json',JSON.stringify(results,null,2));
  console.log('AGENT_COMPOSER_UI_PASS '+JSON.stringify(results));
}finally{await browser.close();}
