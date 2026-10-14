"""Public GitHub repository qualification through real StackPilot APIs.

No source commands execute on the host. Each account/project is test owned.
Selection and immutable revisions are recorded, including unsuccessful cases.
Default runs isolate deterministic delivery from model/provider variability.
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import secrets
import subprocess
import time
from urllib.parse import urlsplit
import urllib.request
import uuid

import release_pipeline_smoke as release
from stackpilot_test_artifacts import artifact_path

POOLS = {
    "android": ["StephenGemin/Calculator_Android_App", "AdityaBahl/Calculator-Android-App", "alexbond008/calculator-android"],
    "web": ["skoulasp/todo-app", "jean-ely-gendrau/vite-todo-app"],
    "desktop-python": ["cyb3rr31a/python-calculator", "sakethsimhareddy/Calculator"],
}
EXTRA = [("desktop-compose", "JetBrains/compose-multiplatform-desktop-template"),
         ("desktop-windows", "microsoft/WPF-Samples"), ("cli-go", "charmbracelet/glow"),
         ("package-python", "pypa/sampleproject")]
SOURCE = release.ROOT / "local-projects" / "github-qualification"
REPORT = artifact_path("github-category-qualification.json")


def selection(seed):
    rng = random.Random(seed)
    return [(kind, rng.choice(pool)) for kind, pool in POOLS.items()] + EXTRA


def revision(repo):
    directory = SOURCE / repo.replace("/", "--")
    if not (directory / ".git").is_dir():
        raise RuntimeError("Clone the bounded public source inventory first: " + repo)
    def git(*args):
        return subprocess.run(["git", "-C", str(directory), *args], check=True, capture_output=True,
                              text=True, timeout=15).stdout.strip()
    return git("rev-parse", "HEAD"), git("symbolic-ref", "refs/remotes/origin/HEAD").removeprefix("refs/remotes/origin/")


def save(report):
    pending = REPORT.with_suffix(".pending.json")
    pending.write_text(json.dumps(report, indent=2), encoding="utf-8")
    # OneDrive/readers briefly lock replace targets on Windows.
    for attempt in range(8):
        try:
            pending.replace(REPORT)
            return
        except PermissionError:
            time.sleep(min(.1 * 2 ** attempt, 2))
    raise RuntimeError("Qualification evidence file remained locked")


def resume_test_identity(report):
    user_id = str(uuid.UUID(report["user_id"]))
    prefix = report.get("identity_prefix", "github-qa-")
    if prefix not in {"github-qa-", "github-config-", "github-retry-"}:
        raise ValueError("Unknown qualification account prefix")
    email = prefix + report["run"] + "@example.test"
    # A short-lived fixture credential stays in subprocess memory. No platform
    # secret/token is printed by the harness or written into evidence files.
    code = """import base64,hashlib,hmac,json,os,sys,time
uid,email=json.load(sys.stdin);now=int(time.time())
encode=lambda x:base64.urlsafe_b64encode(json.dumps(x,separators=(',',':')).encode()).decode().rstrip('=')
data=encode({'alg':'HS256','typ':'JWT'})+'.'+encode({'user_id':uid,'email':email,'iat':now,'exp':now+7200})
signature=base64.urlsafe_b64encode(hmac.new(os.environ['JWT_SECRET'].encode(),data.encode(),hashlib.sha256).digest()).decode().rstrip('=')
print(data+'.'+signature)
"""
    import http.cookiejar
    token = subprocess.run(["docker", "exec", "-i", "stackpilot-backend", "python3", "-c", code],
        input=json.dumps([user_id, email]),
        capture_output=True, text=True, check=True, timeout=15).stdout.strip()
    release.cookies.clear()
    release.cookies.set_cookie(http.cookiejar.Cookie(0,"token",token,None,False,"127.0.0.1",False,False,"/",True,False,None,True,None,None,{},False))
    user = release.api("GET", "/auth/me")["user"]
    assert user["id"] == user_id and user["email"] == email, "Only the exact test identity can resume"


def request_runtime(url, path="/"):
    parsed = urlsplit(url)
    if parsed.hostname and parsed.hostname.endswith(".preview.localhost"):
        target = "http://127.0.0.1:" + str(parsed.port) + path
        headers = {"Host": parsed.netloc}
    else:
        target = url.rstrip("/") + path
        headers = {}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(urllib.request.Request(target, headers=headers), timeout=30) as response:
        return response.status, response.headers, response.read()


def finish_case(case, deployment):
    snapshot = deployment.get("runtime_snapshot") or {}
    case["platform_status"] = deployment["status"]
    case["job_status"] = (deployment.get("job") or {}).get("status")
    case["verification"] = snapshot.get("runtime_verification") or {}
    case["routed_verification"] = snapshot.get("routed_verification") or {}
    case["runtime_url"] = deployment.get("runtime_url") or ""
    case["archetype"] = snapshot.get("archetype") or (snapshot.get("deployment_plan") or {}).get("workload")
    if deployment["status"] in {"running", "ready"} and case["verification"].get("verified") and case["routed_verification"].get("verified"):
        case["outcome"] = "delivered"
        status, _, body = request_runtime(case["runtime_url"])
        case["http_status"] = status
        case["runtime_document_sha256"] = hashlib.sha256(body).hexdigest()
        if case["verification"].get("scope") == "artifact_delivery":
            _, _, body = request_runtime(case["runtime_url"], "/healthz")
            health = json.loads(body)
            downloaded = []
            for entry in health.get("artifacts", []):
                _, headers, data = request_runtime(case["runtime_url"], "/artifacts/" + entry["name"])
                assert len(data) == entry["size"] and hashlib.sha256(data).hexdigest() == entry["sha256"]
                assert headers.get("Content-Disposition", "").startswith("attachment;")
                filename = case["category"] + "-" + case["deployment_id"][:8] + "-" + entry["name"]
                artifact_path(filename).write_bytes(data)
                downloaded.append({**entry, "download_verified": True, "local_file": filename})
            assert downloaded, "Artifact runtime has no downloadable output"
            case["downloads"] = downloaded
    else:
        case["outcome"] = "failed" if deployment["status"] in {"failed", "failed_ci"} else "unverified"
    logs = release.api("GET", "/deployments/" + case["deployment_id"] + "/logs")
    text = (logs.get("deployment") or {}).get("logs", logs.get("logs", ""))
    name = case["category"] + "-" + case["deployment_id"][:8] + ".log"
    artifact_path(name).write_text(text, encoding="utf-8")
    case["log_file"] = name
    case["log_tail"] = text[-7000:]
    case["duration_seconds"] = round(time.time() - case["started_at"], 1)


def main(seed=20261013, ai_enabled=False, cleanup=False, resume=False):
    run = uuid.uuid4().hex[:10]
    report = {"run": run, "selection_seed": seed, "selection_pools": POOLS,
              "selection_method": "Seeded draw from public search candidates, plus explicit category coverage samples",
              "source_changes": "none", "ai_enabled": ai_enabled, "route": "authenticated project/create-deployment/trigger/status APIs",
              "started_at": time.time(), "cases": [], "complete": False}
    username = "github-qa-" + run
    user_id = None
    try:
        if resume:
            report = json.loads(REPORT.read_text(encoding="utf-8"))
            run = report["run"]
            user_id = report["user_id"]
            resume_test_identity(report)
            report["cleanup_errors"] = []
            report["complete"] = False
        else:
            release.cookies.clear()
            release.api("POST", "/auth/register", {"username": username, "email": username + "@example.test",
                                                    "password": "Fixture-" + secrets.token_hex(16) + "!aA1"})
            user_id = str(uuid.UUID(release.api("GET", "/auth/me")["user"]["id"]))
            report["user_id"] = user_id
            release.api("PUT", "/ai/settings", {"enabled": ai_enabled})
        for category, repo in selection(report["selection_seed"]):
            previous = next((c for c in report["cases"] if c["category"] == category), None)
            if previous and not previous.get("cleaned_up"):
                continue
            sha, branch = revision(repo)
            case = {"category": category, "repository": "https://github.com/" + repo, "commit": sha,
                    "branch": branch, "started_at": time.time(), "outcome": "creating"}
            if previous:
                case["previous_observer_attempt"] = {k:previous.get(k) for k in ("project_id","deployment_id","outcome","cleaned_up")}
                report["cases"][report["cases"].index(previous)] = case
            else:
                report["cases"].append(case)
            save(report)
            try:
                project = release.api("POST", "/projects", {"name": "GitHub QA " + category + " " + run,
                    "source_type": "github", "repo_url": case["repository"], "execution_mode": "local",
                    "environments": [{"name": "production", "branch": branch, "auto_deploy": False, "require_ci": False}]})["project"]
                case["project_id"] = project["id"]
                deployment = release.api("POST", "/projects/" + project["id"] + "/deployments",
                    {"version": "github-qa-" + sha[:10], "branch": branch, "commit_sha": sha})["deployment"]
                case["deployment_id"] = deployment["id"]
                release.api("POST", "/deployments/" + deployment["id"] + "/trigger", {})
                case["outcome"] = "queued"
                print("GITHUB_QUEUED " + category + " " + repo + " " + sha[:10], flush=True)
            except Exception as exc:
                case["outcome"] = "setup_failed"
                case["error"] = str(exc)
                print("GITHUB_SETUP_FAILED " + category + " " + str(exc), flush=True)
            save(report)
        deadline = time.monotonic() + 3600
        pending = [case for case in report["cases"] if case["outcome"] == "queued"]
        states = {}
        while pending and time.monotonic() < deadline:
            for case in pending[:]:
                result = release.api("GET", "/deployments/" + case["deployment_id"])
                status = result["status"]
                job = (result.get("job") or {}).get("status", "")
                case["platform_status"] = status
                case["job_status"] = job
                marker = status + "/" + job
                if states.get(case["category"]) != marker:
                    states[case["category"]] = marker
                    print("GITHUB_STATE " + case["category"] + " " + marker, flush=True)
                routed = (result.get("runtime_snapshot") or {}).get("routed_verification") or {}
                if status in {"failed", "failed_ci", "canceled", "superseded"} or status in {"running", "ready"} and routed.get("verified"):
                    try:
                        finish_case(case, result)
                    except Exception as exc:
                        case["outcome"] = "verification_failed"
                        case["error"] = str(exc)
                    print("GITHUB_RESULT " + case["category"] + " " + case["outcome"], flush=True)
                    pending.remove(case)
                save(report)
            if pending:
                time.sleep(5)
        for case in pending:
            case["outcome"] = "timed_out"
            release.api("POST", "/deployments/" + case["deployment_id"] + "/cancel", {}, expected=(200, 202, 409))
        report["complete"] = True
        report["finished_at"] = time.time()
        save(report)
        print("GITHUB_QUALIFICATION_COMPLETE " + json.dumps({case["category"]: case["outcome"] for case in report["cases"]}), flush=True)
    finally:
        if cleanup:
            errors = []
            for case in report["cases"]:
                if case.get("project_id"):
                    try:
                        release.api("DELETE", "/projects/" + case["project_id"], expected=(200, 204, 404))
                        case["cleaned_up"] = True
                    except Exception as exc:
                        errors.append(str(exc))
            report["cleanup_errors"] = errors
            if user_id and not errors:
                sql = "DELETE FROM organizations WHERE is_personal AND id IN (SELECT organization_id FROM organization_members WHERE user_id='" + user_id + "'); DELETE FROM users WHERE id='" + user_id + "';"
                subprocess.run(["docker", "exec", "-i", "stackpilot-postgres", "sh", "-c",
                                'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1'],
                               input=sql, text=True, check=True, capture_output=True)
                report["account_cleaned_up"] = True
            save(report)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=20261013)
    parser.add_argument("--ai-enabled", action="store_true")
    parser.add_argument("--cleanup", action="store_true")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    main(args.seed, args.ai_enabled, args.cleanup, args.resume)
