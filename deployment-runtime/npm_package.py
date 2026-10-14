"""Worker-only npm export, preserving the repository's publish policy."""
from pathlib import Path
import subprocess

def build(root):
    root=Path(root);ignore=root/'.npmignore';original=ignore.read_bytes() if ignore.is_file() else None
    if ignore.is_symlink():raise ValueError('npm publish policy cannot be a symlink')
    output=root/'stackpilot-output/packages';output.mkdir(parents=True,exist_ok=True)
    try:
        # Generated executor helpers and injected env files are not library
        # source. Add exclusions only for packaging, restoring exact bytes.
        ignore.write_bytes((original or b'')+b'\n.stackpilot*\nstackpilot-output\n.env\n.env.*\n')
        subprocess.run(['npm','pack','--pack-destination',str(output)],cwd=root,check=True,timeout=300)
    finally:
        if original is None:ignore.unlink(missing_ok=True)
        else:ignore.write_bytes(original)

if __name__=='__main__':build(Path.cwd())
