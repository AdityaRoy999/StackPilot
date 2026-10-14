"""Resolve a GitHub ref once, before build or CI, without logging credentials."""
import json
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


def resolve(repo, ref, token="", fetch=None):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Invalid GitHub repository")
    if not isinstance(ref, str) or len(ref) > 255 or any(ord(c) < 32 for c in ref):
        raise ValueError("Invalid Git ref")

    def get(path):
        request = urllib.request.Request("https://api.github.com/repos/" + repo + path, headers={
            "Accept": "application/vnd.github+json", "User-Agent": "StackPilot",
            "X-GitHub-Api-Version": "2022-11-28",
            **({"Authorization": "Bearer " + token} if token else {}),
        })
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    fetch = fetch or get
    if not ref or ref == "HEAD":
        ref = fetch("").get("default_branch", "")
        if not ref:
            raise ValueError("Repository has no default branch")
    sha = fetch("/commits/" + urllib.parse.quote(ref, safe="")).get("sha", "")
    if not re.fullmatch(r"[a-fA-F0-9]{40}|[a-fA-F0-9]{64}", sha):
        raise ValueError("GitHub did not return an immutable commit")
    if re.fullmatch(r"[a-fA-F0-9]{7,64}", ref) and not sha.lower().startswith(ref.lower()):
        raise ValueError("Resolved commit does not match the requested SHA")
    return {"resolved": True, "sha": sha.lower(), "ref": ref}


if __name__ == "__main__":
    try:
        config = json.loads(Path(sys.argv[1]).read_text())
        print(json.dumps(resolve(config["repo"], config.get("ref", ""), config.get("token", ""))))
    except urllib.error.HTTPError as exc:
        print(json.dumps({"resolved": False, "detail": f"GitHub revision lookup returned HTTP {exc.code}. Check repository access and branch."}))
    except Exception as exc:
        print(json.dumps({"resolved": False, "detail": "GitHub revision could not be resolved: " + type(exc).__name__}))
