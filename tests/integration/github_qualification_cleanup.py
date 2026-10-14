"""Remove only exact, authenticated resources from a completed GitHub QA run."""
import argparse
import json
from pathlib import Path
import subprocess
import uuid
import re

import github_category_qualification as github
import release_pipeline_smoke as release
from stackpilot_test_artifacts import artifact_path


def cleanup(filename, prefix):
    extended=filename=='github-adapter-qualification.json' or re.fullmatch(r'github-real-healing(?:-[a-f0-9]{10})?\.json',filename)
    if filename not in {"github-category-qualification.json", "github-configured-qualification.json", "github-targeted-qualification.json"} and not extended:
        raise ValueError("Not a qualification report")
    path = artifact_path(filename)
    report = json.loads(path.read_text(encoding="utf-8"))
    if not report.get("complete") and not (extended and report.get('outcome') in {'healed','recovery_failed'}):
        raise ValueError("Active qualification resources must remain available")
    if report.get("account_cleaned_up"):
        print("QUALIFICATION_ALREADY_CLEANED " + filename)
        return
    report["identity_prefix"] = prefix
    github.resume_test_identity(report)
    user = str(uuid.UUID(report["user_id"]))
    pending = subprocess.run(["docker", "exec", "-i", "stackpilot-postgres", "sh", "-c",
                              'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1'],
                             input="SELECT (SELECT count(*) FROM deployment_jobs WHERE user_id='" + user + "' AND status IN ('queued','running','retrying'))+(SELECT count(*) FROM deployment_incidents WHERE user_id='"+user+"' AND status IN ('queued','running','retrying'));",
                             capture_output=True, text=True, check=True, timeout=20).stdout.strip()
    if pending != "0":
        raise ValueError("Qualification account still has active build jobs")
    errors = []
    cases=report.get('cases',[])
    if extended:
        # Additional retries/signing cases use the same authenticated fixture
        # actor. Enumerate only its exact owned projects, including observer
        # attempts whose per-case report was superseded; never query other users.
        rows=subprocess.run(['docker','exec','-i','stackpilot-postgres','sh','-c','psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1'],
            input="SELECT COALESCE(json_agg(json_build_object('project_id',id,'name',name)),'[]') FROM projects WHERE user_id='"+user+"';",
            text=True,encoding='utf-8',capture_output=True,check=True,timeout=20).stdout
        cases=json.loads(rows)
        if any(report['run'] not in case['name'] for case in cases):raise ValueError('Unexpected non-fixture project owned by the qualification actor')
        report['cleanup_projects']=cases
    for case in cases:
        if not case.get("project_id") or case.get("cleaned_up"):
            continue
        identity = str(uuid.UUID(case["project_id"]))
        try:
            release.api("DELETE", "/projects/" + identity, expected=(200, 204, 404))
            case["cleaned_up"] = True
        except Exception as exc:
            errors.append(str(exc))
    report["cleanup_errors"] = errors
    if not errors:
        # The JWT identity was verified before any write. Only that fixture's
        # personal organization and account can be removed here.
        sql = ("DELETE FROM organizations WHERE is_personal AND id IN (SELECT organization_id FROM organization_members WHERE user_id='" + user + "'); "
               "DELETE FROM users WHERE id='" + user + "';")
        subprocess.run(["docker", "exec", "-i", "stackpilot-postgres", "sh", "-c",
                        'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1'],
                       input=sql, capture_output=True, text=True, check=True, timeout=20)
        report["account_cleaned_up"] = True
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if errors:
        raise RuntimeError("Qualification cleanup incomplete: " + "; ".join(errors))
    print("QUALIFICATION_CLEANED " + filename)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("report")
    parser.add_argument("--identity-prefix", default="github-qa-", choices=["github-qa-", "github-config-", "github-retry-"])
    args = parser.parse_args()
    cleanup(args.report, args.identity_prefix)
