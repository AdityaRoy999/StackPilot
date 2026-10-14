"""Seed the exact pinned wrapper ZIP after a transient Java transport failure."""
import hashlib
import json
import os
from pathlib import Path
import re
import time
import urllib.request
import urllib.error


def cache_location(url, home):
    value=int.from_bytes(hashlib.md5(url.encode('ascii')).digest(),'big');characters='0123456789abcdefghijklmnopqrstuvwxyz';key=''
    while value:key=characters[value%36]+key;value//=36
    name=url.rsplit('/',1)[1]
    return Path(home)/'wrapper/dists'/name.removesuffix('.zip')/key/name


def seed(expires):
    path=Path('gradle/wrapper/gradle-wrapper.properties')
    if not path.is_file() or path.is_symlink() or path.stat().st_size>65536:return False
    values=dict(re.findall(r'^\s*([\w]+)\s*=\s*([^\r\n]*)',path.read_text(),re.M))
    url=values.get('distributionUrl','').replace('\\:',':')
    checksum=values.get('distributionSha256Sum','')
    if not re.fullmatch(r'https://(?:services|downloads)\.gradle\.org/distributions/gradle-[0-9.]+-(?:bin|all)\.zip',url):return False
    if checksum and not re.fullmatch('[a-fA-F0-9]{64}',checksum):raise ValueError('Invalid pinned Gradle checksum')
    if values.get('distributionBase','GRADLE_USER_HOME')!='GRADLE_USER_HOME' or values.get('zipStoreBase','GRADLE_USER_HOME')!='GRADLE_USER_HOME' or values.get('distributionPath','wrapper/dists')!='wrapper/dists' or values.get('zipStorePath','wrapper/dists')!='wrapper/dists':return False
    destination=cache_location(url,os.getenv('GRADLE_USER_HOME',str(Path.home()/'.gradle')))
    if destination.with_suffix('.zip.ok').is_file():return False
    destination.parent.mkdir(parents=True,exist_ok=True)
    partial=destination.with_suffix('.stackpilot-download')
    mirror='https://downloads.gradle.org/distributions/'+destination.name
    try:
        checksum_source='repository_pin'
        if not checksum:
            # Old wrappers may omit checksum validation and ignore transport
            # timeout settings. Resolve the official checksum for their exact
            # selected release; never switch version or accept unchecked bytes.
            with urllib.request.urlopen(mirror+'.sha256',timeout=min(30,max(1,expires-time.monotonic()))) as response:
                checksum=response.read(200).decode('ascii').strip()
            if not re.fullmatch('[a-fA-F0-9]{64}',checksum):raise ValueError('Official Gradle checksum response is invalid')
            checksum_source='official_release_https'
        for attempt,target in enumerate(dict.fromkeys([mirror,url])):
            try:
                digest=hashlib.sha256();size=0;last_report=0
                print(json.dumps({'stage':'gradle_transport','attempt':attempt+1,'version_archive':destination.name,'checksum_required':True,'checksum_source':checksum_source}),flush=True)
                with urllib.request.urlopen(target,timeout=min(60,max(1,expires-time.monotonic()))) as response,partial.open('wb') as stream:
                    while True:
                        if time.monotonic()>=expires:raise TimeoutError('Pinned Gradle download deadline exceeded')
                        chunk=response.read(1024*1024)
                        if not chunk:break
                        size+=len(chunk)
                        if size>512*1024**2:raise ValueError('Gradle distribution exceeds transport bounds')
                        stream.write(chunk);digest.update(chunk)
                        if size-last_report>=16*1024**2:print(json.dumps({'stage':'gradle_transport','bytes':size}),flush=True);last_report=size
                if digest.hexdigest()!=checksum.lower():raise ValueError('Pinned Gradle checksum mismatch; transport retry refused')
                partial.replace(destination)
                print(json.dumps({'stage':'gradle_transport','status':'checksum_verified','bytes':size}),flush=True)
                return True
            except (urllib.error.URLError,TimeoutError,OSError):
                if attempt or time.monotonic()>=expires:raise
        return False
    finally:
        partial.unlink(missing_ok=True)
