"""Build inside an isolated Linux image and record executable entrypoint/tests."""
import json
from pathlib import Path
import shutil
import subprocess
import sys

from repository_tests import test
from select_entrypoint import java, python_app
try:
    from repository_toolchains import wrapper_command
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'ai-service'/'app'))
    from repository_toolchains import wrapper_command


def run(argv, root):
    subprocess.run(argv, cwd=root, check=True, timeout=1200)


def build(kind, root):
    root = Path(root).resolve()
    plan = json.loads((root/'.stackpilot-plan.json').read_text())
    entrypoint = plan.get('entrypoint')
    if kind == 'python':
        if (root/'requirements.txt').is_file(): run([sys.executable, '-m', 'pip', 'install', '--no-cache-dir', '-r', 'requirements.txt'], root)
        elif any((root/name).is_file() for name in ('pyproject.toml', 'setup.py')): run([sys.executable, '-m', 'pip', 'install', '--no-cache-dir', '.'], root)
        if not entrypoint: entrypoint = python_app(root)
    elif kind in {'node', 'node-static'}:
        task = str(root/'.stackpilot-runtime/node_tasks.cjs')
        run(['node', task, 'install'], root)
        package = json.loads((root/'package.json').read_text())
        scripts = package.get('scripts', {})
        if scripts.get('build'): run(['node', task, 'build'], root)
        if not entrypoint and scripts.get('start'): entrypoint = ['node', task, 'start']
        if kind == 'node-static':
            candidates = [root/name for name in ('dist', 'build', 'out') if (root/name/'index.html').is_file()]
            if len(candidates) != 1: raise ValueError('Static build requires exactly one compiled dist/build/out index.html; declare outputs in a build_recipe')
            candidate = candidates[0]
            if candidate.is_symlink() or any(path.is_symlink() for path in candidate.rglob('*')):
                raise ValueError('Static output must not contain symlinks')
            count = size = 0
            for path in candidate.rglob('*'):
                relative = path.relative_to(candidate)
                if any(part in {'.git', '.env', '.stackpilot-runtime'} or part.startswith('.env.') for part in relative.parts): raise ValueError('Private configuration cannot be exported as static output')
                if path.is_file():
                    count += 1; size += path.stat().st_size
                    if count>10000 or size>2*1024**3: raise ValueError('Static output exceeds export bounds')
            test(root)
            shutil.copytree(candidate, '/stackpilot-output', dirs_exist_ok=True)
            return
        if not entrypoint:
            raise ValueError('Node runtime requires a declared entrypoint or start script; declare a static build_recipe for static outputs')
    elif kind == 'java':
        if (root/'mvnw').is_file():
            run(wrapper_command('mvnw', 'package'), root)
        elif (root/'gradlew').is_file():
            run(wrapper_command('gradlew', 'build', '--no-daemon'), root)
        else: raise ValueError('Java default recipe requires its repository build wrapper')
        if not entrypoint: entrypoint = java(root)
    elif kind == 'ruby':
        run(['bundle', 'install'], root)
    elif kind == 'php':
        # Composer is a separate toolchain dependency. Do not install an
        # unsigned, moving installer or silently omit locked dependencies.
        if not shutil.which('composer'):
            raise ValueError('PHP dependencies require Composer; provide a tested build_recipe/runtime_setup')
        run(['composer', 'install', '--no-interaction', '--prefer-dist'], root)
    else: raise ValueError('Unsupported Linux build recipe')
    if not entrypoint: raise ValueError('No executable entrypoint was declared or independently discovered')
    evidence = test(root)
    (root/'.stackpilot-entry.json').write_text(json.dumps(entrypoint))
    return evidence


if __name__ == '__main__': build(sys.argv[1], Path.cwd())
