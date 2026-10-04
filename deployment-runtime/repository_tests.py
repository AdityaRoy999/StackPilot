"""Run declared/discovered tests in an isolated image; preserve real exit codes."""
import json
import os
from pathlib import Path
import subprocess
import sys
try:
    from repository_toolchains import wrapper_command
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'ai-service'/'app'))
    from repository_toolchains import wrapper_command


def commands(root):
    contract=json.loads((root/'stackpilot.json').read_text()) if (root/'stackpilot.json').is_file() else {}
    if contract.get('version')==2:
        from repository_plan import normalize
        contract,_=normalize(root,contract)
    explicit=contract.get('tests')
    if explicit is not None:return explicit
    if (root/'package.json').is_file():
        package=json.loads((root/'package.json').read_text())
        if package.get('scripts',{}).get('test'):
            # CI=true disables interactive watch modes in common test runners.
            return [['node',str(root/'.stackpilot-runtime/node_tasks.cjs'),'test']]
    if any(root.glob('test*.py')) or (root/'tests').is_dir() and any((root/name).is_file() for name in ('requirements.txt','pyproject.toml','setup.py')):
        return [['python','-m','pytest','-q']]
    if (root/'go.mod').is_file():return [['go','test','./...']]
    if (root/'Cargo.toml').is_file():return [['cargo','test',*(['--locked'] if (root/'Cargo.lock').is_file() else [])]]
    if (root/'pom.xml').is_file():return [wrapper_command('mvnw','verify')] if (root/'mvnw').is_file() else [['mvn','verify']]
    if any((root/name).is_file() for name in ('build.gradle','build.gradle.kts')):
        return [wrapper_command('gradlew','build','--no-daemon')] if (root/'gradlew').is_file() else [['gradle','build']]
    if (root/'pubspec.yaml').is_file():return [['flutter','test']]
    if (root/'CMakeLists.txt').is_file():
        found=subprocess.run(['ctest','--test-dir','build','--show-only=json-v1'],cwd=root,capture_output=True,text=True,check=True,timeout=30)
        if json.loads(found.stdout).get('tests'):return [['ctest','--test-dir','build','--output-on-failure']]
    return []


def test(root):
    config=json.loads((root/'stackpilot.json').read_text()) if (root/'stackpilot.json').is_file() else {}
    if config.get('version')==2:
        from repository_plan import normalize
        config,_=normalize(root,config)
    tasks=commands(root)
    if not tasks and config.get('tests_required'):
        raise RuntimeError('Required repository tests are not configured')
    os.environ['CI']='true'
    results=[]
    for command in tasks:
        if not isinstance(command,list) or not command or any(not isinstance(a,str) for a in command):
            raise ValueError('Tests must be executable argument arrays')
        result=subprocess.run(command,cwd=root,timeout=int(os.getenv('TEST_STAGE_TIMEOUT','300')))
        results.append({'command':command,'exit_code':result.returncode,'passed':result.returncode==0})
        if result.returncode:
            (root/'.stackpilot-tests.json').write_text(json.dumps({'status':'failed','results':results}))
            raise RuntimeError('Repository test failed; build must not be promoted')
    evidence={'status':'passed' if tasks else 'not_configured','results':results,'scope':'repository_tests'}
    (root/'.stackpilot-tests.json').write_text(json.dumps(evidence))
    return evidence


if __name__=='__main__':
    print(json.dumps(test(Path.cwd())))
