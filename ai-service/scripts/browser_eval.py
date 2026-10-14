"""Aggregate a saved StackPilot browser SSE/JSONL trace without printing task data.

Usage: python scripts/browser_eval.py path/to/events.jsonl
"""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.browser_testing.evaluation import summarize_events


def load_events(path: Path) -> list[dict]:
    events = []
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line.startswith('data:'):
            line = line[5:].strip()
        if line and line != '[DONE]':
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    events.append(value)
            except json.JSONDecodeError:
                continue
    return events


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python scripts/browser_eval.py path/to/events.jsonl')
    print(json.dumps(summarize_events(load_events(Path(sys.argv[1]))), indent=2))
