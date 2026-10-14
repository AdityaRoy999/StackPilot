// Read-only production UI capture. All API responses are isolated demo fixtures.
// The repair outcome and log excerpt are sourced from a recorded real qualification.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const APP=path.resolve(ROOT,'..');
const OUT=path.join(ROOT,'public/product-v2');await fs.mkdir(OUT,{recursive:true});
const recorded=JSON.parse(await fs.readFile(path.join(APP,'tests/artifacts/github-real-healing.json'),'utf8'));
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const context=await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:2,colorScheme:'dark'});
await context.addInitScript(()=>{localStorage.setItem('theme','dark');localStorage.setItem('sidebar-collapsed','true');});
const date='2026-10-13T08:00:00Z',id='11111111-1111-4111-8111-111111111111';
const project={id,name:'Launch workspace',description:'Repository to verified runtime',source_type:'github',repo_url:recorded.repository,created_at:date,updated_at:date};
const deployment={id:'demo-release',project_id:id,project_name:project.name,status:recorded.platform_status,branch:recorded.branch,commit_hash:recorded.commit.slice(0,7),version:'v1.0.0',created_at:date,image_name:'stackpilot/launch:latest',runtime_provider:'local_docker',runtime_url:recorded.runtime_url,trigger_source:'ai_repair',environment_name:'production',runtime_snapshot:{provider:'local_docker',archetype:'standard_web',runtime_verification:recorded.verification,routed_verification:recorded.routed_verification},logs:recorded.log_tail};
project.latest_deployment=deployment;
// Display a concise exact excerpt of the recorded log; retain the full original in evidence.
deployment.logs=recorded.log_tail.slice(recorded.log_tail.indexOf('#13 exporting to image'),recorded.log_tail.indexOf('__STACKPILOT_LOCAL_LOG_TAIL__'))+'\n'+recorded.log_tail.slice(recorded.log_tail.indexOf('Runtime workload contract passed'));
const components=[{id:'python',name:'Python',role:'runtime',kind:'runtime',evidence:['Dockerfile','requirements.txt']},{id:'docker',name:'Docker',role:'infrastructure',kind:'configuration',evidence:['Dockerfile']},{id:'tkinter',name:'Tkinter',role:'desktop',kind:'framework',evidence:['requirements.txt']}];
const stack={status:'detected',components,manifests:[],files_scanned:3,truncated:false,method:'manifests'};
const environments=[{id:'env-prod',name:'production',branch:'main',auto_deploy:false,require_ci:true,cleanup_previous_on_success:true,runtime_type:'docker',runtime_config:{}},{id:'env-dev',name:'development',branch:'develop',auto_deploy:false,require_ci:false,runtime_type:'docker',runtime_config:{}}];
const session={id:'repair-record',title:'Inspect · repair · retry',session_type:'sre_incident',status:'healed',project_id:id,deployment_id:deployment.id,created_at:date,updated_at:date,last_model:'nvidia/nemotron-3-super-120b-a12b'};
const messages=[{id:'q',role:'user',content:'Inspect the failed deployment, repair its configuration, and rebuild.',created_at:date},{id:'a',role:'assistant',content:'### Deployment recovered\n\nThe configured entrypoint referenced `missing.py`. The application source was unchanged.\n\nThe repair updated the launch configuration, rebuilt the image, and started the runtime. The declared HTTP check returned **200**.\n\n**Project context:** main branch · production environment · repository files\n\nEnvironment variable names are available to the agent. Private values stay out of the conversation.',created_at:date}];
await context.route('**/api/**',async route=>{
  const endpoint=new URL(route.request().url()).pathname.replace(/^\/api\/v1/,'');let data={};
  if(endpoint==='/auth/me')data={user:{id:'demo-user',preferences:{sidebar_collapsed:true,ui_theme:'studio',color_mode:'dark'},github_connected:true}};
  else if(endpoint==='/organizations')data={organizations:[{id:'launch-org',name:'Launch workspace',role:'owner',is_personal:true}]};
  else if(endpoint==='/projects')data={projects:[project]};
  else if(endpoint===`/projects/${id}`)data={project};
  else if(endpoint==='/deployments'||endpoint===`/projects/${id}/deployments`)data={deployments:[deployment]};
  else if(endpoint.endsWith('/logs'))data={deployment};
  else if(endpoint.endsWith('/runtime/health'))data={available:true,healthy:recorded.verification.verified,status_code:200,runtime_url:recorded.runtime_url,message:'Declared HTTP contract passed'};
  else if(endpoint.endsWith('/kubernetes/status'))data={runtime:{deployed:true,status:'running',provider:'local_docker',container_name:'launch-workspace',ready_replicas:1,desired_replicas:1,runtime_url:recorded.runtime_url,image:deployment.image_name,logs:'Runtime workload contract passed.'}};
  else if(endpoint.endsWith('/kubernetes/events'))data={available:false,message:'Docker runtime'};
  else if(endpoint.endsWith('/environments'))data={environments};
  else if(endpoint.endsWith('/stack'))data={stack,details:{workspace:'Launch workspace',source_type:'github',repo_url:project.repo_url,execution_mode:'local',remote_runtime_type:'docker',runtime_scheme:'http',variables:3,environments:[{name:'production',branch:'main',auto_deploy:false,require_ci:true,variables:3},{name:'development',branch:'develop',auto_deploy:false,require_ci:false,variables:3}]}};
  else if(endpoint==='/projects/inspect-stack')data={stack};
  else if(endpoint==='/github/repos')data={repositories:[]};
  else if(endpoint==='/ssh/connections')data={connections:[]};
  else if(endpoint==='/rdp/connections')data={connections:[],enabled:true};
  else if(endpoint==='/ai/settings')data={enabled:true,provider:'nvidia',model:session.last_model,agent_access_mode:'full_access',color_mode:'dark'};
  else if(endpoint==='/ai/models')data={models:[{id:session.last_model,mode:'fast'}],selected_model:session.last_model};
  else if(endpoint==='/ai/sessions')data={sessions:[session]};
  else if(endpoint==='/ai/sessions/repair-record')data={session,messages};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
});
const page=await context.newPage(),shots={};page.on('pageerror',e=>console.error(e.message));
async function shoot(name,locator=page){await page.evaluate(()=>document.fonts.ready);await page.addStyleTag({content:'nextjs-portal,.tsqd-parent-container,[data-sonner-toaster]{display:none!important}'});await page.waitForTimeout(1500);await locator.screenshot({path:path.join(OUT,name+'.png'),animations:'disabled'});shots[name]={path:'public/product-v2/'+name+'.png',viewport:[1600,1000],dpr:2};console.log('Captured '+name);}
try{
  await page.goto('http://127.0.0.1:3001/dashboard',{waitUntil:'domcontentloaded',timeout:180000});await page.getByRole('link',{name:project.name,exact:true}).waitFor();await shoot('dashboard');
  await page.getByRole('button',{name:'New project',exact:true}).click();const wizard=page.getByRole('dialog',{name:'New project',exact:true});await wizard.waitFor();await page.locator('#repoUrl').click();await page.locator('#repoUrl').fill(project.repo_url);await shoot('repository',wizard);
  await page.getByRole('button',{name:'Configure project',exact:true}).click();await page.locator('#name').fill('Launch workspace');await page.locator('#initial-branch').fill('main');await shoot('configure',wizard);
  await page.locator('summary').filter({hasText:/^Environment variables/}).click();await page.getByRole('button',{name:'Add Variable',exact:true}).click();await page.getByPlaceholder('EMAILJS_SERVICE_ID',{exact:true}).fill('DATABASE_URL');await page.getByPlaceholder('value',{exact:true}).fill('demo-value');await page.getByRole('button',{name:'Review project',exact:true}).click();await page.getByRole('region',{name:'Project configuration review'}).waitFor();await shoot('review',wizard);
  await page.keyboard.press('Escape');await page.getByRole('button',{name:`Project information for ${project.name}`}).click();await page.getByRole('dialog').waitFor();await shoot('stack',page.getByRole('dialog'));await page.getByRole('button',{name:'Environments',exact:true}).click();await shoot('environments',page.getByRole('dialog'));await page.keyboard.press('Escape');
  await page.goto('http://127.0.0.1:3001/dashboard/ai?session_id=repair-record',{waitUntil:'domcontentloaded'});await page.getByText('Deployment recovered',{exact:true}).waitFor();await page.getByRole('button',{name:'Live App',exact:true}).click();await shoot('agent');
  await page.goto('http://127.0.0.1:3001/dashboard/deployments',{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'View repair',exact:true}).waitFor();await shoot('deployments');await page.getByRole('button',{name:'Logs',exact:true}).click();await page.getByRole('dialog').waitFor();await shoot('logs',page.getByRole('dialog'));await page.keyboard.press('Escape');await page.getByRole('button',{name:'Runtime',exact:true}).click();await page.getByRole('dialog').waitFor();await shoot('runtime',page.getByRole('dialog'));await page.keyboard.press('Escape');
  await page.goto('http://127.0.0.1:3001/dashboard/settings',{waitUntil:'domcontentloaded'});await page.waitForTimeout(1800);await page.getByRole('button',{name:'Remote Connections',exact:true}).click();await page.getByRole('region',{name:'Remote desktops',exact:true}).waitFor();await shoot('remote-settings');await page.getByRole('button',{name:'Add desktop',exact:true}).click();const form=page.getByRole('dialog').filter({hasText:'Add remote desktop'});await form.getByLabel('Name',{exact:true}).fill('Build desktop');await form.getByLabel('Host or IP').fill('192.168.1.50');await form.getByLabel('Windows account',{exact:true}).fill('builduser');await shoot('remote-form',form);
  await fs.writeFile(path.join(OUT,'manifest.json'),JSON.stringify({scope:'production frontend, staged demo data; no live writes',repairEvidence:'tests/artifacts/github-real-healing.json',repairSummary:'Faithful editorial reconstruction, not a captured original conversation',shots},null,2));
}finally{await browser.close()}
