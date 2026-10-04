"""Relocate admitted source references into an immutable candidate context."""
import json
from pathlib import Path
import sys


def relocate(model,old_root,new_root):
    old_root,new_root=Path(old_root).resolve(),Path(new_root).resolve()
    def path(value):
        resolved=(old_root/value).resolve()
        if not resolved.is_relative_to(old_root):raise ValueError('Source reference escapes immutable context')
        return str(new_root/resolved.relative_to(old_root))
    for service in model['services'].values():
        build=service.get('build')
        if isinstance(build,str):service['build']=path(build)
        elif build:
            build['context']=path(build['context'])
            for key,value in build.get('additional_contexts',{}).items():build['additional_contexts'][key]=path(value)
        for mount in service.get('volumes',[]):
            if mount.get('type')=='bind':mount['source']=path(mount['source'])
        for entry in service.get('env_file',[]):
            if isinstance(entry,dict):entry['path']=path(entry['path'])
    for kind in ('configs','secrets'):
        for entry in model.get(kind,{}).values():
            if entry.get('file'):entry['file']=path(entry['file'])
    return model


if __name__=='__main__':
    file=Path(sys.argv[1]);model=relocate(json.loads(file.read_text()),sys.argv[2],sys.argv[3])
    file.write_text(json.dumps(model));file.chmod(0o600)
