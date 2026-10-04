"""Create a content-addressed source bundle and a separate sealed build context."""
import hashlib
import json
import os
import stat
from pathlib import Path
import tarfile
import tempfile
import sys

SKIP={'.git','node_modules','.venv','venv','__pycache__','.next','target'}

def file_hash(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()

def snapshot(root,store,sealed,*,exact=False):
    root,store,sealed=Path(root).resolve(),Path(store).resolve(),Path(sealed).absolute()
    if sealed.exists() or sealed.is_symlink():raise ValueError('Candidate source context already exists')
    store.mkdir(parents=True,exist_ok=True)
    total=0;count=0
    handle=tempfile.NamedTemporaryFile(dir=store,suffix='.tar',delete=False);temporary=Path(handle.name);handle.close()
    try:
        with tarfile.open(temporary,'w',format=tarfile.PAX_FORMAT) as archive:
            for current,dirs,files in os.walk(root,followlinks=False):
                skipped=set() if exact else SKIP
                if any((Path(current)/d).is_symlink() for d in dirs if d not in skipped):
                    raise ValueError('Source directory symlinks require explicit portable packaging')
                dirs[:]=sorted(d for d in dirs if d not in skipped)
                for name in sorted(files):
                    if not exact and name.startswith('.env') and name!='.env.production.local':continue
                    path=Path(current)/name
                    before=path.lstat()
                    if stat.S_ISLNK(before.st_mode):raise ValueError('Source file symlinks require explicit portable packaging')
                    if not stat.S_ISREG(before.st_mode):raise ValueError('Source contains a non-regular file')
                    total+=before.st_size;count+=1
                    if total>2*1024**3 or count>100000:raise ValueError('Source bundle exceeds worker limits')
                    info=tarfile.TarInfo(path.relative_to(root).as_posix());info.size=before.st_size
                    info.mode=0o755 if before.st_mode&0o111 else 0o644;info.uid=info.gid=0;info.mtime=0
                    with path.open('rb') as stream:archive.addfile(info,stream)
                    after=path.stat()
                    if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('Source changed during snapshot')
        digest=file_hash(temporary)
        target=store/(digest+'.tar')
        if target.exists():
            if file_hash(target)!=digest:raise ValueError('Source store integrity failure')
        else:os.replace(temporary,target)
        sealed.mkdir(mode=0o700,parents=True)
        sealed_root=sealed.resolve()
        directories={sealed_root}
        with tarfile.open(target) as archive:
            # This archive is generated above from regular files, but validate
            # the content store again before extraction on Python 3.10 workers.
            for member in archive:
                relative=Path(member.name)
                destination=sealed_root/relative
                if (not member.isfile() or relative.is_absolute() or '..' in relative.parts or
                        not destination.is_relative_to(sealed_root)):
                    raise ValueError('Source archive contains an unsafe entry')
                # The new private context starts empty, and every archive entry
                # is a regular file; no archive-created symlink can redirect a
                # lexical child path. Avoid repeated remote filesystem resolves.
                if destination.parent not in directories:
                    destination.parent.mkdir(parents=True,exist_ok=True)
                    directories.add(destination.parent)
                with archive.extractfile(member) as source, destination.open('wb') as output:
                    import shutil
                    shutil.copyfileobj(source,output)
                destination.chmod(member.mode & 0o777)
        return {'sha256':digest,'archive':str(target),'build_context':str(sealed),'files':count,'bytes':total}
    finally:
        temporary.unlink(missing_ok=True)

if __name__=='__main__':
    result=snapshot(*sys.argv[1:4]);Path(sys.argv[4]).write_text(json.dumps(result))
