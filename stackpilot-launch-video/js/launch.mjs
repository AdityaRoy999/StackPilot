import {COPY} from './copy.mjs';
import {THEME as T} from './theme.mjs';
import {FPS} from './timeline.mjs';
import {spring,SPRING,clamp,ease,P} from './engine.js';
const tau=Math.PI*2;
export const SCENES=[0,4,10,18,26,34,42];
const random=i=>{const v=Math.sin(i*127.1+311.7)*43758.5453;return v-Math.floor(v)};
function rect(c,x,y,w,h,r=0,fill=T.surface,stroke){c.beginPath();c.roundRect(x,y,w,h,r);if(fill){c.fillStyle=fill;c.fill()}if(stroke){c.strokeStyle=stroke;c.lineWidth=1.5;c.stroke()}}
function text(c,s,x,y,size=80,color=T.text,weight=700,align='left',mono=false){c.font=`${weight} ${size}px ${mono?T.mono:T.font}`;c.textAlign=align;c.textBaseline='alphabetic';c.fillStyle=color;c.fillText(s,x,y)}
function reveal(c,s,x,y,size,t,at,color=T.text,align='left'){const p=spring(t-at,...SPRING.heavy);c.save();c.beginPath();c.rect(0,y-size-24,1920,size+42);c.clip();c.globalAlpha=clamp(p*1.8);text(c,s,x,y+(1-p)*(size+36),size,color,750,align);c.restore()}
function rule(c,t,at,y,color=T.text){const p=P(t,at,at+0.6,ease.outExpo);c.fillStyle=color;c.fillRect(144,y,1632*p,2)}
function mark(c,x,y,size,color=T.text){c.save();c.translate(x,y);c.scale(size/192,size/192);c.fillStyle=color;c.beginPath();[[96,35],[114,72],[155,78],[125,107],[132,148],[96,128],[60,148],[67,107],[37,78],[78,72]].forEach(([a,b],i)=>i?c.lineTo(a,b):c.moveTo(a,b));c.closePath();c.fill();c.restore()}
function orb(c,t,x,y,r,color,amp=0){
  c.save();c.translate(x,y);r*=1+clamp(amp*2.3,0,0.18)+Math.sin(t*1.4)*0.008;
  let glow=c.createRadialGradient(0,0,r*.8,0,0,r*1.55);glow.addColorStop(0,color+'16');glow.addColorStop(1,color+'00');c.fillStyle=glow;c.beginPath();c.arc(0,0,r*1.55,0,tau);c.fill();
  let g=c.createRadialGradient(-r*.34,-r*.4,0,0,0,r);g.addColorStop(0,color+'b0');g.addColorStop(.58,color+'43');g.addColorStop(1,T.base);c.fillStyle=g;c.beginPath();c.arc(0,0,r,0,tau);c.fill();
  c.save();c.beginPath();c.arc(0,0,r-1,0,tau);c.clip();
  const turn=t*.27,tilt=.52+Math.sin(t*.21)*.14;
  for(let i=0;i<1250;i++){
    let ny=1-(i+.5)/625,rr=Math.sqrt(1-ny*ny),a=i*2.399963229728653;
    let nx=rr*Math.cos(a+turn),nz=rr*Math.sin(a+turn);
    let yy=ny*Math.cos(tilt)-nz*Math.sin(tilt),zz=ny*Math.sin(tilt)+nz*Math.cos(tilt);
    if(zz<-.14)continue;c.globalAlpha=(.12+.82*Math.max(0,zz))*(.65+.35*Math.sin(i*.55+t));
    c.fillStyle=i%17===0?T.text:color;c.beginPath();c.arc(nx*r,yy*r,1+1.5*Math.max(0,zz),0,tau);c.fill();
  }
  c.globalAlpha=.15;c.strokeStyle=color;c.lineWidth=1;
  for(let k=0;k<12;k++){c.beginPath();c.ellipse(0,0,r*Math.max(.06,Math.abs(Math.sin(k*Math.PI/12+turn))),r,tilt,0,tau);c.stroke()}
  c.restore();c.globalAlpha=.4;c.strokeStyle=color;c.lineWidth=1.25;c.beginPath();c.arc(0,0,r,0,tau);c.stroke();c.restore();
}
function chip(c,s,x,y,t,at,color=T.muted,w=310){const p=spring(t-at,...SPRING.base);if(p<=0)return;c.save();c.globalAlpha=clamp(p);c.translate(0,(1-p)*28);rect(c,x,y,w,54,27,T.surface,T.edge);text(c,s,x+24,y+35,26,color,500,'left',true);c.restore()}
function frame(c,img,x,y,w,h,t,at){if(!img)return;const p=spring(t-at,...SPRING.base);if(p<=0)return;c.save();c.translate(x+w/2,y+h/2+(1-p)*70);c.scale(.94+.06*p+(t-at)*.002,.94+.06*p+(t-at)*.002);c.globalAlpha=clamp(p);rect(c,-w/2,-h/2,w,h,20,T.surface,T.edge);c.save();c.beginPath();c.roundRect(-w/2,-h/2,w,h,20);c.clip();c.drawImage(img,-w/2,-h/2,w,h);c.restore();c.restore()}
function background(c,t){c.fillStyle=T.base;c.fillRect(0,0,1920,1080);let g=c.createRadialGradient(1420+Math.sin(t*.13)*180,370+Math.cos(t*.17)*100,30,1400,400,970);g.addColorStop(0,T.mesh);g.addColorStop(1,T.base);c.fillStyle=g;c.fillRect(0,0,1920,1080);c.globalAlpha=.25;c.fillStyle=T.edge;for(let x=40;x<1920;x+=72)for(let y=36;y<1080;y+=72){c.beginPath();c.arc(x,y,.75,0,tau);c.fill()}c.globalAlpha=1}
const captionPages=new WeakMap();
function captions(c,t,words,color){
  if(!captionPages.has(words)){const pages=[];let part=[];words.forEach((w,i)=>{part.push(w);if(part.length===6||/[.!?]$/.test(w.text.trim())||!words[i+1]||words[i+1].startMs-w.endMs>350){pages.push(part);part=[]}});captionPages.set(words,pages)}
  const group=captionPages.get(words).find(g=>t*1000>=g[0].startMs&&t*1000<=g.at(-1).endMs+100);if(!group)return;
  c.font=`500 44px ${T.font}`;const widths=group.map(w=>c.measureText(w.text.trim()).width),total=widths.reduce((v,n)=>v+n,0)+(group.length-1)*14;let x=(1920-total)/2;
  rect(c,x-30,954,total+60,80,20,T.base+'e8',T.edge);
  group.forEach((w,i)=>{const active=t*1000>=w.startMs&&t*1000<w.endMs;text(c,w.text.trim(),x,1010,44,active?color:T.muted,active?700:500);x+=widths[i]+14});
}
function hook(c,t,amp){reveal(c,COPY.hook[0],144,365,146,t,-.08);reveal(c,'Ready for',144,552,146,t,.65);reveal(c,'launch.',144,735,146,t,1.25,T.cyan);orb(c,t,1435,493,250,T.cyan,amp);rule(c,t,.25,843);chip(c,'REPOSITORY → RELEASE',144,891,t,2.5,T.muted,420)}
function revealBrand(c,t,amp){orb(c,t,960,343,165,T.cyan,amp);reveal(c,'StackPilot',960,705,180,t,4.2,T.text,'center');reveal(c,COPY.tagline,960,808,46,t,5,T.muted,'center');rule(c,t,5.75,874,T.edge);chip(c,'Built around your workflow',724,899,t,7,T.muted,472)}
function pipeline(c,t,amp){
  reveal(c,t<14?'Connect your repository.':'Build. Verify. Deploy.',144,251,t<14?102:116,t,t<14?10:14,T.text);
  for(let i=0;i<3;i++){
    const at=10.5+i*.5,p=spring(t-at,...SPRING.base),x=144+i*562;
    if(p<=0)continue;c.save();c.globalAlpha=clamp(p);c.translate(0,(1-p)*60);rect(c,x,380,504,285,30,T.surface,T.edge);
    if(i===0){text(c,'</>',x+38,460,45,T.muted,500,'left',true);text(c,'Your source',x+38,614,26,T.muted,450)}
    else if(i===1){text(c,'{ }',x+38,460,45,T.muted,500,'left',true);text(c,'Your environment',x+38,614,26,T.muted,450)}
    else{orb(c,t,x+434,427,30,T.cyan,amp);text(c,'Verified workflow',x+38,614,26,T.muted,450)}
    text(c,COPY.pipeline[i],x+38,550,45,T.text,650);c.restore();
    if(i<2){const q=P(t,11.5+i*.5,12+i*.5,ease.outExpo);c.strokeStyle=T.edge;c.lineWidth=2;c.beginPath();c.moveTo(x+512,523);c.lineTo(x+512+42*q,523);c.stroke()}
  }
  const active=clamp(Math.floor(t-15),0,2);COPY.flow.forEach((s,i)=>chip(c,s,144+i*250,740,t,14.5+i*.5,i===active?T.cyan:T.muted,220));
  reveal(c,'Branch-aware. Environment-aware.',144,893,35,t,12.5,T.muted);
}
function agent(c,t,amp){orb(c,t,475,499,250,T.violet,amp);COPY.agent.forEach((s,i)=>reveal(c,s,930,335+i*157,133,t,18+i*.55,i===Math.min(2,Math.floor((t-18)/2.5))?T.violet:T.text));chip(c,'Project context',150,850,t,19,T.muted,320);chip(c,'Branches + environments',490,850,t,20,T.muted,450);chip(c,'Environment keys only',960,850,t,21,T.muted,440)}
function runtime(c,t,amp,images){reveal(c,'See what your app does.',144,240,108,t,26);frame(c,images.calculator,1030,330,744,560,t,26.4);COPY.runtime.forEach((s,i)=>reveal(c,s,144,434+i*128,i===2?61:90,t,26.5+i*.65,i===2?T.amber:T.text));reveal(c,'Actual qualified desktop workflow',1030,940,27,t,29,T.muted);orb(c,t,837,828,61,T.amber,amp)}
function remote(c,t,amp,images){reveal(c,'Remote desktops.',144,246,112,t,34);frame(c,images.rdp,144,337,1632,401,t,34.4);reveal(c,'Inside StackPilot.',144,874,91,t,36.5,T.cyan);orb(c,t,1675,876,60,T.cyan,amp)}
function lockup(c,t){const p=spring(t-42,...SPRING.heavy);c.save();c.globalAlpha=clamp(p);mark(c,870,164,180,T.text);c.restore();reveal(c,'StackPilot',960,525,167,t,42.1,T.text,'center');reveal(c,'Your stack. Your control.',960,656,64,t,42.75,T.cyan,'center');rule(c,t,43.2,746,T.edge);reveal(c,COPY.cta,960,837,43,t,43.5,T.text,'center');reveal(c,COPY.url,960,910,30,t,44,T.muted,'center')}
export function draw(c,t,assets={}){
  const {images={},captions:words=[],amplitude=[]}=assets;const amp=amplitude[Math.min(amplitude.length-1,Math.max(0,Math.floor(t*FPS)))]||0;
  background(c,t);let index=0;for(let i=1;i<SCENES.length;i++)if(t>=SCENES[i])index=i;
  const funcs=[hook,revealBrand,pipeline,agent,runtime,remote,lockup];
  function scene(i,offset=0){c.save();c.translate(offset,0);funcs[i](c,t,amp,images);c.restore()}
  const age=t-SCENES[index];if(index>0&&age<.35){const q=ease.inOutSine(clamp(age/.35));scene(index-1,-1920*q);scene(index,1920*(1-q))}else scene(index);
  const vignette=c.createRadialGradient(960,500,480,960,500,1180);vignette.addColorStop(0,T.base+'00');vignette.addColorStop(1,T.base+'78');c.fillStyle=vignette;c.fillRect(0,0,1920,1080);
  c.globalAlpha=T.grainOpacity;c.fillStyle=T.text;for(let i=0;i<650;i++){const x=random(i*3+Math.floor(t*FPS)%5)*1920,y=random(i*3+1)*1080;c.fillRect(x,y,1,1)}c.globalAlpha=1;
  captions(c,t,words,index===3?T.violet:index===4?T.amber:T.cyan);
}
