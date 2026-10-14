import api from './api';

interface Reply { session_id:string; text:string; final:boolean; sequence:number }
interface Payload { action:'start'|'audio'|'stop'|'cancel'; session_id?:string; sample_rate?:number; sequence?:number; pcm?:string }
type Transport=(body:Payload)=>Promise<Reply>;
const transport:Transport=async body=>(await api.post<Reply>('/ai/dictation',body,{timeout:12000})).data;

export function dictationText(base:string,speech:string) {
  return [base.trimEnd(),speech.trim()].filter(Boolean).join(' ');
}

function errorMessage(error:unknown) {
  const value=error as {name?:string;response?:{data?:{error?:string}}};
  if(value.name==='NotAllowedError')return 'Allow microphone access in your browser to use dictation.';
  if(value.name==='NotFoundError')return 'No microphone was found. Connect one and try again.';
  return value.response?.data?.error || 'Dictation could not connect. Check your connection and try the microphone again.';
}

/** Live text only: no MediaRecorder, audio attachment, or persisted recording. */
export class Dictation {
  private session='';
  private sequence=0;
  private context:AudioContext|null=null;
  private stream:MediaStream|null=null;
  private node:AudioWorkletNode|null=null;
  private chunks:Uint8Array[]=[];
  private timer:ReturnType<typeof setInterval>|null=null;
  private inFlight:Promise<void>|null=null;
  private finishing:Promise<void>|null=null;
  private cancelled=false;
  private stopping=false;
  private flushAck:(()=>void)|null=null;
  constructor(private callbacks:{text:(text:string)=>void;active:(active:boolean)=>void;error:(message:string)=>void},private request:Transport=transport) {}

  async start() {
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia||!window.AudioWorkletNode) {
      this.callbacks.error('Dictation needs HTTPS or localhost and a browser with microphone support.');
      return false;
    }
    try {
      // Create/resume inside the microphone click before any network await.
      this.context=new AudioContext({sampleRate:16000});
      const resumed=this.context.resume();
      this.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});
      if(this.cancelled||this.stopping){this.release();return false;}
      for(const track of this.stream.getTracks())track.onended=()=>{if(!this.cancelled&&!this.stopping)this.fail(new Error('Microphone disconnected'));};
      await resumed;
      const response=await this.request({action:'start',sample_rate:this.context.sampleRate});
      this.session=response.session_id;
      if(this.cancelled||this.stopping){this.cancel();return false;}
      await this.context.audioWorklet.addModule('/dictation-worklet.js');
      if(this.cancelled||this.stopping){this.cancel();return false;}
      this.node=new AudioWorkletNode(this.context,'stackpilot-dictation');
      this.node.port.onmessage=event=>{
        if(this.cancelled)return;
        if(event.data.pcm) {
          this.chunks.push(new Uint8Array(event.data.pcm));
          if(this.chunks.reduce((sum,chunk)=>sum+chunk.length,0)>this.context!.sampleRate*4)
            this.fail(new Error('Dictation connection is too slow'));
        }
        if(event.data.flushed)this.flushAck?.();
      };
      const mute=this.context.createGain();mute.gain.value=0;
      this.context.createMediaStreamSource(this.stream).connect(this.node);
      this.node.connect(mute).connect(this.context.destination);
      this.callbacks.active(true);
      this.timer=setInterval(()=>{void this.flush().catch(error=>this.fail(error));},200);
      return true;
    } catch(error) {if(!this.cancelled)this.fail(error);return false;}
  }

  private async flush() {
    if(this.inFlight){await this.inFlight;return;}
    if(this.cancelled||!this.session||!this.chunks.length)return;
    const chunks:Uint8Array[]=[];let bytes=0;
    while(this.chunks.length&&bytes+this.chunks[0].length<=60000){const chunk=this.chunks.shift()!;chunks.push(chunk);bytes+=chunk.length;}
    const pcm=new Uint8Array(bytes);let offset=0;
    for(const chunk of chunks){pcm.set(chunk,offset);offset+=chunk.length;}
    const body:Payload={action:'audio',session_id:this.session,sequence:this.sequence,pcm:btoa(String.fromCharCode(...pcm))};
    const operation=(async()=>{
      let response:Reply;
      try {response=await this.request(body);}
      catch(error) {
        if(this.cancelled||typeof (error as {response?:unknown}).response!=='undefined')throw error;
        // Reuse the same sequence: the service returns its cached acknowledgement.
        response=await this.request(body);
      }
      if(this.cancelled)return;
      this.sequence=response.sequence;
      this.callbacks.text(response.text);
    })();
    this.inFlight=operation;
    try {await operation;} finally {if(this.inFlight===operation)this.inFlight=null;}
  }

  stop():Promise<void> {
    if(this.finishing)return this.finishing;
    this.stopping=true;
    if(!this.session){this.cancel();return Promise.resolve();}
    this.finishing=(async()=>{
      if(this.timer)clearInterval(this.timer);this.timer=null;
      if(this.node)await new Promise<void>(resolve=>{
        const timeout=setTimeout(resolve,150);
        this.flushAck=()=>{clearTimeout(timeout);resolve();};
        this.node!.port.postMessage('flush');
      });
      this.release();
      if(this.inFlight)await this.inFlight;
      while(this.chunks.length&&!this.cancelled)await this.flush();
      if(this.cancelled)return;
      const response=await this.request({action:'stop',session_id:this.session});
      this.callbacks.text(response.text);
      this.session='';
    })().catch(error=>{if(!this.cancelled)this.fail(error);});
    return this.finishing;
  }

  cancel() {
    this.cancelled=true;this.release();this.chunks=[];
    if(this.session){void this.request({action:'cancel',session_id:this.session}).catch(()=>{});this.session='';}
  }
  private fail(error:unknown) {this.cancel();this.callbacks.error(errorMessage(error));}
  private release() {
    if(this.timer)clearInterval(this.timer);this.timer=null;
    if(this.node){this.node.port.onmessage=null;this.node.disconnect();this.node=null;}
    this.stream?.getTracks().forEach(track=>{track.onended=null;track.stop();});this.stream=null;
    void this.context?.close().catch(()=>{});this.context=null;
    this.callbacks.active(false);
  }
}
