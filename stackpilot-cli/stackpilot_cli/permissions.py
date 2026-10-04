import json
from rich.prompt import Confirm
from .ui import console


def confirm_step(permission):
    tool = permission.get("tool_name") or permission.get("name") or permission.get("tool") or "Requested action"
    step = permission.get("browser_step") or {}
    console.print(f"\nPermission: {tool}", markup=False)
    for key in ("label", "url", "reason"):
        if step.get(key):
            console.print(f"{key}: {step[key]}", markup=False)
    if permission.get("description"):
        console.print(str(permission["description"]), markup=False)
    if permission.get("arguments"):
        console.print(json.dumps(permission["arguments"], indent=2, ensure_ascii=False), markup=False)
    # Never echo an approval capability or automatically accept a broad test goal.
    return Confirm.ask("Approve this specific action?", default=False)
