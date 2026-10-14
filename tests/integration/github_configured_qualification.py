"""Compare untouched GitHub source with explicit StackPilot delivery settings.

Only stackpilot.json is added to task-owned copies. Application code and tests
remain unchanged; all builds execute through public platform APIs.
"""
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import time
import uuid
import release_pipeline_smoke as release
import github_category_qualification as github
from stackpilot_test_artifacts import artifact_path


def main():
    run = uuid.uuid4().hex[:10]
    report = {"run": run, "route": "StackPilot public APIs", "source_changes": "Only explicit stackpilot.json delivery settings; application source/tests unchanged", "cases": [], "complete": False}
    output = artifact_path("github-configured-qualification.json")
    projects = []
    user_id = None
    def save():
        output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    try:
        name = "github-config-" + run
        release.cookies.clear()
        release.api("POST", "/auth/register", {"username": name, "email": name + "@example.test", "password": "Fixture-" + secrets.token_hex(16) + "!aA1"})
        user_id = str(uuid.UUID(release.api("GET", "/auth/me")["user"]["id"]))
        report["user_id"] = user_id
        release.api("PUT", "/ai/settings", {"enabled": False})
        cases = [
            ("web-standalone", "skoulasp/todo-app", None),
            ("desktop-python-explicit", "cyb3rr31a/python-calculator", {
                "workload": "desktop", "build_recipe": {
                    "image": "python:3.12-slim", "commands": [["python3", "-m", "compileall", "-q", "main.py"],
                        ["python3", "-c", "from pathlib import Path; import shutil; Path('output').mkdir(exist_ok=True); shutil.copy2('main.py','output/main.py')"]],
                    "outputs": ["output"], "runtime_image": "python:3.12-slim",
                    "runtime_setup": [["apt-get", "update"], ["apt-get", "install", "-y", "--no-install-recommends", "python3-tk"]],
                    "runtime_command": ["/usr/bin/python3", "/app/output/main.py"]}}),
            ("package-python-explicit", "pypa/sampleproject", {
                "workload": "package", "tests_required": True,
                "tests": [["python", "-m", "unittest", "discover", "-s", "tests"]],
                "build_recipe": {"image": "python:3.12-slim", "commands": [["python", "-m", "pip", "install", "--no-input", "build"],
                    ["python", "-m", "pip", "install", "--no-input", "-e", "."], ["python", "-m", "build"]], "outputs": ["dist"]}}),
            ("cli-go-explicit", "charmbracelet/glow", {"workload": "cli", "entrypoint": ["/app/server", "--version"],
                "console_scenarios": [{"name": "Version command", "steps": [{"output_contains": "glow"}, {"exit_code": 0}]}]}),
            ("desktop-windows-explicit", "microsoft/WPF-Samples", {"workload": "windows"}),
        ]
        for category, repo, contract in cases:
            sha, branch = github.revision(repo)
            item = {"category": category, "repository": "https://github.com/" + repo, "commit": sha,
                    "branch": branch, "started_at": time.time(), "outcome": "creating", "contract_added": contract is not None}
            report["cases"].append(item)
            save()
            if contract:
                directory = release.ROOT / "local-projects" / "github-configured" / run / category
                shutil.copytree(github.SOURCE / repo.replace("/", "--"), directory, ignore=shutil.ignore_patterns(".git"))
                (directory / "stackpilot.json").write_text(json.dumps(contract, indent=2), encoding="utf-8")
                spec = {"source_type": "local", "source_path": "/app/local-projects/github-configured/" + run + "/" + category}
                item["delivery_contract"] = contract
            else:
                spec = {"source_type": "github", "repo_url": item["repository"]}
            project = release.api("POST", "/projects", {"name": "Configured GitHub QA " + category + " " + run, "execution_mode": "local",
                "environments": [{"name": "production", "branch": branch, "require_ci": False, "auto_deploy": False}], **spec})["project"]
            item["project_id"] = project["id"]
            projects.append(project["id"])
            deployment = release.api("POST", "/projects/" + project["id"] + "/deployments", {"version": "configured-" + sha[:10], "branch": branch, "commit_sha": sha})["deployment"]
            item["deployment_id"] = deployment["id"]
            release.api("POST", "/deployments/" + deployment["id"] + "/trigger", {})
            item["outcome"] = "queued"
            print("CONFIGURED_QUEUED " + category, flush=True)
            save()
        pending = report["cases"][:]
        states = {}
        deadline = time.monotonic() + 3600
        while pending and time.monotonic() < deadline:
            for item in pending[:]:
                result = release.api("GET", "/deployments/" + item["deployment_id"])
                item["platform_status"] = result["status"]
                if states.get(item["category"]) != result["status"]:
                    print("CONFIGURED_STATE " + item["category"] + " " + result["status"], flush=True)
                    states[item["category"]] = result["status"]
                routed = (result.get("runtime_snapshot") or {}).get("routed_verification") or {}
                if result["status"] in {"failed", "failed_ci", "canceled", "superseded"} or result["status"] in {"running", "ready"} and routed.get("verified"):
                    try:
                        github.finish_case(item, result)
                    except Exception as exc:
                        item["outcome"] = "verification_failed"
                        item["error"] = str(exc)
                    pending.remove(item)
                    print("CONFIGURED_RESULT " + item["category"] + " " + item["outcome"], flush=True)
                save()
            if pending:
                time.sleep(5)
        for item in pending:
            item["outcome"] = "timed_out"
            release.api("POST", "/deployments/" + item["deployment_id"] + "/cancel", {}, expected=(200, 202, 409))
        report["complete"] = True
        save()
        # Keep delivered samples available for independent browser/package checks.
        print("CONFIGURED_COMPLETE " + json.dumps({c["category"]: c["outcome"] for c in report["cases"]}), flush=True)
    finally:
        save()


if __name__ == "__main__":
    main()
