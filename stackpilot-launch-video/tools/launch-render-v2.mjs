import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DURATION,FPS,CUE} from '../js/timeline.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright')}catch{playwright=require(process.env.STACKPILOT_PLAYWRIGHT_MODULE||'C:/Users/adiro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')}
const {chromium}=playwright;
const mode=process.argv[2]||'stills';fs.mkdirSync(path.join(ROOT,'out/v2/stills'),{recursive:true});
const server=http.createServer((req,res)=>{let file=path.resolve(ROOT,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!file.startsWith(ROOT+path.sep)){res.writeHead(403);res.end();return}if(!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end();return}const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.ttf':'font/ttf','.wav':'audio/wav','.png':'image/png','.mp4':'video/mp4'};res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';const executablePath=process.env.STACKPILOT_BROWSER_EXECUTABLE||(fs.existsSync(edge)?edge:undefined);
  browser=await chromium.launch({headless:true,executablePath});
  const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});page.on('pageerror',error=>{throw error});
  await page.goto(`http://127.0.0.1:${server.address().port}/render-v2.html`);await page.waitForFunction(()=>window.ready);
  if(mode==='stills'){
    for(const t of[.5,2.5,7,12,16,21,23.5,28,29,32,37,39,45,...[4,10,18,26,34,42].flatMap(t=>[t-.1,t+.1,t+.4])]){
      await page.evaluate(t=>window.drawFrame(t),t);await page.locator('canvas#film').screenshot({path:path.join(ROOT,`out/v2/stills/frame-${t.toFixed(2)}.png`)});
    }
    // Verify determinism by capturing the same target after a different scene.
    await page.evaluate(()=>window.drawFrame(21));const a=await page.locator('#film').screenshot();await page.evaluate(()=>window.drawFrame(7));await page.evaluate(()=>window.drawFrame(21));const b=await page.locator('#film').screenshot();if(!a.equals(b))throw new Error('Non-deterministic frame');
    console.log('Key frames and transition strips captured; determinism passed');
  }else if(mode==='render'){
    for(const f of['captions.json','amplitude.json','master.wav'])if(!fs.existsSync(path.join(ROOT,'public',f)))throw new Error('Missing final audio data: '+f);
    const video=path.join(ROOT,'out/stackpilot-launch-v2.mp4');
    const ff=spawn('ffmpeg',['-hide_banner','-nostdin','-y','-f','image2pipe','-framerate',String(FPS),'-vcodec','mjpeg','-i','pipe:0','-i',path.join(ROOT,'public/master.wav'),'-c:v','libx264','-preset','fast','-crf','16','-pix_fmt','yuv420p','-c:a','aac','-b:a','256k','-movflags','+faststart','-t',String(DURATION),video],{stdio:['pipe','ignore','pipe']});
    let log='';ff.stderr.on('data',chunk=>{log=(log+chunk).slice(-6000)});ff.stdin.on('error',()=>{});const finished=once(ff,'exit');
    for(let frame=0;frame<DURATION*FPS;frame++){
      await page.evaluate(t=>window.drawFrame(t,true),frame/FPS);const buffer=await page.locator('#film').screenshot({type:'jpeg',quality:96});if(!ff.stdin.write(buffer))await once(ff.stdin,'drain');
      if(frame%300===0)console.log(`Rendered ${Math.round(frame/(DURATION*FPS)*100)}% (${frame}/${DURATION*FPS})`);
    }
    ff.stdin.end();const[code]=await finished;if(code!==0)throw new Error('FFmpeg: '+log);
    console.log('Master written:',video);
    const web=spawn('ffmpeg',['-v','error','-nostdin','-y','-i',video,'-vf','scale=1280:720,setpts=N/(60*TB)','-r','60','-fps_mode','cfr','-frames:v',String(DURATION*FPS),'-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-b:a','192k','-movflags','+faststart',path.join(ROOT,'out/stackpilot-launch-v2-web.mp4')],{stdio:['ignore','ignore','inherit']});const [webCode]=await once(web,'exit');if(webCode)throw new Error('Web export failed');console.log('Web copy written');
  }
}finally{if(browser)await browser.close();server.close()}
