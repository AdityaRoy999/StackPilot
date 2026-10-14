"""Qualify the delivered GitHub APK using StackPilot's owned Android worker.

Service credentials and viewer tickets remain in memory; evidence contains
only the bound artifact, actual native scenario results and a PNG frame.
"""
import asyncio
import argparse
import json
import subprocess
import sys
from pathlib import Path

import github_category_qualification as github
import release_pipeline_smoke as release
from android_pipeline_smoke import frame
from stackpilot_test_artifacts import artifact_path


def main(signed=False):
    if signed:
        report=json.loads(artifact_path('github-adapter-qualification.json').read_text())
        sample=json.loads(artifact_path('github-additional-android-signed-apk.json').read_text())
    else:
        report = json.loads(artifact_path("github-android-final.json").read_text())
        sample = next(c for c in report["cases"] if c["category"] == "android-final")
    prefix='github-android-signed' if signed else 'github-android'
    if not report.get("complete") or sample["outcome"] != "delivered":
        raise RuntimeError("Android build has not delivered a verified APK")
    github.resume_test_identity(report)
    deployment = release.api("GET", "/deployments/" + sample["deployment_id"])
    ports = subprocess.run(["docker", "port", deployment["remote_container_name"], "3000/tcp"],
                           capture_output=True, text=True, check=True, timeout=15).stdout
    port = int(ports.splitlines()[0].rsplit(":", 1)[1])
    steps = [{"action": "tap", "selector": {"text": key}} for key in ("AC", "1", "2", "+", "3", "0", "=")]
    steps.append({"action": "assert", "expectations": [{"text": "42.0"}]})
    payload = {"url": "http://host.docker.internal:" + str(port), "deployment_id": sample["deployment_id"],
               "contract": {"workload": "android", "verification_scope": "artifact_delivery", "health_path": "/healthz",
                            "app_id": "com.example.calculator", "native_preview_required": True,
                            "native_scenarios": [{"name": "Calculate 12 plus 30", "steps": steps}]}}
    code = """import httpx,json,os,sys
with httpx.Client(timeout=240,trust_env=False) as client:
 response=client.post('http://127.0.0.1:8010/runtime/verify',headers={'x-stackpilot-service-token':os.environ['STACKPILOT_AI_SERVICE_TOKEN']},json=json.load(sys.stdin))
 response.raise_for_status(); print(json.dumps(response.json()))
"""
    result = subprocess.run(["docker", "exec", "-i", "stackpilot-ai-service", "python", "-c", code],
                            input=json.dumps(payload), capture_output=True, text=True, check=True, timeout=270)
    proof = json.loads(result.stdout)
    native = proof.get("native") or {}
    evidence = {"repository": sample["repository"], "commit": sample["commit"], "deployment_id": sample["deployment_id"],
                "scope": "independent_native_workflow_after_delivery", "runtime_proof": proof,
                "expected_display": "42.0",
                "businessWorkflowPassed": proof.get("verified") is True and native.get("workflow_verified") is True}
    artifact_path(prefix+"-workflow.json").write_text(json.dumps(evidence, indent=2))
    if not evidence["businessWorkflowPassed"]:
        raise RuntimeError("Actual Android calculator workflow did not pass; inspect recorded proof")
    # Access the public deployment-scoped stream, not an ADB screenshot shortcut.
    ticket = release.api("GET", "/deployments/" + sample["deployment_id"] + "/native-preview-ticket")
    try:
        png = asyncio.run(frame(ticket["preview_url"]))
    except Exception as exc:
        raise RuntimeError("Authenticated Android frame failed: " + type(exc).__name__) from None
    artifact_path(prefix+"-calculator.png").write_bytes(png)
    evidence["authenticated_png_stream"] = True
    artifact_path(prefix+"-workflow.json").write_text(json.dumps(evidence, indent=2))
    print("ANDROID_CALCULATOR_12_PLUS_30_EQUALS_42_PASS")


if __name__ == "__main__":
    try:
        parser=argparse.ArgumentParser();parser.add_argument('--signed',action='store_true');main(parser.parse_args().signed)
    except Exception as exc:
        # Never expose request credentials or ticket URLs through tracebacks.
        print("ANDROID_WORKFLOW_FAILED " + type(exc).__name__ + ": " + str(exc) if isinstance(exc, RuntimeError) else "ANDROID_WORKFLOW_FAILED " + type(exc).__name__)
        sys.exit(1)
