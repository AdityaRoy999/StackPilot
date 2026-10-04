import json
from pathlib import Path
import subprocess
import sys

result=subprocess.run([sys.executable,'job.py'],capture_output=True,text=True,check=True,timeout=5)
assert 'RESULT sum=55 count=4' in result.stdout
assert json.loads(Path('/tmp/result.json').read_text()) == {'sum':55,'count':4}
