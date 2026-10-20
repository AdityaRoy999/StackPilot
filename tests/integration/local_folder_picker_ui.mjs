// Uses a disposable account supplied over stdin and the real local-folder API.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE||'playwright');
let input='';for await(const chunk of process.stdin)input+=chunk;
const fixture=JSON.parse(input);
const browser=await chromium.launch({headless:true,executablePath:process.env.STACKPILOT_BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies([{name:'token',value:fixture.token,url:'http://localhost:3000',httpOnly:true,sameSite:'Lax'}]);
  await context.addInitScript(()=>localStorage.setItem('theme','dark'));
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://localhost:3000/dashboard');
  await page.getByRole('button',{name:'New project',exact:true}).first().click();
  const creation=page.getByRole('dialog',{name:'New project',exact:true});
  await creation.getByRole('button',{name:'Local',exact:true}).click();
  await creation.getByRole('button',{name:'Browse',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'Browse local projects',exact:true});
  await picker.getByRole('button',{name:fixture.drive,exact:true}).waitFor();
  assert.equal(await picker.getByRole('button',{name:'Use this folder',exact:true}).isEnabled(),false);
  await picker.getByRole('button',{name:fixture.drive,exact:true}).click();
  await page.waitForFunction(()=>/^[A-Z]:\\$/.test(document.querySelector('[aria-label="Folder path"]')?.value||''));
  await picker.getByRole('button',{name:'Parent folder',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Folder path"]')?.value==='');
  await picker.getByRole('textbox',{name:'Folder path'}).fill(fixture.parent);
  await picker.getByRole('button',{name:'Go',exact:true}).click();
  await picker.getByRole('button',{name:new RegExp(fixture.name+'\\s*Folder$')}).click();
  await page.waitForFunction(path=>document.querySelector('[aria-label="Folder path"]')?.value===path,fixture.path);
  await mkdir('tests/artifacts',{recursive:true});
  await page.screenshot({path:'tests/artifacts/local-folder-picker.png',fullPage:true});
  await picker.getByRole('button',{name:'Use this folder',exact:true}).click();
  assert.equal(await creation.locator('#localSourcePath').inputValue(),fixture.path);
  assert.deepEqual(errors,[]);
  console.log('PASS real folder picker: drive navigation, parent navigation, typed paths, external project selection');
}finally{await browser.close();}
