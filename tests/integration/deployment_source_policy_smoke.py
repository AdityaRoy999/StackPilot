"""Opt-in source/CI API qualification; no provider calls or user repositories.

Uses GitHub's public Hello-World fixture to resolve a real default branch, then
cancels before CI's grace period. All mutations target this run's fixture IDs.
"""
import json
import secrets
import subprocess
import time
import uuid
import release_pipeline_smoke as release


def main():
    run = uuid.uuid4().hex[:12]
    project = None
    cases = []
    release.api("POST", "/auth/register", {"username": "source-policy-" + run, "email": "source-policy-" + run + "@example.test", "password": "Fixture-" + secrets.token_hex(16) + "!Aa1"})
    try:
        project = release.api("POST", "/projects", {"name": "Source policy " + run, "repo_url": "https://github.com/octocat/Hello-World", "source_type": "github", "environments": [{"name": "production", "branch": "HEAD", "auto_deploy": False, "require_ci": True}]})["project"]
        first = release.api("POST", "/projects/" + project["id"] + "/deployments", {"trigger_source": "manual", "ci_required": False})["deployment"]
        assert first["ci_required"] and first["ci_status"] == "pending", first
        assert first["version"] == "release-" + first["id"], first
        release.api("POST", "/deployments/" + first["id"] + "/trigger", {})
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            observed = release.api("GET", "/deployments/" + first["id"])
            if observed.get("commit_sha") and observed["status"] == "blocked": break
            if observed["status"] == "failed": raise AssertionError("Source resolution failed before CI: " + str(observed.get("job")))
            time.sleep(.5)
        else: raise AssertionError("Source was not pinned before CI")
        assert len(observed["commit_sha"]) == 40 and observed["commit_hash"] == observed["commit_sha"], observed
        assert observed["branch"] == "master", observed
        assert not observed.get("image_name"), "Build started before CI passed"
        cases.append("manual CI inheritance, default branch resolution, canonical commit pinning before CI")
        release.api("POST", "/deployments/" + first["id"] + "/cancel", {})

        # An existing failed CI result must not become a pass when manually queued.
        retry = release.api("POST", "/projects/" + project["id"] + "/deployments", {"commit_sha": observed["commit_sha"], "branch": observed["branch"]})["deployment"]
        identity = str(uuid.UUID(retry["id"]))
        subprocess.run(["docker", "exec", "-i", "stackpilot-postgres", "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], input="UPDATE deployments SET ci_status='failed' WHERE id='" + identity + "';", text=True, check=True, capture_output=True)
        release.api("POST", "/deployments/" + identity + "/trigger", {}, expected=(200,202,400,409))
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            retried = release.api("GET", "/deployments/" + identity)
            assert not retried.get("image_name"), "Failed CI was bypassed on retry"
            if retried["status"] in {"blocked", "failed_ci"}: break
            time.sleep(.5)
        else: raise AssertionError("Failed CI retry did not remain gated")
        release.api("POST", "/deployments/" + identity + "/cancel", {}, expected=(200,202,409))
        cases.append("failed CI remains gated on a manual retry")

        refused = release.api("POST", "/projects/" + project["id"] + "/deployments", {"source_artifact_id": str(uuid.uuid4())}, expected=(400,))
        assert "CI" in refused.get("error", "")
        cases.append("edited workspace archive cannot borrow CI evidence from another source")
        edited = release.api("PUT", "/projects/" + project["id"], {"env_vars": [{"key": "SOURCE_POLICY_FIXTURE", "value": run}]})
        assert edited.get("auto_build_triggered") and edited.get("auto_build_deployment_id"), edited
        rebuilt = release.api("GET", "/deployments/" + edited["auto_build_deployment_id"])
        assert rebuilt["environment_id"] == first["environment_id"] and rebuilt["branch"] == observed["branch"], rebuilt
        assert rebuilt["commit_sha"] == observed["commit_sha"] and rebuilt["ci_required"] and rebuilt["ci_status"] != "passed", rebuilt
        release.api("POST", "/deployments/" + rebuilt["id"] + "/cancel", {}, expected=(200,202,409))
        cases.append("variable changes preserve environment, pinned source, and required CI")
        print("SOURCE_POLICY_PASS " + json.dumps({"cases": cases}), flush=True)
    finally:
        if project: release.api("DELETE", "/projects/" + project["id"], expected=(200,204))


if __name__ == "__main__":
    main()
