"""Resolve acceptance toolchains without changing a frozen completion contract."""
from copy import deepcopy
from urllib.parse import urlsplit
import json
import re
import shlex
from ..repository_toolchains import verification_profile, read, toml_loads
from .workspace import safe_path


def validate_environment(check):
    """Reject impossible setup before freezing or queuing acceptance."""
    setup = check.get('setup', [])
    if any(any(operator in command[0] for operator in (' && ', ' || ', '; ')) for command in setup):
        raise ValueError('Setup commands must be executable argv arrays. For a shell script use ["sh", "-ec", "mkdir -p build && ..."], not an entire script as the executable name.')
    installs = any(not any(a in {'--no-index','--offline'} for a in c) and ((c[0] in {'pip', 'pip3', 'npm', 'pnpm', 'yarn', 'apt', 'apt-get'} and any(a in {'install', 'ci', 'update'} for a in c[1:])) or (c[:3] in (['python', '-m', 'pip'], ['python3', '-m', 'pip']) and 'install' in c[3:])) for c in setup)
    if installs and not check.get('network', False):
        raise ValueError('Acceptance dependency installation requires network=true or a prebuilt offline SDK. Set the execution environment before freezing the plan; verify_agent_source cannot override a frozen check.')
    argv = check.get('argv', [])
    if argv and argv[0] in {'curl', 'wget'} and not setup and any(urlsplit(a).hostname in {'localhost','127.0.0.1','::1'} for a in argv if a.startswith(('http://','https://'))):
        raise ValueError('Fresh acceptance workers contain source, not the deployed service. Test source with its test client or start the application in setup before probing localhost.')


def gui_entrypoint_repair(root,config):
    """Freeze a narrow source-preserving configuration check, not GUI coverage.

    The release still needs its actual desktop runtime checks. This contract
    cannot admit application edits, weakened tests or a substituted launcher.
    """
    if config.get('workload')!='desktop' or config.get('desktop_framework')!='python-gui':return None
    if config.get('build_recipe') or config.get('components'):return None
    from .workspace import source_files
    import hashlib
    paths=source_files(root)
    if len(paths)>128:return None
    profile=verification_profile(root)
    if profile['issues'] or profile.get('kind')!='python' or not profile.get('image'):return None
    digests={path:hashlib.sha256((root/path).read_bytes()).hexdigest() for path in paths if path!='stackpilot.json'}
    base={k:v for k,v in config.items() if k!='entrypoint'}
    program='''import ast,hashlib,json,os,pathlib
root=pathlib.Path('.')
expected=EXPECTED
before=BASE
config=json.loads((root/'stackpilot.json').read_text())
assert {k:v for k,v in config.items() if k!='entrypoint'}==before, 'Only the entrypoint may change in this configuration repair'
entry=config.get('entrypoint')
assert isinstance(entry,list) and (len(entry)==2 or (len(entry)==3 and entry[1]=='-u')) and entry[0] in ('python','python3'), 'Use the original Python application argv; the desktop runtime provides its display'
path=pathlib.PurePosixPath(entry[-1])
assert path.suffix=='.py' and not path.is_absolute() and '..' not in path.parts and str(path) in expected, 'Entrypoint must select an existing original Python source file'
actual={}
for directory,dirs,files in os.walk(root,followlinks=False):
 dirs[:]=[d for d in dirs if d not in {'.git','node_modules','.venv','venv','__pycache__','.gradle','.next','.stackpilot-runtime'}]
 for name in files:
  value=pathlib.Path(directory)/name;relative=value.relative_to(root).as_posix()
  if relative=='stackpilot.json' or name in {'.git','.stackpilot-source.json','.stackpilot-context.json'} or name=='.env' or (name.startswith('.env.') and not name.endswith(('example','sample','template'))) or (name.endswith('.env') and not name.startswith('.env.')):continue
  assert value.is_file() and not value.is_symlink(), 'Source must remain regular files'
  actual[relative]=hashlib.sha256(value.read_bytes()).hexdigest()
assert actual==expected, 'Application source or build inputs changed; this requires independent behavioral acceptance'
ast.parse((root/path).read_text(encoding='utf-8-sig'))
print('Original Python GUI entrypoint resolved; application source preserved; GUI behavior awaits runtime verification')
'''.replace('EXPECTED',repr(digests)).replace('BASE',repr(base))
    if len(program)>24000:return None
    return {'version':1,'workload':'desktop','summary':'Restore the Python GUI entrypoint while preserving all original source and build inputs',
        'assumptions':['This checks only deployment configuration and Python syntax. Existing repository tests and actual desktop runtime verification remain release requirements; undeclared GUI business behavior is unverified.'],
        'features':[{'id':'original-gui-entrypoint','description':'Resolve the original Python GUI entrypoint without altering application behavior or acceptance',
            'checks':[{'root':'.','argv':['python','-c',program],'image':profile['image'],'setup':[],'network':False,'timeout_seconds':30}]}]}


def repair_completion(root):
    """Reuse original FastAPI suites for explicit Compose build components.

    This establishes existing behavior, not invented product requirements or
    runtime success. Other delivery types keep the regular completion planner.
    """
    import yaml
    root = root.resolve()
    config_text = read(root, 'stackpilot.json')
    config = json.loads(config_text) if config_text else {}
    if isinstance(config,dict) and config.get('static_frontend'):
        from ..hosted_frontend import infer
        original = infer(root)
        if not original or original['static_frontend'] != config['static_frontend']:
            raise ValueError('Hosted frontend recovery must retain its declared production inputs')
        profile = verification_profile(root)
        return {'version':1,'workload':'web','summary':'Build the declared production frontend and connect to its existing hosted services',
            'assumptions':['Scope is frontend deployment readiness. Hosted API and database are external dependencies; their source tests and infrastructure are not rebuilt. Live rendering and proxy qualification remain release gates.'],
            'features':[{'id':'production-frontend-build','description':'The original production frontend build passes with its declared Node toolchain',
                'checks':[{'root':'.','argv':original['static_frontend']['build'],'image':profile['image'],
                    'setup':[original['static_frontend']['install']],'network':True,'timeout_seconds':300}]}]}
    if not isinstance(config,dict) or config.get('version',1)!=1:return None
    gui=gui_entrypoint_repair(root,config)
    if gui:return gui
    if config.get('workload','api')!='api':return None
    configs = [root/name for name in ('compose.yaml','compose.yml','docker-compose.yaml','docker-compose.yml') if (root/name).is_file()]
    if len(configs) != 1 or configs[0].is_symlink() or configs[0].stat().st_size > 1024*1024:
        return None
    definition = yaml.safe_load(configs[0].read_text(encoding='utf-8'))
    services = definition.get('services', {}) if isinstance(definition,dict) else {}
    if not isinstance(services,dict) or not 0 < len(services) <= 128:
        return None
    roots = set()
    for service in services.values():
        if not isinstance(service,dict):return None
        build = service.get('build')
        if not build:continue
        relative = build if isinstance(build,str) else build.get('context') if isinstance(build,dict) else None
        if not isinstance(relative,str) or '$' in relative:return None
        directory = root if relative in {'.','./'} else safe_path(root, relative.removeprefix('./'))
        if not directory.is_dir():return None
        roots.add(directory)
    features=[]
    for directory in sorted(roots):
        # Workspace Node installs and service-backed integration tests need
        # their explicit repository recipe; do not manufacture one here.
        if not (directory/'pyproject.toml').is_file() or not (directory/'tests').is_dir():return None
        manifest = toml_loads(read(directory,'pyproject.toml'))
        dependencies = manifest.get('project',{}).get('dependencies',[])
        if not any(isinstance(value,str) and value.lower().startswith('fastapi') for value in dependencies):return None
        profile=verification_profile(directory)
        if profile['issues'] or profile.get('kind')!='python':return None
        relative=directory.relative_to(root).as_posix()
        features.append({'id':'original-tests-'+str(len(features)+1),
            'description':'Preserve the original tested behavior of '+relative,
            'checks':[{'root':relative,'argv':['python','-m','pytest','-q'],'image':profile['image'],
                'setup':profile['setup'],'network':profile['network'],'timeout_seconds':300}]})
    if not features:return None
    return {'version':1,'workload':'api','summary':'Restore the deployed Compose components and pass their original protected test suites',
        'assumptions':['Scope is the original suites for explicitly built Python services; runtime qualification remains a separate release gate.'],
        'features':features}


def worker_arguments(root, arguments):
    """Prepare dependencies and the check in the same disposable guest."""
    result = deepcopy(arguments)
    if result.get('sandbox_id'):
        if result.get('setup') or result.get('root', '.') != '.':
            raise ValueError('Persistent instances use explicit argv (e.g. sh -lc) for setup/cwd; root and setup apply to disposable workers')
        return result
    argv = result.get('argv')
    if not isinstance(argv, list) or not argv or any(not isinstance(arg, str) for arg in argv):
        raise ValueError('argv must be a string array, for example ["python", "-m", "pytest"]; it is not shell text')
    if len(argv)==3 and argv[0] in {'sh','bash'} and argv[1] in {'-c','-lc','-ec','-euc'}:
        script=argv[2]
        if len(script)>2 and script[0] in {'\'','"'} and script[-1]==script[0]:
            try: decoded=shlex.split(script)
            except ValueError: decoded=[]
            if len(decoded)==1 and re.match(r'[A-Za-z_][A-Za-z0-9_-]*\s',decoded[0]) and any(operator in decoded[0] for operator in (' && ', ' || ', '; ')):
                # Provider adapters sometimes shell-quote a script already
                # contained in an argv string. Decode only that redundant layer.
                result['argv']=argv=[*argv[:2],decoded[0]]
    relative = result.get('root', '.')
    directory = root if relative == '.' else safe_path(root, relative)
    if not directory.is_dir():
        raise ValueError('Command root must be an existing repository directory')
    pytest_command = argv[0] in {'pytest','py.test'} or argv[:3] in (['python','-m','pytest'],['python3','-m','pytest'])
    if pytest_command and relative != '.':
        # Correct an observed repository file path copied from inventory into
        # a command already rooted at its component. Options and unknown paths
        # retain their meaning; no path outside the component is rewritten.
        normalized=[]
        for index,argument in enumerate(argv):
            path, separator, selector = argument.partition('::')
            option_value=index>0 and argv[index-1] in {'-k','-m','-o','--override-ini','--cov','--cov-report','--junitxml'}
            if not option_value and path.startswith(relative.rstrip('/')+'/') and not (directory/path).exists():
                target=safe_path(root,path)
                if target.exists() and target.is_relative_to(directory):
                    path=target.relative_to(directory).as_posix()
            normalized.append(path+(separator+selector if separator else ''))
        result['argv']=argv=normalized
    install_command = ((argv[0] in {'pip', 'pip3', 'npm', 'pnpm', 'yarn'} and any(a in {'install', 'ci'} for a in argv[1:3])) or (argv[:3] in (['python','-m','pip'],['python3','-m','pip']) and 'install' in argv[3:5]))
    test_command = argv[0] in {'pytest', 'py.test'} or argv[:3] in (['python', '-m', 'pytest'], ['python3', '-m', 'pytest']) or (argv[0] in {'npm', 'pnpm', 'yarn'} and any(a in {'test','build','lint','typecheck'} for a in argv[1:3])) or (argv[0] in {'go','cargo'} and any(a in {'test','build','check'} for a in argv[1:3]))
    prepare_environment = result.get('prepare_environment', test_command)
    if (prepare_environment or install_command or argv[0] in {'node','npm','pnpm','yarn','go','cargo'}) and not result.get('image'):
        profile = verification_profile(directory)
        if profile['issues'] or not profile['image']:
            raise ValueError('Select root for the component being tested (e.g. apps/api), or supply an explicit image/setup: '+ '; '.join(profile['issues']))
        expected = 'python' if argv[0] in {'python','python3','pip','pip3','pytest','py.test'} else 'node' if argv[0] in {'node','npm','pnpm','yarn'} else 'go' if argv[0] == 'go' else 'rust' if argv[0] == 'cargo' else None
        if expected and profile.get('kind') not in {expected,'explicit_recipe'}:
            raise ValueError('Command toolchain does not match this root; select the '+expected+' component directory')
        result['image'] = profile['image']
        if prepare_environment:
            result.setdefault('setup', profile['setup'])
            result.setdefault('network', profile['network'])
            result.setdefault('timeout_seconds', 300)
    if install_command and not any(a in {'--no-index','--offline'} for a in argv):
        result.setdefault('network', True)
    result.pop('prepare_environment', None)
    return result


def prepare(root, commands, arguments):
    prepared, requirements, profiles = [], [], {}
    for original in commands:
        command = deepcopy(original)
        # Completion checks already contain their frozen execution environment.
        # Explicit caller choices also override discovery for repository tests.
        if 'image' not in command and not arguments.get('image'):
            relative = command.get('root', '.')
            if relative not in profiles:
                directory = root if relative == '.' else safe_path(root, relative)
                profiles[relative] = verification_profile(directory)
            profile = profiles[relative]
            if profile['issues'] or not profile['image']:
                if not any(item['root'] == relative for item in requirements):
                    requirements.append({'kind':'toolchain','root':relative,
                        'description':'; '.join(profile['issues']) or 'No unambiguous Linux acceptance toolchain'})
            else:
                command['image'] = profile['image']
                command['setup'] = arguments['setup'] if 'setup' in arguments else profile['setup']
                command['network'] = arguments['network'] if 'network' in arguments else profile['network']
        prepared.append(command)
    return prepared, requirements
