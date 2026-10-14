"""Requalify Android bootstrap and select one real WPF application component.

Source is unchanged. Windows receives only explicit delivery metadata. Retain
resources until independent interaction checks finish; cleanup uses exact IDs.
"""
import json
import secrets
import shutil
import time
import uuid

import github_category_qualification as github
import release_pipeline_smoke as release
from stackpilot_test_artifacts import artifact_path


def main():
    run = uuid.uuid4().hex[:10]
    report = {"run": run, "identity_prefix": "github-retry-", "ai_enabled": False,
              "route": "StackPilot public APIs", "cases": [], "complete": False}
    output = artifact_path("github-targeted-qualification.json")
    def save():
        pending = output.with_suffix(".pending.json")
        pending.write_text(json.dumps(report, indent=2), encoding="utf-8")
        for attempt in range(8):
            try:
                pending.replace(output)
                return
            except PermissionError:
                time.sleep(min(.1 * 2 ** attempt, 2))
        raise RuntimeError("Qualification report remained locked")
    name = report["identity_prefix"] + run
    release.cookies.clear()
    release.api("POST", "/auth/register", {"username": name, "email": name + "@example.test",
                "password": "Fixture-" + secrets.token_hex(16) + "!aA1"})
    report["user_id"] = str(uuid.UUID(release.api("GET", "/auth/me")["user"]["id"]))
    release.api("PUT", "/ai/settings", {"enabled": False})
    save()
    for category, repo, component in [
            ("android-retry", "alexbond008/calculator-android", None),
            ("windows-selected-app", "microsoft/WPF-Samples", "Sample Applications/CalculatorDemo")]:
        sha, branch = github.revision(repo)
        item = {"category": category, "repository": "https://github.com/" + repo,
                "commit": sha, "branch": branch, "started_at": time.time(),
                "source_changes": "none", "outcome": "creating"}
        report["cases"].append(item)
        save()
        if component:
            directory = release.ROOT / "local-projects" / "github-targeted" / run / category
            shutil.copytree(github.SOURCE / repo.replace("/", "--") / component, directory)
            (directory / "stackpilot.json").write_text(json.dumps({"workload": "windows"}), encoding="utf-8")
            item.update(component=component, source_changes="Only stackpilot.json with workload=windows")
            spec = {"source_type": "local", "source_path": "/app/local-projects/github-targeted/" + run + "/" + category}
        else:
            spec = {"source_type": "github", "repo_url": item["repository"]}
        project = release.api("POST", "/projects", {"name": "Targeted GitHub QA " + category + " " + run,
                    "execution_mode": "local", "environments": [{"name": "production", "branch": branch,
                    "auto_deploy": False, "require_ci": False}], **spec})["project"]
        item["project_id"] = project["id"]
        deployment = release.api("POST", "/projects/" + project["id"] + "/deployments",
                       {"version": "retry-" + sha[:10], "branch": branch, "commit_sha": sha})["deployment"]
        item["deployment_id"] = deployment["id"]
        release.api("POST", "/deployments/" + deployment["id"] + "/trigger", {})
        item["outcome"] = "queued"
        print("TARGETED_QUEUED " + category, flush=True)
        save()
    pending = report["cases"][:]
    states = {}
    deadline = time.monotonic() + 3600
    while pending and time.monotonic() < deadline:
        for item in pending[:]:
            result = release.api("GET", "/deployments/" + item["deployment_id"])
            item["platform_status"] = result["status"]
            if states.get(item["category"]) != result["status"]:
                print("TARGETED_STATE " + item["category"] + " " + result["status"], flush=True)
                states[item["category"]] = result["status"]
            routed = (result.get("runtime_snapshot") or {}).get("routed_verification") or {}
            if result["status"] in {"failed", "failed_ci", "canceled", "superseded"} or result["status"] in {"running", "ready"} and routed.get("verified"):
                try:
                    github.finish_case(item, result)
                except Exception as exc:
                    item["outcome"] = "verification_failed"
                    item["error"] = str(exc)
                pending.remove(item)
                print("TARGETED_RESULT " + item["category"] + " " + item["outcome"], flush=True)
            save()
        if pending:
            time.sleep(5)
    for item in pending:
        item["outcome"] = "timed_out"
        release.api("POST", "/deployments/" + item["deployment_id"] + "/cancel", {}, expected=(200, 202, 409))
    report["complete"] = True
    save()
    print("TARGETED_COMPLETE " + json.dumps({c["category"]: c["outcome"] for c in report["cases"]}), flush=True)


if __name__ == "__main__":
    main()
