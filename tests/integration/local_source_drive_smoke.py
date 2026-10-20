"""Qualify drive browsing and building a real project outside local-projects.

Run against the local stack with Docker and desktop source mounts enabled.
Set LOCAL_FOLDER_UI=1 for the real browser picker check; Playwright/Edge paths
can be overridden using the same variables as local_folder_picker_ui.mjs.
Only disposable source files, accounts, builds and runtimes are created.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
from urllib.parse import unquote, urlsplit
import urllib.request
import uuid

from project_exposure_smoke import API, database


def main():
    deadline = time.monotonic()+40
    while True:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8090/api/v1/health", timeout=2) as health:
                if health.status == 200: break
        except OSError:
            if time.monotonic() >= deadline: raise
        time.sleep(.5)
    api, user, project = API(), None, None
    deployments = []
    images = set()
    run = uuid.uuid4().hex[:10]
    with tempfile.TemporaryDirectory(prefix="StackPilot local folders ") as temporary:
        source = Path(temporary) / "Existing Project"
        source.mkdir()
        (source / "Child Folder").mkdir()
        (source / "Dockerfile").write_text('FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN python3 .stackpilot-runtime/repository_tests.py\nEXPOSE 3000\nCMD ["python3","-m","http.server","3000"]\n', encoding="utf-8")
        (source / "stackpilot.json").write_text(json.dumps({"workload":"web","port":3000,"tests_required":True,
            "tests":[["python3","-c","assert 2+2==4"]]}), encoding="utf-8")
        try:
            api.call("POST", "/local/sources/browse", {"path":""}, expected=(401,))
            api.call("POST", "/auth/register", {"username":"local-folders-"+run,"email":"local-folders-"+run+"@example.test","password":"Fixture-"+secrets.token_hex(16)+"!aA1"})
            user = api.call("GET", "/auth/me")["user"]["id"]
            roots = api.call("POST", "/local/sources/browse", {"path":""})
            if os.name == "nt":
                drive = source.drive + "\\"
                assert any(root["path"] == drive for root in roots["roots"]), "Host drive is missing from the picker"
                root_listing = api.call("POST", "/local/sources/browse", {"path":drive})
                assert root_listing["parent_path"] == "", "Up from a drive must return to the drive chooser"
            listing = api.call("POST", "/local/sources/browse", {"path":str(source)})
            assert listing["path"] == str(source)
            assert listing["parent_path"] == str(source.parent)
            assert any(item["path"] == str(source / "Child Folder") for item in listing["entries"])
            assert all(item["directory"] for item in listing["entries"])
            api.call("POST", "/local/sources/browse", {"path":str(source / "not-present")}, expected=(400,))
            # The container filesystem is not implicitly shared by adding host drives.
            if os.name == "nt":
                api.call("POST", "/local/sources/browse", {"path":"/etc"}, expected=(400,))
                api.call("POST", "/local/sources/browse", {"path":"C:/../../etc"}, expected=(400,))
            stack = api.call("POST", "/projects/inspect-stack", {"source_type":"local","source_path":str(source)})["stack"]
            assert stack["status"] == "detected" and any(item["id"] == "docker" for item in stack["components"])
            print("PASS authenticated drive browsing, native paths, parent navigation, source inspection and path boundaries", flush=True)
            if os.getenv("LOCAL_FOLDER_UI") == "1":
                token = next(unquote(cookie.value) for cookie in api.cookies if cookie.name == "token")
                result = subprocess.run(["node","tests/integration/local_folder_picker_ui.mjs"], input=json.dumps({"token":token,"path":str(source),"parent":str(source.parent),"name":source.name,"drive":source.drive}), text=True, capture_output=True, timeout=90)
                assert result.returncode == 0, "Folder picker UI failed: " + result.stderr[-1800:]
                print(result.stdout.strip(), flush=True)
            project = api.call("POST", "/projects", {"name":"Local folder qualification "+run,"source_type":"local","source_path":str(source),"execution_mode":"local","remote_runtime_type":"docker"})["project"]
            assert project["source_path"] == str(source), "Project must display its native host path"
            if os.name == "nt":
                mounted = json.loads(subprocess.run(["docker","inspect","--format","{{json .Mounts}}","stackpilot-backend"], capture_output=True, text=True, check=True).stdout)
                assert any(item["Destination"] == "/app/host-drives/"+source.drive[0].lower() and not item["RW"] for item in mounted)
            for version in ("one", "two"):
                (source / "index.html").write_text("<h1>Existing local project "+version+"</h1>", encoding="utf-8")
                identity = api.call("POST", "/projects/"+project["id"]+"/deployments", {"version":"local-folder-"+version})["deployment"]["id"]
                deployments.append(identity)
                api.call("POST", "/deployments/"+identity+"/trigger", {})
                deadline = time.monotonic()+180
                previous = ""
                while time.monotonic() < deadline:
                    deployment = api.call("GET", "/deployments/"+identity)
                    state = deployment["status"]
                    if state != previous:
                        print("LOCAL_SOURCE_BUILD "+version+" "+state, flush=True)
                        previous = state
                    if state == "failed":
                        logs = api.call("GET", "/deployments/"+identity+"/logs")["deployment"]["logs"]
                        evidence = Path("tests/artifacts/local-source-build-failure.log")
                        evidence.parent.mkdir(parents=True, exist_ok=True)
                        evidence.write_text(logs, encoding="utf-8")
                        raise AssertionError("Local source build failed; fixture diagnostics: " + str(evidence))
                    if state in {"running","ready"} and deployment.get("runtime_snapshot",{}).get("routed_verification",{}).get("verified"):
                        break
                    time.sleep(1)
                else:
                    raise TimeoutError("Local source build did not finish")
                parsed = urlsplit(deployment["runtime_url"])
                request = urllib.request.Request("http://127.0.0.1:"+str(parsed.port)+(parsed.path or "/"), headers={"Host":parsed.netloc})
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
                    assert "Existing local project "+version in response.read().decode()
                if deployment.get("image_name"): images.add(deployment["image_name"])
            assert (source / "index.html").read_text() == "<h1>Existing local project two</h1>"
            print("PASS outside-root project create/build/deploy and second build reading updated host files; source mounted read-only", flush=True)
        finally:
            if project:
                api.call("DELETE", "/projects/"+project["id"], expected=(200,204,404))
            if user:
                database([("DELETE FROM organizations WHERE created_by=%s AND is_personal=TRUE",(user,)),("DELETE FROM users WHERE id=%s",(user,))])
            for image in images:
                subprocess.run(["docker","image","rm",image], capture_output=True, timeout=30)
            for identity in deployments:
                owned = subprocess.run(["docker","image","ls","--filter","reference=stackpilot/"+identity+":*","--format","{{.ID}}"], capture_output=True, text=True, timeout=20)
                for image in owned.stdout.splitlines():
                    subprocess.run(["docker","image","rm",image], capture_output=True, timeout=30)


if __name__ == "__main__":
    main()
