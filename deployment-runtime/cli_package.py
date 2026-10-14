"""Bundle the selected compiled CLI, with portable executable permissions."""
import json
from pathlib import Path
import tarfile

def package(root):
    root=Path(root);config=json.loads((root/'stackpilot.json').read_text())
    binary=Path('/artifacts/server')
    if binary.is_symlink() or not binary.is_file():raise ValueError('Selected CLI binary was not built')
    # Fixed worker output path; the archive member keeps the original name.
    name=config['go_prebuilt']['source']
    with tarfile.open('/artifacts/application-linux.tar.gz','w:gz') as archive:
        info=archive.gettarinfo(str(binary),arcname=name);info.mode=0o755;info.uid=info.gid=0;info.uname=info.gname=''
        with binary.open('rb') as stream:archive.addfile(info,stream)

if __name__=='__main__':package(Path.cwd())
