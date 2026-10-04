import json
import os
from pathlib import Path
command=json.loads(Path('/app/.stackpilot-entry.json').read_text())
if not isinstance(command,list) or not command:
    raise RuntimeError('Validated application entrypoint missing')
plan_path=Path('/app/.stackpilot-plan.json')
plan=json.loads(plan_path.read_text()) if plan_path.is_file() else {}
if plan.get('workload') in {'cli','job'}:
    from console_server import serve
    serve(command,plan['workload'],int(os.getenv('PORT','3000')),plan.get('job_timeout_seconds',3600))
    raise SystemExit
os.execvp(command[0],command)
