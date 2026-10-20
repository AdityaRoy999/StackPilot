// Opt-in local Chromium fixture for the actual read-only observation/assertion JS.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const input = JSON.parse(readFileSync(0, 'utf8'));
const browser = await chromium.launch({headless:true,
  ...(process.env.AI_BROWSER_EXECUTABLE ? {executablePath:process.env.AI_BROWSER_EXECUTABLE} : {})});
try {
  const page = await browser.newPage({viewport:{width:1100,height:800}});
  await page.setContent(`<!doctype html><style>body{font:16px sans-serif} h1,h2,h3{margin:8px}</style>
    <main><h1 id="module"><code>dataclasses</code> — Data Classes<a href="#module" style="visibility:hidden">PRIVATE_PERMALINK</a></h1>
    <h2 id="reference"><span aria-hidden="true">PRIVATE_ICON</span>API <em>Reference</em></h2>
    <div role="heading" aria-level="3" id="role-heading">Typed <strong>Decisions</strong></div>
    <output id="result">Build <strong>complete</strong></output>
    <p id="lead">Ada was an English <a href="#math">mathematician</a> and writer.</p>
    <p id="description">This module provides a <code>decorator</code> and functions.</p>
    <h3 id="privacy">Safe Title<span hidden>PRIVATE_HIDDEN</span><span style="opacity:0"><b>PRIVATE_OPACITY</b></span><span aria-hidden="true">PRIVATE_ARIA</span><span contenteditable="true">PRIVATE_EDITOR</span><span class="monaco-editor">PRIVATE_CODE</span><textarea>PRIVATE_TEXTAREA</textarea><input value="PRIVATE_INPUT"></h3>
    <h4 id="adjacent">Prefix<code>Code</code>Suffix</h4>
    <label for="native-task">StackPilot task</label><input id="native-task" type="checkbox" checked>
    <button id="action"><h4>Clickable heading excluded</h4></button>
    <h5 id="offscreen" style="margin-top:2000px">Offscreen <em>heading</em></h5></main>`);
  await page.evaluate(() => {
    window.__spFast={nodes:new Map(),ids:new WeakMap(),nextId:10,generation:2};
    window.__spGetOrAssignId=e=>{let id=window.__spFast.ids.get(e);if(id===undefined){id=window.__spFast.nextId++;window.__spFast.ids.set(e,id);}window.__spFast.nodes.set(id,e);return id;};
    window.fixtureMutations=[];window.fixtureClicks=0;
    new MutationObserver(events=>window.fixtureMutations.push(...events.map(e=>e.type))).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
    document.addEventListener('click',()=>window.fixtureClicks++);
  });
  const observe = (query, scope='page', generation=2) => page.evaluate(input.observation.replace('__REQUEST__',JSON.stringify({query,scope,generation,offset:0,limit:40})));
  const heading=await observe('dataclasses');
  const h1=heading.text_evidence.find(e=>e.tag==='h1');
  const check = specs => page.evaluate(input.assertion.replace('__SPECS__',JSON.stringify(specs)));
  const exact=await check([{kind:'text',element_id:h1?.id,expected:'dataclasses — Data Classes',match:'exact'}]);
  const wrongCase=await check([{kind:'text',element_id:h1?.id,expected:'dataclasses — data classes',match:'exact'}]);
  const privacy=await observe('Safe Title');
  const privateHeading=privacy.text_evidence.find(e=>e.tag==='h3');
  const privacyAssert=await check([{kind:'text',element_id:privateHeading?.id,expected:'Safe Title',match:'exact'}]);
  const reference=await observe('API Reference');
  const role=await observe('Typed Decisions');
  const output=await observe('Build complete');
  const paragraph=await observe('mathematician');
  const lead=paragraph.text_evidence.find(e=>e.tag==='p');
  const paragraphAssert=await check([{kind:'text',element_id:lead?.id,expected:'English mathematician',match:'contains'}]);
  const description=await observe('provides a decorator and functions');
  const taskId=await page.evaluate(()=>window.__spGetOrAssignId(document.getElementById('native-task')));
  const nativeName=await check([{kind:'accessible_name',element_id:taskId,expected:'StackPilot task',match:'exact'}]);
  const wrongInputText=await check([{kind:'text',element_id:taskId,expected:'StackPilot task',match:'exact'}]);
  const adjacent=await observe('PrefixCodeSuffix');
  const interactive=await observe('Clickable heading excluded');
  const viewport=await observe('Offscreen heading','viewport');
  const staleGeneration=await observe('dataclasses','page',999);
  const effects=await page.evaluate(()=>({mutations:window.fixtureMutations,clicks:window.fixtureClicks}));
  const identity=await page.evaluate(id=>window.__spFast.nodes.get(id)===document.getElementById('module'),h1?.id);
  await page.evaluate(()=>document.getElementById('module').remove());
  const detached=await check([{kind:'text',element_id:h1?.id,expected:'dataclasses — Data Classes',match:'exact'}]);
  console.log(JSON.stringify({heading,exact,wrongCase,privacy,privacyAssert,reference,role,output,paragraph,paragraphAssert,description,nativeName,wrongInputText,adjacent,
    interactive,viewport,staleGeneration,effects,identity,detached}));
} finally { await browser.close(); }
