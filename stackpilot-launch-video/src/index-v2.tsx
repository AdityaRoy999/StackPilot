import React from 'react';
import {registerRoot,Composition,AbsoluteFill,Audio,staticFile,useCurrentFrame,useVideoConfig,delayRender,continueRender} from 'remotion';
import {draw,drawCaptions,IMAGE_NAMES} from '../js/launch-v2.mjs';
const Launch=()=>{
  const frame=useCurrentFrame();const {fps}=useVideoConfig();const ref=React.useRef<HTMLCanvasElement>(null);
  const[handle]=React.useState(()=>delayRender('Fonts and launch assets'));
  const[data,setData]=React.useState<any>(null);
  React.useEffect(()=>{let active=true;(async()=>{
    await Promise.all([new FontFace('Jakarta',`url(${staticFile('Jakarta.ttf')})`).load().then(f=>document.fonts.add(f)),new FontFace('JetBrains',`url(${staticFile('JetBrains.ttf')})`).load().then(f=>document.fonts.add(f))]);
    const next:any={images:{}};for(const name of['captions','amplitude'])try{next[name]=await fetch(staticFile(name+'.json')).then(r=>r.json())}catch{next[name]=[]}
    for(const name of IMAGE_NAMES){const img=new Image();img.src=staticFile(name==='stack-studio-v2'?name+'.png':'product-v2/'+name+'.png');await img.decode();next.images[name]=img}
    if(active){setData(next);continueRender(handle)}
  })();return()=>{active=false}},[handle]);
  React.useLayoutEffect(()=>{if(data&&ref.current){draw(ref.current.getContext('2d'),frame/fps,data);drawCaptions(ref.current.getContext('2d'),frame/fps,data.captions)}},[data,frame,fps]);
  return <AbsoluteFill><canvas ref={ref} width={1920} height={1080}/><Audio src={staticFile('master.wav')}/></AbsoluteFill>;
};
const Root=()=> <Composition id="StackPilotLaunchV2" component={Launch} width={1920} height={1080} fps={60} durationInFrames={2880}/>;
registerRoot(Root);
