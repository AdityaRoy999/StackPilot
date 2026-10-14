"""Inspect exported bytes and archive paths; extensions alone are not evidence."""
from pathlib import PurePosixPath
import tarfile
import zipfile


def safe_members(names):
    if len(names)>10000:raise ValueError('Artifact archive entry budget exceeded')
    for name in names:
        path=PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or '\\' in name or any(p=='.env' or p.startswith('.env.') or p in {'.git','.stackpilot-runtime'} for p in path.parts):raise ValueError('Artifact archive contains private configuration or escaping paths')


def inspect(path, target=None):
    extension=path.suffix.lower();kind=extension.removeprefix('.');validation='unverified'
    if extension=='.exe':
        from windows_crossbuild import validate_pe
        validate_pe(path,(target or {}).get('arch','amd64'));kind='windows_executable';validation='passed'
    elif extension in {'.zip','.whl','.jar','.nupkg','.vsix'}:
        with zipfile.ZipFile(path) as archive:
            names=archive.namelist();safe_members(names)
            if sum(i.file_size for i in archive.infolist())>2*1024**3:raise ValueError('Artifact archive expanded size exceeds bounds')
            if any((i.external_attr>>16)&0o170000==0o120000 for i in archive.infolist()):raise ValueError('Artifact archive symlinks are refused')
            if extension=='.whl' and not any(n.endswith('.dist-info/WHEEL') for n in names):raise ValueError('Wheel metadata missing')
            if extension=='.nupkg' and not any(n.endswith('.nuspec') for n in names):raise ValueError('NuGet package metadata missing')
            if archive.testzip() is not None:raise ValueError('Artifact archive checksum failed')
        validation='passed'
    elif extension in {'.tgz','.gz','.tar','.crate'}:
        with tarfile.open(path,'r:*') as archive:
            members=archive.getmembers();safe_members([m.name for m in members])
            if sum(m.size for m in members)>2*1024**3:raise ValueError('Artifact archive expanded size exceeds bounds')
            if any(not (m.isfile() or m.isdir()) for m in members):raise ValueError('Artifact archive contains links or special files')
            if extension=='.tgz' and not any(m.name=='package/package.json' for m in members):raise ValueError('npm package metadata missing')
        validation='passed'
    return {'kind':kind,'format_validation':validation,'target':target,'native_execution':'unverified'}
