"""Inspect each built/declared test service before starting a Compose candidate."""
import json
from pathlib import Path
import subprocess
import sys
from image_evidence import inspect, require


def qualify(project, model, plan, inspector=inspect):
    services=model['services']
    selected=plan.get('test_services') or [name for name,service in services.items() if service.get('build')]
    if any(name not in services for name in selected):raise ValueError('Unknown test service')
    evidence={}
    for name in selected:
        image=services[name].get('image') or project+'-'+name
        evidence[name]=inspector(image)
    passed=bool(evidence) and all(e.get('status',e.get('tests'))=='passed' for e in evidence.values())
    result={'status':'passed' if passed else 'unrecorded','scope':'compose_repository_tests','services':evidence}
    require(result,plan.get('tests_required',False))
    return result


if __name__=='__main__':
    project,model_path,plan_path,output=sys.argv[1:]
    result=qualify(project,json.loads(Path(model_path).read_text()),json.loads(Path(plan_path).read_text()))
    Path(output).write_text(json.dumps(result))
