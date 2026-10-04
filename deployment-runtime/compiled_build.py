"""Build executable targets from compiler metadata, never directory order."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
from select_entrypoint import dotnet_project


def run(argv, **kwargs):
    return subprocess.run(argv,check=True,timeout=1200,**kwargs)


def build(kind, root):
    config=json.loads((root/'stackpilot.json').read_text()) if (root/'stackpilot.json').is_file() else {}
    test_commands=[]
    if kind=='go':
        # go list emits concatenated JSON objects, including nested cmd roots.
        output=run(['go','list','-json','./...'],capture_output=True,text=True).stdout
        decoder=json.JSONDecoder();packages=[]
        while output.strip():
            value,end=decoder.raw_decode(output.lstrip());packages.append(value);output=output.lstrip()[end:]
        choices=[p['ImportPath'] for p in packages if p.get('Name')=='main']
        selected=config.get('go_package')
        if selected:
            if selected not in choices:raise ValueError('go_package is not a runnable package reported by go list')
        elif len(choices)==1:selected=choices[0]
        else:raise ValueError('Select go_package in stackpilot.json; zero or multiple main packages found')
        run(['go','test','./...'])
        test_commands.append(['go','test','./...'])
        Path('/artifacts').mkdir(exist_ok=True)
        run(['go','build','-o','/artifacts/server',selected])
    elif kind=='rust':
        locked = ['--locked'] if (root/'Cargo.lock').is_file() else []
        run(['cargo','test',*locked])
        test_commands.append(['cargo','test',*locked])
        output=run(['cargo','build','--release',*locked,'--message-format=json'],capture_output=True,text=True).stdout
        choices=[]
        for line in output.splitlines():
            value=json.loads(line)
            if value.get('reason')=='compiler-artifact' and value.get('executable') and 'bin' in value.get('target',{}).get('kind',[]) and not value.get('profile',{}).get('test'):
                choices.append((value['target']['name'],value['executable']))
        selected=[p for name,p in choices if name==config['rust_binary']] if config.get('rust_binary') else [p for name,p in choices]
        if len(selected)!=1:raise ValueError('Select rust_binary in stackpilot.json; zero or multiple release binaries found')
        Path('/artifacts').mkdir(exist_ok=True);shutil.copy2(selected[0],'/artifacts/server')
    elif kind=='dotnet':
        project=dotnet_project(root)
        # Test the solution when unique, otherwise each declared test project.
        solutions=list(root.glob('*.sln'))+list(root.glob('*.slnx'))
        if len(solutions)==1:
            command=['dotnet','test',str(solutions[0]),'-c','Release'];run(command);test_commands.append(command)
        else:
            for path in root.glob('**/*.csproj'):
                if 'test' in path.stem.lower():
                    command=['dotnet','test',str(path),'-c','Release'];run(command);test_commands.append(command)
        run(['dotnet','publish',str(project),'-c','Release','-o','/app/out','/p:UseAppHost=false'])
    else:raise ValueError('Unsupported compiler lane')
    target=Path('/app/out' if kind=='dotnet' else '/artifacts')
    evidence={'status':'passed' if test_commands else 'not_configured','scope':'repository_test_commands','results':[{'command':c,'exit_code':0} for c in test_commands]}
    (target/'.stackpilot-tests.json').write_text(json.dumps(evidence))
    if kind in {'go','rust'}:
        (target/'.stackpilot-entry.json').write_text(json.dumps(config.get('entrypoint') or ['/app/server']))


if __name__=='__main__':build(sys.argv[1],Path.cwd())
