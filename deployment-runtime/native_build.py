"""Fail-closed native builds, executed only inside an isolated build worker."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import signal
import threading
import time
import zipfile
import platform
try:
    from repository_toolchains import wrapper_command
except ModuleNotFoundError:
    import sys
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'ai-service'/'app'))
    from repository_toolchains import wrapper_command


def run(args, **kwargs):
    print(json.dumps({'stage':'native_build', 'command':args}), flush=True)
    return subprocess.run(args, check=True, timeout=int(os.getenv('BUILD_STAGE_TIMEOUT','1200')), **kwargs)


@contextmanager
def wrapper_network_settings():
    """Worker-only transport policy; restore the repository's exact bytes."""
    properties = Path('gradle/wrapper/gradle-wrapper.properties')
    if not properties.exists():
        yield
        return
    if (not properties.resolve().is_relative_to(Path.cwd().resolve()) or
            any(path.is_symlink() for path in (properties, *properties.parents)) or
            properties.stat().st_size > 65536):
        raise ValueError('Gradle wrapper properties must be a bounded regular file')
    original = properties.read_bytes()
    text = original.decode('utf-8')
    values = re.findall(r'^\s*networkTimeout\s*[=:]\s*([^\r\n]*)', text, re.M)
    configured = int(values[-1].strip()) if values else 10000
    policy = max(1000, min(120000, int(os.getenv('STACKPILOT_GRADLE_NETWORK_TIMEOUT_MS', '60000'))))
    if configured >= policy:
        yield
        return
    # SDK URL, version, checksum and every build/test task remain authoritative.
    properties.write_bytes(original + f'\nnetworkTimeout={policy}\n'.encode())
    try:
        yield
    finally:
        properties.write_bytes(original)


def _gradle_tasks_once(expires):
    wrapper = Path('gradlew')
    if not wrapper.is_file() or wrapper.is_symlink() or wrapper.stat().st_size>1024*1024:
        raise RuntimeError('Gradle wrapper required; install a declared Gradle toolchain or include gradlew')
    argv=wrapper_command('gradlew','--no-daemon','tasks','--all','--console=plain')
    print(json.dumps({'stage':'native_task_discovery','command':argv}),flush=True)
    # Task discovery also downloads the wrapper and plugins on a cold worker.
    # Tee its output as it arrives instead of leaving the UI silent for minutes.
    process=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
    expired=threading.Event()
    def deadline():
        expired.set()
        if process.poll() is None:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
    timer=threading.Timer(max(.01, expires-time.monotonic()),deadline);timer.start()
    lines=[];size=0
    try:
        for line in process.stdout:
            print(line,end='',flush=True);size+=len(line)
            if size>2*1024**2:raise RuntimeError('Gradle task listing exceeds supported discovery bounds')
            lines.append(line)
        code=process.wait()
        if expired.is_set():raise TimeoutError('Native task discovery deadline exceeded')
        if code:raise subprocess.CalledProcessError(code,argv,output=''.join(lines))
    finally:
        timer.cancel()
        if process.poll() is None:
            os.killpg(process.pid,signal.SIGKILL);process.wait()
        process.stdout.close()
    output=''.join(lines)
    return set(re.findall(r'^([\w:]+)(?:\s+-[^\n]*)?\s*$', output, re.M))


def gradle_tasks():
    """Retry only transient wrapper downloads within one discovery deadline."""
    expires = time.monotonic() + int(os.getenv('BUILD_STAGE_TIMEOUT', '1200'))
    retries = max(0, min(2, int(os.getenv('STACKPILOT_GRADLE_DISCOVERY_RETRIES', '2'))))
    with wrapper_network_settings():
        from gradle_transport import seed
        # Old wrapper JARs can ignore networkTimeout. Fetch the same pinned
        # bytes with streamed progress before starting their Java downloader.
        seed(expires)
        for attempt in range(retries + 1):
            try:
                return _gradle_tasks_once(expires)
            except subprocess.CalledProcessError as exc:
                output = exc.output or ''
                download = 'Downloading ' in output and 'org.gradle.wrapper.Download' in output
                transient = any(marker in output for marker in ('SocketTimeoutException', 'Read timed out', 'ConnectException', 'Connection reset'))
                integrity_error = any(marker in output.lower() for marker in ('checksum', 'verification of gradle distribution failed'))
                if not download or not transient or integrity_error or attempt >= retries:
                    raise
                if attempt==0:
                    from gradle_transport import seed
                    if seed(expires):
                        print(json.dumps({'stage':'native_wrapper_retry','reason':'Exact pinned distribution seeded through verified transport'}),flush=True)
                        continue
                delay = min(2 ** attempt, 2)
                if time.monotonic() + delay >= expires:
                    raise TimeoutError('Native task discovery deadline exceeded') from exc
                print(json.dumps({'stage':'native_wrapper_retry', 'attempt':attempt+1,
                                  'reason':'Transient Gradle distribution download failure'}), flush=True)
                time.sleep(delay)


def native_build(kind, output):
    source=Path.cwd().resolve();output=output.resolve()
    config=json.loads((source/'stackpilot.json').read_text()) if (source/'stackpilot.json').is_file() else {}
    try:
        if kind=='android':
            from android_delivery import validate
            options=validate(config.get('android',{}));directory=source/options.get('project_root','.')
            if not directory.resolve().is_relative_to(source) or not directory.is_dir() or any(p.is_symlink() for p in [directory,*directory.parents] if p.is_relative_to(source)):raise ValueError('Android project_root must be a regular source directory')
            os.chdir(directory)
        return _native_build(kind,output,config)
    finally:os.chdir(source)


def _native_build(kind, output, config):
    output.mkdir(parents=True, exist_ok=True)
    if kind=='android':
        with Path('gradle.properties').open('a') as stream:stream.write('\nandroid.builder.sdkDownload=true\norg.gradle.workers.max=2\norg.gradle.jvmargs=-Xmx1536m\n')
    tasks = gradle_tasks()
    if kind == 'android':
        from android_delivery import select, verify
        options=config.get('android',{})
        if os.getenv('STACKPILOT_ANDROID_BUILD_TASK'):options={**options,'task':os.environ['STACKPILOT_ANDROID_BUILD_TASK']}
        options,requested,tests,lint=select(tasks,options)
        run(wrapper_command('gradlew','--no-daemon','--console=plain', 'clean', *tests, *([lint] if lint else []), requested))
        format=options['format']
        folder={'apk':'apk','aab':'bundle','aar':'aar'}[format]
        module=Path(options['module'].replace(':','/')) if options.get('module') else Path('.')
        artifacts = list(module.glob('**/build/outputs/'+folder+'/**/*.'+format))
        if format=='aar':artifacts=list(module.glob('**/build/outputs/aar/*.'+format))
        if not artifacts:
            raise RuntimeError('Gradle finished without selected Android artifacts: '+format)
        copied = [];signatures={}
        for artifact in artifacts:
            if artifact.is_symlink():
                raise RuntimeError('Symlink artifact refused')
            signer = sorted(Path(os.environ['ANDROID_HOME']).glob('build-tools/*/apksigner'))
            if not signer:
                raise RuntimeError('Android apksigner unavailable')
            signature=verify(artifact,format,signer[-1],options.get('signing'))
            name = '-'.join(artifact.parts[-5:])
            shutil.copyfile(artifact, output/name)
            copied.append(name)
            signatures[name]=signature
        evidence = {'kind':kind, 'format':format,'variant':options['variant'],'task':requested,'signatures':signatures, 'build':'passed', 'tests':'passed' if tests else 'not_configured', 'test_tasks':tests, 'lint':bool(lint), 'artifacts':copied, 'device_workflows':'unverified','signing_verified':bool(options.get('signing')) and all(s=='verified' for s in signatures.values()),'store_publication':'unverified'}
    elif kind == 'desktop':
        targets = [t for t in tasks if t == 'packageUberJarForCurrentOS' or t.endswith(':packageUberJarForCurrentOS')]
        if len(targets) != 1:
            raise RuntimeError('Select one executable desktop packaging target; no ambiguous JAR fallback is allowed')
        tests = [t for t in tasks if t in {'test','desktopTest'}]
        run(['xvfb-run','-a',*wrapper_command('gradlew','--no-daemon','--console=plain', 'clean', *tests, targets[0])])
        jars = []
        for path in Path('.').glob('**/build/**/*.jar'):
            with zipfile.ZipFile(path) as archive:
                try:
                    manifest = archive.read('META-INF/MANIFEST.MF').decode('utf-8')
                except KeyError:
                    continue
                if re.search(r'^Main-Class:\s*\S+', manifest, re.M) and (path.parent.parts[-3:]==('build','compose','jars') or 'uber' in str(path).lower() or 'fat' in path.name.lower()):
                    jars.append(path)
        if len(jars) != 1:
            raise RuntimeError('Desktop packaging must produce exactly one executable application JAR')
        shutil.copyfile(jars[0], output/'application.jar')
        arch={'x86_64':'amd64','aarch64':'arm64'}.get(platform.machine(),platform.machine())
        evidence = {'kind':kind, 'build':'passed', 'tests':'passed' if tests else 'not_configured', 'test_tasks':tests,'artifacts':['application.jar'],'target':{'os':'linux','arch':arch},'gui_workflows':'unverified'}
    else:
        raise RuntimeError('Unsupported native build lane')
    evidence['sha256'] = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in output.iterdir() if p.is_file()}
    (output/'manifest.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    return evidence


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('kind', choices=['android','desktop'])
    parser.add_argument('--output', type=Path, default=Path('/artifacts'))
    args = parser.parse_args()
    native_build(args.kind, args.output)
