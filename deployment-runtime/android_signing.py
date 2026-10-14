"""Sign exported outputs in a fresh SDK stage containing no repository code."""
import hashlib
import json
from pathlib import Path
import os
from android_delivery import validate, verify

def sign(root,config_file):
    root=Path(root);config=json.loads(Path(config_file).read_text());options=validate(config['android'])
    manifest=root/'manifest.json'
    if manifest.is_symlink() or manifest.stat().st_size>256*1024:raise ValueError('Invalid Android build evidence')
    evidence=json.loads(manifest.read_text());names=evidence.get('artifacts',[])
    if not isinstance(names,list) or not 0<len(names)<=32:raise ValueError('Android output list exceeds signing bounds')
    signer=Path(os.environ['ANDROID_HOME'])/'build-tools/35.0.0/apksigner'
    signatures={};digests={};metadata={}
    for name in names:
        if not isinstance(name,str) or Path(name).name!=name or '\\' in name or not name.endswith('.'+options['format']):raise ValueError('Unexpected Android signing output')
        path=root/name
        if path.is_symlink() or not path.is_file() or path.stat().st_size>1024**3:raise ValueError('Android signing output must be a bounded regular artifact')
        signatures[name]=verify(path,options['format'],signer,options['signing'])
        digest=hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
        digests[name]=digest.hexdigest();metadata[name]={'kind':options['format'],'variant':options['variant'],'signature_status':signatures[name],'store_publication':'unverified'}
    if not all(s=='verified' for s in signatures.values()):raise ValueError('Required signing identity was not verified')
    evidence.update(sha256=digests,signatures=signatures,signing_verified=True,artifact_metadata=metadata)
    manifest.write_text(json.dumps(evidence,indent=2))

if __name__=='__main__':sign('/artifacts','/signing/stackpilot.json')
