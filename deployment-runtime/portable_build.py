"""Framework-independent build recipes. Execute only in the build container."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import zipfile
from repository_tests import test


def recipe(config, workload):
    value = config.get('build_recipe')
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError('build_recipe must be an object')
    image = value.get('image')
    runtime = value.get('runtime_image', image)
    for ref in (image, runtime):
        if not isinstance(ref, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}', ref):
            raise ValueError('Build and runtime images must be Docker image references')
    commands = value.get('commands')
    if not isinstance(commands, list) or not 0 < len(commands) <= 32:
        raise ValueError('Declare a bounded list of build commands')
    setup=value.get('runtime_setup',[])
    if not isinstance(setup,list) or len(setup)>16:
        raise ValueError('runtime_setup must be a bounded list of commands')
    for command in commands + setup + ([value.get('runtime_command')] if workload not in {'artifact','package'} else []):
        if not isinstance(command, list) or not command or any(not isinstance(a, str) or not a or '\0' in a for a in command):
            raise ValueError('Commands must be nonempty executable argument arrays')
    outputs = value.get('outputs')
    if not isinstance(outputs, list) or not 0 < len(outputs) <= 32:
        raise ValueError('Declare the build output files/directories')
    for output in outputs:
        if not isinstance(output, str) or not output or '\\' in output or '\0' in output:
            raise ValueError('Outputs must be relative source paths')
        path = PurePosixPath(output)
        if path.is_absolute() or '..' in path.parts or path == PurePosixPath('.'):
            raise ValueError('Outputs must remain within a specific build output directory')
    if workload not in {'web','api','cli','job','package','worker','tcp','grpc','artifact','desktop'}:
        raise ValueError('Portable recipes run on Linux; native mobile/Windows/macOS need their platform adapter')
    return {**value, 'runtime_image': runtime}


def dockerfile(config, workload):
    value = recipe(config, workload)
    if value is None:
        return None
    # The supplied toolchain must be Linux and support Python for trusted gates.
    text = f"FROM {value['image']} AS builder\nWORKDIR /source\n"
    text += 'RUN command -v python3 || (command -v apt-get && apt-get update && apt-get install -y --no-install-recommends python3) || (command -v apk && apk add --no-cache python3)\n'
    text += 'COPY . .\nRUN python3 .stackpilot-runtime/portable_build.py\n'
    if workload in {'artifact','package'}:
        text += 'FROM python:3.12-slim\nCOPY --from=builder /stackpilot-output/artifacts /artifacts\n'
        text += 'COPY .stackpilot-runtime/artifact_server.py /preview/server.py\nENV ARTIFACT_ROOT=/artifacts PORT=3000\nUSER 65534:65534\nEXPOSE 3000\nCMD ["python", "/preview/server.py"]\n'
    else:
        text += f"FROM {value['runtime_image']}\nWORKDIR /app\n"
        if workload == 'desktop':
            text += 'RUN apt-get update && apt-get install -y --no-install-recommends python3 xvfb openbox x11vnc novnc websockify wmctrl x11-utils fonts-dejavu-core libgl1 libfontconfig1 && rm -rf /var/lib/apt/lists/*\n'
            text += 'COPY .stackpilot-runtime/desktop_entrypoint.py /preview/entrypoint.py\n'
            for command in value.get('runtime_setup',[]):text += 'RUN '+json.dumps(command)+'\n'
            text += 'ENV STACKPILOT_APP_COMMAND=' + json.dumps(json.dumps(value['runtime_command'])) + '\nENV HOME=/tmp\nUSER 65534:65534\nEXPOSE 3000\nCMD ["python3", "/preview/entrypoint.py"]\n'
        elif workload in {'cli','job'}:
            text += 'RUN command -v python3 || (command -v apt-get && apt-get update && apt-get install -y --no-install-recommends python3) || (command -v apk && apk add --no-cache python3)\n'
            for command in value.get('runtime_setup',[]):text += 'RUN '+json.dumps(command)+'\n'
            text += 'COPY .stackpilot-runtime/console_server.py /preview/console_server.py\nCOPY .stackpilot-plan.json stackpilot.json /app/\n'
            text += 'ENV PORT=3000\nUSER 65534:65534\nEXPOSE 3000\nCMD ["python3", "/preview/console_server.py"]\n'
        else:
            for command in value.get('runtime_setup',[]):text += 'RUN '+json.dumps(command)+'\n'
            if workload not in {'worker'}:
                port=config.get('port',3000)
                if not port:raise ValueError('Portable network services need an explicit port')
                text += f'ENV PORT={port}\nEXPOSE {port}\n'
            text += 'USER 65534:65534\nCMD ' + json.dumps(value['runtime_command']) + '\n'
        text += 'COPY --from=builder /stackpilot-output/data/ /app/\n'
        text += 'COPY --from=builder /stackpilot-output/tests.json /stackpilot-evidence/tests.json\n'
    return text


def build(root, destination):
    root = Path(root).resolve()
    config = json.loads((root/'stackpilot.json').read_text())
    if config.get('version') == 2:
        from repository_plan import normalize
        config,_ = normalize(root,config)
    value = recipe(config, config.get('workload','web'))
    if value is None:
        raise ValueError('No build recipe')
    for command in value['commands']:
        print(json.dumps({'stage':'portable_build','command':command}), flush=True)
        subprocess.run(command, cwd=root, check=True, timeout=int(os.getenv('BUILD_STAGE_TIMEOUT','1200')))
    evidence = test(root)
    destination = Path(destination)
    data = destination/'data'
    data.mkdir(parents=True)
    count = total = 0
    for output in value['outputs']:
        source = root/output
        if any(parent.is_symlink() for parent in [source,*source.parents] if parent.is_relative_to(root)):
            raise RuntimeError('Symlink output path refused')
        if not source.exists():raise RuntimeError('Build did not produce declared output: '+output)
        candidates = [source, *source.rglob('*')] if source.is_dir() else [source]
        for path in candidates:
            if path.is_symlink() or not path.resolve().is_relative_to(root):
                raise RuntimeError('Symlink or escaping build output refused')
            relative = path.relative_to(root)
            if any(part in {'.git','.env','.stackpilot-runtime'} or part.startswith('.env.') for part in relative.parts):
                raise RuntimeError('Private/source configuration cannot be exported')
            if path.is_file():
                count += 1;total += path.stat().st_size
                if count > 10000 or total > 2*1024**3:raise RuntimeError('Build output exceeds export bounds')
                target = data/relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path,target)
    if not count:raise RuntimeError('Build produced no exportable files')
    (destination/'tests.json').write_text(json.dumps(evidence))
    artifacts=destination/'artifacts';artifacts.mkdir()
    with zipfile.ZipFile(artifacts/'application.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for path in data.rglob('*'):
            if path.is_file():archive.write(path,path.relative_to(data))
    digest=hashlib.sha256()
    with (artifacts/'application.zip').open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
    (artifacts/'manifest.json').write_text(json.dumps({**evidence,'build':'passed','scope':'repository_tests',
        'artifacts':['application.zip'],'sha256':{'application.zip':digest.hexdigest()},'device_workflows':'unverified'}))
    return evidence


if __name__ == '__main__':
    build(Path.cwd(),'/stackpilot-output')
