"""Android variant/output selection and worker-only signing material."""
import base64
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile


def validate(value):
    if not isinstance(value,dict) or set(value)-{'task','format','variant','module','signing','project_root','jdk'}:raise ValueError('android requires task/format/variant/module/signing/project_root/jdk options')
    result={'format':'apk','variant':'Debug',**value}
    if result['format'] not in {'apk','aab','aar'}:raise ValueError('Android format must be apk, aab or aar')
    if not isinstance(result['variant'],str) or not re.fullmatch(r'[A-Z][A-Za-z0-9]{0,63}',result['variant']):raise ValueError('Android variant must be a Gradle variant suffix, e.g. Debug or DemoRelease')
    if 'module' in result and (not isinstance(result['module'],str) or not re.fullmatch(r'[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*',result['module'])):raise ValueError('Android module must be a qualified Gradle project name')
    if 'task' in result and (not isinstance(result['task'],str) or not re.fullmatch(r':?(?:[A-Za-z0-9_-]+:)*(?:assemble|bundle)[A-Za-z0-9]+',result['task'])):raise ValueError('Android task must be a qualified assemble/bundle task')
    if 'project_root' in result and (not isinstance(result['project_root'],str) or Path(result['project_root']).is_absolute() or '..' in Path(result['project_root']).parts or '\\' in result['project_root']):raise ValueError('Android project_root must remain within source')
    if 'jdk' in result and result['jdk'] not in {'8','11','17','21','25'}:raise ValueError('Android jdk must identify a supported Java SDK')
    signing=result.get('signing')
    if signing:
        if result['format']=='aar' or not isinstance(signing,dict) or set(signing)!={'keystore','store_password','key_password','alias'}:raise ValueError('Android signing requires four secret identifiers for an APK/AAB')
        if any(not isinstance(key,str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}',key) for key in signing.values()):raise ValueError('Signing uses private secret identifiers, never credential values')
    return result


def select(tasks, value):
    value=validate(value);variant=value['variant']
    requested=value.get('task',('bundle' if value['format']=='aab' else 'assemble')+variant)
    if value.get('module') and ':' not in requested:requested=value['module']+':'+requested
    requested=requested.lstrip(':')
    # Prefer an exact, qualified target. An aggregate task is permitted only
    # when its exported output resolves to one selected application.
    qualified=sorted(t for t in tasks if t==requested or t.endswith(':'+requested))
    if requested in tasks:chosen=requested
    elif len(qualified)==1:chosen=qualified[0]
    else:raise ValueError('Android build task absent or ambiguous; select module and variant: '+requested)
    prefix=chosen.rsplit(':',1)[0]+':' if ':' in chosen else ''
    tests=[prefix+'test'+variant+'UnitTest'] if prefix+'test'+variant+'UnitTest' in tasks else []
    lint=prefix+'lint'+variant if prefix+'lint'+variant in tasks else None
    return value,chosen,tests,lint


@contextmanager
def credentials(signing):
    if not signing:
        yield None;return
    values={}
    for field,key in signing.items():
        path=Path('/run/secrets')/key
        if not path.is_file() or path.is_symlink() or path.stat().st_size>65536:raise ValueError('Required Android signing input unavailable: '+key)
        values[field]=path.read_text()
    with tempfile.TemporaryDirectory(prefix='stackpilot-android-signing-') as directory:
        key=Path(directory)/'identity.keystore'
        try:key.write_bytes(base64.b64decode(values['keystore'],validate=True))
        except ValueError:raise ValueError('Signing keystore must be base64 encoded') from None
        key.chmod(0o600)
        yield {'key':str(key),'alias':values['alias'],'env':{**os.environ,
            'SP_STORE_PASSWORD':values['store_password'],'SP_KEY_PASSWORD':values['key_password']}}


def verify(artifact, kind, signer, signing):
    with zipfile.ZipFile(artifact) as archive:
        expected={'apk':'AndroidManifest.xml','aab':'base/manifest/AndroidManifest.xml','aar':'AndroidManifest.xml'}[kind]
        if expected not in archive.namelist():raise ValueError('Android output format does not match '+kind)
    if signing and os.getenv('STACKPILOT_DEFER_ANDROID_SIGNING')=='1':return 'pending'
    if kind=='aar':return 'not_applicable'
    with credentials(signing) as identity:
        if identity:
            if kind=='apk':argv=[str(signer),'sign','--ks',identity['key'],'--ks-key-alias',identity['alias'],'--ks-pass','env:SP_STORE_PASSWORD','--key-pass','env:SP_KEY_PASSWORD',str(artifact)]
            else:argv=['jarsigner','-keystore',identity['key'],'-storepass:env','SP_STORE_PASSWORD','-keypass:env','SP_KEY_PASSWORD',str(artifact),identity['alias']]
            # Do not emit credentials, including the private alias, in logs.
            print(json.dumps({'stage':'android_sign','format':kind,'secret_names':sorted(signing.values())}),flush=True)
            subprocess.run(argv,env=identity['env'],check=True,timeout=120,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if kind=='apk':
            subprocess.run([str(signer),'verify',str(artifact)],check=True,timeout=120)
            return 'verified' if identity else 'repository_signed'
        with zipfile.ZipFile(artifact) as archive:
            signed=any(name.upper().startswith('META-INF/') and name.upper().endswith(('.RSA','.DSA','.EC')) for name in archive.namelist())
        if signed:
            subprocess.run(['jarsigner','-verify',str(artifact)],check=True,timeout=120)
            return 'verified' if identity else 'repository_signed'
        return 'unsigned'
