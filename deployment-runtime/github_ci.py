"""Commit-bound, paginated GitHub CI checks; skipped checks are not passes."""
import json
from pathlib import Path
import re
import sys
import urllib.request


def judge(runs,statuses,sha,policy=None):
    policy=policy or {}
    if not isinstance(policy,dict) or set(policy)-{'checks','statuses'}:raise ValueError('Unknown required CI policy fields')
    named=policy.get('checks',[]);contexts=policy.get('statuses',[])
    if not isinstance(named,list) or not isinstance(contexts,list):raise ValueError('Invalid named CI policy')
    selected=[]
    if named:
        for requirement in named:
            if not isinstance(requirement,dict) or not isinstance(requirement.get('name'),str) or type(requirement.get('app_id')) is not int:raise ValueError('Named checks require name and trusted app_id')
            matches=[r for r in runs if r.get('name')==requirement['name'] and (r.get('app') or {}).get('id')==requirement['app_id']]
            if len(matches)!=1:return {'queried':True,'has_checks':True,'passed':False,'failed':True,'detail':'A required trusted check is missing or ambiguous'}
            selected+=matches
    else:selected=runs
    if any(r.get('head_sha','').lower()!=sha.lower() for r in selected):return {'queried':False,'passed':False,'detail':'CI evidence is bound to a different commit'}
    latest={}
    for status in statuses:
        if status.get('context') not in latest:latest[status.get('context')]=status
    if contexts:
        if any(not isinstance(c,str) or c not in latest for c in contexts):return {'queried':True,'has_checks':True,'passed':False,'failed':True,'detail':'A required commit status is missing'}
        selected_statuses=[latest[c] for c in contexts]
    else:selected_statuses=list(latest.values())
    if not selected and not selected_statuses:return {'queried':True,'has_checks':False,'passed':False,'detail':'No source-bound CI checks exist'}
    pending=any(r.get('status')!='completed' for r in selected) or any(s.get('state')=='pending' for s in selected_statuses)
    failed=any(r.get('status')=='completed' and r.get('conclusion')!='success' for r in selected) or any(s.get('state') not in {'success','pending'} for s in selected_statuses)
    return {'queried':True,'has_checks':True,'pending':pending,'failed':failed,'passed':not pending and not failed,
            'detail':'All selected CI checks passed' if not pending and not failed else 'CI checks failed or remain pending',
            'check_count':len(selected),'status_count':len(selected_statuses)}


def query(repo,sha,token,policy=None,fetch=None):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repo) or not re.fullmatch(r'[a-fA-F0-9]{40,64}',sha):raise ValueError('Invalid repository or commit identity')
    def get(path):
        request=urllib.request.Request('https://api.github.com/repos/'+repo+'/commits/'+sha+path,
            headers={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'StackPilot',**({'Authorization':'Bearer '+token} if token else {})})
        with urllib.request.urlopen(request,timeout=10) as response:return json.load(response)
    fetch=fetch or get
    runs=[];statuses=[]
    for page in range(1,11):
        result=fetch(f'/check-runs?filter=latest&per_page=100&page={page}')
        batch=result['check_runs'];runs+=batch
        if len(runs)>=result['total_count']:break
    else:raise RuntimeError('CI evidence exceeds the supported pagination bound')
    for page in range(1,11):
        batch=fetch(f'/statuses?per_page=100&page={page}');statuses+=batch
        if len(batch)<100:break
    else:raise RuntimeError('Commit status evidence exceeds the supported pagination bound')
    return judge(runs,statuses,sha,policy)


if __name__=='__main__':
    try:
        config=json.loads(Path(sys.argv[1]).read_text())
        print(json.dumps(query(config['repo'],config['sha'],config['token'],config.get('policy'))))
    except Exception as exc:print(json.dumps({'queried':False,'passed':False,'detail':'GitHub CI evidence unavailable: '+type(exc).__name__}))
