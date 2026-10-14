// Opt-in scoring journey against an explicitly selected TalentMatch runtime.
// Uses fictional data only; no StackPilot control-plane actions or credentials.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE||'playwright');
const target=process.env.STACKPILOT_RUNTIME_URL;
assert(target,'Set STACKPILOT_RUNTIME_URL to the selected TalentMatch release');
const lines=['Alex Example - Software Engineer','Skills: Python, FastAPI, Docker, SQL, Git',
 'Experience: Three years building APIs and automated tests','Education: Bachelor of Computer Science',
 'Projects: Containerized API with CI tests'];
const stream='BT /F1 11 Tf 50 750 Td '+lines.map((line,i)=>(i?'0 -18 Td ':'')+'('+line+') Tj').join('\n')+' ET';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
 '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
let pdf='%PDF-1.4\n';const offsets=[0];
for(const [i,object] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;}
const start=Buffer.byteLength(pdf);
pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
const browser=await chromium.launch({headless:true,executablePath:process.env.STACKPILOT_BROWSER_EXECUTABLE});
try {
 const page=await browser.newPage({viewport:{width:1440,height:950}});page.setDefaultTimeout(30000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(target);
 await page.locator('input[type=file]').setInputFiles({name:'sample-resume.pdf',mimeType:'application/pdf',buffer:Buffer.from(pdf)});
 await page.locator('textarea').fill('Software engineer with Python, FastAPI, SQL, Docker and Git experience. Build web APIs and automated tests.');
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/score' && r.request().method()==='POST');
 await page.getByRole('button',{name:'Analyze Match',exact:true}).click();
 const scored=await response;assert.equal(scored.status(),200);
 const result=await scored.json();assert.equal(typeof result.overall_score,'number');
 assert(result.overall_score>=0 && result.overall_score<=100);
 await page.waitForFunction(expected=>document.querySelector('#scoreValue')?.textContent===expected,Math.round(result.overall_score)+'%');
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('#resultsSection')).opacity==='1');
 assert.deepEqual(errors,[]);
 await mkdir('tests/artifacts',{recursive:true});
 await page.screenshot({path:'tests/artifacts/talentmatch-recovery-score.png',fullPage:true});
 console.log(JSON.stringify({pdf_workflow:'passed',status:scored.status(),score:result.overall_score,console_errors:errors}));
} finally {await browser.close();}
