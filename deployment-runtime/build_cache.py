"""Project-scoped mutable compiler caches with exclusive BuildKit access."""
import hashlib
import json
from pathlib import Path
import uuid


def namespace(root):
    path=Path(root)/'.stackpilot-context.json'
    identity=None
    if path.is_file() and not path.is_symlink() and path.stat().st_size<=256*1024:
        context=json.loads(path.read_text())
        if isinstance(context,dict):identity=context.get('project',{}).get('id')
    try:
        identity=str(uuid.UUID(identity))
    except (ValueError,TypeError,AttributeError):
        # Standalone/custom builds have no authenticated project context and
        # must not inherit another build's mutable cache.
        identity=uuid.uuid4().hex
    return 'stackpilot-'+hashlib.sha256(identity.encode()).hexdigest()[:24]
