"""Local Kokoro narration, stable-ts forced alignment, and original soundtrack."""
import hashlib
import json
import math
import os
import re
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get('STACKPILOT_AUDIO_CACHE', Path.home()/'.cache/stackpilot-launch-audio'))
CACHE.mkdir(parents=True, exist_ok=True)
OUT = ROOT/'public'
OUT.mkdir(exist_ok=True)
PARTS = [
    (0.5, 4.0, 'Your code deserves a clearer path to launch.'),
    (4.5, 9.5, 'Meet Stack Pilot. Your application delivery cockpit.'),
    (10.5, 17.5, 'Connect your repository. Choose an environment. Build, verify, and deploy.'),
    (18.5, 25.5, 'Give your AI agent the project context to inspect failures, make repairs, and retry.'),
    (26.5, 33.5, 'See your runtime, logs, and browser checks together.'),
    (34.5, 41.5, 'Connect a remote machine. Open its desktop without leaving Stack Pilot.'),
    (42.5, 47.5, 'Your stack. Your control. Start building with Stack Pilot.'),
]
FILES = {
    'kokoro-v1.0.int8.onnx': 'ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c',
    'voices-v1.0.bin': 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
}

def download():
    for name, checksum in FILES.items():
        dest = CACHE/name
        if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest() == checksum:
            print('Cached and verified', name, flush=True)
            continue
        url = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/'+name
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, headers={'User-Agent':'StackPilot-Launch/1.0'})
                with urllib.request.urlopen(request, timeout=25) as response, dest.with_suffix('.partial').open('wb') as handle:
                    total = int(response.headers.get('Content-Length',0)); size = 0; last = 0
                    while chunk := response.read(1024*1024):
                        handle.write(chunk); size += len(chunk)
                        if size-last >= 20*1024*1024:
                            print(name, round(size/1e6), '/', round(total/1e6), 'MB', flush=True); last=size
                assert hashlib.sha256(dest.with_suffix('.partial').read_bytes()).hexdigest() == checksum, 'Model checksum mismatch'
                dest.with_suffix('.partial').replace(dest)
                print('Downloaded and verified', name, flush=True)
                break
            except Exception:
                if attempt == 2: raise
                time.sleep(1)

def narration():
    import numpy as np
    import soundfile as sf
    import onnxruntime as ort
    from kokoro_onnx import Kokoro
    options = ort.SessionOptions(); options.intra_op_num_threads = 4; options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(CACHE/'kokoro-v1.0.int8.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    kokoro = Kokoro.from_session(session, str(CACHE/'voices-v1.0.bin'))
    sr = 24000; full = np.zeros(48*sr, dtype=np.float32); segments=[]
    for i,(start,deadline,text) in enumerate(PARTS):
        clip = OUT/f'voice-{i}.wav'
        if clip.exists(): samples, rate = sf.read(clip, dtype='float32')
        else:
            samples, rate = kokoro.create(text, voice='af_heart', speed=1.04, lang='en-us')
            sf.write(clip, samples, rate)
        if len(samples)/rate > deadline-start:
            factor = (len(samples)/rate)/(deadline-start-0.1)
            adjusted = OUT/f'voice-{i}-fit.wav'
            subprocess.run(['ffmpeg','-v','error','-y','-i',str(clip),'-af',f'atempo={factor:.6f}',str(adjusted)],check=True)
            samples, rate = sf.read(adjusted,dtype='float32'); clip=adjusted
        at=round(start*sr); full[at:at+len(samples)] += samples
        segments.append({'start':start,'end':start+len(samples)/rate,'text':text,'file':clip.name})
        print('Narration', i+1, 'duration', round(len(samples)/rate,2), flush=True)
    sf.write(OUT/'voiceover.wav',full,sr)
    (OUT/'narration.json').write_text(json.dumps(segments,indent=2),encoding='utf8')

def align():
    import torch
    import stable_whisper
    torch.set_num_threads(4)
    model = stable_whisper.load_model('base.en', device='cpu', download_root=str(CACHE/'whisper'))
    captions=[]
    for segment in json.loads((OUT/'narration.json').read_text()):
        result = model.align(str(OUT/segment['file']),segment['text'],language='en',verbose=None,regroup=False,fast_mode=True)
        for group in result.to_dict()['segments']:
            for word in group['words']:
                a=round((segment['start']+word['start'])*1000); z=round((segment['start']+word['end'])*1000)
                captions.append({'text':word['word'],'startMs':a,'endMs':max(a+1,z),'timestampMs':round((a+z)/2),'confidence':word.get('probability')})
        print('Aligned:', segment['text'], flush=True)
    assert captions and all(0 <= x['startMs'] < x['endMs'] <= 48000 for x in captions)
    assert all(captions[i]['startMs'] <= captions[i+1]['startMs'] for i in range(len(captions)-1))
    (OUT/'captions.json').write_text(json.dumps(captions,indent=2),encoding='utf8')

def score():
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    sr=48000; n=48*sr; rng=np.random.default_rng(1024); left=np.zeros(n); right=np.zeros(n)
    def put(signal,at,pan=0.0):
        k=round(at*sr); a=max(0,k); j=max(0,-k); length=min(len(signal)-j,n-a)
        if length > 0:
            left[a:a+length] += signal[j:j+length]*math.sqrt((1-pan)/2)
            right[a:a+length] += signal[j:j+length]*math.sqrt((1+pan)/2)
    def tone(freq,dur,amp=0.1):
        t=np.arange(round(sr*dur))/sr
        return amp*(np.sin(2*np.pi*freq*t)+0.2*np.sin(2*np.pi*freq*2.003*t))*np.exp(-t*4/dur)*np.minimum(t/0.012,1)
    # Syncopated electro at 120 BPM in D minor. No stock or borrowed melody.
    chords=[(146.83,174.61,220),(116.54,146.83,174.61),(130.81,164.81,196),(110,130.81,164.81)]
    for bar in range(24):
        at=bar*2.0; chord=chords[(bar//2)%4]; density=0.7 if at < 4 else 1.0
        for beat in [0,0.75,1.5]:
            t=np.arange(round(0.23*sr))/sr
            kick=np.sin(2*np.pi*(49*t+9*(1-np.exp(-t*35))))*np.exp(-t*18)*0.14*density
            put(kick,at+beat)
        for beat in [0.5,1.5]:
            t=np.arange(round(0.14*sr))/sr; noise=rng.normal(0,1,len(t))
            snare=(noise-np.convolve(noise,np.ones(12)/12,'same'))*np.exp(-t*35)*0.027*density
            put(snare,at+beat)
        for tick in range(8):
            t=np.arange(round(0.04*sr))/sr; noise=rng.normal(0,1,len(t))
            hat=(noise-np.convolve(noise,np.ones(5)/5,'same'))*np.exp(-t*110)*0.017
            put(hat,at+tick*0.25+(0.04 if tick%2 else 0),pan=0.28*(-1)**tick)
            note=chord[[0,2,1,2,0,1,2,1][tick]]*4
            put(tone(note,0.3,0.022),at+tick*0.25,pan=0.45*(-1)**tick)
        for beat in [0,0.75,1.25]: put(tone(chord[0]/2,0.45,0.055),at+beat)
        for freq in chord: put(tone(freq*2,1.9,0.012),at,pan=0.12)
    cues=json.loads((ROOT/'public/plan.json').read_text())['cues']
    for at in cues:
        t=np.arange(round(sr*0.26))/sr; noise=rng.normal(0,1,len(t))
        swoosh=np.convolve(noise,np.ones(20)/20,'same')*np.sin(np.pi*t/0.26)**2*0.035
        put(swoosh,at-0.18,pan=-0.2)
        put(tone(880,0.085,0.018),at,pan=0.2)
    # A small real silence before the brand reveal; a three-note sonic logo.
    for arr in [left,right]: arr[round(3.8*sr):4*sr]=0
    for at in [4,42]:
        for offset,freq in [(0,587.33),(0.125,698.46),(0.25,880)]: put(tone(freq,0.8,0.045),at+offset)
    voice,voice_sr=sf.read(OUT/'voiceover.wav'); voice=resample_poly(voice,sr,voice_sr)
    envelope=np.convolve(np.abs(voice)[::480],np.ones(12)/12,'same')
    duck=np.interp(np.arange(n),np.arange(len(envelope))*480,1/(1+envelope*18))
    fade=np.minimum(1,np.maximum(0,(48-np.arange(n)/sr)/1.4))
    bed=np.column_stack([left,right])*duck[:,None]*fade[:,None]
    sf.write(OUT/'music.wav',bed,sr)
    mixed=bed+voice[:,None]*0.85
    sf.write(OUT/'mix.wav',mixed,sr)
    measured=subprocess.run(['ffmpeg','-hide_banner','-nostdin','-i',str(OUT/'mix.wav'),'-af','loudnorm=I=-14:TP=-1.5:LRA=9:print_format=json','-f','null','-'],check=True,capture_output=True,text=True)
    metrics=json.loads(re.search(r'\{\s*"input_i"[\s\S]*?\}',measured.stderr).group())
    normalize='loudnorm=I=-14:TP=-1.5:LRA=9:linear=true'+''.join(':'+k+'='+metrics[v] for k,v in [('measured_I','input_i'),('measured_TP','input_tp'),('measured_LRA','input_lra'),('measured_thresh','input_thresh'),('offset','target_offset')])
    subprocess.run(['ffmpeg','-hide_banner','-nostdin','-y','-i',str(OUT/'mix.wav'),'-af',normalize,'-ar','48000',str(OUT/'master.wav')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    # Envelope sampled at exactly the composition frame rate drives the orb.
    amplitudes=[round(float(np.sqrt(np.mean(voice[int(i*sr/60):int((i+1)*sr/60)]**2))),5) for i in range(48*60)]
    (OUT/'amplitude.json').write_text(json.dumps(amplitudes),encoding='utf8')
    print('Original soundtrack and amplitude envelope ready',flush=True)

if __name__ == '__main__':
    step=sys.argv[1] if len(sys.argv)>1 else 'all'
    if step in ['download','all']: download()
    if step in ['voice','all']: narration()
    if step in ['align','all']: align()
    if step in ['score','all']: score()
