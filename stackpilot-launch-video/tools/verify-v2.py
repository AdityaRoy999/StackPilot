"""Checks the encoded deliverables, not just the scene implementation."""
import json
import hashlib
from pathlib import Path
import re
import subprocess
from PIL import Image, ImageDraw
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'out'; QA=OUT/'qa-v2'; QA.mkdir(exist_ok=True)
report={'passed':False,'durationSeconds':48,'captionAlignment':'stable-ts forced alignment with Whisper base.en','reference':'user-provided style breakdown; reference video fetch throttled','files':[]}
for name,width,height,fps in [('stackpilot-launch-v2.mp4',1920,1080,60),('stackpilot-launch-v2-web.mp4',1280,720,60)]:
    file=OUT/name
    metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(file)],text=True))
    video=next(x for x in metadata['streams'] if x['codec_type']=='video'); audio=next(x for x in metadata['streams'] if x['codec_type']=='audio')
    assert (video['width'],video['height'])==(width,height)
    assert video['avg_frame_rate']==f'{fps}/1' and int(video['nb_frames'])==48*fps
    assert video['codec_name']=='h264' and audio['codec_name']=='aac' and audio['channels']==2
    assert abs(float(metadata['format']['duration'])-48)<.05
    decoded=subprocess.run(['ffmpeg','-v','error','-nostdin','-i',str(file),'-f','null','-'],capture_output=True,text=True,check=True)
    assert not decoded.stderr.strip(),decoded.stderr
    stats=subprocess.run(['ffmpeg','-hide_banner','-nostdin','-i',str(file),'-af','loudnorm=I=-14:TP=-1:LRA=9:print_format=json','-f','null','-'],capture_output=True,text=True,check=True)
    loudness=json.loads(re.search(r'\{\s*"input_i"[\s\S]*?\}',stats.stderr).group())
    assert -15.1<=float(loudness['input_i'])<=-13.0,loudness
    assert float(loudness['input_tp'])<=-1.0,loudness
    report['files'].append({'file':name,'bytes':file.stat().st_size,'resolution':[width,height],'fps':fps,'frameCount':int(video['nb_frames']),'integratedLufs':float(loudness['input_i']),'truePeakDbtp':float(loudness['input_tp']),'fullDecode':'passed'})

words=json.loads((ROOT/'public/captions.json').read_text()); script=json.loads((ROOT/'public/narration.json').read_text())
normal=lambda s:re.findall(r'\w+',s.lower())
assert normal(' '.join(w['text'] for w in words))==normal(' '.join(s['text'] for s in script))
assert len(json.loads((ROOT/'public/amplitude.json').read_text()))==2880
assert all(0<=w['startMs']<w['endMs']<=48000 for w in words)
report['alignedWords']=len(words);report['captionTranscriptMatches']=True;report['audioEnvelopeSourceFrames']=2880

# Verify real motion cadence, rather than trusting the 60 fps container label.
# A 30 fps source doubled to 60 would repeat half of the decoded moving frames.
report['motionCadence']=[]
for name in ['stackpilot-launch-v2.mp4','stackpilot-launch-v2-web.mp4']:
    for start in [6.5,13.2,20.7,36.8]:
        raw=subprocess.check_output(['ffmpeg','-v','error','-nostdin','-ss',str(start),'-i',str(OUT/name),'-t','1','-vf','scale=480:270','-pix_fmt','gray','-f','rawvideo','-'])
        size=480*270
        hashes=[hashlib.sha256(raw[i:i+size]).digest() for i in range(0,len(raw),size)]
        assert len(hashes)==60,(name,start,len(hashes))
        changed=sum(a!=b for a,b in zip(hashes,hashes[1:]))
        assert changed>=57,(name,start,changed)
        report['motionCadence'].append({'file':name,'startSeconds':start,'frames':60,'changedAdjacentPairs':changed,'totalAdjacentPairs':59})

# Inspect encoded frames, with speech and transitions, after the encoder has run.
times=[2.5,7,12,16,23.5,28,32,39,45]
sheet=Image.new('RGB',(1440,864),'#222'); labels=ImageDraw.Draw(sheet)
for i,t in enumerate(times):
    frame=QA/f'encoded-{t:g}.png'
    subprocess.run(['ffmpeg','-v','error','-nostdin','-y','-ss',str(t),'-i',str(OUT/'stackpilot-launch-v2.mp4'),'-frames:v','1',str(frame)],check=True)
    shot=Image.open(frame).convert('RGB')
    assert shot.size==(1920,1080)
    assert max(shot.convert('L').getextrema())>200
    sheet.paste(shot.resize((480,270)),((i%3)*480,(i//3)*288));labels.text(((i%3)*480+10,(i//3)*288+271),f'{t}s',fill='white')
sheet.save(QA/'encoded-contact-sheet.png')
subprocess.run(['ffmpeg','-v','error','-nostdin','-y','-ss','7','-i',str(OUT/'stackpilot-launch-v2.mp4'),'-frames:v','1',str(OUT/'stackpilot-launch-v2-cover.png')],check=True)
report['passed']=True
(QA/'verification.json').write_text(json.dumps(report,indent=2),encoding='utf8')
print(json.dumps(report,indent=2))
