"""Build a task-owned Linux SDK image without control-plane credentials.

Only a bounded source snapshot is staged. The Docker guest receives no socket,
host filesystem, environment, SSH agent, build arguments or secret inputs.
This is a local development Docker adapter, not hostile-tenant VM isolation.
"""
import hashlib
import json
import os
from pathlib import Path,PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from agent_process import inventory,lease_valid
from sandbox_capabilities import select


def request(spec):
    if not isinstance(spec,dict):raise ValueError('SDK image request must be an object')
    for key in ('run_id','user_id'):
        value=spec.get(key)
        if not isinstance(value,str) or str(uuid.UUID(value))!=value:
            raise ValueError('SDK image request requires a canonical '+key)
    for key in ('task_id','lease_owner'):
        if not isinstance(spec.get(key),str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}',spec[key]):
            raise ValueError('SDK image request requires a bounded '+key)
    if type(spec.get('attempt')) is not int or not 1<=spec['attempt']<=10000:
        raise ValueError('SDK image request requires a live task attempt')
    path=spec.get('dockerfile','Dockerfile')
    if not isinstance(path,str) or not 1<=len(path)<=512 or any(c in path for c in '\\:\0\r\n'):
        raise ValueError('Dockerfile must be a bounded relative source path')
    parsed=PurePosixPath(path)
    if parsed.is_absolute() or '..' in parsed.parts or not parsed.parts:
        raise ValueError('Dockerfile escapes task source')
    timeout=spec.get('timeout_seconds',600)
    if type(timeout) is not int or not 1<=timeout<=900:
        raise ValueError('SDK image build timeout must be between 1 and 900 seconds')
    network=spec.get('network',False)
    if type(network) is not bool:raise ValueError('SDK build network must be a boolean')
    if network and os.getenv('STACKPILOT_AGENT_WORKER_NETWORK','false').lower()!='true':
        raise ValueError('Worker network capability is unavailable; request it explicitly')
    return parsed.as_posix(),timeout,network


def stage(source,destination,manifest):
    """Copy only inventoried regular source files and preserve executable bits."""
    source=Path(source).resolve()
    destination.mkdir()
    for relative,entry in manifest.items():
        target=source.joinpath(*PurePosixPath(relative).parts)
        if not target.resolve().is_relative_to(source) or any(p.is_symlink() for p in [target,*target.parents] if p.is_relative_to(source)):
            raise ValueError('SDK source path escaped or changed to a symlink')
        descriptor=os.open(target,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
        with os.fdopen(descriptor,'rb') as incoming:
            metadata=os.fstat(incoming.fileno())
            if not stat.S_ISREG(metadata.st_mode):raise ValueError('SDK source contains a special file')
            data=incoming.read(256*1024*1024+1)
        if hashlib.sha256(data).hexdigest()!=entry['sha256']:
            raise ValueError('Task source changed while staging SDK image: '+relative)
        copied=destination.joinpath(*PurePosixPath(relative).parts)
        copied.parent.mkdir(parents=True,exist_ok=True);copied.write_bytes(data)
        copied.chmod(0o755 if entry['executable'] else 0o644)


def offline_recipe(text,cli,env):
    """Offline RUN is insufficient when ADD/FROM can fetch outside the guest."""
    logical=[];pending=''
    for line in text.splitlines():
        stripped=line.strip()
        if not stripped or stripped.startswith('#'):
            if stripped.startswith('#') and re.match(r'#\s*syntax\s*=',stripped,re.I):
                raise ValueError('Offline SDK builds cannot fetch a custom Dockerfile frontend')
            if stripped.startswith('#') and re.match(r'#\s*escape\s*=\s*[^\\\s]',stripped,re.I):
                raise ValueError('Offline SDK builds require the standard Dockerfile continuation syntax')
            continue
        pending+=stripped[:-1]+' ' if stripped.endswith('\\') else stripped
        if stripped.endswith('\\'):continue
        logical.append(pending);pending=''
    if pending:raise ValueError('Dockerfile has an unfinished continuation')
    stages=set();images=set()
    for line in logical:
        operation,_,body=line.partition(' ');operation=operation.upper()
        if operation=='FROM':
            tokens=body.split()
            while tokens and tokens[0].startswith('--'):tokens.pop(0)
            if not tokens:raise ValueError('Dockerfile FROM requires an image')
            image=tokens[0]
            if '$' in image:raise ValueError('Offline SDK builds require resolved base image references')
            if image!='scratch' and image.lower() not in stages:images.add(image)
            if len(tokens)>=3 and tokens[1].upper()=='AS':stages.add(tokens[2].lower())
        if operation in {'RUN','ADD','COPY'}:
            if re.search(r'--network(?:=|\s+)(?:host|default)\b',body):
                raise ValueError('Offline SDK build cannot override its execution network')
            if operation=='ADD' and (re.search(r'(?i)(?:https?|git|ssh)://',body) or re.search(r'\b[^\s]+@[^\s]+:',body)):
                raise ValueError('Offline SDK builds cannot fetch remote ADD inputs')
            external=re.search(r'--from(?:=|\s+)([^\s]+)',body)
            if external and external.group(1).lower() not in stages and not external.group(1).isdigit():
                if '$' in external.group(1):raise ValueError('Offline COPY must use a resolved local image')
                images.add(external.group(1))
            for mount in re.findall(r'--mount=([^\s]+)',body):
                options=dict(part.split('=',1) for part in mount.split(',') if '=' in part)
                image=options.get('from')
                if image and image.lower() not in stages and not image.isdigit():
                    if '$' in image:raise ValueError('Offline mount must use a resolved local image')
                    images.add(image)
    for image in images:
        result=subprocess.run([cli,'image','inspect',image],capture_output=True,timeout=15,env=env)
        if result.returncode!=0:raise ValueError('Offline SDK base image must already exist locally: '+image)


def execute(source,spec):
    dockerfile,timeout,network=request(spec)
    placement=select(spec.get('capabilities',[]),purpose='command',probe=True)
    if placement['status']!='ready':
        return {**placement,'status':'blocked','error':'SDK build requires a matching Linux Docker sandbox','changes':[]}
    root=Path(source)
    if root.is_symlink() or not root.is_dir():raise ValueError('SDK source must be a real task directory')
    root=root.resolve();manifest=inventory(root)
    if dockerfile not in manifest:raise ValueError('Dockerfile is missing from the task source inventory')
    if (root/dockerfile).stat().st_size>256*1024:raise ValueError('SDK Dockerfile exceeds 256 KiB')
    if not lease_valid(spec):raise PermissionError('Task execution lease revoked before SDK staging')
    cli=shutil.which('docker')
    if not cli:raise ValueError('Docker CLI unavailable')
    tag='stackpilot-agent-sdk-'+uuid.uuid4().hex
    labels={'stackpilot.agent-run':spec['run_id'],'stackpilot.agent-sdk':'true','stackpilot.agent-task':spec['task_id']}
    retained=False;process=None;image_id=None
    with tempfile.TemporaryDirectory(prefix='stackpilot-agent-sdk-') as temporary:
        directory=Path(temporary);context=directory/'source';configuration=directory/'docker-config'
        configuration.mkdir();(configuration/'config.json').write_text('{}')
        # No inherited cloud/Git/registry/proxy/application credentials. The
        # local Docker socket is used only by this trusted control-plane CLI.
        env={'PATH':os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin'),
             'DOCKER_CONFIG':str(configuration),'DOCKER_BUILDKIT':'1'}
        try:
            stage(root,context,manifest)
            if not lease_valid(spec):raise PermissionError('Task execution lease revoked before SDK build')
            recipe=context/dockerfile
            if not network:offline_recipe(recipe.read_text(encoding='utf-8'),cli,env)
            arguments=[cli,'build','--progress','plain','--pull=false','--network','default' if network else 'none',
                       '--iidfile',str(directory/'image-id'),'--file',str(recipe),'--tag',tag]
            for key,value in labels.items():arguments.extend(['--label',key+'='+value])
            arguments.append(str(context))
            process=subprocess.Popen(arguments,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=env)
            captured=bytearray()
            def drain():
                with process.stdout:
                    while chunk:=process.stdout.read(4096):
                        remaining=65536-len(captured)
                        if remaining>0:captured.extend(chunk[:remaining])
            reader=threading.Thread(target=drain,daemon=True);reader.start()
            started=time.monotonic();checked=0;revoked=False;timed_out=False
            while process.poll() is None:
                now=time.monotonic()
                if now-checked>=2:checked=now;revoked=not lease_valid(spec)
                if revoked or now-started>=timeout:
                    timed_out=not revoked;process.terminate()
                    try:process.wait(timeout=5)
                    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
                    break
                time.sleep(.2)
            reader.join(timeout=5)
            output=captured.decode('utf-8',errors='replace')
            if revoked or not lease_valid(spec):raise PermissionError('Task execution lease revoked; SDK image rejected')
            if timed_out or process.returncode!=0:
                return {'status':'failed','exit_code':124 if timed_out else process.returncode,
                        'timed_out':timed_out,'output':output,'verified':False,'scope':'sdk_image_build','changes':[]}
            iid=directory/'image-id'
            image_id=iid.read_text().strip() if iid.is_file() else ''
            if not re.fullmatch(r'sha256:[0-9a-f]{64}',image_id):raise ValueError('Docker build returned no actual image digest')
            inspected=subprocess.run([cli,'image','inspect',image_id],capture_output=True,text=True,check=True,timeout=15,env=env)
            metadata=json.loads(inspected.stdout)
            if not isinstance(metadata,list) or len(metadata)!=1 or metadata[0].get('Id')!=image_id:
                raise ValueError('Built SDK image identity differs from Docker observation')
            actual=(metadata[0].get('Config') or {}).get('Labels') or {}
            if any(actual.get(key)!=value for key,value in labels.items()):raise ValueError('Built SDK ownership labels are missing')
            if not lease_valid(spec):raise PermissionError('Task execution lease revoked before SDK image acceptance')
            retained=True
            return {'status':'completed','exit_code':0,'image':image_id,'image_id':image_id,'labels':labels,
                    'dockerfile':dockerfile,'source_files':len(manifest),'timed_out':False,'output':output,
                    'verified':False,'scope':'sdk_image_build','changes':[]}
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
            if not retained:
                subprocess.run([cli,'image','rm',tag],capture_output=True,timeout=20,env=env)


def cleanup(run_id):
    """Trusted broker calls only after checking this run is terminal/authorized.

    Image ownership labels are inspected again; no force removal is used.
    Docker therefore refuses an image that gains a container after our check.
    Retained images are reported explicitly for a later reconciliation pass.
    """
    if not isinstance(run_id,str) or str(uuid.UUID(run_id))!=run_id:
        raise ValueError('SDK cleanup requires a canonical run identity')
    cli=shutil.which('docker')
    if not cli:raise ValueError('Docker CLI unavailable')
    removed=[];retained=[];started=time.monotonic()
    with tempfile.TemporaryDirectory(prefix='stackpilot-sdk-cleanup-') as temporary:
        env={'PATH':os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin'),'DOCKER_CONFIG':temporary}
        result=subprocess.run([cli,'image','ls','--quiet','--no-trunc','--filter','label=stackpilot.agent-run='+run_id,
                               '--filter','label=stackpilot.agent-sdk=true'],capture_output=True,text=True,check=True,timeout=15,env=env)
        images=list(dict.fromkeys(result.stdout.splitlines()))
        if len(images)>128:raise ValueError('SDK cleanup exceeds 128-image reconciliation budget')
        for image in images:
            if not re.fullmatch(r'sha256:[0-9a-f]{64}',image):raise ValueError('Docker returned an invalid SDK image identity')
            if time.monotonic()-started>30:
                retained.append({'image_id':image,'reason':'cleanup observation budget exceeded'});continue
            inspected=subprocess.run([cli,'image','inspect',image],capture_output=True,text=True,timeout=10,env=env)
            if inspected.returncode!=0:continue  # Already removed by another authorized cleanup.
            metadata=json.loads(inspected.stdout)
            actual=metadata[0] if isinstance(metadata,list) and len(metadata)==1 else {}
            labels=(actual.get('Config') or {}).get('Labels') or {}
            if actual.get('Id')!=image or labels.get('stackpilot.agent-run')!=run_id or labels.get('stackpilot.agent-sdk')!='true':
                retained.append({'image_id':image,'reason':'ownership observation mismatch'});continue
            users=subprocess.run([cli,'ps','--all','--quiet','--filter','ancestor='+image],capture_output=True,text=True,check=True,timeout=10,env=env)
            if users.stdout.strip():
                retained.append({'image_id':image,'reason':'image is referenced by a container'});continue
            result=subprocess.run([cli,'image','rm',image],capture_output=True,text=True,timeout=15,env=env)
            if result.returncode==0:removed.append(image)
            else:retained.append({'image_id':image,'reason':'Docker retained the image; it may have gained a reference or multiple tags'})
    return {'status':'partial' if retained else 'completed','run_id':run_id,'removed':removed,'retained':retained,
            'verified':False,'scope':'sdk_image_cleanup'}


if __name__=='__main__':
    source,request_path,result_path=sys.argv[1:4]
    try:
        spec=json.loads(Path(request_path).read_text())
        result=cleanup(spec.get('run_id')) if source=='cleanup' else execute(Path(source),spec)
    except Exception as error:result={'status':'failed','error':str(error),'verified':False,
        'scope':'sdk_image_cleanup' if source=='cleanup' else 'sdk_image_build','changes':[]}
    Path(result_path).write_text(json.dumps(result))
