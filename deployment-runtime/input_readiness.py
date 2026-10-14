"""Expose environment key names and selected branch, never variable values."""
import json
from pathlib import Path
import re

KEY=r'[A-Za-z_][A-Za-z0-9_]{0,127}'

def inspect(root,config):
    root=Path(root);required=config.get('required_env_keys',[])
    if not isinstance(required,list) or len(required)>128 or any(not isinstance(k,str) or not re.fullmatch(KEY,k) for k in required):raise ValueError('required_env_keys must contain bounded environment key names')
    context={};path=root/'.stackpilot-context.json'
    if path.exists():
        if path.is_symlink() or not path.is_file() or path.stat().st_size>256*1024:raise ValueError('Invalid executor context')
        context=json.loads(path.read_text())
        if not isinstance(context,dict):raise ValueError('Invalid executor context')
    configured={item['key'] for item in context.get('effective_env_keys',[]) if isinstance(item,dict) and isinstance(item.get('key'),str) and re.fullmatch(KEY,item['key'])}
    examples=set()
    for name in ('.env.example','.env.sample','.env.template'):
        path=root/name
        if path.is_file() and not path.is_symlink() and path.stat().st_size<=256*1024:
            examples.update(re.findall(r'^\s*(?:export\s+)?('+KEY+r')\s*=',path.read_text(errors='replace'),re.M))
    # A local declared .env is consumed by its executor. Only key names enter
    # the plan; examples do not count as supplied application configuration.
    for name in ('.env','.env.production.local','.env.local'):
        path=root/name
        if path.is_file() and not path.is_symlink() and path.stat().st_size<=256*1024:
            configured.update(re.findall(r'^\s*(?:export\s+)?('+KEY+r')\s*=',path.read_text(errors='replace'),re.M))
    missing=sorted(set(required)-configured)
    result={'required_keys':sorted(set(required)),'configured_keys':sorted(configured),'example_keys':sorted(examples),
            'missing_keys':missing,'values_visible':False,'environment':context.get('deployment',{}).get('environment_name'),
            'branch':context.get('deployment',{}).get('branch'),'status':'requires_input' if missing else 'ready'}
    if missing:raise ValueError('Required environment inputs unavailable for selected branch/environment: '+', '.join(missing))
    return result
