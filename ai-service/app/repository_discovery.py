"""Bounded, read-only repository evidence. Never imports or executes source."""
import ast
import json
import os
from pathlib import Path

SKIP = {'.git', 'node_modules', '.next', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build', '.stackpilot-runtime', '.gradle'}
MANIFESTS = {'package.json': 'node', 'pyproject.toml': 'python', 'requirements.txt': 'python',
             'go.mod': 'go', 'Cargo.toml': 'rust', 'pom.xml': 'java', 'build.gradle': 'java',
             'build.gradle.kts': 'java', 'CMakeLists.txt': 'cmake', 'composer.json': 'php', 'Gemfile': 'ruby',
             'setup.py': 'python', 'setup.cfg': 'python', 'go.work': 'go'}
WEB_IMPORTS = {'flask', 'fastapi', 'django', 'streamlit', 'gradio', 'dash', 'aiohttp', 'tornado', 'bottle', 'sanic'}


def analyze(root, max_files=20000):
    try:
        from .repository_toolchains import discover as discover_toolchains, wrapper_command
    except ImportError:
        from repository_toolchains import discover as discover_toolchains, wrapper_command
    root = Path(root).resolve()
    if not root.is_dir() or type(max_files) is not int or not 1 <= max_files <= 20000:
        raise ValueError('Discovery requires a repository directory and a bounded file budget')
    components, python, issues = {}, [], []
    python_tests = False
    count, truncated = 0, False
    for current, directories, files in os.walk(root, followlinks=False):
        directory = Path(current)
        directories[:] = sorted(d for d in directories if d not in SKIP and not (directory/d).is_symlink())
        if len(directory.relative_to(root).parts) >= 16 and directories:
            issues.append('Repository depth exceeds discovery budget; select a component root explicitly')
            directories[:] = []
            truncated = True
        for name in sorted(files):
            count += 1
            if count > max_files:
                truncated = True
                break
            path = directory/name
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024*1024:
                continue
            relative = path.relative_to(root).as_posix()
            if name.endswith('.py') and (name.startswith('test_') or any(p in {'tests','test'} for p in path.relative_to(root).parts)):
                python_tests = True
            language = MANIFESTS.get(name)
            if name.endswith('.csproj'): language = 'dotnet'
            if language or name in {'Dockerfile', 'compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'}:
                key = directory.relative_to(root).as_posix()
                item = components.setdefault(key, {'root': key, 'languages': [], 'manifests': []})
                item['manifests'].append(relative)
                if language and language not in item['languages']: item['languages'].append(language)
            if name.endswith('.py') and not name.startswith('test_') and not any(p in {'tests', 'test'} for p in path.relative_to(root).parts):
                try:
                    tree = ast.parse(path.read_text(encoding='utf-8-sig'))
                except (SyntaxError, UnicodeError) as exc:
                    issues.append(relative+': '+type(exc).__name__)
                    continue
                imports = {n.module.split('.')[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
                imports.update(a.name.split('.')[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names)
                calls = {n.func.id if isinstance(n.func, ast.Name) else n.func.attr if isinstance(n.func, ast.Attribute) else ''
                         for n in ast.walk(tree) if isinstance(n, ast.Call)}
                main = any(isinstance(n, ast.Compare) and isinstance(n.left, ast.Name) and n.left.id == '__name__'
                           and any(isinstance(c, ast.Constant) and c.value == '__main__' for c in n.comparators) for n in ast.walk(tree))
                top_level = any(isinstance(n, ast.Expr) and isinstance(n.value, ast.Call) or isinstance(n, (ast.While, ast.Try)) for n in tree.body)
                python.append({'path': relative, 'imports': sorted(imports), 'web': bool(imports & WEB_IMPORTS),
                               'interactive': 'input' in calls, 'command_line': bool(imports & {'argparse', 'click', 'typer', 'fire'}),
                               'executable': main or top_level})
        if truncated and count > max_files: break
    config_path = root/'stackpilot.json'
    config = {}
    if config_path.is_file() and not config_path.is_symlink():
        try: config = json.loads(config_path.read_text())
        except (ValueError, UnicodeError): issues.append('stackpilot.json is not valid JSON')
    if not isinstance(config, dict): config = {}; issues.append('stackpilot.json must be an object')
    selected = config
    if config.get('version') == 2 and isinstance(config.get('components'),list):
        matches=[item for item in config['components'] if isinstance(item,dict) and item.get('id')==config.get('primary_component')]
        if len(matches)==1:selected={**config,**matches[0]}
    web = [p for p in python if p['web']]
    cli = [p for p in python if p['interactive'] or p['command_line']]
    # Root-level entrypoints only: nested components are selected explicitly.
    candidates = [p for p in cli if '/' not in p['path'] and p['executable']]
    workload, confidence = ('web', 'framework') if web else ('cli', 'source') if len(candidates) == 1 else ('unknown', 'insufficient')
    entrypoint = ['python', '-u', candidates[0]['path']] if workload == 'cli' else None
    node_bins=[];discovered_tests=[]
    package_path=root/'package.json'
    if package_path.is_file() and not package_path.is_symlink() and package_path.stat().st_size <= 1024*1024:
        try:
            package=json.loads(package_path.read_text(encoding='utf-8-sig'))
            if isinstance(package,dict) and package.get('scripts',{}).get('test'):
                manager=str(package.get('packageManager','')).split('@')[0] or ('pnpm' if (root/'pnpm-lock.yaml').is_file() else 'yarn' if (root/'yarn.lock').is_file() else 'bun' if any((root/name).is_file() for name in ('bun.lock','bun.lockb')) else 'npm')
                if manager in {'npm','pnpm','yarn','bun'}:discovered_tests=[[manager,'run','test']]
            bins=package.get('bin',{}) if isinstance(package,dict) else {}
            bins=[bins] if isinstance(bins,str) else list(bins.values()) if isinstance(bins,dict) else []
            frameworks={'next','nuxt','express','fastify','koa','react','vue','svelte','@angular/core','vite','gatsby'}
            dependencies={**package.get('dependencies',{}),**package.get('devDependencies',{})}
            if not frameworks & dependencies.keys():
                for binary in bins:
                    if not isinstance(binary,str):continue
                    path=(root/binary).resolve()
                    if path.is_relative_to(root) and not (root/binary).is_symlink() and path.is_file() and path.suffix in {'.js','.cjs','.mjs'}:
                        node_bins.append(path.relative_to(root).as_posix())
            node_bins=list(dict.fromkeys(node_bins))
        except (ValueError,AttributeError,TypeError,UnicodeError): issues.append('package.json has an invalid package/bin contract')
    if not web and not candidates and len(node_bins)==1:
        workload,confidence,entrypoint='cli','package_bin',['node',node_bins[0]]
    elif len(node_bins)>1 or node_bins and candidates:
        workload,confidence,entrypoint='unknown','ambiguous',None
        issues.append('Multiple executable candidates; declare workload and entrypoint')
    if 'workload' in selected: workload, confidence = selected['workload'], 'declared'
    if selected.get('entrypoint'):
        declared = selected['entrypoint']
        if isinstance(declared, list) and declared and all(isinstance(a, str) and a and '\0' not in a for a in declared):
            entrypoint = declared
            if 'workload' not in selected and declared[0].split('/')[-1] in {'python','python3'}:
                target = next((p for p in python if p['path'] in declared[1:]), None)
                if target and target['interactive'] and not target['web']:
                    workload, confidence = 'cli', 'declared_entrypoint_source'
        else: issues.append('entrypoint must be a nonempty argument array, for example ["python", "app.py"]')
    if len(candidates) > 1: issues.append('Multiple CLI candidates; declare entrypoint')
    if not discovered_tests:
        if (root/'go.mod').is_file():discovered_tests=[['go','test','./...']]
        elif (root/'Cargo.toml').is_file():discovered_tests=[['cargo','test',*(['--locked'] if (root/'Cargo.lock').is_file() else [])]]
        elif (root/'pom.xml').is_file():discovered_tests=[wrapper_command('mvnw','verify')] if (root/'mvnw').is_file() else [['mvn','verify']]
        elif any((root/name).is_file() for name in ('build.gradle','build.gradle.kts')):discovered_tests=[wrapper_command('gradlew','build','--no-daemon')] if (root/'gradlew').is_file() else [['gradle','build']]
        elif python_tests:discovered_tests=[['python','-m','pytest','-q']]
    if len(components)>128: truncated=True;issues.append('More than 128 components; select a deployment root')
    toolchains = discover_toolchains(root,nested=True)
    for item in components.values():
        item['toolchains'] = toolchains if item['root'] == '.' else discover_toolchains(root/item['root'])
    issues.extend(kind['kind']+': '+issue for kind in toolchains for issue in kind['issues'])
    return {'version': 1, 'workload': workload, 'confidence': confidence, 'entrypoint': entrypoint,
            'components': list(components.values())[:128], 'python': python[:128], 'issues': issues[:64],
            'toolchains': toolchains,
            'files_scanned': count, 'truncated': truncated,
            'delivery': 'interactive_console' if workload == 'cli' else 'job_results' if workload == 'job' else
                        'artifact_download' if workload in {'artifact', 'package'} else 'application_endpoint',
            'testing': {'declared_commands': selected.get('tests', []), 'discovered_commands':discovered_tests,
                        'console_scenarios': selected.get('console_scenarios', []),
                        'business_behavior_verified': False}}
