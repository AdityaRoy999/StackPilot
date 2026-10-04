"""Fail-closed native builds, executed only inside an isolated build worker."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import signal
import threading
import zipfile


def run(args, **kwargs):
    print(json.dumps({'stage':'native_build', 'command':args}), flush=True)
    return subprocess.run(args, check=True, timeout=int(os.getenv('BUILD_STAGE_TIMEOUT','1200')), **kwargs)


def gradle_tasks():
    wrapper = Path('gradlew')
    if not wrapper.is_file():
        raise RuntimeError('Gradle wrapper required; install a declared Gradle toolchain or include gradlew')
    wrapper.chmod(wrapper.stat().st_mode | 0o100)
    argv=['./gradlew','--no-daemon','tasks','--all','--console=plain']
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
    timer=threading.Timer(int(os.getenv('BUILD_STAGE_TIMEOUT','1200')),deadline);timer.start()
    lines=[];size=0
    try:
        for line in process.stdout:
            print(line,end='',flush=True);size+=len(line)
            if size>2*1024**2:raise RuntimeError('Gradle task listing exceeds supported discovery bounds')
            lines.append(line)
        code=process.wait()
        if expired.is_set():raise TimeoutError('Native task discovery deadline exceeded')
        if code:raise subprocess.CalledProcessError(code,argv)
    finally:
        timer.cancel()
        if process.poll() is None:
            os.killpg(process.pid,signal.SIGKILL);process.wait()
        process.stdout.close()
    output=''.join(lines)
    return set(re.findall(r'^([\w:]+)(?:\s+-[^\n]*)?\s*$', output, re.M))


def native_build(kind, output):
    output.mkdir(parents=True, exist_ok=True)
    if kind=='android':
        with Path('gradle.properties').open('a') as stream:stream.write('\nandroid.builder.sdkDownload=true\norg.gradle.workers.max=2\norg.gradle.jvmargs=-Xmx1536m\n')
    tasks = gradle_tasks()
    if kind == 'android':
        requested = os.getenv('STACKPILOT_ANDROID_BUILD_TASK','assembleDebug')
        if requested not in tasks:
            qualified=[t for t in tasks if t.endswith(':'+requested)]
            if len(qualified)!=1:
                raise RuntimeError(f'Android task {requested!r} is absent or ambiguous; declare the exact module/variant build task')
            requested=qualified[0]
        tests = sorted(t for t in tasks if re.fullmatch(r'(?:[\w]+:)*test[\w]*DebugUnitTest', t))
        lint = 'lintDebug' if 'lintDebug' in tasks else next((t for t in tasks if t==requested.rsplit(':',1)[0]+':lintDebug'),None)
        run(['./gradlew','--no-daemon','--console=plain', 'clean', *tests, *([lint] if lint else []), requested])
        artifacts = list(Path('.').glob('**/build/outputs/apk/**/*.apk'))
        if not artifacts:
            raise RuntimeError('Gradle finished without APK artifacts')
        copied = []
        for artifact in artifacts:
            if artifact.is_symlink():
                raise RuntimeError('Symlink artifact refused')
            with zipfile.ZipFile(artifact) as archive:
                if 'AndroidManifest.xml' not in archive.namelist():
                    raise RuntimeError('Output is not an APK: AndroidManifest.xml missing')
            signer = sorted(Path(os.environ['ANDROID_HOME']).glob('build-tools/*/apksigner'))
            if not signer:
                raise RuntimeError('Android apksigner unavailable')
            run([str(signer[-1]), 'verify', str(artifact)])
            name = '-'.join(artifact.parts[-5:])
            shutil.copyfile(artifact, output/name)
            copied.append(name)
        evidence = {'kind':kind, 'build':'passed', 'tests':'passed' if tests else 'not_configured', 'test_tasks':tests, 'lint':bool(lint), 'artifacts':copied, 'device_workflows':'unverified'}
    elif kind == 'desktop':
        targets = [t for t in tasks if t == 'packageUberJarForCurrentOS' or t.endswith(':packageUberJarForCurrentOS')]
        if len(targets) != 1:
            raise RuntimeError('Select one executable desktop packaging target; no ambiguous JAR fallback is allowed')
        tests = [t for t in tasks if t in {'test','desktopTest'}]
        run(['./gradlew','--no-daemon','--console=plain', 'clean', *tests, targets[0]])
        jars = []
        for path in Path('.').glob('**/build/**/*.jar'):
            with zipfile.ZipFile(path) as archive:
                try:
                    manifest = archive.read('META-INF/MANIFEST.MF').decode('utf-8')
                except KeyError:
                    continue
                if re.search(r'^Main-Class:\s*\S+', manifest, re.M) and ('uber' in str(path).lower() or 'fat' in path.name.lower()):
                    jars.append(path)
        if len(jars) != 1:
            raise RuntimeError('Desktop packaging must produce exactly one executable application JAR')
        shutil.copyfile(jars[0], output/'application.jar')
        evidence = {'kind':kind, 'build':'passed', 'tests':'passed' if tests else 'not_configured', 'gui_workflows':'unverified'}
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
