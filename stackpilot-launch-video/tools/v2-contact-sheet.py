from pathlib import Path
from PIL import Image, ImageDraw
ROOT=Path(__file__).resolve().parents[1]
times=[.5,2.5,7,12,16,21,29,37,45]
for name,times in [('keyframes',times),('transitions',[a+d for a in [4,10,18,26,34,42] for d in [-.1,.1,.4]])]:
    cols=3;rows=(len(times)+cols-1)//cols
    sheet=Image.new('RGB',(1920,rows*380),'#242424');labels=ImageDraw.Draw(sheet)
    for i,t in enumerate(times):
        image=Image.open(ROOT/f'out/v2/stills/frame-{t:.2f}.png').convert('RGB').resize((640,360))
        sheet.paste(image,((i%cols)*640,(i//cols)*380));labels.text(((i%cols)*640+14,(i//cols)*380+363),f'{t:g}s',fill='white')
    sheet.save(ROOT/f'out/v2/{name}.png')
asset=Image.open(ROOT/'public/stack-studio-v2.png')
print('Studio asset',asset.size,asset.mode,'alpha extrema:',asset.getchannel('A').getextrema() if 'A' in asset.getbands() else 'opaque')
