"""Choose a Gradle JVM from pinned evidence, without executing build scripts."""
from pathlib import Path
import re

def select(root,config,discovery,workload):
    root=Path(root);directory=root/config.get('android',{}).get('project_root','.') if workload=='android' else root
    properties=directory/'gradle/wrapper/gradle-wrapper.properties'
    text=properties.read_text() if properties.is_file() and not properties.is_symlink() and properties.stat().st_size<=65536 else ''
    match=re.search(r'gradle-(\d+)\.(\d+)(?:\.\d+)?-(?:bin|all)\.zip',text)
    if not match:return {'jdk':'21','gradle':None,'status':'requires_wrapper','execution_verified':False}
    gradle=tuple(map(int,match.groups()));version='.'.join(map(str,gradle))
    sdk=next((t for t in discovery.get('toolchains',[]) if t['kind']=='java'),{})
    exact=[e['requirement'] for e in sdk.get('evidence',[]) if e['mode']=='pin']
    for name in ('build.gradle','build.gradle.kts'):
        path=directory/name
        if path.is_file() and not path.is_symlink() and path.stat().st_size<=1024*1024:
            exact.extend(re.findall(r'(?:JavaLanguageVersion\.of|jvmToolchain)\s*\(\s*(\d+)\s*\)',path.read_text()))
    if len(set(exact))>1:raise ValueError('Multiple pinned Java toolchains require an explicit native build recipe')
    requested=config.get('android',{}).get('jdk') if workload=='android' else None
    requested=requested or (exact[0] if exact else None)
    jdk=int(requested.split('.')[0]) if isinstance(requested,str) else 21 if gradle>=(8,5) else 17 if gradle>=(7,3) else 11 if gradle>=(5,0) else 8
    compatibility={8:(2,0),11:(5,0),17:(7,3),21:(8,5),25:(9,1)}
    if jdk not in compatibility or gradle<compatibility[jdk] or (jdk<17 and gradle>=(9,0)):raise ValueError('Pinned Gradle '+version+' cannot run on selected Java '+str(jdk)+'; select compatible SDK evidence')
    catalog=directory/'gradle/libs.versions.toml'
    agp=None
    if catalog.is_file() and not catalog.is_symlink() and catalog.stat().st_size<=1024*1024:
        match=re.search(r'^\s*agp\s*=\s*[\'"](\d+)[.\d]*[\'"]',catalog.read_text(),re.M)
        if match:agp=int(match[1])
    if workload=='android' and agp and jdk<(17 if agp>=8 else 11 if agp>=7 else 8):raise ValueError('Android Gradle Plugin and selected Java SDK are incompatible')
    return {'jdk':str(jdk),'gradle':version,'agp_major':agp,'status':'selected','execution_verified':False}
