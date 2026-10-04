import json
from pathlib import Path

values = [12, 30, 6, 7]
result = {'sum': sum(values), 'count': len(values)}
Path('/tmp/result.json').write_text(json.dumps(result))
print('RESULT sum=55 count=4', flush=True)
