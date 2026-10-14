"""Opt-in stack API qualification with disposable local accounts and a preset.

No deployments, provider calls, or user repositories are touched. The public
GitHub Hello-World fixture exercises an honest unknown-stack response.
"""
import copy
import json
import secrets
import subprocess
import uuid
import release_pipeline_smoke as release


def main():
    project_id = None
    identities = []
    emails = []
    fixture = "stack-inspection-" + uuid.uuid4().hex[:12]
    secret = "private-fixture-" + secrets.token_hex(12)
    try:
        release.api("POST", "/projects/inspect-stack", {"source_type": "application", "application_template_id": "postgres"}, expected=(401,))
        for suffix in ["owner", "other"]:
            emails.append(fixture + "-" + suffix + "@example.test")
        release.api("POST", "/auth/register", {"username": fixture, "email": emails[0], "password": "Fixture-" + secrets.token_hex(16) + "!aA1"})
        identities.append(release.api("GET", "/auth/me")["user"]["id"])
        owner_cookies = copy.deepcopy(list(release.cookies))
        before = len(release.api("GET", "/projects")["projects"])
        preview = release.api("POST", "/projects/inspect-stack", {"source_type": "application", "application_template_id": "postgres"})["stack"]
        assert any(item["id"] == "postgres" and item["kind"] == "service" for item in preview["components"])
        assert len(release.api("GET", "/projects")["projects"]) == before, "Preview created a project"
        denied = release.api("POST", "/projects/inspect-stack", {"source_type": "local", "source_path": "/etc"})["stack"]
        assert denied["status"] == "unavailable" and not denied["components"]
        unknown = release.api("POST", "/projects/inspect-stack", {"source_type": "github", "repo_url": "https://github.com/octocat/Hello-World"})["stack"]
        assert unknown["status"] in {"unknown", "unavailable"}, unknown
        if unknown["status"] == "unavailable":
            assert not unknown["components"] and unknown["message"]
            print("Public GitHub inspection unavailable (access/rate limit/network); honest unavailable response verified.")
        project = release.api("POST", "/projects", {"name": fixture, "source_type": "application", "application_template_id": "postgres", "application_config": {"password": secret, "username": "postgres", "database": "fixture"}, "env_vars": [{"key": "EXAMPLE_VALUE", "value": secret}], "environments": [{"name": "production", "branch": "application", "auto_deploy": False, "require_ci": False, "env_vars": [{"key": "EXAMPLE_ENVIRONMENT_VALUE", "value": secret}]}]})["project"]
        project_id = str(uuid.UUID(project["id"]))
        information = release.api("GET", "/projects/" + project_id + "/stack")
        assert information["stack"]["status"] == "detected", information["stack"]["message"]
        assert secret not in json.dumps(information), "Private values leaked into project information"
        assert information["details"]["preset"] == "PostgreSQL"
        assert information["details"]["image"].startswith("postgres:")
        assert information["details"]["container_port"] == "5432"
        assert any(item["value"] == "fixture" for item in information["details"]["application_fields"])
        assert information["details"]["environments"][0]["name"] == "production"
        assert information["details"]["environments"][0]["variables"] == 1
        assert information["details"]["variables"] >= 1
        release.cookies.clear()
        release.api("POST", "/auth/register", {"username": fixture + "-other", "email": emails[1], "password": "Fixture-" + secrets.token_hex(16) + "!aA1"})
        identities.append(release.api("GET", "/auth/me")["user"]["id"])
        release.api("GET", "/projects/" + project_id + "/stack", expected=(404,))
        release.cookies.clear()
        for cookie in owner_cookies:
            release.cookies.set_cookie(cookie)
        release.api("DELETE", "/projects/" + project_id, expected=(200, 204))
        project_id = None
        print("PROJECT_STACK_API_PASS: authenticated preview, no premature creation, preset detection, approved-root enforcement, public GitHub inspection, secret masking, configuration/environment details, cross-user access")
    finally:
        if project_id:
            release.api("DELETE", "/projects/" + project_id, expected=(200, 204, 404))
        # Exact test-owned identities only; never delete by a broad prefix.
        for identity in identities:
            identity = str(uuid.UUID(identity))
            sql = "DELETE FROM organizations WHERE is_personal AND id IN (SELECT organization_id FROM organization_members WHERE user_id='" + identity + "' AND role='owner'); DELETE FROM users WHERE id='" + identity + "';"
            subprocess.run(["docker", "exec", "-i", "stackpilot-postgres", "sh", "-c", 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], input=sql, check=True, capture_output=True, text=True)


if __name__ == "__main__":
    main()
