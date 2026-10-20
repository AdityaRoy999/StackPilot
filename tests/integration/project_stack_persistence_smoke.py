"""Durable stack metadata qualification using only disposable local projects.

Set STACK_CACHE_RESTART_BACKEND=1 to prove persistence across a real restart.
No model calls, external repositories, builds, or user projects are involved.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.request
import uuid

from project_exposure_smoke import API, database


def ready():
    deadline = time.monotonic()+45
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8090/api/v1/health", timeout=2) as response:
                if response.status == 200: return
        except OSError: pass
        time.sleep(.5)
    raise TimeoutError("Backend did not become ready")


def technologies(response):
    return {item["id"] for item in response["stack"]["components"]}


def snapshot(project):
    return database([("SELECT jsonb_build_object('stack',stack,'key',source_key,'inspected_at',inspected_at,'last_attempted_at',last_attempted_at,'last_error',last_error,'invalidated_at',invalidated_at) FROM project_stack_snapshots WHERE project_id=%s",(project,))])[0][0][0]


def main():
    ready()
    owner, other = API(), API()
    run = uuid.uuid4().hex[:10]
    identities, projects = [], []
    private = "private-fixture-"+secrets.token_hex(16)
    password = "Fixture-"+secrets.token_hex(16)+"!aA1"
    email = "stack-cache-"+run+"@example.test"
    with tempfile.TemporaryDirectory(prefix="StackPilot stack cache ") as temporary:
        source = Path(temporary) / "Project One"
        second = Path(temporary) / "Project Two"
        source.mkdir(); second.mkdir()
        manifest = source / "package.json"
        def package(framework):
            manifest.write_text(json.dumps({"name":"cache-fixture","description":private,"dependencies":{framework:"*"}}), encoding="utf-8")
        package("react")
        (source / ".env").write_text("FIXTURE_SECRET="+private+"\n", encoding="utf-8")
        (second / "requirements.txt").write_text("fastapi==0.115.0\n", encoding="utf-8")
        try:
            owner.call("GET", "/projects/"+str(uuid.uuid4())+"/stack", expected=(401,))
            for api, suffix in ((owner,""),(other,"-other")):
                api.call("POST", "/auth/register", {"username":"stack-cache-"+run+suffix,"email":email if not suffix else "stack-cache-"+run+suffix+"@example.test","password":password})
                identities.append(api.call("GET", "/auth/me")["user"]["id"])
            project = owner.call("POST", "/projects", {"name":"Stack persistence "+run,"source_type":"local","source_path":str(source),"env_vars":[{"key":"FIXTURE_SECRET","value":private}]})["project"]["id"]
            projects.append(project)
            path = "/projects/"+project+"/stack"
            updated_at = database([("SELECT updated_at::text FROM projects WHERE id=%s",(project,))])[0][0][0]
            first = owner.call("GET",path)
            assert "react" in technologies(first) and first["cache"]["persisted"]
            saved = snapshot(project)
            assert saved["stack"] == first["stack"]
            assert database([("SELECT updated_at::text FROM projects WHERE id=%s",(project,))])[0][0][0] == updated_at, "Saving a stack invalidated project settings queries"
            assert private not in json.dumps(saved) and private not in json.dumps(first), "A private value entered stack metadata"
            other.call("GET",path,expected=(404,));other.call("GET",path+"?refresh=1",expected=(404,))
            assert snapshot(project)["inspected_at"] == saved["inspected_at"]
            package("vue")
            fresh_session = API()
            fresh_session.call("POST","/auth/login",{"email":email,"password":password})
            cached = fresh_session.call("GET",path)
            assert cached["cache"]["cached"] and "react" in technologies(cached) and "vue" not in technologies(cached)
            assert snapshot(project)["inspected_at"] == saved["inspected_at"], "Ordinary reads rescanned the repository"
            if os.getenv("STACK_CACHE_RESTART_BACKEND") == "1":
                subprocess.run(["docker","restart","stackpilot-backend"], capture_output=True, check=True, timeout=45)
                ready()
                cached = fresh_session.call("GET",path)
                assert cached["cache"]["cached"] and "react" in technologies(cached)
                assert snapshot(project)["inspected_at"] == saved["inspected_at"]
            print("PASS database snapshot, private-value exclusion, cross-user isolation, fresh session and backend restart persistence",flush=True)
            refreshed = owner.call("GET",path+"?refresh=1")
            assert "vue" in technologies(refreshed) and "react" not in technologies(refreshed)
            saved = snapshot(project)
            manifest.write_text(" "*70000, encoding="utf-8")
            incomplete = owner.call("GET",path+"?refresh=1")
            assert "vue" in technologies(incomplete) and incomplete["cache"]["stale"]
            assert snapshot(project)["stack"] == saved["stack"], "An incomplete scan erased the last successful snapshot"
            package("vue")
            offline = source.with_name("Project Temporarily Offline")
            source.rename(offline)
            try:
                failed = owner.call("GET",path+"?refresh=1")
                assert "vue" in technologies(failed) and failed["cache"]["stale"] and failed["cache"]["refresh_error"]
                assert snapshot(project)["inspected_at"] == saved["inspected_at"]
            finally: offline.rename(source)
            changed = owner.call("PUT","/projects/"+project,{"name":"Stack persistence "+run,"source_type":"local","source_path":str(second)})
            assert changed["project"]["source_path"] == str(second)
            current = owner.call("GET",path)
            assert "fastapi" in technologies(current) and "vue" not in technologies(current) and current["cache"]["persisted"]
            database([("UPDATE project_environments SET branch='feature/cached-stack' WHERE project_id=%s",(project,))])
            branch = owner.call("GET",path)
            assert branch["cache"]["persisted"] and snapshot(project)["key"]["branch"] == "feature/cached-stack"
            owner.call("POST","/projects/"+project+"/deployments",{"version":"stack-cache-invalidation"})
            assert snapshot(project)["invalidated_at"] is not None
            deployed = owner.call("GET",path)
            assert deployed["cache"]["persisted"] and "fastapi" in technologies(deployed)
            # Deployment invalidation with an unavailable source retains the
            # previous result and suppresses repeated automatic failed scans.
            offline = second.with_name("Second Temporarily Offline")
            second.rename(offline)
            try:
                owner.call("POST","/projects/"+project+"/deployments",{"version":"stack-cache-cooldown"})
                failed = owner.call("GET",path)
                assert failed["cache"]["stale"] and "fastapi" in technologies(failed)
                attempted = snapshot(project)["last_attempted_at"]
                again = owner.call("GET",path)
                assert again["cache"]["stale"] and "fastapi" in technologies(again)
                assert snapshot(project)["last_attempted_at"] == attempted, "Failed automatic inspections were repeated during cooldown"
            finally: offline.rename(second)
            print("PASS explicit refresh, partial/offline-source recovery, source and branch invalidation, deployment invalidation and retry cooldown",flush=True)
            # Preset config secrets never become part of the durable descriptor.
            preset = owner.call("POST","/projects",{"name":"Preset stack persistence "+run,"source_type":"application","application_template_id":"postgres","application_config":{"password":private}})["project"]["id"]
            projects.append(preset)
            preset_stack = owner.call("GET","/projects/"+preset+"/stack")
            assert "postgres" in technologies(preset_stack) and preset_stack["cache"]["persisted"]
            assert private not in json.dumps(snapshot(preset))
            for identity in list(projects):
                owner.call("DELETE","/projects/"+identity,expected=(200,204))
                projects.remove(identity)
                assert database([("SELECT COUNT(*) FROM project_stack_snapshots WHERE project_id=%s",(identity,))])[0][0][0] == 0
            print("PASS preset stack persistence and automatic snapshot cleanup on project deletion",flush=True)
        finally:
            for identity in projects:
                owner.call("DELETE","/projects/"+identity,expected=(200,204,404))
            for identity in identities:
                database([("DELETE FROM organizations WHERE created_by=%s AND is_personal=TRUE",(identity,)),("DELETE FROM users WHERE id=%s",(identity,))])


if __name__ == "__main__": main()
