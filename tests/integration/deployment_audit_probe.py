"""Read-only deployment audit probes against generated code; no real credentials.

The HTTP fixture executes the Android portal embedded in BuildService.cpp in a
temporary source directory. It does not deploy, build, or modify an application.
"""
import ast
import argparse
import functools
import http.server
import json
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[2]


def fetch(base, path):
    try:
        with urllib.request.urlopen(base + path, timeout=5) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cmake-image", help="Optional existing image with CMake and a C compiler; never pulls an image")
    parser.add_argument("--output", type=Path)
    options = parser.parse_args()
    source = (ROOT / "src/services/BuildService.cpp").read_text(encoding="utf-8")
    branch = source.split('else if (archetype.type == "native_android") {', 1)[1]
    branch = branch.split('else if (archetype.type == "desktop_compose_gui") {', 1)[0]
    assignment = branch.split("generated =", 1)[1]
    dockerfile = "".join(ast.literal_eval(value) for value in re.findall(r'"(?:\\.|[^"\\])*"', assignment))
    encoded_portal = dockerfile.split("RUN printf '", 1)[1].split("' > /app/portal.py", 1)[0]
    portal = encoded_portal.replace("\\n", "\n")
    portal = portal.split("with socketserver.TCPServer", 1)[0]
    findings = {
        "android_generator_has_gradle_build": "gradlew" in dockerfile or "gradle " in dockerfile,
        "android_generator_has_sdk_install": "sdkmanager" in dockerfile,
    }
    with tempfile.TemporaryDirectory(prefix="stackpilot-deployment-audit-") as workdir:
        fixture = Path(workdir)
        (fixture / ".env").write_text("AUDIT_DUMMY_TOKEN=not-a-real-secret\n", encoding="utf-8")
        # Only redirect the generated glob to the isolated source fixture.
        portal = portal.replace('"/app/**/*.apk"', repr(str(fixture / "**/*.apk")))
        namespace = {}
        exec(compile(portal, "generated_android_portal.py", "exec"), namespace)
        handler = namespace["H"]
        handler.log_message = lambda *args: None
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(handler, directory=workdir))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            status, html = fetch(base, "/")
            findings["missing_apk_portal_http_status"] = status
            findings["missing_apk_still_advertises_ready"] = "Android Application Ready" in html
            findings["missing_apk_download_http_status"] = fetch(base, "/app-debug.apk")[0]
            nested_apk = fixture / "app/build/outputs/apk/debug/app-debug.apk"
            nested_apk.parent.mkdir(parents=True)
            nested_apk.write_bytes(b"audit fixture only; not an APK")
            findings["nested_apk_exists_but_download_http_status"] = fetch(base, "/app-debug.apk")[0]
            env_status, env_content = fetch(base, "/.env")
            findings["source_env_http_status"] = env_status
            findings["source_env_dummy_canary_exposed"] = "AUDIT_DUMMY_TOKEN=not-a-real-secret" in env_content
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)
    if options.cmake_image:
        subprocess.run(["docker", "image", "inspect", options.cmake_image], check=True, capture_output=True)
        script = '''set -e
work=$(mktemp -d)
cd "$work"
printf '%s\\n' 'cmake_minimum_required(VERSION 3.16)' 'project(audit C)' 'add_executable(z_application main.c)' 'add_executable(a_unit_test test.c)' > CMakeLists.txt
printf '%s\\n' 'int main(void) { return 37; }' > main.c
printf '%s\\n' 'int main(void) { return 0; }' > test.c
cmake -S . -B build >/dev/null
cmake --build build >/dev/null
exe=$(find build -maxdepth 4 -type f -executable | head -n1)
printf '%s\\n' "$exe"
'''
        result = subprocess.run(["docker", "run", "--rm", "--pull=never", "--entrypoint", "sh", options.cmake_image, "-c", script], check=True, capture_output=True, text=True, timeout=60)
        selected = result.stdout.strip().splitlines()[-1]
        findings["cmake_multi_target_selected_executable"] = selected
        findings["cmake_multi_target_selected_intended_application"] = selected == "build/z_application"
    serialized = json.dumps(findings, indent=2) + "\n"
    if options.output:
        options.output.write_text(serialized, encoding="utf-8")
    print(serialized, end="")


if __name__ == "__main__":
    main()
