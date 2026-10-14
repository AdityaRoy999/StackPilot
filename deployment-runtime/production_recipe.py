"""Recognize an unambiguous original Render Docker deployment without execution.

Only a single root Docker web service is admitted. Other YAML layouts remain
ambiguous and require an explicit stackpilot.json recipe; no general YAML parser
or provider secrets are needed to recognize these bounded scalar declarations.
"""
import json
from pathlib import Path
import re
import shlex


def root_render_docker(root):
    root = Path(root)
    manifest, dockerfile = root/'render.yaml', root/'Dockerfile'
    if any(path.is_symlink() or not path.is_file() or path.stat().st_size > 256*1024
           for path in (manifest, dockerfile)):
        return None
    context = root/'.stackpilot-context.json'
    if context.is_file() and not context.is_symlink():
        selected = json.loads(context.read_text()).get('deployment') or {}
        if str(selected.get('environment_name', '')).lower() in {'dev', 'development', 'local', 'test', 'testing'}:
            return None
    text = manifest.read_text(encoding='utf-8-sig')
    services = re.findall(r'^([ ]+)-[ ]+type:[ ]*([a-z]+)[ ]*(?:#.*)?$', text, re.M)
    if len(services) != 1 or services[0][1] != 'web':
        return None
    indent = len(services[0][0]) + 2
    # Reject aliases and flow collections rather than guessing their semantics.
    if re.search(r'[&*]|^[ \t]*services:[ \t]*[^\s#]', text, re.M):
        return None
    fields = {}
    for line in text.splitlines():
        match = re.fullmatch(r' {'+str(indent)+r'}(env|runtime|dockerfilePath|rootDir):\s*([\'"]?)([A-Za-z0-9_./-]+)\2\s*(?:#.*)?', line)
        if match:
            if match[1] in fields: return None
            fields[match[1]] = match[3]
        elif re.match(r' {'+str(indent)+r'}(?:env|runtime|dockerfilePath|rootDir):', line):
            return None
    if 'env' in fields and 'runtime' in fields and fields['env'] != fields['runtime']:
        return None
    if (fields.get('env', fields.get('runtime')) != 'docker' or
            fields.get('dockerfilePath', 'Dockerfile') not in {'Dockerfile', './Dockerfile'} or
            fields.get('rootDir', '.') not in {'.', './'}):
        return None
    commands = re.findall(r'^ {'+str(indent)+r'}dockerCommand:\s*(.+?)\s*$', text, re.M)
    if commands:
        final = re.split(r'^\s*FROM\s+', dockerfile.read_text(), flags=re.M|re.I)[-1]
        command = re.findall(r'^\s*CMD\s+(.+?)\s*$', final, re.M|re.I)
        if len(commands) != 1 or len(command) != 1: return None
        try:
            original = re.sub(r'\$\{PORT:-\d+\}', '$PORT', command[0])
            if shlex.split(commands[0]) != shlex.split(original): return None
        except ValueError:
            return None
    return {'manifest': 'render.yaml', 'dockerfile': 'Dockerfile', 'service_type': 'web',
            'reason': 'Original production manifest explicitly selects the root Docker recipe'}
