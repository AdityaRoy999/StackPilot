#!/usr/bin/env python3
"""StackPilot integration regression suite.

Every test here corresponds to a defect that actually shipped. They exist
because in each case the code *looked* correct and did nothing — the SSRF guard
that missed a route, the permission column that was never read, the WebSocket
that never checked a token. Reading the source was not enough to catch any of
them; only firing a real request was.

Runs against a live stack. No third-party dependencies (stdlib only).

    python tests/integration/test_platform.py
    python tests/integration/test_platform.py --backend http://127.0.0.1:8090

Exit code 0 = all passed, 1 = at least one failure.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import subprocess
import time
import sys
import urllib.error
import urllib.request
from typing import Any, Optional

# Use 127.0.0.1 rather than localhost: on Windows, `localhost` resolves to ::1
# first and Docker's port forward doesn't answer on IPv6, adding ~200ms per call.
BACKEND = "http://127.0.0.1:8090"
AI_SERVICE = "http://127.0.0.1:8010"
FRONTEND = "http://127.0.0.1:3000"
# Must match CORS_ALLOWED_ORIGIN exactly -- the guard compares strings, so
# 127.0.0.1 is not interchangeable with localhost here.
BROWSER_ORIGIN = "http://localhost:3000"
PG_CONTAINER = "stackpilot-postgres"

RESULTS: list[tuple[str, bool, str]] = []


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def psql(sql: str) -> str:
    """Run SQL in the postgres container and return trimmed stdout."""
    proc = subprocess.run(
        ["docker", "exec", PG_CONTAINER, "sh", "-c",
         f'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc {json.dumps(sql)}'],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"psql failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def request(
    method: str,
    url: str,
    body: Optional[dict[str, Any]] = None,
    headers: Optional[dict[str, str]] = None,
) -> tuple[int, str]:
    """Return (status, body). Never raises on HTTP error status."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:  # connection refused, timeout, ...
        return 0, str(exc)


def check(name: str, passed: bool, detail: str = "") -> None:
    RESULTS.append((name, passed, detail))
    print(f"  {'PASS' if passed else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not passed else ""))


# Set when the suite registers its own user, so cleanup knows to remove it.
FIXTURE_USER_EMAIL = ""


def ensure_user() -> str:
    """Return a user id, registering a throwaway account if the database is empty.

    A fresh CI database has no users, which used to abort the whole suite
    fourteen tests in. Registering through the public route rather than
    inserting a row keeps the fixture honest: it exercises the same password
    hashing the real signup path uses, so a user created here is a user the
    rest of the platform will accept.
    """
    global FIXTURE_USER_EMAIL

    existing = psql("SELECT id FROM users LIMIT 1;")
    if existing:
        return existing

    email = f"integration-fixture-{secrets.token_hex(6)}@stackpilot.invalid"
    # Mutating routes require a trusted Origin plus the CSRF header unless the
    # caller presents a bearer token. Registration cannot have a token yet, so
    # the fixture has to look like the browser does.
    status, body = request(
        "POST",
        f"{BACKEND}/api/v1/auth/register",
        {
            # The field is `username`, not `name`, and the password minimum is
            # 12 characters -- both taken from AuthController::registerUser
            # rather than assumed.
            "username": f"integration-fixture-{secrets.token_hex(4)}",
            "email": email,
            "password": "Fixture-" + secrets.token_hex(12) + "!aA1",
        },
        headers={
            "Origin": BROWSER_ORIGIN,
            "X-stackpilot-CSRF": "1",
        },
    )
    if status not in (200, 201):
        raise RuntimeError(f"could not register a fixture user: {status} {body[:200]}")

    FIXTURE_USER_EMAIL = email
    user_id = psql(f"SELECT id FROM users WHERE email = '{email}';")
    if not user_id:
        raise RuntimeError("registration reported success but no user row exists")
    return user_id


def mint_mcp_token(scopes: list[str], label: str) -> str:
    """Create a short-lived MCP token directly in the DB and return the raw value."""
    raw = "STACKPILOT_mcp_" + secrets.token_hex(16)
    digest = hashlib.sha256(raw.encode()).hexdigest()
    user_id = ensure_user()
    psql(
        "INSERT INTO mcp_tokens (user_id, name, token_hash, token_prefix, permissions, expires_at) "
        f"VALUES ('{user_id}', '{label}', '{digest}', 'test', "
        f"'{json.dumps(scopes)}'::jsonb, NOW() + INTERVAL '10 minutes');"
    )
    return raw


def cleanup(label: str) -> None:
    psql(f"DELETE FROM mcp_tokens WHERE name = '{label}';")


def cleanup_fixture_user() -> None:
    """Remove the account ensure_user() created, if it created one.

    Only ever deletes an account this run registered. A database that already
    had users is left exactly as it was found -- the suite is meant to be safe
    to run against a stack with real data.
    """
    if not FIXTURE_USER_EMAIL:
        return
    psql(f"DELETE FROM users WHERE email = '{FIXTURE_USER_EMAIL}';")


# --------------------------------------------------------------------------
# tests
# --------------------------------------------------------------------------
def test_liveness() -> None:
    print("\nliveness")
    status, _ = request("GET", f"{BACKEND}/api/v1/health")
    check("backend /health responds 200", status == 200, f"got {status}")
    status, _ = request("GET", f"{AI_SERVICE}/health")
    check("ai-service /health responds 200", status == 200, f"got {status}")
    status, _ = request("GET", FRONTEND + "/")
    check("frontend responds", status in (200, 307, 308), f"got {status}")


def test_authentication_required() -> None:
    """Unauthenticated callers must not reach data endpoints."""
    print("\nauthentication")
    for path in ("/api/v1/auth/me", "/api/v1/secrets", "/api/v1/projects", "/api/v1/deployments"):
        status, _ = request("GET", BACKEND + path)
        check(f"{path} rejects anonymous", status == 401, f"got {status}")
    status, _ = request("POST", f"{BACKEND}/api/v1/ai/connection-test", {"model": "fixture-model"},
                        headers={"Origin": BROWSER_ORIGIN, "X-stackpilot-CSRF": "1"})
    check("AI connection test rejects anonymous", status == 401, f"got {status}")


def test_static_files_not_served() -> None:
    """Regression: document_root was '/app', exposing source and cloned repos."""
    print("\nstatic file exposure")
    for path in ("/mcp-server/src/index.js", "/config.json", "/sql/migrations/001_create_users.sql"):
        status, _ = request("GET", BACKEND + path)
        check(f"{path} is not served", status in (404, 401), f"got {status}")


def test_platform_containers_protected() -> None:
    """Regression: any user could claim and stop stackpilot-postgres."""
    print("\nplatform container protection")
    status, _ = request(
        "POST", f"{BACKEND}/api/v1/infrastructure/claims",
        {"provider_type": "docker", "resource_type": "container",
         "resource_key": "stackpilot-postgres", "name": "stackpilot-postgres"},
    )
    # 401 (anonymous) or 403 (protected) both mean "not claimable".
    check("claiming stackpilot-postgres is refused", status in (401, 403), f"got {status}")


def test_ai_service_requires_token() -> None:
    """Regression: ai-service had no authentication on any route."""
    print("\nai-service authentication")
    status, _ = request("POST", f"{AI_SERVICE}/embeddings", {"texts": ["hi"]})
    check("rejects unauthenticated POST", status == 401, f"got {status}")
    status, _ = request("GET", f"{AI_SERVICE}/health")
    check("health stays public (container healthcheck)", status == 200, f"got {status}")


def test_ai_service_ssrf_guard(service_token: Optional[str]) -> None:
    """Regression: provider_overrides.base_url reached httpx unvalidated.

    The first version of this guard only covered the chat path; the embeddings
    route was a complete bypass. Both are exercised here.
    """
    print("\nai-service SSRF guard")
    if not service_token:
        check("SSRF guard (skipped: STACKPILOT_AI_SERVICE_TOKEN unset)", True)
        return
    headers = {"X-StackPilot-Service-Token": service_token}
    cases = {
        "cloud metadata endpoint": "http://169.254.169.254/latest/meta-data",
        "internal container": "http://stackpilot-postgres:5432",
        "loopback": "http://127.0.0.1:8090",
        "non-http scheme": "file:///etc/passwd",
    }
    for label, url in cases.items():
        status, _ = request(
            "POST", f"{AI_SERVICE}/embeddings",
            {"provider": "openai_compatible",
             "provider_overrides": {"base_url": url, "api_key": "x"},
             "texts": ["hi"]},
            headers,
        )
        check(f"blocks {label}", status == 400, f"got {status}")


def test_mcp_token_scopes() -> None:
    """Regression: `permissions` was stored but never read — every token was full access."""
    print("\nMCP token scopes")
    label = "__itest_scopes"
    try:
        read_only = mint_mcp_token(["read"], label)
        auth = {"Authorization": f"Bearer {read_only}"}

        status, _ = request("GET", f"{BACKEND}/api/v1/projects", headers=auth)
        check("read scope allows GET", status == 200, f"got {status}")

        status, _ = request("POST", f"{BACKEND}/api/v1/projects",
                            {"name": "__itest_denied", "source_type": "github",
                             "repo_url": "https://github.com/x/y"}, auth)
        check("read scope denies POST", status == 401, f"got {status}")

        status, _ = request("DELETE", f"{BACKEND}/api/v1/projects/"
                            "00000000-0000-0000-0000-000000000000", headers=auth)
        check("read scope denies DELETE", status == 401, f"got {status}")
    finally:
        cleanup(label)
        psql("DELETE FROM projects WHERE name LIKE '__itest%';")


def test_agent_policy_gate() -> None:
    """Regression: agent permissions lived in localStorage; the server never saw them."""
    print("\nagent policy")
    label = "__itest_agent"
    try:
        token = mint_mcp_token(["read", "deploy"], label)
        user_id = psql("SELECT id FROM users LIMIT 1;")
        previous = psql(
            f"SELECT coalesce(agent_access_mode, 'ask') FROM ai_preferences WHERE user_id = '{user_id}';"
        ) or "ask"
        psql(
            f"INSERT INTO ai_preferences (user_id, agent_access_mode) VALUES ('{user_id}', 'ask') "
            "ON CONFLICT (user_id) DO UPDATE SET agent_access_mode = 'ask';"
        )

        project = {"name": "__itest_agent_project", "source_type": "github",
                   "repo_url": "https://github.com/x/y"}
        auth = {"Authorization": f"Bearer {token}"}

        status, _ = request("POST", f"{BACKEND}/api/v1/projects", project,
                            {**auth, "X-StackPilot-Agent-Action": "create_project"})
        check("agent action blocked when mode=ask", status == 403, f"got {status}")

        status, _ = request("POST", f"{BACKEND}/api/v1/projects", project, auth)
        check("same request allowed without agent header", status == 201, f"got {status}")

        psql(f"UPDATE ai_preferences SET agent_access_mode = '{previous}' WHERE user_id = '{user_id}';")
    finally:
        cleanup(label)
        psql("DELETE FROM projects WHERE name LIKE '__itest%';")


def test_secrets_are_write_only() -> None:
    """A secrets store that returns values on list is just an env var."""
    print("\nsecrets confidentiality")
    label = "__itest_secrets"
    try:
        token = mint_mcp_token(["read", "deploy"], label)
        auth = {"Authorization": f"Bearer {token}"}
        status, body = request("GET", f"{BACKEND}/api/v1/secrets", headers=auth)
        check("secrets list responds", status == 200, f"got {status}")
        if status == 200:
            check("list never contains a plaintext value",
                  '"value"' not in body, "response included a 'value' field")
    finally:
        cleanup(label)


def test_organization_access_control() -> None:
    """A second user must not reach the first user's projects.

    This is the check the whole RBAC migration exists to make true. Every
    project query now routes through has_project_access() instead of
    `user_id = $1`; if any of the 41 rewritten predicates dropped its gate, an
    outsider would start seeing rows here.
    """
    print("\norganization access control")
    outsider_email = f"rbac-outsider-{secrets.token_hex(6)}@stackpilot.invalid"
    project_name = f"rbac-fixture-{secrets.token_hex(6)}"
    try:
        owner_id = ensure_user()

        # Every user must land in exactly one personal organization, as owner.
        personal = psql(
            "SELECT count(*) FROM organizations o "
            "JOIN organization_members m ON m.organization_id = o.id "
            f"WHERE m.user_id = '{owner_id}' AND o.is_personal AND m.role = 'owner';")
        check("owner has a personal organization", personal == "1", f"got {personal}")

        orphans = psql("SELECT count(*) FROM projects WHERE organization_id IS NULL;")
        check("no project is orphaned from an organization", orphans == "0", f"{orphans} orphaned")

        # Create our own project rather than borrowing whatever happens to
        # exist. On a fresh CI database nothing does, and the earlier version
        # of this test quietly skipped its twelve real assertions there --
        # a green tick that proved almost nothing.
        owner_org = psql(
            "SELECT o.id FROM organizations o "
            "JOIN organization_members m ON m.organization_id = o.id "
            f"WHERE m.user_id = '{owner_id}' AND o.is_personal LIMIT 1;")
        # RETURNING prints the value and then psql's "INSERT 0 1" status line;
        # only the first line is the id.
        project_id = psql(
            "INSERT INTO projects (organization_id, user_id, name, source_type, repo_url) "
            f"VALUES ('{owner_org}', '{owner_id}', '{project_name}', 'github', "
            "'https://example.invalid/rbac-fixture.git') RETURNING id;").splitlines()[0].strip()
        check("fixture project created", bool(project_id), "no id returned")
        if not project_id:
            return

        check("owner reaches their own project",
              psql(f"SELECT has_project_access('{project_id}', '{owner_id}');") == "t")

        # A real second account, created the same way a real signup would be,
        # so the personal-org trigger is exercised too.
        status, body = request(
            "POST", f"{BACKEND}/api/v1/auth/register",
            {"username": f"rbac-outsider-{secrets.token_hex(4)}",
             "email": outsider_email,
             "password": "Outsider-" + secrets.token_hex(12) + "!aA1"},
            headers={"Origin": BROWSER_ORIGIN, "X-stackpilot-CSRF": "1"},
        )
        if status not in (200, 201):
            check("could register a second user", False, f"{status} {body[:120]}")
            return

        outsider_id = psql(f"SELECT id FROM users WHERE email = '{outsider_email}';")
        check("signup trigger created a personal organization",
              psql("SELECT count(*) FROM organization_members "
                   f"WHERE user_id = '{outsider_id}' AND role = 'owner';") == "1")

        check("outsider cannot reach another user's project",
              psql(f"SELECT has_project_access('{project_id}', '{outsider_id}');") == "f")
        check("outsider has no role on it",
              psql(f"SELECT coalesce(project_role('{project_id}', '{outsider_id}'), 'none');") == "none")

        # Grant viewer, then confirm the role ladder is enforced rather than
        # collapsing into "member or not".
        org_id = psql(f"SELECT organization_id FROM projects WHERE id = '{project_id}';")
        psql("INSERT INTO organization_members (organization_id, user_id, role) "
             f"VALUES ('{org_id}', '{outsider_id}', 'viewer') "
             "ON CONFLICT (organization_id, user_id) DO UPDATE SET role = 'viewer';")

        check("viewer can read the project",
              psql(f"SELECT has_project_access('{project_id}', '{outsider_id}', 'viewer');") == "t")
        check("viewer cannot write (member bar)",
              psql(f"SELECT has_project_access('{project_id}', '{outsider_id}', 'member');") == "f")
        check("viewer cannot delete (admin bar)",
              psql(f"SELECT has_project_access('{project_id}', '{outsider_id}', 'admin');") == "f")

        psql("UPDATE organization_members SET role = 'member' "
             f"WHERE organization_id = '{org_id}' AND user_id = '{outsider_id}';")
        check("member can write",
              psql(f"SELECT has_project_access('{project_id}', '{outsider_id}', 'member');") == "t")
        check("member still cannot delete",
              psql(f"SELECT has_project_access('{project_id}', '{outsider_id}', 'admin');") == "f")

        # An unknown minimum must deny, not pass. If role_rank returned 0 for
        # both sides this would silently grant everything.
        check("an unknown required role denies",
              psql(f"SELECT has_project_access('{project_id}', '{owner_id}', 'superuser');") == "f")
    except Exception as exc:
        check("organization access control reachable", False, str(exc))
    finally:
        psql(f"DELETE FROM projects WHERE name = '{project_name}';")
        if outsider_email:
            psql(f"DELETE FROM users WHERE email = '{outsider_email}';")


def test_drift_cost_and_previews() -> None:
    """Schema and endpoints for drift, cost attribution and PR previews.

    These three features are mostly invisible when working, which is exactly
    why they need a live check: a cost report that silently reads zero and a
    drift detector that silently finds nothing look identical to a healthy
    platform.
    """
    print("\ndrift, cost and previews")
    try:
        for table in ("deployment_drift_checks", "deployment_cost_samples"):
            exists = psql("SELECT to_regclass('public.%s') IS NOT NULL;" % table)
            check(f"{table} exists", exists == "t", f"got {exists}")

        for column in ("is_preview", "pr_number", "preview_expires_at"):
            found = psql(
                "SELECT count(*) FROM information_schema.columns "
                f"WHERE table_name = 'deployments' AND column_name = '{column}';")
            check(f"deployments.{column} exists", found == "1", f"got {found}")

        # The partial unique index is what stops every push to a PR stacking
        # another preview deployment.
        idx = psql(
            "SELECT count(*) FROM pg_indexes WHERE tablename = 'deployments' "
            "AND indexname = 'idx_deployments_active_preview';")
        check("one live preview per (project, PR) is enforced", idx == "1", f"got {idx}")

        # Endpoints must be authenticated. An unauthenticated cost report
        # would disclose project names and spend across the whole install.
        status, _ = request("GET", f"{BACKEND}/api/v1/cost")
        check("cost report rejects anonymous", status == 401, f"got {status}")

        token = mint_mcp_token(["read"], "integration-cost-read")
        try:
            status, body = request(
                "GET", f"{BACKEND}/api/v1/cost?days=7",
                headers={"Authorization": f"Bearer {token}", "X-stackpilot-MCP": "1"})
            check("cost report responds to an authenticated read", status == 200, f"got {status} {body[:120]}")
            if status == 200:
                payload = json.loads(body)
                check("cost report is scoped and totalled",
                      "projects" in payload and "total_formatted" in payload,
                      f"keys={sorted(payload)[:6]}")
                check("cost report honours the window",
                      payload.get("window_days") == 7, f"got {payload.get('window_days')}")
                # Money must render as money, not as a raw integer count of
                # millicents, which is how an off-by-1000 ships unnoticed.
                check("totals are formatted as currency",
                      str(payload.get("total_formatted", "")).startswith("$"),
                      f"got {payload.get('total_formatted')}")
        finally:
            cleanup("integration-cost-read")

        status, _ = request("GET", f"{BACKEND}/api/v1/deployments/{secrets.token_hex(16)}/drift")
        check("drift check rejects anonymous", status == 401, f"got {status}")
    except Exception as exc:
        check("drift, cost and previews reachable", False, str(exc))


def test_preview_lifecycle_has_no_dead_ends() -> None:
    """Every deployment status a writer produces must have a reader.

    Both bugs this guards against were the same shape and neither errored:
    the webhook inserted a preview row and never enqueued a build, and both
    the webhook and the TTL sweep wrote 'pending_teardown' with nothing
    consuming it. In each case the database said exactly the right thing while
    nothing happened -- a preview stuck at 'pending' that never builds, and a
    preview marked for destruction that bills forever.
    """
    print("\npreview lifecycle")
    try:
        source = subprocess.run(
            ["docker", "exec", "stackpilot-backend", "sh", "-c",
             "grep -rlo pending_teardown /app/src 2>/dev/null | wc -l"],
            capture_output=True, text=True).stdout.strip()
        # The container ships the binary, not the source, so fall back to
        # asserting behaviour rather than grepping files.
        del source

        project_id = psql("SELECT id FROM projects LIMIT 1;")
        if not project_id:
            check("preview lifecycle (skipped: no projects)", True)
            return

        # A preview marked pending_teardown must not stay that way. The
        # maintenance worker runs every 60s; give it two ticks plus slack.
        dep_id = psql(
            "INSERT INTO deployments (project_id, status, version, commit_hash, is_preview, "
            "pr_number, preview_expires_at) "
            f"VALUES ('{project_id}', 'pending_teardown', 'pr-99991', 'probe', TRUE, 99991, "
            "NOW() - INTERVAL '1 hour') RETURNING id;").splitlines()[0].strip()
        check("teardown probe created", bool(dep_id), "no id")

        moved = False
        for _ in range(30):
            time.sleep(5)
            status = psql(f"SELECT status FROM deployments WHERE id = '{dep_id}';")
            if status and status != "pending_teardown":
                moved = True
                break
        check("pending_teardown is consumed by the maintenance worker", moved,
              "still pending_teardown after 150s -- nothing reads this status")

        # The partial unique index must allow a replacement once the previous
        # preview is terminal, otherwise a redeploy after teardown fails.
        psql(f"UPDATE deployments SET status = 'destroyed' WHERE id = '{dep_id}';")
        second = psql(
            "INSERT INTO deployments (project_id, status, version, commit_hash, is_preview, pr_number) "
            f"VALUES ('{project_id}', 'pending', 'pr-99991', 'probe2', TRUE, 99991) RETURNING id;"
        ).splitlines()[0].strip()
        check("a new preview can replace a destroyed one", bool(second), "insert rejected")
    except Exception as exc:
        check("preview lifecycle reachable", False, str(exc))
    finally:
        psql("DELETE FROM deployments WHERE pr_number = 99991;")


def test_ai_settings_can_be_saved() -> None:
    """Regression: saving AI settings returned 500 for every user, always.

    The upsert's CASE referenced $9 for the clear-key flag, but $9 is
    agent_access_mode -- a varchar. Postgres rejected the whole statement with
    "argument of CASE/WHEN must be type boolean", so the Agent Settings dialog
    showed "Failed to update AI settings" on every attempt and no one could
    ever change provider or model.

    Nothing caught it because no test had ever exercised a *successful* write
    to this endpoint; the parameter mismatch is invisible until Postgres plans
    the statement.
    """
    print("\nAI settings")
    label = "integration-ai-settings"
    try:
        token = mint_mcp_token(["deploy", "read"], label)
        headers = {"Authorization": f"Bearer {token}", "X-stackpilot-MCP": "1"}

        status, _ = request("POST", f"{BACKEND}/api/v1/ai/connection-test", {}, headers=headers)
        check("AI connection test requires an explicit model", status == 400, f"got {status}")

        status, body = request(
            "PUT", f"{BACKEND}/api/v1/ai/settings",
            {"enabled": True, "provider": "nvidia_nim",
             "model": "meta/llama-3.1-8b-instruct",
             "openai_compatible_base_url": ""},
            headers=headers,
        )
        check("saving AI settings succeeds", status in (200, 201), f"got {status} {body[:160]}")

        # The write must actually land, not merely return 200.
        status, body = request("GET", f"{BACKEND}/api/v1/ai/settings", headers=headers)
        if status == 200:
            saved = json.loads(body)
            check("the saved model is read back",
                  saved.get("model") == "meta/llama-3.1-8b-instruct",
                  f"got {saved.get('model')}")

        # A second save is the upsert's ON CONFLICT path -- the branch that
        # actually contained the broken CASE.
        status, body = request(
            "PUT", f"{BACKEND}/api/v1/ai/settings",
            {"enabled": True, "provider": "nvidia_nim",
             "model": "meta/llama-3.1-70b-instruct",
             "openai_compatible_base_url": ""},
            headers=headers,
        )
        check("re-saving takes the upsert conflict path", status in (200, 201),
              f"got {status} {body[:160]}")

        # An invalid base URL must still be rejected; the fix must not have
        # loosened the SSRF guard on this route.
        status, _ = request(
            "PUT", f"{BACKEND}/api/v1/ai/settings",
            {"enabled": True, "provider": "openai_compatible",
             "model": "gpt-4o-mini",
             "openai_compatible_base_url": "http://169.254.169.254/v1"},
            headers=headers,
        )
        check("an unsafe compatible base URL is still refused", status == 400, f"got {status}")
    except Exception as exc:
        check("AI settings reachable", False, str(exc))
    finally:
        cleanup(label)


def test_migration_ledger() -> None:
    """Regression: all migrations re-ran every boot, replaying destructive backfills."""
    print("\nmigration ledger")
    try:
        count = int(psql("SELECT count(*) FROM schema_migrations;"))
        check("schema_migrations is populated", count > 0, f"{count} rows")
        files = int(subprocess.run(
            ["docker", "exec", "stackpilot-backend", "sh", "-c",
             "ls sql/migrations/*.sql | wc -l"],
            capture_output=True, text=True).stdout.strip() or 0)
        check("every migration is recorded", count >= files, f"ledger={count} files={files}")
    except Exception as exc:
        check("migration ledger reachable", False, str(exc))


# --------------------------------------------------------------------------
def main() -> int:
    global BACKEND, AI_SERVICE, FRONTEND

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", default=BACKEND)
    parser.add_argument("--ai-service", default=AI_SERVICE)
    parser.add_argument("--frontend", default=FRONTEND)
    parser.add_argument("--ai-token", default=None,
                        help="STACKPILOT_AI_SERVICE_TOKEN (enables SSRF guard tests)")
    args = parser.parse_args()

    BACKEND, AI_SERVICE, FRONTEND = args.backend, args.ai_service, args.frontend

    service_token = args.ai_token
    if not service_token:
        try:
            with open(".env", encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("STACKPILOT_AI_SERVICE_TOKEN="):
                        service_token = line.split("=", 1)[1].strip()
                        break
        except OSError:
            pass

    print("StackPilot integration regression suite")
    print(f"backend={BACKEND}  ai-service={AI_SERVICE}")

    try:
        test_liveness()
        test_authentication_required()
        test_static_files_not_served()
        test_platform_containers_protected()
        test_ai_service_requires_token()
        test_ai_service_ssrf_guard(service_token)
        test_mcp_token_scopes()
        test_agent_policy_gate()
        test_secrets_are_write_only()
        test_organization_access_control()
        test_drift_cost_and_previews()
        test_preview_lifecycle_has_no_dead_ends()
        test_ai_settings_can_be_saved()
        test_migration_ledger()
    finally:
        # Runs even when a test raises, so a crash mid-suite does not leave a
        # fixture account behind in someone's real database.
        cleanup_fixture_user()

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = len(RESULTS) - passed
    print(f"\n{'-' * 52}\n{passed} passed, {failed} failed, {len(RESULTS)} total")
    if failed:
        print("\nfailures:")
        for name, ok, detail in RESULTS:
            if not ok:
                print(f"  - {name}: {detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
