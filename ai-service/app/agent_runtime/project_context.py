"""Key-only model context; dotenv values never become source observations."""
import json
import os
from pathlib import Path
import re

KEY = re.compile(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=', re.MULTILINE)
SKIP={'.git','node_modules','.next','.venv','venv','__pycache__','.stackpilot-runtime','dist','build','target'}


def is_env_file(path):
    name=Path(path).name
    return name=='.env' or name.startswith('.env.') or name.endswith('.env')


def names(content):
    return sorted(set(KEY.findall(content)))


def env_observation(content):
    return '# Variable names only. Values stay with the deployment executor.\n'+''.join(key+'=[VALUE_HIDDEN]\n' for key in names(content))


def repository_env_keys(root):
    root=Path(root).resolve(); files=[]
    for current, dirs, entries in os.walk(root,followlinks=False):
        dirs[:]=[name for name in sorted(dirs) if name not in SKIP and not (Path(current)/name).is_symlink()]
        if len(Path(current).relative_to(root).parts)>8:dirs[:]=[];continue
        for name in sorted(entries):
            path=Path(current)/name
            if not is_env_file(path) or path.is_symlink() or not path.is_file():continue
            if len(files)>=128:raise ValueError('Environment file inventory exceeds 128 files')
            if path.stat().st_size>1024*1024:raise ValueError('Environment file inventory exceeds 1 MiB per file')
            files.append({'path':path.relative_to(root).as_posix(),'keys':names(path.read_text(encoding='utf-8-sig'))})
    return files


def clean(value):
    """Whitelist broker metadata even when a caller supplied extra fields."""
    value=value if isinstance(value,dict) else {}
    def records(field):
        items=value.get(field,[])
        return items if isinstance(items,list) else []
    result={'version':1,'values_visible':False}
    fields={'project':{'id','name','repo_url','source_type','execution_mode'},
        'deployment':{'id','branch','commit_sha','commit_hash','environment_id','environment_name','execution_mode',
            'remote_runtime_type','remote_connection_id','connection_name','ci_required','ci_status'}}
    for field,allowed in fields.items():
        record=value.get(field,{})
        result[field]={key:item for key,item in record.items() if key in allowed and type(item) in {str,bool,int}} if isinstance(record,dict) else {}
    for field in ('env_keys','effective_env_keys'):
        result[field]=[{key:item for key,item in record.items() if key in {'key','scope','environment_id','visibility'} and isinstance(item,str)}
            for record in records(field) if isinstance(record,dict)]
    allowed={'id','name','branch','execution_mode','remote_runtime_type','runtime_scheme','remote_connection_id','connection_name','require_ci','auto_deploy'}
    result['environments']=[{key:item for key,item in record.items() if key in allowed and type(item) in {str,bool}}
        for record in records('environments') if isinstance(record,dict)]
    result['configured_branches']=[item for item in records('configured_branches') if isinstance(item,str)]
    result['branch_catalog_scope']='selected_source_and_environment_mappings'
    result['environment_selected']=bool(result['deployment'].get('environment_id'))
    if len(json.dumps(result).encode())>256*1024:raise ValueError('Project context exceeds 256 KiB')
    return result
