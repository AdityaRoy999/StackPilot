"""Explicit BuildKit secret mounts. Credential files never enter the context."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile


def validate(values):
    if not isinstance(values,dict) or not 0<len(values)<=20:raise ValueError('Declare at most twenty private build inputs')
    for key,value in values.items():
        if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}',key) or key.startswith(('PUBLIC_','NEXT_PUBLIC_','VITE_','REACT_APP_')):raise ValueError('Build secret identifiers must be private variable names')
        if not isinstance(value,str) or not value or len(value.encode())>65536 or '\0' in value:raise ValueError('Invalid build secret value')
    return values


def redact(line,values):
    for secret in sorted(values.values(),key=len,reverse=True):
        for value in (secret,*secret.splitlines()):
            if value:line=line.replace(value,'[REDACTED]')
    return line


def build(config_file,context,image,memory,parallel='1'):
    source=Path(context).resolve();config_file=Path(config_file).resolve()
    if config_file.is_relative_to(source):raise ValueError('Private build inputs must remain outside the context')
    values=validate(json.loads(config_file.read_text()))
    with tempfile.TemporaryDirectory(prefix='stackpilot-build-secrets-') as directory:
        command=['docker','build','--pull=false','--memory',memory,'--build-arg','STACKPILOT_BACKEND_BUILD_PARALLELISM='+parallel,'-t',image]
        for key,value in values.items():
            target=Path(directory)/key
            descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(descriptor,'w') as output:output.write(value)
            command+=['--secret','id='+key+',src='+str(target)]
        command.append(str(source))
        process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,env={**os.environ,'DOCKER_BUILDKIT':'1'})
        def stop(*_):raise KeyboardInterrupt()
        previous=signal.signal(signal.SIGTERM,stop)
        try:
            for line in process.stdout:print(redact(line,values),end='',flush=True)
            return process.wait()
        finally:
            signal.signal(signal.SIGTERM,previous)
            if process.poll() is None:
                process.terminate()
                try:process.wait(timeout=3)
                except subprocess.TimeoutExpired:process.kill();process.wait()
            process.stdout.close()


if __name__=='__main__':
    try:sys.exit(build(*sys.argv[1:]))
    except KeyboardInterrupt:sys.exit(130)
    except Exception as exc:
        print('Build secret adapter failed: '+type(exc).__name__,flush=True);sys.exit(1)
