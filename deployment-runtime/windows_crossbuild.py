"""Produce .NET Windows artifacts on Linux, without claiming native execution."""
import json
import struct
from pathlib import Path
import subprocess
from select_entrypoint import dotnet_project


def validate_pe(path, arch):
    with path.open('rb') as stream:
        header=stream.read(64)
        if len(header)<64 or header[:2]!=b'MZ':raise ValueError('Windows output is not a PE executable')
        offset=struct.unpack_from('<I',header,60)[0]
        if offset>1024*1024:raise ValueError('PE header offset exceeds validation bounds')
        stream.seek(offset);pe=stream.read(6)
    if len(pe)!=6 or pe[:4]!=b'PE\0\0' or struct.unpack_from('<H',pe,4)[0]!={'amd64':0x8664,'arm64':0xAA64}[arch]:raise ValueError('Windows executable target architecture does not match the requested target')


def build(root):
    root=Path(root).resolve();config=json.loads((root/'stackpilot.json').read_text())
    arch=config.get('target',{}).get('arch','amd64')
    if arch not in {'amd64','arm64'}:raise ValueError('Windows .NET cross-build supports amd64 or arm64')
    project=dotnet_project(root);output=root/'stackpilot-output/windows'
    argv=['dotnet','publish',str(project),'-c','Release','-r',{'amd64':'win-x64','arm64':'win-arm64'}[arch],
          '--self-contained','true','-p:EnableWindowsTargeting=true','-p:PublishSingleFile=true','-p:IncludeNativeLibrariesForSelfExtract=true','-o',str(output)]
    print(json.dumps({'stage':'windows_crossbuild','command':argv}),flush=True)
    subprocess.run(argv,cwd=root,check=True,timeout=1200)
    executables=list(output.glob('*.exe'))
    if len(executables)!=1:raise ValueError('Windows publish must produce one selected application EXE')
    validate_pe(executables[0],arch)
    (output/'windows-evidence.json').write_text(json.dumps({'build':'passed','format':'PE','target':config['target'],
        'native_execution':'unverified','signature':'unsigned','release_qualification':'requires_windows_worker',
        'dependencies':'self_contained_publish_bundle','project':config['project']}))


if __name__=='__main__':build(Path.cwd())
