export const W=1920, H=1080, FPS=60, BPM=120, BEAT=60/BPM, BAR=4*BEAT;
export const b=n=>n*BEAT;
export const DURATION=48;
export const S={hook:[0,4.25],reveal:[3.75,10.25],pipeline:[9.75,18.25],agent:[17.75,26.25],runtime:[25.75,34.25],remote:[33.75,42.25],lockup:[41.75,48]};
export const ENERGY={hook:'high',reveal:'high',pipeline:'high',agent:'high',runtime:'high',remote:'high',lockup:'high'};
export const CUE={hook:0,ready:1,launch:2,line:3,drop:4,name:4.5,cockpit:6,brand:8,repository:10,environment:12,release:14,build:15,verify:16,deploy:17,inspect:18,context:20,repair:22,retry:24,runtime:26,logs:28,browser:30,check:32,remote:34,rdp:36,desktop:38,access:40,logo:42,control:43,cta:44,final:45};
export const WHIPS=[4,10,18,26,34,42].map(t=>[t-0.22,t+0.3]);
export const COVERS=[7,21,45];
export const LOOP=false;
