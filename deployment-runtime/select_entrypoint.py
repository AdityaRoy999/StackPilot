"""Select declared executable targets; refuse filesystem-order ambiguity."""
import json
import ast
from pathlib import Path
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET


def select(root, candidates):
    config = json.loads((root/'stackpilot.json').read_text()) if (root/'stackpilot.json').is_file() else {}
    declared = config.get('entrypoint')
    if declared:
        if not isinstance(declared,list) or not declared or any(not isinstance(p,str) or not p for p in declared):
            raise ValueError('entrypoint must be an argument array')
        return declared
    # CTest registers test binaries; they must never become application targets.
    choices = list(dict.fromkeys(tuple(c) for c in candidates))
    if len(choices)!=1:
        raise ValueError('Exactly one runnable application target is required; declare entrypoint in stackpilot.json to resolve ambiguity')
    return list(choices[0])


def cmake(root):
    build=root/'build'
    response=subprocess.run(['ctest','--test-dir',str(build),'--show-only=json-v1'],check=True,capture_output=True,text=True)
    tests=json.loads(response.stdout).get('tests',[])
    test_binaries={str(Path(t['command'][0]).resolve()) for t in tests if t.get('command')}
    index=json.loads(sorted((build/'.cmake/api/v1/reply').glob('index-*.json'))[-1].read_text())
    reply=index['reply']['codemodel-v2']['jsonFile']
    codemodel=json.loads((build/'.cmake/api/v1/reply'/reply).read_text())
    candidates=[]
    for target in codemodel['configurations'][0]['targets']:
        detail=json.loads((build/'.cmake/api/v1/reply'/target['jsonFile']).read_text())
        if detail.get('type')!='EXECUTABLE':continue
        for artifact in detail.get('artifacts',[]):
            path=(build/artifact['path']).resolve()
            if str(path) not in test_binaries:
                candidates.append([str(path)])
    return select(root,candidates)


def java(root):
    candidates=[]
    for path in root.glob('**/*.jar'):
        if not any(p in {'target','libs'} for p in path.parts) or 'plain' in path.name:continue
        with zipfile.ZipFile(path) as archive:
            try:manifest=archive.read('META-INF/MANIFEST.MF').decode()
            except KeyError:continue
            if '\nMain-Class:' in '\n'+manifest:candidates.append(['java','-jar',str(path)])
    return select(root,candidates)


def dotnet(root):
    candidates=[]
    # runtimeconfig identifies an executable application, unlike arbitrary DLLs.
    for path in root.glob('out/*.runtimeconfig.json'):
        binary=path.with_name(path.name.removesuffix('.runtimeconfig.json')+'.dll')
        if binary.is_file():candidates.append(['dotnet',str(binary)])
    return select(root,candidates)


def python_app(root):
    plan_path = root/'.stackpilot-plan.json'
    if plan_path.is_file():
        plan = json.loads(plan_path.read_text())
        if plan.get('workload') in {'cli','job'} and plan.get('entrypoint'):
            return select(root, [plan['entrypoint']])
    candidates=[]
    for path in root.glob('*.py'):
        tree=ast.parse(path.read_text(encoding='utf-8'))
        imports={n.module.split('.')[0] for n in ast.walk(tree) if isinstance(n,ast.ImportFrom) and n.module}
        imports.update(a.name.split('.')[0] for n in ast.walk(tree) if isinstance(n,ast.Import) for a in n.names)
        applications=[]
        for n in ast.walk(tree):
            if isinstance(n,ast.Assign) and isinstance(n.value,ast.Call):
                constructor=n.value.func
                name=constructor.id if isinstance(constructor,ast.Name) else constructor.attr if isinstance(constructor,ast.Attribute) else ''
                if name in {'FastAPI','Flask'}:
                    applications.extend((t.id,name) for t in n.targets if isinstance(t,ast.Name))
        for variable,framework in applications:
            candidates.append(['python','-m','uvicorn',f'{path.stem}:{variable}','--host','0.0.0.0','--port','3000'] if framework=='FastAPI' else ['python','-m','flask','--app',f'{path.stem}:{variable}','run','--host=0.0.0.0','--port=3000'])
        if 'streamlit' in imports:
            candidates.append(['python','-m','streamlit','run',str(path),'--server.address=0.0.0.0','--server.port=3000'])
    if (root/'manage.py').is_file():
        raise ValueError('Django requires a declared production WSGI/ASGI entrypoint; development runserver is not a production fallback')
    return select(root,candidates)


def dotnet_project(root):
    config=json.loads((root/'stackpilot.json').read_text()) if (root/'stackpilot.json').is_file() else {}
    declared=config.get('project')
    candidates=[]
    for path in root.glob('**/*.csproj'):
        if any(p in {'obj','bin'} for p in path.parts):continue
        xml=ET.parse(path).getroot()
        values={e.tag.rsplit('}',1)[-1]:e.text for e in xml.iter()}
        if values.get('IsTestProject','').lower()=='true':continue
        if xml.get('Sdk','').startswith('Microsoft.NET.Sdk.Web') or values.get('OutputType') in {'Exe','WinExe'}:
            candidates.append(path)
    if declared:
        path=(root/declared).resolve()
        if not path.is_relative_to(root) or path not in candidates:raise ValueError('Declared .NET project must be a runnable project within the source root')
        return path
    if len(candidates)!=1:raise ValueError('Multiple or no executable .NET projects; declare project in stackpilot.json')
    return candidates[0]


if __name__=='__main__':
    kind,root,output=sys.argv[1:]
    root=Path(root).resolve()
    argv={'cmake':cmake,'java':java,'dotnet':dotnet,'python':python_app}[kind](root)
    Path(output).write_text(json.dumps(argv))
