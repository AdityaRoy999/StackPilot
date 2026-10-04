import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import Mock, patch

from stackpilot_cli import lifecycle
from stackpilot_cli.setup_server import SetupState, create_server, default_workspace


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="stackpilot-update-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.test")
        (self.root / ".gitignore").write_text(".env\n.stackpilot-backups/\n.stackpilot-install.json\n.stackpilot-update.lock\n")
        (self.root / "docker-compose.yml").write_text("services: {}\n")
        (self.root / ".env").write_text("DB_PASSWORD='fixture-secret'\n")
        self.git("add", ".")
        self.git("commit", "-m", "Base fixture")
        self.original = self.git("rev-parse", "HEAD")
        self.git("switch", "-c", "fixture-release")
        (self.root / "README.md").write_text("Updated fixture\n")
        self.git("add", ".")
        self.git("commit", "-m", "Release fixture")
        self.target = self.git("rev-parse", "HEAD")
        self.git("switch", "main")
        self.git("remote", "add", "origin", lifecycle.REPOSITORY)
        self.git("update-ref", "refs/remotes/origin/main", self.target)
        self.real_run = lifecycle.run

    def git(self, *arguments):
        return lifecycle.run(["git", *arguments], self.root)

    def fake_run(self, arguments, root=None, timeout=30):
        if arguments[:2] == ["git", "fetch"] or arguments[0] == "docker":
            return ""
        return self.real_run(arguments, root, timeout)

    def test_refuses_local_changes_without_overwriting_them(self):
        (self.root / "docker-compose.yml").write_text("local changes\n")
        with self.assertRaisesRegex(RuntimeError, "Local changes"):
            lifecycle.update_status(self.root, fetch=False)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.original)

    def test_refuses_other_origins_and_branches(self):
        self.git("remote", "set-url", "origin", "https://example.test/untrusted.git")
        with self.assertRaisesRegex(RuntimeError, "official"):
            lifecycle.update_status(self.root, fetch=False)
        self.git("remote", "set-url", "origin", lifecycle.REPOSITORY)
        self.git("switch", "fixture-release")
        with self.assertRaisesRegex(RuntimeError, "main"):
            lifecycle.update_status(self.root, fetch=False)

    def test_refuses_local_commits(self):
        self.git("commit", "--allow-empty", "-m", "Local work")
        with self.assertRaisesRegex(RuntimeError, "local commits"):
            lifecycle.update_status(self.root, fetch=False)

    def test_failed_database_backup_prevents_git_update(self):
        with patch.object(lifecycle, "run", side_effect=self.fake_run), patch.object(lifecycle.subprocess, "run", return_value=Mock(returncode=1)):
            # Git commands still need subprocess.run, so stub only the backup at the narrow boundary.
            with patch.object(lifecycle, "update_status", return_value={"available": True, "target": self.target, "current": self.original, "commits": 1}):
                with self.assertRaisesRegex(RuntimeError, "backup failed"):
                    lifecycle.update(self.root, report=lambda _: None)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.original)
        self.assertFalse((self.root / ".stackpilot-update.lock").exists())

    def test_success_retains_environment_profile_and_real_git_history(self):
        (self.root / ".stackpilot-install.json").write_text(json.dumps({"profile": "full", "production": False}))
        calls = []
        real_process = lifecycle.subprocess.run
        def process(arguments, **options):
            if arguments[0] == "docker":
                calls.append(arguments)
                if "pg_dump" in arguments[-1]:
                    options["stdout"].write(b"fixture-database-backup")
                return Mock(returncode=0, stdout="")
            return real_process(arguments, **options)
        def commands(arguments, root=None, timeout=30, **options):
            if arguments[:2] == ["git", "fetch"]:
                return ""
            return self.real_run(arguments, root, timeout, **options)
        with patch.object(lifecycle, "run", side_effect=commands), patch.object(lifecycle.subprocess, "run", side_effect=process), patch.object(lifecycle, "wait_ready") as health:
            result = lifecycle.update(self.root, "base", report=lambda _: None)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.target)
        self.assertEqual((self.root / ".env").read_text(), "DB_PASSWORD='fixture-secret'\n")
        self.assertEqual((Path(result["backup"]) / "database.dump").read_bytes(), b"fixture-database-backup")
        self.assertIn("full", calls[-1])
        self.assertNotIn("--volumes", str(calls))
        self.assertNotIn("fixture-secret", str(calls))
        health.assert_called_once()

    def test_parallel_update_is_blocked(self):
        (self.root / ".stackpilot-update.lock").write_text("fixture-active")
        with self.assertRaisesRegex(RuntimeError, "already running"):
            lifecycle.update(self.root)

    def test_production_installation_is_not_changed(self):
        (self.root / ".stackpilot-install.json").write_text(json.dumps({"profile": "core", "production": True}))
        with self.assertRaisesRegex(RuntimeError, "HTTPS server"):
            lifecycle.update(self.root)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.original)


class SetupBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = SetupState(self.temporary.name, self.temporary.name)
        self.server = create_server(self.state)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def request(self, path, token=None, body=None, headers=None):
        headers = dict(headers or {})
        if token:
            headers["X-Setup-Token"] = token
        if body:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body else None, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_setup_requires_private_token_even_on_localhost(self):
        self.assertEqual(self.request("/")[0], 200)
        self.assertEqual(self.request("/status")[0], 403)
        self.assertEqual(self.request("/status", "wrong-token")[0], 403)
        self.assertEqual(self.request("/status", self.state.token)[0], 200)

    def test_foreign_origin_and_dns_rebinding_are_rejected(self):
        self.assertEqual(self.request("/status", self.state.token, headers={"Origin": "https://attacker.example"})[0], 403)
        self.assertEqual(self.request("/status", self.state.token, headers={"Host": "attacker.example"})[0], 403)
        self.assertEqual(self.request("/action", self.state.token, {"action": "install"}, {"Origin": "https://attacker.example"})[0], 403)

    def test_only_fixed_actions_and_profiles_are_dispatched(self):
        for data in ({"action": "shell", "command": "fixture"}, {"action": "install", "profile": "$(fixture)"}):
            self.assertEqual(self.request("/action", self.state.token, data)[0], 400)
        self.assertFalse(self.state.job["running"])
        with patch.object(self.state, "start") as start:
            self.assertEqual(self.request("/action", self.state.token, {"action": "install", "profile": "base"})[0], 202)
            start.assert_called_once_with("install", "base")

    def test_prerequisites_detect_stopped_docker(self):
        with patch.object(lifecycle.shutil, "which", return_value="fixture"), patch.object(lifecycle, "run", side_effect=RuntimeError("Stopped")):
            checks = lifecycle.prerequisites()
        self.assertFalse(next(item["ok"] for item in checks if item["name"] == "Docker running"))

    def test_existing_database_without_original_environment_blocks_install(self):
        with patch("stackpilot_cli.setup_server.prerequisites", return_value=[{"ok": True}]), \
             patch("stackpilot_cli.setup_server.run", return_value="existing-fixture") as command:
            self.state.start("install", "core")
            deadline = time.monotonic() + 3
            while self.state.job["running"] and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(self.state.job["running"])
            self.assertFalse(self.state.job["ok"])
            self.assertIn("original checkout", self.state.job["message"])
            self.assertTrue(all(call.args[0][0] == "docker" for call in command.call_args_list))
            self.assertFalse((self.state.workspace / ".env").exists())

    def test_launcher_reuses_the_remembered_checkout(self):
        root = self.state.workspace
        (root / "checkout").mkdir()
        (root / "checkout" / "stackpilot-cli").mkdir()
        (root / "checkout" / "docker-compose.yml").write_text("services: {}")
        (root / ".stackpilot").mkdir()
        (root / ".stackpilot" / "config.json").write_text(json.dumps({"workspace": str(root / "checkout")}))
        with patch("stackpilot_cli.setup_server.Path.home", return_value=root):
            self.assertEqual(default_workspace(), root / "checkout")
