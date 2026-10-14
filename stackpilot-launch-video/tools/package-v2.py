"""Portable V2 source archive. No node_modules, weights, secrets, or old demo scenes."""
from pathlib import Path
import zipfile
ROOT=Path(__file__).resolve().parents[1]
files=['README-V2.md','REVIEW-V2.md','brief.md','image-prompt-v2.md','THIRD_PARTY_NOTICES.md','requirements.txt','package.json','package-lock.json','tsconfig.json','preview-v2.html','render-v2.html','js/launch-v2.mjs','js/theme.mjs','js/timeline.mjs','js/copy.mjs','js/engine.js','src/index-v2.tsx','audio/prepare.py','tools/launch-render-v2.mjs','tools/capture-product-v2.mjs','tools/verify-v2.py','tools/v2-contact-sheet.py','tools/package-v2.py']
files += [str(p.relative_to(ROOT)) for p in (ROOT/'public').rglob('*') if p.is_file() and (p.suffix in {'.wav','.json','.ttf','.svg'} or p.name=='stack-studio-v2.png' or 'product-v2' in p.parts or 'licenses' in p.parts)]
files += ['out/stackpilot-launch-en.srt','out/qa-v2/verification.json','out/qa-v2/encoded-contact-sheet.png','out/stackpilot-launch-v2-cover.png','out/v2/keyframes.png','out/v2/transitions.png']
out=ROOT/'out/stackpilot-launch-v2-source.zip'
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for name in dict.fromkeys(files):
        file=ROOT/name
        assert file.exists(),name
        archive='README.md' if name=='README-V2.md' else name.replace('\\','/')
        z.write(file,archive)
with zipfile.ZipFile(out) as z:
    assert z.testzip() is None
    names=z.namelist()
    assert not any('node_modules/' in n or n.endswith(('.onnx','.pt','.bin','.env')) for n in names)
    print(f'Archive verified: {len(names)} files, {out.stat().st_size:,} bytes')
