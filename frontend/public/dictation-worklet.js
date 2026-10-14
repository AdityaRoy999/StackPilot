// PCM capture only. Recognition and vocabulary run in StackPilot's speech service.
class DictationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples=new Int16Array(4096);
    this.used=0;
    this.port.onmessage=event=>{if(event.data==='flush'){this.flush();this.port.postMessage({flushed:true});}};
  }
  flush() {
    if(!this.used)return;
    const pcm=this.samples.slice(0,this.used);
    this.port.postMessage({pcm:pcm.buffer},[pcm.buffer]);
    this.used=0;
  }
  process(inputs) {
    const channel=inputs[0]?.[0];
    if(channel)for(const value of channel) {
      const clamped=Math.max(-1,Math.min(1,value));
      this.samples[this.used++]=Math.round(clamped*(clamped<0?32768:32767));
      if(this.used===this.samples.length)this.flush();
    }
    return true;
  }
}
registerProcessor('stackpilot-dictation',DictationProcessor);
