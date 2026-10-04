"""Read bounded version evidence without importing or running repository code.

The selected image is a build proposal, not proof that the image, dependencies,
or application work. Explicit Dockerfiles/recipes remain authoritative.
"""
import json
import os
import configparser
from pathlib import Path
import re
import shlex
try:
    import tomllib
except ModuleNotFoundError:
    try:
        import tomli as tomllib
    except ModuleNotFoundError:
        tomllib = None
import xml.etree.ElementTree as ET

DEFAULTS = {'node': '22', 'python': '3.12', 'go': '1.24', 'rust': '1',
            'java': '21', 'dotnet': '8.0', 'ruby': '3.3', 'php': '8.3'}
CANDIDATES = {'node': ['24', '22', '20', '18', '16', '14', '12'],
              'python': ['3.14', '3.13', '3.12', '3.11', '3.10', '3.9', '3.8', '3.7'],
              'ruby': ['3.4', '3.3', '3.2', '3.1', '3.0', '2.7'],
              'php': ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4']}
NUMBER = r'\d{1,3}(?:\.\d{1,3}){0,2}'


def toml_loads(content):
    if tomllib is None: raise ValueError('TOML version discovery requires Python 3.11 or the registered tomli parser')
    return tomllib.loads(content)


def read(root, name):
    path = root/name
    if not path.is_file(): return None
    if path.is_symlink() or not path.resolve().is_relative_to(root) or path.stat().st_size > 1024*1024:
        raise ValueError(name+': version evidence must be a bounded regular repository file')
    return path.read_text(encoding='utf-8-sig')


def numeric(value):
    value = str(value).strip().removeprefix('v')
    if not re.fullmatch(NUMBER, value):
        raise ValueError('Unsupported version expression: '+value[:128])
    return value


def tuple_version(value):
    parts = [int(p) for p in numeric(value).split('.')]
    return tuple((parts+[0, 0])[:3])


def satisfies(version, expression):
    """Common numeric PEP440/npm/composer ranges; unsupported forms fail closed."""
    if not isinstance(expression, str) or not 0 < len(expression) <= 256:
        raise ValueError('Version requirement must be bounded text')
    current = tuple_version(version)
    if expression.strip() in {'*', 'x', 'X'}: return True
    alternatives = expression.split('||')
    results = []
    for alternative in alternatives:
        value = alternative.strip()
        hyphen = re.fullmatch(r'('+NUMBER+r')\s+-\s+('+NUMBER+r')', value)
        if hyphen:
            results.append(tuple_version(hyphen[1]) <= current <= tuple_version(hyphen[2])); continue
        matches = list(re.finditer(r'(>=|<=|==|!=|~=|~>|~|\^|>|<|=)?\s*(\d{1,3}(?:\.(?:\d{1,3}|\*|[xX])){0,2})', value))
        residual = value
        for match in reversed(matches): residual = residual[:match.start()]+residual[match.end():]
        if not matches or residual.strip(' ,'):
            raise ValueError('Unsupported version constraint: '+expression[:128])
        passed = True
        for match in matches:
            operator, target = match[1] or '=', match[2]
            parts = target.split('.')
            wildcard = any(p in {'*', 'x', 'X'} for p in parts)
            prefix = tuple(int(p) for p in parts if p not in {'*', 'x', 'X'})
            padded = tuple((list(prefix)+[0, 0])[:3])
            if operator in {'=', '==', '!='}:
                equal = current[:len(prefix)] == prefix if wildcard or operator == '=' else current == padded
                passed &= not equal if operator == '!=' else equal
            elif wildcard:
                raise ValueError('Ordered wildcard constraints need an explicit numeric bound')
            elif operator == '>=': passed &= current >= padded
            elif operator == '>': passed &= current > padded
            elif operator == '<=': passed &= current <= padded
            elif operator == '<': passed &= current < padded
            else:
                if operator == '^':
                    index = next((i for i, part in enumerate(padded) if part), 2)
                else:
                    index = 0 if len(parts) == 1 or operator in {'~=', '~>'} and len(parts) == 2 else 1
                upper = list(padded); upper[index] += 1
                for i in range(index+1, 3): upper[i] = 0
                passed &= padded <= current < tuple(upper)
        results.append(passed)
    return any(results)


def image(kind, version):
    if kind == 'node': return 'node:'+version+('-bullseye-slim' if int(version.split('.')[0]) < 18 else '-bookworm-slim')
    if kind == 'python': return 'python:'+version+'-slim'
    if kind == 'go': return 'golang:'+version+'-bookworm'
    if kind == 'rust': return 'rust:'+version+'-bookworm'
    if kind == 'java': return 'eclipse-temurin:'+version+'-jdk'
    if kind == 'dotnet': return 'mcr.microsoft.com/dotnet/sdk:'+version
    if kind == 'ruby': return 'ruby:'+version+'-slim'
    if kind == 'php': return 'php:'+version+'-cli'
    raise ValueError('Unsupported toolchain')


def wrapper_command(name, *arguments):
    if name not in {'mvnw', 'gradlew'}: raise ValueError('Unknown repository build wrapper')
    # Windows checkouts can contain CRLF and lose executable mode. Derive a
    # private shell copy in the same directory, preserving $0-relative paths
    # and leaving protected repository bytes/mode unchanged for acceptance.
    script = 'wrapper="$(mktemp .stackpilot-'+name+'-verify.XXXXXX)"; trap \'rm -f "$wrapper"\' EXIT; '
    script += "sed 's/\\r$//' ./"+name+' > "$wrapper"; sh "$wrapper" '+shlex.join(arguments)
    return ['sh', '-ec', script]


def discover(root, nested=False):
    root = Path(root).resolve()
    if not root.is_dir(): raise ValueError('Toolchain discovery needs a repository directory')
    evidence, problems = {}, {}
    def add(kind, value, source, mode='pin'):
        if value is not None:
            if not isinstance(value, str) or not 0 < len(value) <= 256:
                problem(kind, ValueError(source+': version requirement must be bounded text')); return
            records = evidence.setdefault(kind, [])
            if len(records)>=128:
                problem(kind, ValueError('Too much '+kind+' version evidence; select a component root')); return
            records.append({'source': source[:512], 'requirement': value, 'mode': mode})
    def problem(kind, exc):
        records = problems.setdefault(kind, [])
        message = str(exc)[:512]
        if len(records)<8 and message not in records: records.append(message)
    def json_file(name):
        content = read(root, name)
        if content is None: return {}
        value = json.loads(content)
        if not isinstance(value, dict): raise ValueError(name+' must be an object')
        return value
    for kind, names in {'node': ('.nvmrc', '.node-version'), 'python': ('.python-version',),
                        'ruby': ('.ruby-version',), 'java': ('.java-version',)}.items():
        for name in names:
            try:
                content = read(root, name)
                if content is not None: add(kind, content.strip().removeprefix(kind+'-'), name)
            except (ValueError, UnicodeError) as exc: problem(kind, exc)
    try:
        content = read(root, '.tool-versions')
        if content:
            aliases = {'nodejs': 'node', 'python': 'python', 'golang': 'go', 'rust': 'rust', 'java': 'java', 'ruby': 'ruby', 'php': 'php'}
            for line in content.splitlines():
                parts = line.split('#', 1)[0].split()
                if parts and parts[0] in aliases:
                    kind = aliases[parts[0]]
                    if len(parts) != 2: problem(kind, '.tool-versions contains ambiguous versions for '+parts[0])
                    else: add(kind, parts[1], '.tool-versions')
    except (ValueError, UnicodeError) as exc: problem('unknown', exc)
    try:
        package = json_file('package.json')
        if package:
            evidence.setdefault('node', [])
            engines = package.get('engines', {})
            if not isinstance(engines, dict): raise ValueError('package.json engines must be an object')
            add('node', engines.get('node'), 'package.json#engines.node', 'range')
            if isinstance(package.get('volta'), dict): add('node', package['volta'].get('node'), 'package.json#volta.node')
    except (ValueError, UnicodeError) as exc: problem('node', exc)
    try:
        content = read(root, 'pyproject.toml')
        if content:
            evidence.setdefault('python', [])
            data = toml_loads(content)
            add('python', data.get('project', {}).get('requires-python'), 'pyproject.toml#project.requires-python', 'range')
            add('python', data.get('tool', {}).get('poetry', {}).get('dependencies', {}).get('python'), 'pyproject.toml#tool.poetry.dependencies.python', 'range')
        if any((root/name).is_file() for name in ('requirements.txt', 'setup.py', 'setup.cfg')) or any(root.glob('*.py')): evidence.setdefault('python', [])
        runtime = read(root, 'runtime.txt')
        if runtime and runtime.strip().startswith('python-'): add('python', runtime.strip()[7:], 'runtime.txt')
        content = read(root, 'setup.cfg')
        if content:
            parsed = configparser.ConfigParser(interpolation=None); parsed.read_string(content)
            if parsed.has_option('options', 'python_requires'): add('python', parsed.get('options', 'python_requires'), 'setup.cfg#options.python_requires', 'range')
        content = read(root, 'Pipfile')
        if content:
            data = toml_loads(content)
            add('python', data.get('requires', {}).get('python_full_version') or data.get('requires', {}).get('python_version'), 'Pipfile#requires.python_version')
    except (ValueError, UnicodeError, AttributeError, configparser.Error) as exc: problem('python', exc)
    try:
        for name in ('go.mod', 'go.work'):
            content = read(root, name)
            if content:
                evidence.setdefault('go', [])
                for value in re.findall(r'^\s*go\s+('+NUMBER+r')\s*(?://[^\n]*)?$', content, re.M): add('go', value, name+'#go', 'minimum')
                for value in re.findall(r'^\s*toolchain\s+go('+NUMBER+r')\s*(?://[^\n]*)?$', content, re.M): add('go', value, name+'#toolchain', 'minimum')
    except (ValueError, UnicodeError) as exc: problem('go', exc)
    try:
        content = read(root, 'Cargo.toml')
        if content:
            evidence.setdefault('rust', [])
            data = toml_loads(content)
            rust_version = data.get('package', {}).get('rust-version')
            if not isinstance(rust_version, dict): add('rust', rust_version, 'Cargo.toml#package.rust-version', 'minimum')
            add('rust', data.get('workspace', {}).get('package', {}).get('rust-version'), 'Cargo.toml#workspace.package.rust-version', 'minimum')
        content = read(root, 'rust-toolchain.toml')
        if content: add('rust', toml_loads(content).get('toolchain', {}).get('channel'), 'rust-toolchain.toml#toolchain.channel')
        content = read(root, 'rust-toolchain')
        if content: add('rust', content.strip(), 'rust-toolchain')
    except (ValueError, UnicodeError) as exc: problem('rust', exc)
    try:
        content = read(root, 'pom.xml')
        if content:
            evidence.setdefault('java', [])
            xml = ET.fromstring(content)
            values = {item.tag.rsplit('}', 1)[-1]: (item.text or '').strip() for item in xml.iter()}
            for key in ('java.version', 'maven.compiler.release', 'maven.compiler.target', 'maven.compiler.source'):
                value = values.get(key)
                for _ in range(8):
                    reference = re.fullmatch(r'\$\{([^}]+)\}', value or '')
                    if not reference: break
                    value = values.get(reference[1], value)
                if value: add('java', value.removeprefix('1.') if value.startswith('1.') else value, 'pom.xml#'+key, 'minimum')
        for name in ('build.gradle', 'build.gradle.kts'):
            content = read(root, name)
            if content:
                evidence.setdefault('java', [])
                for value in re.findall(r'JavaLanguageVersion\.of\((\d+)', content): add('java', value, name+'#java_toolchain')
                for value in re.findall(r'JavaVersion\.VERSION_(\d+(?:_\d+)?)', content): add('java', value.removeprefix('1_'), name+'#java_toolchain')
                for value in re.findall(r'(?:sourceCompatibility|targetCompatibility)\s*=\s*[\'"]?(1\.\d+|\d+)', content): add('java', value[2:] if value.startswith('1.') else value, name+'#compatibility', 'minimum')
    except (ValueError, UnicodeError, ET.ParseError) as exc: problem('java', exc)
    try:
        sdk = json_file('global.json').get('sdk', {})
        if sdk:
            if not isinstance(sdk, dict): raise ValueError('global.json sdk must be an object')
            add('dotnet', sdk.get('version'), 'global.json#sdk.version')
        projects = []
        scanned = 0
        for directory, dirs, files in os.walk(root, followlinks=False):
            directory = Path(directory)
            dirs[:] = sorted(name for name in dirs if name not in {'.git', 'node_modules', 'obj', 'bin', '.stackpilot-runtime', '.venv', 'venv', 'target', 'dist', 'build'} and not (directory/name).is_symlink())
            if not nested or len(directory.relative_to(root).parts)>=16: dirs[:] = []
            scanned += len(files)
            if scanned>20000:
                if projects: raise ValueError('.NET discovery file budget exceeded; select a component root')
                break
            projects.extend(directory/name for name in sorted(files) if name.endswith('.csproj'))
            if len(projects)>128: raise ValueError('More than 128 .NET projects; select a component root')
        projects.sort()
        declared_project = None
        contract_text = read(root, 'stackpilot.json')
        if contract_text:
            contract = json.loads(contract_text)
            if isinstance(contract, dict) and contract.get('project'):
                declared_project = contract['project']
                if not isinstance(declared_project, str) or Path(declared_project).is_absolute() or '..' in Path(declared_project).parts or not (root/declared_project).resolve().is_relative_to(root): raise ValueError('Selected .NET project must remain within the repository')
                if (root/declared_project) not in projects: raise ValueError('Selected .NET project is not present in bounded discovery')
        for path in projects:
            evidence.setdefault('dotnet', [])
            relative = path.relative_to(root).as_posix()
            xml = ET.fromstring(read(root, relative))
            for item in xml.iter():
                if item.tag.rsplit('}', 1)[-1] in {'TargetFramework', 'TargetFrameworks'}:
                    for framework in (item.text or '').split(';'):
                        match = re.fullmatch(r'(?:netcoreapp|net)(\d+\.\d+)', framework.strip())
                        if match:
                            add('dotnet', match[1], relative+'#TargetFramework', 'minimum')
                            if not declared_project or path == root/declared_project: add('dotnet', match[1], relative+'#TargetFramework', 'runtime')
                        elif framework and not framework.startswith('netstandard'): problem('dotnet', 'Target framework requires an explicit platform adapter: '+framework[:128])
    except (ValueError, UnicodeError, ET.ParseError) as exc: problem('dotnet', exc)
    try:
        content = read(root, 'Gemfile')
        if content:
            evidence.setdefault('ruby', [])
            match = re.search(r'^\s*ruby\s+[\'"]([^\'"]+)[\'"]', content, re.M)
            if match: add('ruby', match[1], 'Gemfile#ruby', 'range')
        content = read(root, 'Gemfile.lock')
        if content:
            match = re.search(r'^RUBY VERSION\s*\n\s+ruby ('+NUMBER+r')(?:p\d+)?\s*$', content, re.M)
            if match: add('ruby', match[1], 'Gemfile.lock#RUBY VERSION')
        composer = json_file('composer.json')
        if composer:
            evidence.setdefault('php', [])
            require = composer.get('require', {})
            if not isinstance(require, dict): raise ValueError('composer.json require must be an object')
            add('php', require.get('php'), 'composer.json#require.php', 'range')
            add('php', composer.get('config', {}).get('platform', {}).get('php'), 'composer.json#config.platform.php')
    except (ValueError, UnicodeError) as exc: problem('php', exc)
    results = []
    for kind in sorted(set(evidence)|set(problems)):
        facts = evidence.get(kind, [])
        issues = problems.get(kind, [])[:]
        version = None
        runtime = None
        try:
            pins = [numeric(f['requirement']) for f in facts if f['mode'] == 'pin']
            if kind == 'java': pins = ['8' if value in {'1.8', '1.8.0'} else value for value in pins]
            minimums = [numeric(f['requirement']) for f in facts if f['mode'] == 'minimum']
            runtimes = sorted(set(f['requirement'] for f in facts if f['mode'] == 'runtime'), key=tuple_version)
            if len(set(pins)) > 1:
                # A major version file and a more exact pin are compatible.
                exact = max(pins, key=lambda p: len(p.split('.')))
                if any(tuple_version(exact)[:len(p.split('.'))] != tuple_version(p)[:len(p.split('.'))] for p in pins):
                    raise ValueError('Conflicting pinned '+kind+' versions')
                pins = [exact]
            if len(runtimes) > 1: raise ValueError('Multiple target runtimes need a selected project or explicit build recipe')
            runtime = runtimes[0] if runtimes else None
            ranges = [f['requirement'] for f in facts if f['mode'] == 'range']
            # Parse even when a pin exists, so unsupported evidence is visible.
            for constraint in ranges: satisfies(DEFAULTS.get(kind, '1'), constraint)
            if pins: version = pins[0]
            elif kind in {'go', 'rust', 'java'} and minimums: version = max(minimums, key=tuple_version)
            elif kind == 'dotnet' and runtime: version = runtime
            elif ranges:
                # Exact patch requirements can identify a more precise image.
                candidates = [DEFAULTS[kind], *CANDIDATES.get(kind, []), *re.findall(NUMBER, ' '.join(ranges))]
                exact = [numeric(v) for expression in ranges for v in re.findall(r'==\s*('+NUMBER+r')(?![\d.*xX])', expression)]
                if exact:
                    candidates = ['.'.join(str(n) for n in tuple_version(v)) for v in exact]
                version = next((v for v in dict.fromkeys(candidates) if all(satisfies(v, requirement) for requirement in ranges)), None)
                if version is None: raise ValueError('No compatible '+kind+' version could be selected from declared requirements')
            else: version = DEFAULTS.get(kind)
            if version and any(not satisfies(version, requirement) for requirement in ranges): raise ValueError('Pinned '+kind+' version conflicts with manifest requirements')
            if version and any(tuple_version(version) < tuple_version(v) for v in minimums): raise ValueError('Pinned '+kind+' version is below the declared minimum')
            if kind == 'dotnet' and version and runtime and tuple_version(version)[:2] < tuple_version(runtime)[:2]: raise ValueError('.NET SDK is older than the target framework')
        except ValueError as exc: issues.append(str(exc)); version = None
        results.append({'kind': kind, 'version': version, 'image': image(kind, version) if version and kind in DEFAULTS else None,
                        'runtime_version': runtime, 'assumed': not bool(facts), 'evidence': facts,
                        'issues': issues, 'status': 'requires_configuration' if issues or not version else 'selected',
                        'execution_verified': False})
    return results


def verification_profile(root):
    """Propose isolated acceptance setup; source is read, never executed here."""
    root = Path(root).resolve()
    result = {'image': None, 'setup': [], 'network': False, 'issues': [], 'execution_verified': False}
    try:
        if not root.is_dir(): raise ValueError('Acceptance profile needs a repository directory')
        config_text = read(root, 'stackpilot.json')
        config = json.loads(config_text) if config_text else {}
        if not isinstance(config, dict): raise ValueError('stackpilot.json must be an object')
        # Component callers normally supply each normalized component root.
        if config.get('version') == 2:
            selected = [c for c in config.get('components', []) if isinstance(c, dict) and c.get('id') == config.get('primary_component')]
            if len(selected) != 1: raise ValueError('Select the component whose tests are being verified')
            component = selected[0]
            relative = Path(component.get('root', '.'))
            if relative.is_absolute() or '..' in relative.parts or not (root/relative).resolve().is_relative_to(root): raise ValueError('Component verification root escapes repository')
            if relative != Path('.'): return verification_profile(root/relative)
            config = {**config, **component}
        build = config.get('build_recipe')
        if build:
            if not isinstance(build, dict) or not isinstance(build.get('image'), str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}', build['image']): raise ValueError('Build recipe requires a valid toolchain image')
            commands = build.get('commands', [])
            if not isinstance(commands, list) or not 0 < len(commands) <= 32 or any(not isinstance(c, list) or not c or any(not isinstance(a, str) or '\0' in a for a in c) or not c[0] for c in commands): raise ValueError('Build recipe verification commands must be bounded argv arrays')
            return {**result, 'image': build['image'], 'setup': commands, 'network': True, 'kind': 'explicit_recipe'}
        values = discover(root, nested=True)
        manifest_names = {'node': ('package.json',), 'python': ('pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'), 'go': ('go.mod',), 'rust': ('Cargo.toml',), 'java': ('pom.xml', 'build.gradle', 'build.gradle.kts'), 'ruby': ('Gemfile',), 'php': ('composer.json',)}
        present = [kind for kind, names in manifest_names.items() if any((root/name).is_file() for name in names)]
        if any(v['kind'] == 'dotnet' for v in values): present.append('dotnet')
        if not present and any(root.glob('*.py')): present = ['python']
        if len(present) != 1: raise ValueError('Acceptance needs an explicit toolchain image/recipe or an unambiguous selected component')
        kind = present[0]; selected = next(v for v in values if v['kind'] == kind)
        if selected['issues'] or not selected['image']: raise ValueError('; '.join(selected['issues']) or 'No compatible toolchain selected')
        result.update({'image': selected['image'], 'kind': kind, 'toolchain': selected})
        setup = result['setup']
        if kind == 'python':
            if (root/'requirements.txt').is_file(): setup.append(['python', '-m', 'pip', 'install', '--no-cache-dir', '-r', 'requirements.txt'])
            elif any((root/name).is_file() for name in ('pyproject.toml', 'setup.py')): setup.append(['python', '-m', 'pip', 'install', '--no-cache-dir', '.'])
            if any(root.glob('test*.py')) or (root/'tests').is_dir(): setup.append(['python', '-m', 'pip', 'install', '--no-cache-dir', 'pytest'])
        elif kind == 'node':
            package = json.loads(read(root, 'package.json'))
            declared = package.get('packageManager', '')
            if not isinstance(declared, str) or len(declared)>256: raise ValueError('Package manager declaration must be bounded text')
            manager = declared.split('@')[0] or ('pnpm' if (root/'pnpm-lock.yaml').is_file() else 'yarn' if (root/'yarn.lock').is_file() else 'bun' if any((root/name).is_file() for name in ('bun.lock', 'bun.lockb')) else 'npm')
            if manager not in {'npm', 'pnpm', 'yarn', 'bun'}: raise ValueError('Unsupported package manager')
            if declared and not re.fullmatch(r'(?:npm|pnpm|yarn|bun)@'+NUMBER+r'(?:\+sha(?:224|256|384|512)\.[A-Za-z0-9]+)?', declared): raise ValueError('Package manager needs a numeric version or explicit build recipe')
            if manager in {'pnpm', 'yarn'}:
                setup.append(['corepack', 'enable'])
                if declared: setup.append(['corepack', 'prepare', declared, '--activate'])
            elif manager == 'npm' and declared:
                setup.append(['npm', 'install', '--global', 'npm@'+declared.split('@',1)[1]])
            elif manager == 'bun': raise ValueError('Bun acceptance requires a tested image with both the declared Node and Bun toolchains')
            if manager == 'npm': setup.append(['npm', 'ci' if (root/'package-lock.json').is_file() else 'install'])
            elif manager == 'pnpm': setup.append(['pnpm', 'install', *(['--frozen-lockfile'] if (root/'pnpm-lock.yaml').is_file() else [])])
            else:
                yarn_major = int(declared.split('@')[1].split('.')[0]) if declared else 1
                setup.append(['yarn', 'install', *(['--frozen-lockfile' if yarn_major == 1 else '--immutable'] if (root/'yarn.lock').is_file() else [])])
        elif kind == 'go': setup.append(['go', 'mod', 'download'])
        elif kind == 'rust': setup.append(['cargo', 'fetch', *(['--locked'] if (root/'Cargo.lock').is_file() else [])])
        elif kind == 'java':
            if (root/'mvnw').is_file(): setup += [wrapper_command('mvnw', 'test-compile')]
            elif (root/'gradlew').is_file(): setup += [wrapper_command('gradlew', 'classes', 'testClasses', '--no-daemon')]
            elif (root/'pom.xml').is_file(): setup += [['apt-get', 'update'], ['apt-get', 'install', '-y', '--no-install-recommends', 'maven'], ['mvn', 'test-compile']]
            else: raise ValueError('Gradle acceptance needs its repository wrapper or an explicit Gradle build image')
        elif kind == 'dotnet':
            project = config.get('project')
            if project:
                if not isinstance(project, str) or not (root/project).resolve().is_relative_to(root) or not (root/project).is_file(): raise ValueError('Selected .NET project must remain in the repository')
                setup.append(['dotnet', 'restore', project])
            else: setup.append(['dotnet', 'restore'])
        elif kind == 'ruby':
            lock = read(root, 'Gemfile.lock') or ''
            bundled = re.search(r'^BUNDLED WITH\s*\n\s+('+NUMBER+r')\s*$', lock, re.M)
            if bundled: setup.append(['gem', 'install', 'bundler', '--version', bundled[1], '--no-document'])
            setup.append(['bundle', 'install'])
        elif kind == 'php':
            # HTTPS signature verification follows Composer's official
            # programmatic installer; it executes only in the test container.
            program = "$p='/tmp/stackpilot-composer-setup.php'; $s=trim(file_get_contents('https://composer.github.io/installer.sig')); if(strlen($s)!==96||!copy('https://getcomposer.org/installer',$p)||hash_file('sha384',$p)!==$s){@unlink($p);fwrite(STDERR,'Composer installer signature mismatch');exit(1);}"
            setup += [['php', '-r', program], ['php', '/tmp/stackpilot-composer-setup.php', '--2', '--install-dir=/usr/local/bin', '--filename=composer'], ['composer', 'install', '--no-interaction', '--prefer-dist']]
        result['network'] = bool(setup)
    except (ValueError, UnicodeError, OSError, AttributeError, StopIteration) as exc:
        result['issues'].append(str(exc)[:1024]); result['image'] = None
    return result
