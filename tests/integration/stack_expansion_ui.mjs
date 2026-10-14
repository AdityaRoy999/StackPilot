// Read-only fixture APIs; inspect every painted frame of stack expansion.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require=createRequire(import.meta.url);
const { chromium }=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({ headless:true, executablePath:process.env.STACKPILOT_BROWSER_EXECUTABLE });
const origin=process.env.STACKPILOT_FRONTEND_URL || 'http://localhost:3000';
const project={ id:'stack-fixture', name:'Stack expansion fixture', source_type:'github', created_at:'2026-10-13T00:00:00Z' };
const components=[
  { id:'docker', name:'Docker', role:'infrastructure', kind:'service', evidence:['compose.yaml'] },
  { id:'python', name:'Python', role:'runtime', kind:'runtime', evidence:['apps/api/Dockerfile','apps/api/pyproject.toml'] },
  { id:'nodejs', name:'Node.js', role:'runtime', kind:'runtime', evidence:['apps/web/package.json','package.json'] },
  { id:'fastapi', name:'FastAPI', role:'backend', kind:'framework', evidence:['apps/api/pyproject.toml'] },
  { id:'react', name:'React', role:'frontend', kind:'framework', evidence:['apps/web/package.json'] },
  { id:'supabase', name:'Supabase', role:'database', kind:'client', evidence:['apps/api/pyproject.toml','apps/web/package.json'] },
];
const results=[];
try {
  for(const scenario of [{width:1440,height:950},{width:1920,height:950},{width:375,height:480},
                         {width:1440,height:950,reducedMotion:'reduce'}]) {
    const context=await browser.newContext({ viewport:{width:scenario.width,height:scenario.height}, reducedMotion:scenario.reducedMotion });
    await context.addInitScript(()=>{localStorage.setItem('theme','dark');localStorage.setItem('sidebar-collapsed','true');});
    await context.route('**/api/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(/\/(projects|deployments)(\/|$)/.test(path))assert.equal(route.request().method(),'GET','Project and deployment requests must be read-only');
      let data={};
      if(path.endsWith('/auth/me'))data={user:{id:'fixture',preferences:{sidebar_collapsed:true,ui_theme:'studio',color_mode:'dark'}}};
      else if(path.endsWith('/organizations'))data={organizations:[]};
      else if(path.endsWith('/projects'))data={projects:[project]};
      else if(path.endsWith('/stack'))data={stack:{status:'detected',components},details:{environments:[]}};
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/dashboard',{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'Project information for '+project.name}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByText('Python',{exact:true}).waitFor();
    // Start after the initial popup entrance and query-loading transitions.
    await dialog.evaluate(async node=>{await Promise.all(node.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
    const trace=await dialog.evaluate(async node=>{
      const section=node.querySelector('section');
      const disclosure=node.querySelector('details[aria-label="Python source files"]');
      const frames=[];
      const initial={popup:node.getBoundingClientRect().height,disclosure:disclosure.getBoundingClientRect().height};
      const sample=label=>{
        const style=getComputedStyle(section);
        const overflow=section.scrollHeight-section.clientHeight>1;
        frames.push({label,overflow,visibleScrollbar:overflow&&style.scrollbarWidth!=='none'&&getComputedStyle(section,'::-webkit-scrollbar').display!=='none',
          popupHeight:node.getBoundingClientRect().height,scrollHeight:section.scrollHeight,clientHeight:section.clientHeight,
          disclosureHeight:disclosure.getBoundingClientRect().height,
          expansionMismatch:Math.abs((node.getBoundingClientRect().height-initial.popup)-(disclosure.getBoundingClientRect().height-initial.disclosure)),
          resizing:node.hasAttribute('data-dialog-resizing')});
      };
      for(const label of ['expand','collapse','expand-again']) {
        disclosure.querySelector('summary').click();
        const until=performance.now()+700;
        do {await new Promise(requestAnimationFrame);sample(label);} while(performance.now()<until);
      }
      sample('settled');
      return frames;
    });
    const flashes=trace.filter(frame=>frame.label!=='settled'&&frame.visibleScrollbar).length;
    results.push({...scenario,flashes,trace});
    await mkdir('tests/artifacts',{recursive:true});
    await writeFile('tests/artifacts/stack-expansion-trace.json',JSON.stringify(results,null,2));
    if(scenario.width>=1440) {
      assert.equal(flashes,0,'A transient scrollbar appeared during a fitting stack disclosure');
      assert(Math.max(...trace.map(frame=>frame.expansionMismatch))<=2,'The popup height trails its expanding source menu');
      const expansion=trace.filter(frame=>frame.label==='expand');
      assert(Math.abs(expansion.at(-1).popupHeight-expansion.at(-1).disclosureHeight-expansion[0].popupHeight+expansion[0].disclosureHeight)<=2,'Popup and disclosure did not finish together');
    }
    else {
      const settled=trace.at(-1);
      assert(settled.overflow&&settled.visibleScrollbar,'Real viewport overflow must keep its scrollbar');
      assert(await dialog.locator('section').evaluate(node=>{node.scrollTop=40;return node.scrollTop>0;}),'Overflowing stack content must remain scrollable');
    }
    assert.deepEqual(errors,[]);
    if(scenario.width===1440&&!scenario.reducedMotion)await page.screenshot({path:'tests/artifacts/stack-expansion-desktop.png'});
    if(scenario.width>=1440) {
      const sections=await dialog.evaluate(async node=>{
        const button=[...node.querySelectorAll('nav button')].find(button=>button.textContent==='Configuration');
        button.click();
        const heights=[];const until=performance.now()+400;
        do {await new Promise(requestAnimationFrame);heights.push(node.getBoundingClientRect().height);} while(performance.now()<until);
        return {heights,resizing:node.hasAttribute('data-dialog-resizing')};
      });
      if(!scenario.reducedMotion)assert(new Set(sections.heights.map(height=>Math.round(height*4))).size>=3,'Section switching lost its smooth height transition');
      assert.equal(sections.resizing,false,'Section resize did not settle');
    }
    console.log(`STACK_EXPANSION ${scenario.width}x${scenario.height} motion=${scenario.reducedMotion||'normal'} flashes=${flashes}`);
    await context.close();
  }
} finally {await browser.close();}
