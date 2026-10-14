"""Evidence-based delivery defaults; submitted recipes keep their authority."""
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from repository_tests import commands


def go_prebuilt(root, discovery):
    """Recognize a packaging-only Go Dockerfile, never rewrite a build recipe."""
    path=root/'Dockerfile'
    if not (root/'go.mod').is_file() or not path.is_file() or path.is_symlink() or path.stat().st_size>65536:return None
    text=path.read_text();lines=[line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith('#')]
    if len(lines)!=3 or not re.fullmatch(r'FROM [A-Za-z0-9][A-Za-z0-9._/:@-]*',lines[0]):return None
    copy=re.fullmatch(r'COPY ([A-Za-z0-9_.-]+) (/[^\s]+)',lines[1])
    if not copy or (root/copy[1]).exists():return None
    try:entry=json.loads(lines[2].removeprefix('ENTRYPOINT '))
    except ValueError:return None
    if not lines[2].startswith('ENTRYPOINT ') or not isinstance(entry,list) or not entry or entry[0]!=copy[2] or any(not isinstance(a,str) or '\0' in a for a in entry):return None
    sdk=next((t for t in discovery['toolchains'] if t['kind']=='go'),None)
    if not sdk or sdk['status']!='selected':raise ValueError('Packaging-only Go source needs a compatible compiler')
    return {'source':copy[1],'destination':copy[2],'entrypoint':entry,'image':sdk['image'],'original':text}


def infer(root, config, discovery):
    root=Path(root);result=dict(config)
    prebuilt=go_prebuilt(root,discovery)
    workload=result.get('workload',discovery.get('workload'))
    if workload=='android' and not (root/'gradlew').is_file() and (root/'android/gradlew').is_file():
        result['android']={'project_root':'android',**result.get('android',{})}
        if (root/'package.json').is_file():
            package=json.loads((root/'package.json').read_text());dependencies={**package.get('dependencies',{}),**package.get('devDependencies',{})}
            if any(key in dependencies for key in ('react-native','@capacitor/core','@nativescript/core')):
                sdk=next((t for t in discovery['toolchains'] if t['kind']=='node'),None)
                if not sdk or sdk['status']!='selected':raise ValueError('Native JavaScript Android build needs compatible Node evidence')
                result.update(adapter='android-js',android_node_image=sdk['image'])
    if 'workload' not in result and workload in {'desktop','package','cli'} and (not (root/'Dockerfile').exists() or prebuilt):result['workload']=workload
    if prebuilt and workload=='cli':
        result.update(adapter='go-packaging-prebuild',go_prebuilt=prebuilt,workload='cli')
        if not result.get('entrypoint'):result['entrypoint']=prebuilt['entrypoint']
    if workload=='desktop' and discovery.get('confidence')=='gui_source' and not result.get('entrypoint'):
        result['entrypoint']=discovery['entrypoint']
        result['desktop_framework']='python-gui'
    if workload=='package' and not result.get('build_recipe') and (root/'pyproject.toml').is_file():
        python=next((t for t in discovery.get('toolchains',[]) if t['kind']=='python'),None)
        if python and python['status']!='selected':raise ValueError('Python package needs compatible version evidence')
        image=python['image'] if python else 'python:3.12-slim'
        build=[['python','-m','pip','install','--no-input','build'],['python','-m','pip','install','--no-input','-e','.']]
        tests=commands(root)
        if any('pytest' in argv for argv in tests):build.append(['python','-m','pip','install','--no-input','pytest'])
        build.append(['python','-m','build'])
        result['build_recipe']={'image':image,'commands':build,'outputs':['dist'],'artifact_files':['dist/*.whl','dist/*.tar.gz']}
        result['adapter']='python-package'
    if workload=='package' and not result.get('build_recipe') and (root/'package.json').is_file():
        sdk=next((t for t in discovery.get('toolchains',[]) if t['kind']=='node'),None)
        if not sdk or sdk['status']!='selected':raise ValueError('npm package needs compatible Node version evidence')
        package=json.loads((root/'package.json').read_text())
        setup=[['node','.stackpilot-runtime/node_tasks.cjs','install']]
        if package.get('scripts',{}).get('build'):setup.append(['node','.stackpilot-runtime/node_tasks.cjs','build'])
        setup.append(['python3','.stackpilot-runtime/npm_package.py'])
        result['build_recipe']={'image':sdk['image'],'commands':setup, 'outputs':['stackpilot-output/packages'],'artifact_files':['stackpilot-output/packages/*.tgz']}
        result['adapter']='npm-package'
    # Cross-compilation delivers a Windows bundle; Windows execution/signing
    # remains a separate worker requirement. Explicit native-preview contracts
    # never silently switch to cross compilation.
    projects=[root/result['project']] if result.get('project') else list(root.glob('*.csproj'))
    if len(projects)==1 and not (root/'Dockerfile').exists() and not result.get('build_recipe'):
        values={n.tag.rsplit('}',1)[-1]:(n.text or '') for n in ET.parse(projects[0]).getroot().iter()}
        if values.get('OutputType')=='WinExe' and (values.get('UseWpf')=='true' or values.get('UseWindowsForms')=='true'):
            if 'workload' not in config:result.update(workload='windows',delivery='artifact')
            if result.get('workload')=='windows' and result.get('delivery')=='artifact' and not result.get('native_preview_required') and not result.get('native_scenarios'):
                sdk=next((t for t in discovery.get('toolchains',[]) if t['kind']=='dotnet'),None)
                if not sdk or sdk['status']!='selected':raise ValueError('Windows cross-build needs a compatible .NET SDK and selected project')
                result.update(adapter='dotnet-windows-crossbuild',target={'os':'windows','arch':result.get('target',{}).get('arch','amd64')},project=projects[0].relative_to(root).as_posix())
                result['build_recipe']={'image':sdk['image'],'commands':[['python3','.stackpilot-runtime/windows_crossbuild.py']], 'outputs':['stackpilot-output/windows'],'artifact_files':['stackpilot-output/windows/*.exe']}
    return result


def go_prebuilt_dockerfile(config,cache_id=None):
    value=config.get('go_prebuilt')
    if config.get('adapter')!='go-packaging-prebuild' or not value:return None
    # The original runtime is still built, including its actual COPY contract.
    original=value['original']
    original=re.sub(r'^(FROM [^\n]+)$',r'\1 AS stackpilot-original',original,flags=re.M)
    original=re.sub(r'^COPY [^\n]+$',f'COPY --from=stackpilot-go /artifacts/server {value["destination"]}',original,flags=re.M)
    text=f'# Generated by StackPilot Linux recipes: Go packaging prebuild\nFROM {value["image"]} AS stackpilot-go\n'
    text+='RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*\nWORKDIR /app\nCOPY . .\nENV CGO_ENABLED=0\n'
    if cache_id is None:
        import uuid
        cache_id='stackpilot-'+uuid.uuid4().hex
    text+=f'RUN --mount=type=cache,id={cache_id}-gomod,sharing=locked,target=/go/pkg/mod --mount=type=cache,id={cache_id}-gobuild,sharing=locked,target=/root/.cache/go-build python3 .stackpilot-runtime/compiled_build.py go && python3 .stackpilot-runtime/repository_tests.py && python3 .stackpilot-runtime/cli_package.py\n'
    text+=original+'\nFROM python:3.12-slim\nWORKDIR /app\n'
    text+=f'COPY --from=stackpilot-original {value["destination"]} {value["destination"]}\nCOPY --from=stackpilot-go /artifacts/server /app/server\n'
    text+='COPY --from=stackpilot-go /artifacts/application-linux.tar.gz /artifacts/application-linux.tar.gz\nCOPY --from=stackpilot-go /app/.stackpilot-tests.json /stackpilot-evidence/tests.json\nCOPY .stackpilot-runtime /app/.stackpilot-runtime\nCOPY .stackpilot-plan.json /app/.stackpilot-plan.json\n'
    text+='ENV PORT=3000 HOME=/tmp ARTIFACT_ROOT=/artifacts\nUSER 65534:65534\nEXPOSE 3000\nCMD ["python3","/app/.stackpilot-runtime/console_server.py"]\n'
    return text


def python_desktop_dockerfile(contract):
    entry=contract.get('entrypoint')
    if contract.get('desktop_framework')!='python-gui' or not entry:return None
    selected=contract.get('toolchain') or {};image=selected.get('image') or 'python:3.12-slim'
    # Identical Python images keep the dependency ABI consistent. Runtime setup
    # happens before applying the unprivileged application UID.
    return (f'# Generated by StackPilot Linux recipes: Python GUI\nFROM {image} AS builder\nWORKDIR /app\nCOPY . .\n'
            'RUN python3 .stackpilot-runtime/linux_build.py python\n'
            f'FROM {image}\nRUN apt-get update && apt-get install -y --no-install-recommends libtk8.6 xvfb openbox x11vnc novnc websockify x11-utils fonts-dejavu-core libgl1 libfontconfig1 && rm -rf /var/lib/apt/lists/*\n'
            'COPY --from=builder /usr/local /usr/local\nCOPY --from=builder /app /app\n'
            'ENV HOME=/tmp STACKPILOT_APP_COMMAND='+json.dumps(json.dumps(entry))+'\n'
            'WORKDIR /app\nUSER 65534:65534\nEXPOSE 3000\nCMD ["python3","/app/.stackpilot-runtime/desktop_entrypoint.py"]\n')
