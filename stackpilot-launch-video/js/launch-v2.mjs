import {THEME as T} from './theme.mjs';
import {spring,clamp,lerp,track,SPRING} from './engine.js';
export const SCENES=[0,4,10,18,26,34,42];
export const IMAGE_NAMES=['stack-studio-v2','dashboard','repository','configure','review','stack','environments','agent','deployments','logs','runtime','remote-settings','remote-form','rdp-viewer','browser-proof'];
const TAU=Math.PI*2;
// Camera curves have zero first and second derivatives at their end points.
const smooth=x=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10)};
const p=(t,a,b)=>smooth((t-a)/(b-a));
const enter=(t,a)=>spring(t-a,2.3,1);
const colors=[T.cyan,T.cyan,T.cyan,T.violet,T.green,T.cyan,T.cyan];
function box(c,x,y,w,h,r,fill,stroke){c.beginPath();c.roundRect(x,y,w,h,r);if(fill){c.fillStyle=fill;c.fill()}if(stroke){c.strokeStyle=stroke;c.lineWidth=1;c.stroke()}}
function text(c,s,x,y,size=72,color=T.text,weight=650,align='left',mono=false){c.font=`${weight} ${size}px ${mono?T.mono:T.font}`;c.textAlign=align;c.textBaseline='alphabetic';c.fillStyle=color;c.fillText(s,x,y)}
function type(c,s,x,y,size,t,a,color=T.text,weight=650,align='left'){
  const words=s.split(' ');c.font=`${weight} ${size}px ${T.font}`;const widths=words.map(w=>c.measureText(w).width),gap=c.measureText(' ').width;
  let xx=x;if(align==='center')xx-=(widths.reduce((a,b)=>a+b,0)+gap*(words.length-1))/2;
  words.forEach((w,i)=>{const e=enter(t,a+i*.07);if(e>0){c.save();c.beginPath();c.rect(xx-6,y-size-10,widths[i]+12,size+26);c.clip();c.globalAlpha*=clamp(e*2);text(c,w,xx,y+(1-e)*size*.85,size,color,weight);c.restore()}xx+=widths[i]+gap;});
}
function mark(c,x,y,size,color=T.text){c.save();c.translate(x,y);c.scale(size/192,size/192);c.fillStyle=color;c.beginPath();[[96,35],[114,72],[155,78],[125,107],[132,148],[96,128],[60,148],[67,107],[37,78],[78,72]].forEach(([a,b],i)=>i?c.lineTo(a,b):c.moveTo(a,b));c.closePath();c.fill();c.restore()}
function label(c,s,x,y,t,a,color=T.cyan){const e=enter(t,a);c.save();c.globalAlpha*=clamp(e);c.translate(0,(1-e)*14);c.fillStyle=color;c.fillRect(x,y-15,24,2);text(c,s,x+40,y,22,T.muted,550,'left',true);c.restore()}
function badge(c,s,x,y,t,a,color=T.cyan){const e=enter(t,a);if(!e)return;c.save();c.globalAlpha*=clamp(e);c.translate(0,(1-e)*22);c.font=`550 26px ${T.font}`;const w=c.measureText(s).width+58;box(c,x,y,w,54,27,T.surface,T.edge);c.fillStyle=color;c.beginPath();c.arc(x+23,y+27,4,0,TAU);c.fill();text(c,s,x+38,y+36,26,T.text,550);c.restore()}
function background(c,t){
  c.fillStyle=T.base;c.fillRect(0,0,1920,1080);
  const x=1260+Math.sin(t*.11)*220,y=290+Math.cos(t*.13)*130;
  const g=c.createRadialGradient(x,y,10,x,y,1200);g.addColorStop(0,T.mesh);g.addColorStop(1,T.base);c.fillStyle=g;c.fillRect(0,0,1920,1080);
  // Architectural light lines; very slow drift, no frame-changing noise.
  c.save();c.translate(960,570);c.rotate(-.22+Math.sin(t*.04)*.025);c.strokeStyle=T.edge;c.globalAlpha=.2;c.lineWidth=.7;
  for(let i=-3;i<4;i++){c.beginPath();c.roundRect(-1250,-580+i*152,2500,400,120);c.stroke()}c.restore();
}
function studio(c,img,t,x=1380,y=480,w=1040){if(!img)return;c.save();c.translate(x,y+Math.sin(t*.65)*9);c.rotate(-.025+Math.sin(t*.18)*.012);const sc=1+.025*Math.sin(t*.22);c.scale(sc,sc);c.drawImage(img,-w/2,-w/3,w,w*2/3);c.restore()}
// Screenshot plate: real pixels, optical depth, controlled crop and camera move.
function plate(c,img,x,y,w,h,{zoom=1,focus=[.5,.5],angle=0,alpha=1,depth=true}={}){
  if(!img||alpha<=0)return;c.save();c.globalAlpha*=alpha;c.translate(x+w/2,y+h/2);c.rotate(angle);
  if(depth){c.shadowColor=T.base;c.shadowBlur=50;c.shadowOffsetY=30;box(c,-w/2,-h/2,w,h,26,T.surface);c.shadowBlur=0;c.shadowOffsetY=0;box(c,-w/2+7,-h/2+14,w,h,26,T.edge);}
  c.save();c.beginPath();c.roundRect(-w/2,-h/2,w,h,26);c.clip();c.fillStyle=T.base;c.fillRect(-w/2,-h/2,w,h);
  const aspect=w/h,ia=img.width/img.height;let sw=img.width,sh=img.height;if(ia>aspect)sw=sh*aspect;else sh=sw/aspect;sw/=zoom;sh/=zoom;
  const sx=clamp(focus[0]*img.width-sw/2,0,img.width-sw),sy=clamp(focus[1]*img.height-sh/2,0,img.height-sh);
  c.drawImage(img,sx,sy,sw,sh,-w/2,-h/2,w,h);c.restore();
  const edge=c.createLinearGradient(-w/2,-h/2,w/2,h/2);edge.addColorStop(0,T.muted+'8c');edge.addColorStop(.35,T.edge);edge.addColorStop(1,T.muted+'30');box(c,-w/2,-h/2,w,h,26,null,edge);c.restore();
}
function paired(c,a,b,t,cut,opts){const q=p(t,cut-.5,cut+.65);const {x,y,w,h}=opts;
  if(q<1)plate(c,a,x-75*q,y-30*q,w,h,{...opts,alpha:1-q,angle:opts.angle-.02*q});
  if(q>0)plate(c,b,x+75*(1-q),y+35*(1-q),w,h,{...opts,alpha:q,angle:opts.angle+.015*(1-q)});
}
function pointer(c,x,y,t,a){const q=p(t,a,a+.85);c.save();c.translate(lerp(x-130,x,q),lerp(y+100,y,q));c.globalAlpha=p(t,a,a+.25)*(1-p(t,a+1.2,a+1.6));c.shadowColor=T.base;c.shadowBlur=7;c.fillStyle=T.text;c.strokeStyle=T.base;c.lineWidth=1.5;c.beginPath();c.moveTo(0,0);c.lineTo(0,29);c.lineTo(8,21);c.lineTo(15,35);c.lineTo(21,32);c.lineTo(14,19);c.lineTo(27,19);c.closePath();c.fill();c.stroke();c.restore();}
function intro(c,t,I){
  label(c,'FROM SOURCE TO RELEASE',116,133,t,-.5);
  type(c,'Your code.',116,349,128,t,-.3);type(c,'Ready for',116,506,128,t,.45);type(c,'launch.',116,663,128,t,1.0,T.cyan);
  studio(c,I['stack-studio-v2'],t,1380-40*p(t,0,4),480,1020);
  c.fillStyle=T.edge;c.fillRect(116,776,1688*p(t,.1,1.25),1);label(c,'STACKPILOT',116,852,t,2.2);
}
function brand(c,t,I){
  const q=p(t,6,8.3);studio(c,I['stack-studio-v2'],t,1420+280*q,480-40*q,900-200*q);
  type(c,'StackPilot',116,355-90*q,148,t,4.1);type(c,'Application delivery cockpit',122,442-90*q,38,t,4.5,T.muted,450);
  const e=enter(t,6.1);plate(c,I.dashboard,230+25*q,1070-570*e,1400,550,{zoom:1.11,focus:[.5,.34],angle:-.028+.023*q,alpha:e});
  badge(c,'Source → runtime',120,820,t,5.3);
}
function repository(c,t,I){
  const q=p(t,13.2,14.4);label(c,'REPOSITORIES + ENVIRONMENTS',116,124,t,10);
  c.save();c.globalAlpha*=1-q;type(c,'Your',116,362,96,t,10.15);type(c,'repository.',116,480,96,t,10.25);c.restore();
  c.save();c.globalAlpha*=q;type(c,'Your',116,362,96,t,13.1);type(c,'environment.',116,474,67,t,13.22);c.restore();
  const z=1.10+.035*p(t,10,18);paired(c,I.repository,I.review,t,13.65,{x:674,y:210,w:1140,h:704,zoom:z,focus:[.0,.34],angle:-.015+.02*p(t,10,18)});
  badge(c,'GitHub · local · SSH',116,594,t,10.5);badge(c,'Branch-aware releases',116,668,t,13.5);badge(c,'Private values stay private',116,742,t,15);
  pointer(c,1513,834,t,11.4);
}
function agent(c,t,I){
  label(c,'AI REPAIR',116,122,t,18,T.violet);type(c,'Context. Then action.',116,232,99,t,18.1);
  const q=p(t,20.5,23.4);plate(c,I.agent,140-20*q,315-30*q,1630+40*q,586+25*q,{zoom:1.55+.12*q,focus:[.51,.24],angle:-.013+.019*p(t,18,26)});
  const e=enter(t,22);c.save();c.globalAlpha*=clamp(e);c.translate(1250,590+(1-e)*90);c.shadowColor=T.base;c.shadowBlur=28;box(c,0,0,548,257,22,T.surface,T.edge);c.shadowBlur=0;
  text(c,'Inspect → repair → retry',28,53,30,T.text,650);text(c,'missing.py',28,110,30,T.muted,500,'left',true);c.strokeStyle=T.muted;c.beginPath();c.moveTo(28,100);c.lineTo(237,100);c.stroke();
  text(c,'Launch config repaired',28,163,27,T.violet,550);text(c,'Rebuilt · HTTP 200',28,212,29,T.green,650);c.restore();
  badge(c,'Repository + branch + environment',116,918,t,19.5,T.violet);
}
function operations(c,t,I){
  label(c,'RUNTIME VISIBILITY',116,122,t,26,T.green);type(c,'From logs to live checks.',116,232,94,t,26.1);
  const q=p(t,29.0,30.15);paired(c,I.logs,I.runtime,t,29.5,{x:116,y:308,w:1688,h:596,zoom:1+.08*p(t,26,34),focus:[.5,.55],angle:.01-.02*p(t,26,34)});
  badge(c,'Build output',128,918,t,26.5,T.green);badge(c,'Runtime health',430,918,t,28.5,T.green);badge(c,'Browser workflows',784,918,t,30.5,T.green);
  // Actual browser-workflow proof card, arriving as a secondary plane.
  const b=enter(t,31.0);if(b>0){plate(c,I['browser-proof'],1160,500+(1-b)*130,640,354,{zoom:1.08,focus:[.5,.44],angle:-.035,alpha:b});}
}
function remote(c,t,I){
  label(c,'REMOTE CONNECTIONS',116,122,t,34);type(c,'Your desktop. Right here.',116,232,94,t,34.1);
  paired(c,I['remote-form'],I['rdp-viewer'],t,37,{x:250,y:308,w:1420,h:602,zoom:1+.06*p(t,34,42),focus:[.5,.28],angle:-.011+.022*p(t,34,42)});
  badge(c,'Saved connections',116,926,t,34.6);badge(c,'Import .rdp',476,926,t,35.6);badge(c,'Keyboard + mouse',760,926,t,38.2);
}
function end(c,t,I){
  studio(c,I['stack-studio-v2'],t,1370,500,1020);const e=enter(t,42.2);c.save();c.globalAlpha*=clamp(e);mark(c,100,134,100);c.restore();
  type(c,'StackPilot',116,400,138,t,42.15);type(c,'Your stack.',116,527,90,t,42.65);type(c,'Your control.',116,635,90,t,43.05,T.cyan);
  c.fillStyle=T.edge;c.fillRect(116,752,850*p(t,43.4,44.6),1);type(c,'Start building with StackPilot',116,825,37,t,44,T.text,500);type(c,'github.com/AdityaRoy999/StackPilot',116,880,24,t,44.35,T.muted,450);
}
const scenes=[intro,brand,repository,agent,operations,remote,end];
export function motionSamples(t){return [4,6.1,10,13.65,18,22,26,29.5,31,34,37,42].some(a=>Math.abs(t-a)<.8)?6:1}
export function draw(c,t,assets={}){
  const I=assets.images||{};background(c,t);let index=0;for(let i=1;i<SCENES.length;i++)if(t>=SCENES[i])index=i;
  const a=SCENES[index],q=index?p(t,a-.5,a+.5):1;
  function scene(i,opacity,dy,scale){c.save();c.globalAlpha=opacity;c.translate(960,540+dy);c.scale(scale,scale);c.translate(-960,-540);scenes[i](c,t,I);c.restore()}
  // Two scenes coexist during a one-second optical push: no hard cut or speed reset.
  const next=index+1,b=SCENES[next];
  if(next<SCENES.length&&t>b-.5){const r=p(t,b-.5,b+.5);scene(index,1-r,-38*r,1+.035*r);scene(next,r,38*(1-r),.97+.03*r)}
  else if(index&&t<a+.5){scene(index-1,1-q,-38*q,1+.035*q);scene(index,q,38*(1-q),.97+.03*q)}else scene(index,1,0,1);
  const v=c.createRadialGradient(960,530,640,960,530,1220);v.addColorStop(0,T.base+'00');v.addColorStop(1,T.base+'66');c.fillStyle=v;c.fillRect(0,0,1920,1080);
  // Stable micrograin avoids the old frame-to-frame sparkle.
  c.globalAlpha=.025;c.fillStyle=T.text;for(let i=0;i<500;i++){const x=((i*127.1)%1916),y=((i*317.7)%1076);c.fillRect(x,y,1,1)}c.globalAlpha=1;
}
const pages=new WeakMap();
export function drawCaptions(c,t,words=[]){
  if(!pages.has(words)){let group=[];const list=[];words.forEach((w,i)=>{group.push(w);if(group.length===6||/[.!?]$/.test(w.text.trim())||!words[i+1]||words[i+1].startMs-w.endMs>350){list.push(group);group=[]}});pages.set(words,list)}
  const g=pages.get(words).find(g=>t*1000>=g[0].startMs&&t*1000<=g.at(-1).endMs+70);if(!g)return;
  c.font=`600 34px ${T.font}`;const widths=g.map(w=>c.measureText(w.text.trim()).width),w=widths.reduce((a,b)=>a+b,0)+(g.length-1)*11;let x=(1920-w)/2;
  box(c,x-23,981,w+46,61,20,T.base+'e8');g.forEach((word,i)=>{const active=t*1000>=word.startMs&&t*1000<word.endMs;text(c,word.text.trim(),x,1023,34,active?T.text:T.muted,600);if(active){c.fillStyle=T.cyan;c.fillRect(x,1035,widths[i],2)}x+=widths[i]+11});
}
