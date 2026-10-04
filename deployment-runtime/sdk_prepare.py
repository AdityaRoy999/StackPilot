"""Install declared SDK versions; let Gradle resolve project variants."""
from pathlib import Path
import json
import re
import subprocess

def packages(root):
    text = '\n'.join(p.read_text(errors='replace') for p in root.glob('**/build.gradle*') if 'build' not in p.parts and not p.is_symlink())
    versions = set(re.findall(r'compileSdk(?:Version)?\s*(?:=|\()?\s*(\d+)',text))
    tools = set(re.findall(r'buildToolsVersion\s*(?:=|\()?\s*["\']([\d.]+)',text))
    return ['platforms;android-'+v for v in sorted(versions)]+['build-tools;'+v for v in sorted(tools)]


if __name__=='__main__':
    import sys
    requested=json.loads(Path(sys.argv[1]).read_text()) if len(sys.argv)>1 else packages(Path('.'))
    if requested:subprocess.run(['sdkmanager',*requested],check=True,timeout=600)
